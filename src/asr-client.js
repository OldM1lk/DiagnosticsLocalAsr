export function createRecognizer({ workerFactory = () => new Worker(new URL('./asr-worker.js', import.meta.url), { type: 'module' }) } = {}) {
  let worker, ready = false, readyConfigId, pending = null;
  function fail(message) {
    ready = false;
    const active = pending; pending = null;
    active?.reject(Object.assign(new Error(message), { unavailable: true }));
  }
  function ensureWorker() {
    if (worker) return;
    worker = workerFactory();
    const instance = worker;
    instance.addEventListener('message', ({ data }) => {
      if (worker !== instance) return;
      if (!pending || pending.input.requestId !== data.requestId) return;
      if (pending.input.type === 'transcribe' && ['sessionId', 'recordingId', 'attemptId', 'configId'].some(key => data[key] !== pending.input[key])) return;
      const active = pending;
      if (data.type === 'ready') { ready = true; pending = null; active.resolve(data); }
      else if (data.type === 'result') { pending = null; active.resolve({ rawText: data.rawText, inferenceMs: data.inferenceMs }); }
      else if (data.type === 'error') {
        pending = null; if (data.unavailable) ready = false;
        active.reject(Object.assign(new Error(data.message), { unavailable: Boolean(data.unavailable) }));
        if (data.unavailable) { instance.terminate(); worker = undefined; }
      }
    });
    instance.addEventListener('error', () => {
      if (worker !== instance) return;
      fail('Локальный исполнитель завершился с ошибкой'); instance.terminate(); worker = undefined;
    });
    instance.addEventListener('messageerror', () => {
      if (worker !== instance) return;
      fail('Локальный исполнитель вернул нечитаемое сообщение'); instance.terminate(); worker = undefined;
    });
  }
  function send(input, transfer = []) {
    if (pending) return Promise.reject(new Error('Исполнитель уже занят'));
    const message = { ...input, requestId: crypto.randomUUID() };
    return new Promise((resolve, reject) => {
      pending = { input: message, resolve, reject };
      try { worker.postMessage(message, transfer); } catch (error) { pending = null; reject(Object.assign(error, { unavailable: true })); ready = false; }
    });
  }
  return {
    async init(config) {
      if (ready && readyConfigId === config.id) return { cold: false };
      if (pending) throw new Error('Исполнитель уже занят');
      ready = false; ensureWorker(); await send({ type: 'init', config }); readyConfigId = config.id; return { cold: true };
    },
    async transcribe(input) {
      if (!ready) throw Object.assign(new Error('Исполнитель не готов'), { unavailable: true });
      return send({ ...input, type: 'transcribe' }, [input.samples.buffer]);
    },
    dispose() { fail('Локальный исполнитель остановлен'); worker?.terminate(); worker = undefined; },
  };
}
