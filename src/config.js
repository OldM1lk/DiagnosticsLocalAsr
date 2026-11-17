export const CONFIG = Object.freeze({
  id: 'whisper-tiny-ff417702-q8-wasm-1thread-ru-v1', transformers: '3.8.1',
  runtime: '1.22.0-dev.20250409-89f8206ba4',
  model: 'onnx-community/whisper-tiny', revision: 'ff4177021cc41f7db950912b73ea4fdf7d01d8e7',
  device: 'wasm', dtype: 'q8', numThreads: 1,
  generation: Object.freeze({ language: 'russian', task: 'transcribe', chunk_length_s: 30, stride_length_s: 5, do_sample: false }),
});
export const MODEL_FILES = ['config.json', 'generation_config.json', 'preprocessor_config.json', 'tokenizer_config.json', 'tokenizer.json',
  'onnx/encoder_model_quantized.onnx', 'onnx/decoder_model_merged_quantized.onnx'];
export const RUNTIME_FILES = ['ort-wasm-simd-threaded.mjs', 'ort-wasm-simd-threaded.wasm',
  'ort-wasm-simd-threaded.jsep.mjs', 'ort-wasm-simd-threaded.jsep.wasm'];
