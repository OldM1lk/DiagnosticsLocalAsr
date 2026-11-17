import { buildReport } from './report.js';
import { recordingIdFor } from './manifest.js';

export function createMeasurements({ repository, host, queue, getSessionId, getViews, renderRecords, selectMode, onBusyChange = () => {} }) {
  host.innerHTML = `<h2>Серия и измерения</h2>
    <p>Манифест задаётся до первой записи. Полный профиль 15–18 лет сверяется с текущим прототипом; технический набор не подтверждает критерий полной диагностики.</p>
    <label>Манифест серии <input data-m="manifest" type="file" accept="application/json,.json"></label>
    <p data-m="manifest-status"></p><label>Ответ серии <select data-m="slot"><option value="">Без манифеста</option></select></label>
    <button data-m="series-start">Начать серию по манифесту</button>
    <p><label>Устройство <select data-m="device"><option value="unknown">Не указано</option><option value="desktop">Компьютер</option><option value="huawei-matepad-se-11">HUAWEI MatePad SE 11 LTE 8/128</option><option value="other-tablet">Другой планшет</option></select></label>
    <label>ОС <select data-m="os"><option value="unknown">Не проверена</option><option value="windows">Windows</option><option value="android">Android</option><option value="harmonyos">HarmonyOS</option><option value="linux">Linux</option><option value="macos">macOS</option></select></label>
    <label>Версия браузера <input data-m="browser-version" inputmode="decimal"></label><button data-m="passport">Сохранить паспорт</button></p>
    <p><label><input data-m="familiar" type="checkbox">Специалист знаком с записями или эталоном</label>
    <button data-m="plan">Подготовить парное сравнение</button></p>
    <p>Новый замер начинает текст заново; предыдущая версия сохраняется в локальной истории. Эталон в замере не показывается. Время плеера, набора и проверки входит в работу.</p>
    <button data-m="next">Начать следующий замер (новый текст)</button>
    <button data-m="pause">Внешний перерыв</button><button data-m="resume">Продолжить замер</button>
    <button data-m="leave">Вернуться к обычной проверке</button>
    <p><label><input data-m="complete" type="checkbox">Проверена дословная полнота текущего текста</label></p>
    <p data-m="trial"></p>
    <label>Замер для исправления или повтора <select data-m="past"></select></label>
    <button data-m="correct">Продолжить проверку с учётом времени</button><button data-m="repeat">Повторить выбранный замер заново</button>
    <details><summary>Ошибки исходной расшифровки — вне замера</summary>
      <label>Запись для сверки ошибок <select data-m="audit-record"></select></label>
      <div data-m="audit-fields"></div>
      <label><input data-m="audit-verified" type="checkbox">Счётчики сверены по оригиналу и эталону</label><button data-m="audit">Сохранить счётчики ошибок</button>
    </details>
    <p data-m="summary"></p><button data-m="export">Выгрузить обезличенный JSON</button><p data-m="message" aria-live="polite"></p>`;
  const el = name => host.querySelector(`[data-m="${name}"]`);
  const labels = { referenceWords: 'Слов в эталоне', omissions: 'Пропуски', substitutions: 'Замены', insertions: 'Вставки',
    lostRepeats: 'Потерянные повторы', orderErrors: 'Ошибки порядка', seamErrors: 'Ошибки стыков чанков' };
  for (const [key, text] of Object.entries(labels)) {
    const label = document.createElement('label'); label.textContent = text;
    const input = document.createElement('input'); input.type = 'number'; input.min = '0'; input.step = '1'; input.dataset.count = key; input.setAttribute('aria-label', text);
    label.append(input); el('audit-fields').append(label);
  }
  let snapshot, plan, trial, busy = false, revision = 0, initializedSession = null;
  const message = text => { el('message').textContent = text; };
  const modeLabel = mode => mode === 'asr' ? 'с ASR' : 'ручной ввод';
  const stateLabel = state => ({ active: 'работа', waiting: 'ожидание ASR', paused: 'внешний перерыв',
    complete: 'завершён', interrupted: 'прерван', 'needs-correction': 'нужна допроверка' })[state] ?? 'неизвестно';
  const resultLabel = result => ({ pass: 'критерий выполнен', fail: 'критерий не выполнен', 'insufficient-data': 'данных недостаточно' })[result];
  const now = () => performance.now();
  const ticker = setInterval(() => {
    if (!trial) return;
    const elapsed = trial.phaseTimelineId === queue.timelineId && ['active', 'waiting'].includes(trial.state) ? Math.max(0, now() - trial.phaseStartedAt) : 0;
    el('trial').textContent = `Замер ${trial.trialSeq}: ${modeLabel(trial.mode)}; ${stateLabel(trial.state)}. Работа: ${Math.round(trial.activeMs + (trial.state === 'active' ? elapsed : 0))} мс; ожидание: ${Math.round(trial.waitingMs + (trial.state === 'waiting' ? elapsed : 0))} мс. Полнота отмечается до подтверждения текста.`;
  }, 250);
  async function flush() { for (const view of getViews().values()) await view.review.flush(); }
  const forReport = data => queue.journalIncomplete ? { ...data, events: [...data.events, { type: 'journal-gap' }] } : data;
  async function operate(action) {
    if (busy) return;
    busy = true;
    onBusyChange();
    try { await action(); } catch (error) { message(`Ошибка измерения: ${error.message}`); }
    finally { busy = false; await refresh(); onBusyChange(); }
  }
  function chooseOptions(select, rows, selected = select.value) {
    select.replaceChildren(); for (const [value, text] of rows) select.add(new Option(text, value));
    if (rows.some(([value]) => value === selected)) select.value = selected;
  }
  function visibility() {
    for (const view of getViews().values()) {
      const measuring = plan && !plan.paused && plan.nextStep < plan.steps.length;
      const active = trial && ['active', 'waiting', 'paused'].includes(trial.state);
      const hidden = view.sessionId === getSessionId() && (active ? trial.state !== 'active' || view.recordingId !== trial.recordingId : measuring);
      view.item.hidden = Boolean(hidden);
      if (hidden) view.player.element.pause();
    }
  }
  async function refresh() {
    const token = ++revision, sessionId = getSessionId();
    if (!sessionId) { snapshot = null; plan = trial = null; el('summary').textContent = 'Выберите тестовую сессию.'; return; }
    const value = await repository.snapshot(sessionId);
    if (token !== revision || sessionId !== getSessionId() || !value.session) return;
    snapshot = value;
    plan = value.events.find(e => e.type === 'benchmark-plan');
    trial = value.events.filter(e => e.type === 'benchmark-trial' && ['active', 'waiting', 'paused'].includes(e.state)).sort((a, b) => b.trialSeq - a.trialSeq)[0] ?? null;
    if (initializedSession !== sessionId) {
      initializedSession = sessionId;
      el('device').value = value.session.passport?.device ?? 'unknown'; el('os').value = value.session.passport?.os ?? 'unknown';
      el('browser-version').value = value.session.passport?.browserVersion ?? (/Edg\/([\d.]+)/.exec(navigator.userAgent)?.[1] ?? /Chrome\/([\d.]+)/.exec(navigator.userAgent)?.[1] ?? '');
      el('complete').checked = false;
    }
    const entries = value.session.manifest?.entries ?? [];
    el('manifest-status').textContent = entries.length ? `Ожидается ${entries.length} записей; сохранено ${value.recordings.length}. Профиль: ${value.session.manifest.profile}.` : 'Манифест отсутствует; критерий полной серии не оценивается.';
    el('series-start').disabled = busy || !entries.length || value.session.startedAt != null || Boolean(value.recordings.length);
    const missing = entries.filter(e => !value.recordings.some(r => r.id === recordingIdFor(sessionId, e.id)));
    chooseOptions(el('slot'), missing.length ? missing.map(e => [e.id, `${e.presentationId} (${e.taskType})`]) : [['', entries.length ? 'Все ожидаемые оригиналы сохранены' : 'Без манифеста']]);
    chooseOptions(el('audit-record'), value.recordings.map(r => [r.id, r.presentationId]));
    const past = value.events.filter(e => e.type === 'benchmark-trial' && !['active', 'waiting', 'paused'].includes(e.state)).sort((a, b) => a.trialSeq - b.trialSeq);
    chooseOptions(el('past'), past.map(t => [t.id, `Замер ${t.trialSeq}: ${modeLabel(t.mode)}, ${stateLabel(t.state)}`]));
    const report = buildReport(forReport(value));
    el('summary').textContent = `Полная серия: ${resultLabel(report.series.status)}; ожидание после конца: ${report.series.remainingMs ?? 'не измерено'} мс. Сравнение времени: ${resultLabel(report.comparison.status)}; отношение сумм: ${report.comparison.ratio ?? 'не измерено'}. Это расчёт измерений, решение эксперимента ещё не принято.`;
    el('next').disabled = busy || !plan || Boolean(trial) || plan.nextStep >= plan.steps.length;
    el('pause').disabled = busy || trial?.state !== 'active'; el('resume').disabled = busy || trial?.state !== 'paused';
    el('correct').disabled = busy || Boolean(trial) || !past.length; el('repeat').disabled = busy || Boolean(trial) || !past.length;
    el('plan').disabled = busy || Boolean(plan); el('audit').disabled = busy || Boolean(trial);
    if (!trial) el('trial').textContent = plan ? `Порядок сохранён. Следующий шаг ${Math.min(plan.nextStep + 1, plan.steps.length)} из ${plan.steps.length}.` : 'Замеры не начаты.';
    else el('trial').textContent = `Замер ${trial.trialSeq}: ${modeLabel(trial.mode)}; ${stateLabel(trial.state)}. Работа: ${Math.round(trial.activeMs)} мс; ожидание: ${Math.round(trial.waitingMs)} мс. Отсчёт заканчивается подтверждением дословного текста с отмеченной полнотой.`;
    visibility();
    onBusyChange();
    if (!busy && trial?.state === 'waiting' && value.attempts.some(a => a.recordingId === trial.recordingId && a.state === 'done')) {
      await operate(async () => {
        const current = trial; await repository.moveBenchmark(current.id, 'active', now(), queue.timelineId);
        getViews().get(current.recordingId)?.review.reload(current.mode); await renderRecords();
      });
    }
  }
  el('manifest').onchange = () => operate(async () => {
    const file = el('manifest').files[0]; if (!file) return;
    await repository.saveManifest(getSessionId(), JSON.parse(await file.text())); message('Манифест сохранён.');
  });
  el('passport').onclick = () => operate(async () => {
    await repository.savePassport(getSessionId(), { device: el('device').value, os: el('os').value, browserVersion: el('browser-version').value }); message('Паспорт сохранён.');
  });
  el('series-start').onclick = () => operate(async () => { await repository.startSeries(getSessionId(), now(), queue.timelineId); message('Начало серии зафиксировано. Соблюдайте и фиксируйте реальный график ответов.'); });
  el('plan').onclick = () => operate(async () => {
    await flush();
    await repository.createBenchmarkPlan(getSessionId(), { seed: crypto.getRandomValues(new Uint32Array(1))[0], familiar: el('familiar').checked });
    message('Порядок сравнения сохранён. Эталоны не показываются.');
  });
  async function start(repeatId) {
    await flush();
    const started = await repository.beginBenchmarkTrial(getSessionId(), now(), queue.timelineId, repeatId);
    el('complete').checked = false;
    getViews().forEach(view => { view.item.hidden = true; view.player.element.pause(); });
    getViews().get(started.recordingId)?.review.reload(started.mode);
    await selectMode(started.mode); await renderRecords(); message('Замер начат.');
  }
  el('next').onclick = () => operate(() => start());
  el('repeat').onclick = () => operate(() => start(el('past').value));
  el('pause').onclick = () => operate(async () => {
    if ([...getViews().values()].some(v => v.recordingId === trial?.recordingId && !v.player.element.paused)) throw new Error('Время прослушивания входит в работу; сначала остановите плеер');
    await flush(); await repository.moveBenchmark(trial.id, 'paused', now(), queue.timelineId); message('Внешний перерыв.');
  });
  el('resume').onclick = () => operate(async () => { await repository.moveBenchmark(trial.id, 'active', now(), queue.timelineId); message('Замер продолжен.'); });
  el('correct').onclick = () => operate(async () => {
    await flush(); const selected = snapshot.events.find(e => e.id === el('past').value);
    if (!selected || selected.unknownInterval || selected.state === 'interrupted') throw new Error('Есть неизмеренный интервал; повторите замер заново');
    await repository.moveBenchmark(selected.id, 'active', now(), queue.timelineId);
    await repository.recordEvent({ ...plan, paused: false }); el('complete').checked = false;
    await selectMode(selected.mode); await renderRecords(); message('Дополнительная проверка входит во время этого замера.');
  });
  el('leave').onclick = () => operate(async () => {
    await flush();
    if (trial) await repository.moveBenchmark(trial.id, 'interrupted', now(), queue.timelineId);
    if (plan) await repository.recordEvent({ ...plan, paused: true }); message('Обычная проверка; прерванный замер не завершён.');
  });
  el('audit').onclick = () => operate(async () => {
    if (trial) throw new Error('Сверка ошибок проводится вне замера');
    const recordingId = el('audit-record').value, audit = {};
    for (const key of Object.keys(labels)) {
      const value = host.querySelector(`[data-count="${key}"]`).value;
      if (value === '' || !Number.isSafeInteger(Number(value)) || Number(value) < 0) throw new Error('Счётчики должны быть целыми неотрицательными числами');
      audit[key] = Number(value);
    }
    const latest = snapshot.attempts.filter(a => a.recordingId === recordingId && a.state === 'done').sort((a, b) => a.attemptSeq - b.attemptSeq).at(-1);
    if (!latest || !el('audit-verified').checked) throw new Error('Нужны исходная расшифровка и подтверждённая сверка счётчиков');
    await repository.recordEvent({ type: 'error-audit', sessionId: getSessionId(), id: JSON.stringify(['error-audit', recordingId, latest.id]),
      recordingId, attemptId: latest.id, verified: true, ...audit }); message('Счётчики сохранены, порог точности не применяется.');
  });
  el('export').onclick = () => operate(async () => {
    await flush();
    const report = buildReport(forReport(await repository.snapshot(getSessionId())));
    const url = URL.createObjectURL(new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' }));
    const anchor = document.createElement('a'); anchor.href = url; anchor.download = 'local-asr-report.json'; anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000); message('Обезличенный отчёт сформирован без аудио, текстов и имён файлов.');
  });
  return {
    refresh,
    dispose() { clearInterval(ticker); },
    audioPlayed(recordingId) {
      if (trial?.state === 'active' && trial.recordingId === recordingId) void repository.recordEvent({ type: 'listening', sessionId: getSessionId(),
        trialId: trial.id, recordingId, at: now(), timelineId: queue.timelineId }).catch(error => message(`Ошибка журнала: ${error.message}`));
    },
    get busy() { return busy; },
    get trialActive() { return Boolean(trial); },
    get captureComplete() { return Boolean(snapshot?.session?.manifest) && snapshot.session.expectedRecordingIds.every(id => snapshot.recordings.some(r => r.id === id)); },
    lockCapture(value) { el('manifest').disabled = value || busy || Boolean(snapshot?.recordings.length); el('slot').disabled = value || busy; },
    changed(recordingId, mode) { if (trial?.recordingId === recordingId && trial.mode === mode) el('complete').checked = false; },
    selectedEntry() {
      if (!snapshot?.session?.manifest) return null;
      const entry = snapshot.session.manifest.entries.find(e => e.id === el('slot').value);
      if (!entry) throw new Error('Все ответы манифеста уже сохранены');
      return { ...entry, recordingId: recordingIdFor(getSessionId(), entry.id) };
    },
    async confirmed(recordingId, mode, version) {
      if (!trial || trial.state !== 'active' || trial.recordingId !== recordingId || trial.mode !== mode) return;
      if (!el('complete').checked) { message('Проверьте дословную полноту, отметьте её и подтвердите текст снова. Таймер продолжает идти.'); return; }
      await repository.completeBenchmark(trial.id, version, true, now(), queue.timelineId); el('complete').checked = false;
      message('Замер завершён, полнота зафиксирована.'); await refresh();
    },
    async onSession() { if (getSessionId()) await repository.recoverBenchmarks(getSessionId(), now(), queue.timelineId); await refresh(); },
  };
}
