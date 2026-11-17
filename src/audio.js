/** URLs live only while their players are mounted; originals remain in IndexedDB. */
export function createAudioPlayer(blob, { label, onError = () => {} } = {}) {
  const audio = document.createElement('audio');
  const url = URL.createObjectURL(blob);
  audio.controls = true; audio.preload = 'metadata';
  audio.setAttribute('aria-label', label ?? 'Оригинал ответа'); audio.src = url;
  audio.addEventListener('error', () => onError('Оригинал сохранён, но браузер не смог его воспроизвести'));
  return { element: audio, dispose() { audio.pause(); audio.removeAttribute('src'); audio.load(); URL.revokeObjectURL(url); } };
}

export async function decodeToMono16k(blob) {
  const context = new OfflineAudioContext(1, 1, 16000);
  let decoded;
  try { decoded = await context.decodeAudioData(await blob.arrayBuffer()); }
  catch { throw new Error('Аудиоформат не декодируется; оригинал сохранён'); }
  if (!decoded.length) throw new Error('Нет аудиоданных для обработки');
  const samples = new Float32Array(decoded.length);
  for (let channel = 0; channel < decoded.numberOfChannels; channel++) {
    const data = decoded.getChannelData(channel);
    for (let i = 0; i < samples.length; i++) samples[i] += data[i] / decoded.numberOfChannels;
  }
  return { samples, durationMs: samples.length / 16 };
}
