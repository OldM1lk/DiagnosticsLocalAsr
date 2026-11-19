import { CONFIG, MODEL_FILES, RUNTIME_FILES } from './config.js';
export function validateManifest(manifest) {
  if (manifest?.configId !== CONFIG.id || manifest.revision !== CONFIG.revision || manifest.transformers !== CONFIG.transformers || manifest.runtime !== CONFIG.runtime || !Array.isArray(manifest.files)) throw new Error('Неверный манифест ресурсов');
  const expected = [...MODEL_FILES.map(f => `/models/${CONFIG.model}/${f}`), ...RUNTIME_FILES.map(f => `/runtime/${f}`)];
  if (manifest.files.length !== expected.length || new Set(manifest.files.map(f => f.path)).size !== expected.length ||
      manifest.files.some(f => !expected.includes(f.path) || !Number.isSafeInteger(f.bytes) || f.bytes <= 0 || !/^[a-f0-9]{64}$/.test(f.sha256))) throw new Error('Неполный или небезопасный комплект ресурсов');
  return manifest;
}
export async function verifyResources(manifest, read) {
  validateManifest(manifest);
  for (const file of manifest.files) {
    const buffer = await read(file.path);
    const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', buffer))].map(x => x.toString(16).padStart(2, '0')).join('');
    if (buffer.byteLength !== file.bytes || hash !== file.sha256) throw new Error(`Повреждён ресурс: ${file.path}`);
  }
  return manifest;
}
async function readLocal(path) {
  if (!path.startsWith('/') || path.startsWith('//')) throw new Error('Запрещён внешний ресурс');
  const response = await fetch(`${import.meta.env.BASE_URL}${path.slice(1)}`, { credentials: 'omit', cache: 'no-store' });
  if (!response.ok) throw new Error(`Ресурс недоступен (${response.status}): ${path}`);
  return response;
}
export async function prepareLocalResources() {
  const manifest = await (await readLocal('/resource-manifest.json')).json();
  return verifyResources(manifest, async path => (await readLocal(path)).arrayBuffer());
}
