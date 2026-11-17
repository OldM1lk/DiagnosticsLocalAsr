const formats = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4'];
const defaultClock = { now: () => performance.now(), setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: id => clearTimeout(id) };

/** No silence detection. The caller supplies limits; no clinical timing is inferred. */
export function createRecorder({ mediaDevices = globalThis.navigator?.mediaDevices,
  MediaRecorderClass = globalThis.MediaRecorder, clock = defaultClock } = {}) {
  let state = 'idle', current, generation = 0;
  function cleanup(run) {
    if (run.timer !== undefined) clock.clearTimeout(run.timer);
    for (const track of run.stream?.getTracks() ?? []) {
      track.removeEventListener('ended', run.onEnded);
      track.stop();
    }
  }
  function stop() {
    const run = current;
    if (!run) return Promise.reject(new Error('Запись ещё не начата'));
    if (state === 'recording') {
      state = 'stopping';
      if (run.timer !== undefined) clock.clearTimeout(run.timer);
      // Inactive can mean the recorder is already delivering error/data/stop events.
      if (run.recorder.state !== 'inactive') {
        try { run.recorder.stop(); } catch (error) {
          run.error ??= error;
          run.finish();
        }
      }
    }
    return run.finished;
  }
  return {
    get state() { return state; },
    async start({ limitMs } = {}) {
      if (state !== 'idle') throw new Error('Запись уже запущена или запрашивается');
      if (limitMs != null && (!Number.isFinite(limitMs) || limitMs <= 0 || limitMs > 2147483647)) throw new Error('Некорректный лимит записи');
      if (!mediaDevices?.getUserMedia || !MediaRecorderClass?.isTypeSupported) throw new Error('Запись с микрофона недоступна в этом браузере');
      const mimeType = formats.find(type => MediaRecorderClass.isTypeSupported(type));
      if (!mimeType) throw new Error('Не поддерживается ни один формат записи');
      state = 'requesting';
      const token = ++generation;
      const run = { chunks: [], error: null };
      try {
        run.stream = await mediaDevices.getUserMedia({ audio: true });
        if (token !== generation) throw new Error('Запуск записи отменён');
        run.recorder = new MediaRecorderClass(run.stream, { mimeType });
        run.finished = new Promise(resolve => { run.resolve = resolve; });
        run.finish = () => {
          if (run.done) return;
          run.done = true;
          const blob = new Blob(run.chunks, { type: run.chunks[0]?.type || run.recorder.mimeType || mimeType });
          const result = { blob, durationMs: Math.max(0, clock.now() - run.startedAt),
            completeness: blob.size ? (run.error ? 'partial' : 'complete') : 'lost', error: run.error };
          cleanup(run); state = 'idle'; run.resolve(result);
        };
        run.recorder.addEventListener('dataavailable', event => { if (!run.done && event.data?.size) run.chunks.push(event.data); });
        run.recorder.addEventListener('error', event => {
          if (run.done || current !== run) return;
          run.error ??= event.error ?? new Error('Сбой записи'); void stop();
        });
        run.recorder.addEventListener('stop', run.finish);
        run.onEnded = () => {
          if (run.done || current !== run) return;
          run.error ??= new Error('Поток микрофона прерван'); void stop();
        };
        for (const track of run.stream.getAudioTracks()) track.addEventListener('ended', run.onEnded);
        current = run;
        run.startedAt = clock.now();
        run.recorder.start(1000);
        state = 'recording';
        if (limitMs != null) run.timer = clock.setTimeout(() => { void stop(); }, limitMs);
        return { finished: run.finished };
      } catch (error) {
        cleanup(run); current = undefined; state = 'idle';
        if (error.name === 'NotAllowedError') {
          const localized = new Error('Доступ к микрофону запрещён браузером или системой. Разрешите доступ к микрофону в настройках сайта и устройства и попробуйте снова.', { cause: error });
          localized.name = error.name;
          throw localized;
        }
        throw error;
      }
    },
    stop,
    dispose() {
      generation++;
      if (state === 'recording') { current.error ??= new Error('Страница закрывается'); void stop(); }
      if (current?.stream) cleanup(current);
    },
  };
}
