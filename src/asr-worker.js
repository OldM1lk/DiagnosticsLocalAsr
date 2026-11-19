import { env, pipeline } from '@huggingface/transformers';
import { CONFIG } from './config.js';
env.allowLocalModels = true; env.allowRemoteModels = false;
env.localModelPath = `${import.meta.env.BASE_URL}models/`; env.useBrowserCache = false;
env.backends.onnx.wasm.wasmPaths = `${import.meta.env.BASE_URL}runtime/`;
env.backends.onnx.wasm.numThreads = 1; env.backends.onnx.wasm.proxy = false;
const nativeFetch = globalThis.fetch.bind(globalThis);
globalThis.fetch = (input, options) => {
  const url = new URL(typeof input === 'string' ? input : input.url, location.href);
  if (url.origin !== location.origin || (options?.method ?? input?.method ?? 'GET').toUpperCase() !== 'GET') throw new Error('Внешний запрос исполнителя запрещён');
  return nativeFetch(input, options);
};
let pipe, busy = false;
self.onmessage = async ({ data }) => {
  if (busy) { self.postMessage({ ...identity(data), type: 'error', message: 'Исполнитель уже занят', unavailable: true }); return; }
  busy = true;
  try {
    if (data.type === 'init') {
      if (data.config.id !== CONFIG.id) throw new Error('Неизвестная конфигурация модели');
      pipe ??= await pipeline('automatic-speech-recognition', CONFIG.model, { revision: CONFIG.revision, device: CONFIG.device, dtype: CONFIG.dtype });
      self.postMessage({ ...identity(data), type: 'ready' });
    } else if (data.type === 'transcribe') {
      if (!pipe || data.configId !== CONFIG.id) throw new Error('Модель не готова или конфигурация не совпадает');
      const startedAt = performance.now();
      const output = await pipe(data.samples, CONFIG.generation);
      if (typeof output.text !== 'string') throw new Error('Модель не вернула текст');
      self.postMessage({ ...identity(data), type: 'result', rawText: output.text, inferenceMs: performance.now() - startedAt });
    }
  } catch (error) {
    // Decoding failures are handled before this Worker; a runtime failure requires explicit reinitialization.
    self.postMessage({ ...identity(data), type: 'error', message: error.message, unavailable: true });
  } finally { busy = false; }
};
function identity(data) { return Object.fromEntries(['requestId', 'sessionId', 'recordingId', 'attemptId', 'configId'].map(key => [key, data[key]])); }
