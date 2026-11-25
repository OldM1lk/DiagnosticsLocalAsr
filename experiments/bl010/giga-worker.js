import * as ort from './ort.mjs';
import {extract, decode} from './gigaam.js';
ort.env.wasm.numThreads = 1;
ort.env.wasm.wasmPaths = new URL('../runtime/', import.meta.url).href;
let session, vocab;
self.onmessage = async ({data}) => {
  try {
    if (data.type === 'init') {
      const response = await fetch(new URL('./v3_vocab.txt', import.meta.url));
      if (!response.ok) throw new Error('Словарь GigaAM недоступен: HTTP ' + response.status);
      vocab = [];
      for (const line of (await response.text()).trim().split(/\r?\n/)) {
        const [token, index] = line.split(' ');
        vocab[Number(index)] = token;
      }
      session = await ort.InferenceSession.create(new URL('./v3_ctc.int8.onnx', import.meta.url).href, {executionProviders: ['wasm']});
      self.postMessage({type: 'ready'});
    } else {
      const {features, frames} = extract(data.samples);
      const {log_probs} = await session.run({
        features: new ort.Tensor('float32', features, [1, 64, frames]),
        feature_lengths: new ort.Tensor('int64', BigInt64Array.of(BigInt(frames)), [1]),
      });
      self.postMessage({type: 'result', rawText: decode(log_probs, vocab)});
    }
  } catch (error) {
    self.postMessage({type: 'error', message: String(error.message ?? error)});
  }
};
