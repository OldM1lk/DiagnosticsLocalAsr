import { mkdir, readFile, writeFile, rename, access } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { CONFIG, MODEL_FILES, RUNTIME_FILES } from '../src/config.js';
import { verifyResources } from '../src/resources.js';
const root = fileURLToPath(new URL('../', import.meta.url));
const publicDir = path.join(root, 'public');
let exists = false; try { await access(publicDir); exists = true; } catch {}
if (exists) {
  const manifest = JSON.parse(await readFile(path.join(publicDir, 'resource-manifest.json'), 'utf8'));
  await verifyResources(manifest, async name => { const b = await readFile(path.join(publicDir, name.slice(1))); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); });
  console.log('Existing resource bundle verified; no download needed.');
} else {
  const stage = path.join(root, `.resources-staging-${crypto.randomUUID()}`);
  const runtime = JSON.parse(await readFile(path.join(root, 'node_modules/onnxruntime-web/package.json'), 'utf8')).version;
  const manifest = { configId: CONFIG.id, revision: CONFIG.revision, transformers: CONFIG.transformers, runtime, downloadMs: 0, files: [] };
  async function record(name, data) {
    const destination = path.join(stage, name.slice(1)); await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, data);
    const sha256 = [...new Uint8Array(await crypto.subtle.digest('SHA-256', data))].map(x => x.toString(16).padStart(2, '0')).join('');
    manifest.files.push({ path: name, bytes: data.byteLength, sha256 }); console.log(`${name}: ${data.byteLength} bytes`);
  }
  for (const name of MODEL_FILES) {
    const startedAt = performance.now();
    const response = await fetch(`https://huggingface.co/${CONFIG.model}/resolve/${CONFIG.revision}/${name}`, { signal: AbortSignal.timeout(180000) });
    if (!response.ok) throw new Error(`Download failed ${response.status}: ${name}; unpublished stage preserved at ${stage}`);
    const bytes = new Uint8Array(await response.arrayBuffer()); manifest.downloadMs += performance.now() - startedAt;
    await record(`/models/${CONFIG.model}/${name}`, bytes);
  }
  for (const name of RUNTIME_FILES) await record(`/runtime/${name}`, await readFile(path.join(root, 'node_modules/onnxruntime-web/dist', name)));
  await verifyResources(manifest, async name => { const b = await readFile(path.join(stage, name.slice(1))); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); });
  await writeFile(path.join(stage, 'resource-manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  // Entire public directory is published only after all bytes and hashes were verified.
  await rename(stage, publicDir);
  console.log(`Published ${manifest.files.length} resources; runtime ${runtime}`);
}
