export function reviseText(previous, text) {
  if (typeof text !== 'string') throw new TypeError('Нужен текст проверки');
  if (previous && previous.text === text) return { ...previous };
  return { ...previous, text, textVersion: (previous?.textVersion ?? 0) + 1, confirmedVersion: null };
}
export function confirmText(review, recording, textVersion) {
  if (!review || review.textVersion !== textVersion) throw new Error('Изменилась версия текста; проверьте актуальный текст');
  if (!recording || recording.completeness !== 'complete' || !recording.blob?.size) throw new Error('Нельзя подтвердить неполный или потерянный оригинал как полноценный ответ');
  return { ...review, confirmedVersion: textVersion };
}

/** Keeps drafts mounted through queue updates; manual/asr have independent persistent versions. */
export function createReviewPanel({ repository, recording, onConfirmed = async () => {}, onSourceExposed = async () => {}, onTextChanged = () => {} }) {
  const element = document.createElement('section');
  const raw = document.createElement('section'), label = document.createElement('label'), input = document.createElement('textarea');
  const caption = document.createElement('span');
  const saveButton = document.createElement('button'), confirmButton = document.createElement('button'), status = document.createElement('p');
  saveButton.textContent = 'Сохранить текст'; confirmButton.textContent = 'Подтвердить текст';
  input.rows = 4; input.cols = 60; input.disabled = true;
  label.append(caption, input); element.append(raw, label, saveButton, confirmButton, status);
  const states = new Map();
  let mode, current, disposed = false, revision = 0, playable = false, transitioning = true, blocked = false, exposureSent = false;
  function render() {
    if (!current || disposed) return;
    const dirty = !current.saved || current.saved.text !== current.draft;
    const confirmed = !dirty && !current.error && !current.saving && current.saved.confirmedVersion === current.saved.textVersion;
    status.textContent = current.error ? `Ошибка сохранения текста: ${current.error}. Введённый текст остаётся для повтора.`
      : current.saving ? 'Текст сохраняется; подтверждение недоступно.'
      : confirmed ? 'Текст подтверждён специалистом.' : 'Предварительный текст — требуется проверка специалистом.';
    input.disabled = transitioning || blocked;
    confirmButton.disabled = blocked || transitioning || current.saving || Boolean(current.error) || !playable || recording.completeness !== 'complete' || !recording.blob.size;
    saveButton.disabled = blocked || transitioning || current.saving;
  }
  function persist(state, selectedMode) {
    state.saving++;
    render();
    state.chain = state.chain.catch(() => {}).then(async () => {
      try {
        const snapshot = state.draft;
        state.saved = await repository.saveReview({ recordingId: recording.id, mode: selectedMode, text: snapshot,
          expectedVersion: state.saved?.textVersion ?? 0 });
        state.error = null;
      } catch (error) { state.error = error.message; throw error; }
      finally { state.saving--; render(); }
    });
    return state.chain;
  }
  input.oninput = () => {
    if (!current || transitioning) return;
    current.draft = input.value; current.touched = true;
    onTextChanged(mode);
    void persist(current, mode).catch(() => {});
  };
  saveButton.onclick = () => { if (transitioning || !current) return; current.touched = true; void persist(current, mode).catch(() => {}); };
  confirmButton.onclick = async () => {
    if (transitioning || !current) return;
    const state = current, selectedMode = mode;
    let confirming = false;
    state.touched = true;
    try {
      await persist(state, selectedMode);
      state.saving++; confirming = true; render();
      state.saved = await repository.confirmReview({ recordingId: recording.id, mode: selectedMode, textVersion: state.saved.textVersion });
      await onConfirmed(state.saved);
      state.error = null;
    } catch (error) { state.error = error.message; }
    finally { if (confirming) state.saving--; render(); }
  };
  return {
    element,
    setBlocked(value) { blocked = value; render(); },
    async flush() {
      for (const state of states.values()) { await state.chain; if (state.error) throw new Error(state.error); }
    },
    reload(selectedMode) {
      const state = states.get(selectedMode);
      if (state?.saving || state?.error) throw new Error('Сначала сохраните правку');
      states.delete(selectedMode); revision++;
    },
    suspend() {
      transitioning = true; revision++;
      raw.replaceChildren(); input.value = ''; input.disabled = true;
      confirmButton.disabled = true; saveButton.disabled = true;
      status.textContent = 'Загрузка выбранного режима проверки…';
    },
    setPlayable(value) { playable = value; render(); },
    async update({ mode: nextMode, attempts }) {
      const token = ++revision;
      if (mode !== nextMode) { raw.replaceChildren(); input.value = ''; input.disabled = true; }
      let state = states.get(nextMode);
      if (!state) {
        state = { saved: null, draft: '', touched: false, saving: 0, error: null, chain: Promise.resolve() };
        states.set(nextMode, state);
        state.loading = repository.getReview(recording.id, nextMode).then(saved => {
          state.saved = saved ?? null; state.draft = saved?.text ?? ''; state.touched = Boolean(saved);
        });
      }
      await state.loading;
      if (disposed || token !== revision) return;
      mode = nextMode; current = state; transitioning = false;
      input.disabled = false;
      const originals = attempts.filter(a => a.recordingId === recording.id && a.state === 'done');
      if (nextMode === 'asr' && !state.touched && !state.saved) state.draft = originals.at(-1)?.rawText ?? '';
      input.setAttribute('aria-label', nextMode === 'manual' ? 'Текст вручную' : 'Исправленный текст');
      caption.textContent = nextMode === 'manual' ? 'Текст вручную' : 'Исправленный текст';
      if (input.value !== state.draft) input.value = state.draft;
      raw.replaceChildren();
      if (nextMode === 'asr') {
        const title = document.createElement('h4'); title.textContent = 'Исходные расшифровки (неизменяемые)'; raw.append(title);
        for (const attempt of originals) {
          const caption = document.createElement('p'); caption.textContent = `Попытка ${attempt.attemptSeq}`;
          const text = document.createElement('pre'); text.style.whiteSpace = 'pre-wrap'; text.textContent = attempt.rawText; raw.append(caption, text);
        }
        if (originals.length && !exposureSent && element.isConnected && !element.closest('[hidden]')) {
          exposureSent = true; void onSourceExposed().catch(() => { exposureSent = false; });
        }
      }
      render();
    },
    dispose() { disposed = true; revision++; },
  };
}
