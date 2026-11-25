import {createHash} from 'node:crypto';
import {copyFile, mkdir, readdir, readFile, writeFile} from 'node:fs/promises';
import {basename, join} from 'node:path';
import {Readable} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import {createWriteStream} from 'node:fs';

const target = 'dist/bl010';
await mkdir(target, {recursive: true});
for (const source of [
  'experiments/bl010/gigaam.js', 'experiments/bl010/giga-worker.js',
  'src/audio.js', 'src/config.js',
]) await copyFile(source, join(target, basename(source)));
await copyFile('node_modules/onnxruntime-web/dist/ort.wasm.min.mjs', join(target, 'ort.mjs'));

const origin = 'https://huggingface.co/istupakov/gigaam-v3-onnx/resolve/e8e041ef8dda01e744be2de526e6dd382243443d';
for (const [name, expected] of [
  ['v3_ctc.int8.onnx', 'ceb61454e2e1a2dec5872cbac1de0fe0a4271d1148f6b26b5bda53ff30a12acd'],
  ['v3_vocab.txt', 'a9143c30844d3c0bee3e9e927e4084774eb1b9eeaafc473b2c4521e4911a7c07'],
  ['LICENSE.txt', null],
]) {
  const file = join(target, name);
  if (process.env.BL010_WEIGHTS_DIR) {
    await copyFile(join(process.env.BL010_WEIGHTS_DIR, name), file);
  } else {
    const response = await fetch(origin + '/' + name, {signal: AbortSignal.timeout(300_000)});
    if (!response.ok) throw new Error(name + ': HTTP ' + response.status);
    await pipeline(Readable.fromWeb(response.body), createWriteStream(file));
  }
  if (expected && createHash('sha256').update(await readFile(file)).digest('hex') !== expected) {
    throw new Error('Неверный SHA-256: ' + name);
  }
}
const workers = (await readdir('dist/assets')).filter(name => /^asr-worker-.*\.js$/.test(name));
if (workers.length !== 1) throw new Error('Ожидался один собранный worker Whisper');
const html = await readFile('experiments/bl010/tablet.html', 'utf8');
await writeFile(join(target, 'index.html'), html.replace('__WHISPER_WORKER__', '../assets/' + workers[0]));
