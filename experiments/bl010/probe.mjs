// Run from repository root with a subpath dist build and local, pre-downloaded weights.
import {chromium} from 'playwright';
import {createServer} from 'node:http';
import {createReadStream} from 'node:fs';
import {readFile, readdir, stat} from 'node:fs/promises';
import {join, extname} from 'node:path';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {cpus, totalmem, release} from 'node:os';
import {CONFIG} from '../../src/config.js';

const [modelDir, ...audio] = process.argv.slice(2);
if (!modelDir || !audio.length) throw new Error('Укажите папку весов и WAV-файлы по порядку либо --serve');
const interactive = audio.length === 1 && audio[0] === '--serve';
const base = '/DiagnosticsLocalAsr/', files = new Map();
async function exposeTree(dir, url) {
  for (const entry of await readdir(dir, {withFileTypes:true})) {
    if (entry.isDirectory()) await exposeTree(join(dir, entry.name), url + entry.name + '/');
    else if (entry.isFile()) files.set(url + entry.name, join(dir, entry.name));
  }
}
await exposeTree('dist', base);
await exposeTree('dist/runtime', '/runtime/');
for (const name of ['v3_ctc.int8.onnx','v3_vocab.txt']) files.set('/' + name, join(modelDir,name));
const hash = async file => createHash('sha256').update(await readFile(file)).digest('hex');
if (await hash(files.get('/v3_ctc.int8.onnx')) !== 'ceb61454e2e1a2dec5872cbac1de0fe0a4271d1148f6b26b5bda53ff30a12acd') throw new Error('SHA-256 модели не совпадает');
if (await hash(files.get('/v3_vocab.txt')) !== 'a9143c30844d3c0bee3e9e927e4084774eb1b9eeaafc473b2c4521e4911a7c07') throw new Error('SHA-256 словаря не совпадает');
files.set('/ort.mjs','node_modules/onnxruntime-web/dist/ort.wasm.min.mjs');
for (const name of ['giga-worker.js','gigaam.js']) files.set('/'+name,'experiments/bl010/'+name);
files.set('/audio.js','src/audio.js');
files.set('/config.js','src/config.js');
const whisperWorker = [...files.keys()].find(p=>p.includes('/assets/asr-worker-'));
if (!whisperWorker) throw new Error('Требуется сборка dist с APP_BASE_PATH=/DiagnosticsLocalAsr/');
const html = (await readFile('experiments/bl010/tablet.html','utf8')).replace('__WHISPER_WORKER__',whisperWorker);
const served = [];
const server = createServer(async (req,res) => {
  if (req.url === '/') return res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'}).end(interactive ? html : '<input type=file multiple>');
  const path = files.get(req.url);
  if (!path || req.method !== 'GET') return res.writeHead(404).end();
  const mime = {'.js':'text/javascript','.mjs':'text/javascript','.wasm':'application/wasm','.json':'application/json'};
  const info = await stat(path).catch(()=>null);
  if (!info?.isFile()) return res.writeHead(404).end();
  const {size} = info;
  served.push({url:req.url,bytes:size});
  res.writeHead(200,{'Content-Type':mime[extname(path)] ?? 'application/octet-stream','Content-Length':size,'Cache-Control':'public,max-age=3600'});
  createReadStream(path).pipe(res);
});
await new Promise(resolve=>server.listen(interactive ? Number(process.env.BL010_PORT ?? 5190) : 0,'127.0.0.1',resolve));
if (interactive) console.log('Проба BL-010: http://127.0.0.1:'+server.address().port+'/');
let browser;
if (!interactive) try {
  browser = await chromium.launch({channel:'chrome',headless:true});
  const cdp = await browser.newBrowserCDPSession();
  async function rendererBytes() {
    if (process.platform !== 'win32') return null;
    const {processInfo} = await cdp.send('SystemInfo.getProcessInfo');
    const ids = processInfo.filter(p=>p.type.toLowerCase()==='renderer').map(p=>Number(p.id));
    if (!ids.length) return null;
    return Number(execFileSync('powershell.exe',['-NoProfile','-Command',
      '(Get-Process -Id '+ids.join(',')+' -ErrorAction SilentlyContinue | Measure-Object WorkingSet64 -Sum).Sum'],{windowsHide:true}).toString().trim());
  }
  console.log(JSON.stringify({browser:browser.version(),cpu:cpus()[0].model,ramBytes:totalmem(),os:release(),
    audioHashes:await Promise.all(audio.map(hash)),whisper:CONFIG, gigaRevision:'e8e041ef8dda01e744be2de526e6dd382243443d'}));
  for (const model of ['GigaAM','Whisper']) {
    const context = await browser.newContext();
    const page = await context.newPage();
    for (const cache of ['new-context','reload']) {
      served.length = 0;
      await page.goto('http://127.0.0.1:'+server.address().port);
      await page.locator('input').setInputFiles(audio);
      const before = await rendererBytes();
      const workerUrl = model === 'GigaAM' ? '/giga-worker.js' : [...files.keys()].find(p=>p.includes('/assets/asr-worker-'));
      const initMs = await page.evaluate(async ({workerUrl,config})=>{
        const start = performance.now();
        const w = new Worker(workerUrl,{type:'module'});
        window.call = (data, transfer=[])=>new Promise((resolve,reject)=>{
          w.onerror = e=>reject(new Error(e.message));
          w.onmessage = ({data:r})=>r.type === 'error' ? reject(new Error(r.message)) : resolve(r);
          w.postMessage(data,transfer);
        });
        await window.call({type:'init',config});
        return performance.now()-start;
      },{workerUrl,config:CONFIG});
      const prepared = await rendererBytes();
      const result = await page.evaluate(async configId=>{
        const {decodeToMono16k} = await import('/audio.js');
        const rows = [], start = performance.now();
        for (const file of document.querySelector('input').files) {
          const t = performance.now();
          const {samples,durationMs} = await decodeToMono16k(file);
          const {rawText} = await window.call({type:'transcribe',configId,samples},[samples.buffer]);
          rows.push({file:file.name,durationMs,rawText,ms:performance.now()-t});
        }
        return {rows,drainMs:performance.now()-start};
      },CONFIG.id);
      console.log(JSON.stringify({model,cache,initMs,rendererWorkingSetBytes:[before,prepared,await rendererBytes()],...result,served}));
    }
    await context.close();
  }
} finally {
  await browser?.close();
  server.closeAllConnections();
  server.close();
}
