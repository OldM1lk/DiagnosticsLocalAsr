// Reference DFT for the short feasibility samples. Input is mono PCM at 16 kHz.
const bins = 161, windowSize = 320, hop = 160, bands = 64;
const real = new Float32Array(bins * windowSize), imag = real.slice();
const filters = Array.from({length: bands}, () => []);
const edges = Array.from({length: bands + 2}, (_, i) => 700 * (Math.pow(1 + 8000 / 700, i / 65) - 1));
for (let k = 0; k < bins; k++) {
  for (let t = 0; t < windowSize; t++) {
    const angle = 2 * Math.PI * t / windowSize;
    const hann = (1 - Math.cos(angle)) / 2;
    real[k * windowSize + t] = hann * Math.cos(k * angle);
    imag[k * windowSize + t] = hann * Math.sin(k * angle);
  }
  const hz = 50 * k;
  for (let b = 0; b < bands; b++) {
    const [lo, mid, hi] = edges.slice(b, b + 3);
    const weight = Math.min((hz - lo) / (mid - lo), (hi - hz) / (hi - mid));
    if (weight > 0) filters[b].push([k, weight]);
  }
}
export function extract(samples) {
  const frames = 1 + Math.floor((samples.length - windowSize) / hop);
  if (frames < 1) throw new Error('Для одного кадра нужно 20 мс звука');
  const features = new Float32Array(bands * frames), power = new Float32Array(bins);
  for (let f = 0; f < frames; f++) {
    for (let k = 0; k < bins; k++) {
      let re = 0, im = 0;
      for (let t = 0; t < windowSize; t++) {
        const x = samples[f * hop + t], index = k * windowSize + t;
        re += x * real[index];
        im += x * imag[index];
      }
      power[k] = re * re + im * im;
    }
    for (let b = 0; b < bands; b++) {
      let sum = 0;
      for (const [k, weight] of filters[b]) sum += power[k] * weight;
      features[b * frames + f] = Math.log(Math.max(1e-9, Math.min(1e9, sum)));
    }
  }
  return {features, frames};
}
export function decode({data, dims}, vocab) {
  const [batch, steps, classes] = dims;
  if (batch !== 1 || classes !== vocab.length) throw new Error('Неверная форма выхода CTC');
  let previous = -1, text = '';
  for (let t = 0; t < steps; t++) {
    const start = t * classes;
    let best = 0;
    for (let i = 1; i < classes; i++) if (data[start + i] > data[start + best]) best = i;
    if (best !== previous && vocab[best] !== '<blk>') text += vocab[best];
    previous = best;
  }
  return text.replaceAll('▁', ' ').trim();
}
