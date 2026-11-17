import { openRepository, storageStatus } from './storage.js';
import { createRecorder } from './recorder.js';
import { createAudioPlayer, decodeToMono16k } from './audio.js';
import { createQueue } from './queue.js';
import { CONFIG } from './config.js';
import { createRecognizer } from './asr-client.js';
import { prepareLocalResources } from './resources.js';
import { createReviewPanel } from './review.js';
import { createMeasurements } from './measurements.js';
import './styles.css';

document.querySelector('#app').innerHTML = `
  <header class="page-header">
    <div><p class="eyebrow">Экспериментальный стенд</p><h1>Локальное распознавание</h1>
    <p class="muted">Только тестовые данные. Расшифровку проверяет специалист.</p></div>
    <span class="local-tag">Аудио на устройстве</span>
  </header>
  <section class="model-bar" aria-label="Модель распознавания">
    <div><strong>Whisper tiny</strong><span class="muted"> · Русский · WASM q8</span>
    <p id="model-status">Модель не подготовлена.</p>
    <p id="queue-status">Исполнитель недоступен; оригиналы сохраняются, очередь ожидает.</p></div>
    <button id="prepare">Подготовить модель</button>
  </section>
  <section class="workspace" aria-labelledby="capture-title">
  <div class="section-heading"><h2 id="capture-title">Запись ответа</h2></div>
  <div class="session-row"><label>Тестовая сессия <select id="sessions"><option value="">Выберите сессию</option></select></label>
  <button id="create">Новая тестовая сессия</button>
  <button id="end" disabled>Закончить серию</button></div>
  <label class="presentation">Предъявление <input id="presentation" value="Технический ответ"></label>
  <p class="muted">Объясните задание до записи. Тишина не завершает ответ.</p>
  <div class="capture-actions"><button id="start" class="primary" disabled>Начать ответ</button><button id="stop" disabled>Завершить ответ</button></div>
  <details class="import-panel"><summary>Загрузить аудиофайл</summary><div class="details-body">
  <label>Тестовый аудиофайл <input id="file" type="file" accept="audio/*"></label>
  <div class="actions">
  <button id="save" disabled>Сохранить файл</button>
  <button id="discard" disabled>Снять несохранённый импорт</button></div></div></details>
  <div id="pending"></div>
  <p role="status" aria-live="polite"></p></section>
  <section class="results" aria-labelledby="results-title">
    <div class="section-heading"><h2 id="results-title">Ответы</h2>
    <label>Режим проверки <select id="review-mode"><option value="asr">С расшифровкой</option><option value="manual">Ручной ввод без подсказки</option></select></label></div>
    <ul id="recordings"></ul>
    <p id="empty-recordings" class="empty-state">Здесь появятся сохранённые ответы и текст для проверки.</p>
  </section>
  <details class="utility-panel"><summary>Настройки и хранение</summary><div class="details-body">
    <label>Технический лимит, секунды <input id="limit" type="number" min="0.1" step="0.1" placeholder="Без лимита"></label>
    <p class="muted">Только техническая проба; лимиты методики здесь не задаются автоматически.</p>
    <p id="storage"></p><div class="actions"><button id="persist">Запросить постоянное хранение</button>
    <button id="delete" class="danger" disabled>Удалить тестовую сессию</button></div>
  </div></details>
  <details class="utility-panel" id="measurements"><summary>Серия и измерения</summary><section class="details-body" id="measurement-host"></section></details>`;
const measurementHost = document.getElementById('measurement-host');

const el = id => document.getElementById(id);
const message = text => { document.querySelector('[role=status]').textContent = text; };
el('review-mode').value = new URL(location.href).searchParams.get('review') === 'manual' ? 'manual' : 'asr';
const recordViews = new Map();
let repo, queue, measurements, pending, recordingActive = false, players = [], pendingPlayer, renderVersion = 0;
const recorder = createRecorder();
const localRecognizer = createRecognizer();
let preparing = false;
let recognizer = { async transcribe(input) {
  if (input.configId !== CONFIG.id) throw new Error('Конфигурация записи не совпадает с моделью');
  const startedAt = performance.now();
  const { samples, durationMs } = await decodeToMono16k(input.blob);
  const decodeMs = performance.now() - startedAt;
  const output = await localRecognizer.transcribe({ ...input, blob: undefined, samples });
  return { ...output, decodeMs, audioDurationMs: durationMs };
} };
const configId = import.meta.env.MODE === 'test' ? 'test-fifo-v1' : CONFIG.id;
if (import.meta.env.MODE === 'test') {
  const { createTestRecognizer } = await import('./test-recognizer.js');
  recognizer = createTestRecognizer();
  el('prepare').hidden = true;
  const note = document.createElement('p');
  note.textContent = 'Тестовый исполнитель — не измерение ASR';
  const abort = document.createElement('button');
  abort.textContent = 'Ошибка следующего сохранения';
  abort.onclick = () => repo?.testing.abortNextSave();
  document.querySelector('#app').append(note, abort);
  for (const [label, action] of [
    ['Включить тестовый исполнитель', () => queue?.setAvailable(true)],
    ['Задержать следующую обработку', () => recognizer.holdNext()],
    ['Продолжить обработку', () => recognizer.release()],
    ['Ошибка следующего файла', () => recognizer.failNext()],
    ['Отказ исполнителя', () => recognizer.unavailableNext()],
    ['Восстановить исполнитель', () => run(async () => { await queue.start(el('sessions').value); queue.setAvailable(true); })],
  ]) {
    const button = document.createElement('button'); button.textContent = label; button.onclick = action;
    document.querySelector('#app').append(button);
  }
}
const controls = ['create', 'delete', 'sessions', 'file', 'save', 'persist', 'start', 'stop', 'presentation', 'limit', 'end', 'discard'];
let busy = false;
function updateControls() {
  controls.forEach(id => { el(id).disabled = busy || !repo; });
  for (const id of ['create', 'delete', 'sessions', 'file', 'start', 'presentation', 'limit', 'end']) {
    el(id).disabled ||= recordingActive || Boolean(pending);
  }
  el('stop').disabled = busy || !recordingActive || recorder.state !== 'recording';
  el('start').disabled ||= !el('sessions').value;
  el('file').disabled ||= !el('sessions').value;
  el('delete').disabled ||= !el('sessions').value;
  el('end').disabled ||= !el('sessions').value;
  el('save').disabled ||= recordingActive || !el('sessions').value || !pending;
  el('discard').disabled ||= !pending?.imported;
  for (const id of ['file', 'start', 'save', 'end', 'discard']) el(id).disabled ||= measurements?.busy;
  for (const id of ['file', 'start']) el(id).disabled ||= measurements?.captureComplete;
  for (const id of ['create', 'delete', 'sessions', 'review-mode']) el(id).disabled ||= measurements?.busy || measurements?.trialActive;
  measurements?.lockCapture(Boolean(busy || recordingActive || pending));
  recordViews.forEach(view => view.review.setBlocked(Boolean(measurements?.busy)));
}
async function run(action) {
  busy = true; updateControls();
  try { await action(); } catch (e) { message(`Ошибка: ${e.message}${pending ? '. Оригинал остаётся для повторного сохранения в этой странице.' : ''}`); }
  finally { busy = false; updateControls(); }
}
async function refreshSessions(selected = el('sessions').value) {
  el('sessions').replaceChildren(new Option('Выберите сессию', ''));
  for (const session of await repo.listSessions()) el('sessions').add(new Option(session.id, session.id));
  el('sessions').value = selected;
  const url = new URL(location.href); url.hash = selected ? encodeURIComponent(selected) : '';
  history.replaceState(null, '', url);
  if (selected) await queue.start(selected); else await queue.stop();
  if (measurements) await measurements.onSession();
  await renderRecords();
}
async function renderRecords() {
  const sessionId = el('sessions').value;
  const mode = el('review-mode').value;
  const version = ++renderVersion;
  const jobs = sessionId ? await repo.listJobs(sessionId) : [];
  const records = sessionId ? await repo.listRecordings(sessionId) : [];
  const attempts = sessionId ? await repo.listAttempts(sessionId) : [];
  if (version !== renderVersion || sessionId !== el('sessions').value || mode !== el('review-mode').value) return;
  el('empty-recordings').hidden = records.length > 0;
  for (const [id, view] of recordViews) {
    if (!records.some(record => record.id === id)) {
      view.item.remove(); view.player.element.pause();
      // Other sessions keep in-memory drafts, including failed writes, until the page closes.
      if (view.sessionId === sessionId) { view.player.dispose(); view.review.dispose(); recordViews.delete(id); }
    }
  }
  players = [...recordViews.values()].map(view => view.player);
  if (!sessionId) return;
  for (const record of records) {
    if (version !== renderVersion) return;
    let view = recordViews.get(record.id);
    if (!view) {
      const item = document.createElement('li'), summary = document.createElement('span'), retry = document.createElement('button'), error = document.createElement('p');
      const review = createReviewPanel({ repository: repo, recording: record,
        onConfirmed: review => measurements?.confirmed(record.id, review.mode, review.textVersion),
        onTextChanged: mode => measurements?.changed(record.id, mode),
        onSourceExposed: () => repo.recordEvent({ id: JSON.stringify(['source-exposed', record.id]), sessionId: record.sessionId,
          recordingId: record.id, type: 'source-exposed', at: performance.now(), timelineId: queue.timelineId }) });
      const player = createAudioPlayer(record.blob, { label: `Оригинал: ${record.presentationId}`, onError: text => { error.textContent = text; review.setPlayable(false); } });
      player.element.addEventListener('loadedmetadata', () => review.setPlayable(true));
      player.element.addEventListener('play', () => measurements?.audioPlayed(record.id));
      retry.textContent = 'Повторить обработку';
      item.append(summary, retry, player.element, error, review.element);
      view = { item, summary, retry, player, review, sessionId: record.sessionId, recordingId: record.id }; recordViews.set(record.id, view); players.push(player);
      el('recordings').append(item);
    }
    if (!view.item.isConnected) el('recordings').append(view.item);
    const job = jobs.find(j => j.recordingId === record.id);
    const states = { pending: 'В очереди', running: 'Обрабатывается', done: 'Готово', error: 'Ошибка обработки' };
    view.summary.textContent = `${record.presentationId}: ${record.bytes} байт; ${job ? states[job.state] : 'Нет задания'}`
      + (job?.lastError ? `: ${job.lastError.message}` : '') + (record.completeness === 'partial' ? ' — Неполная запись' : '')
      + (record.manifestHashMatches === false ? ' — SHA-256 не соответствует манифесту; оригинал сохранён, сравнение исключено' : '');
    if (import.meta.env.MODE === 'test' && job?.state === 'done') view.summary.append(' — тестовый результат, не ASR');
    view.retry.hidden = !job || !['done', 'error'].includes(job.state);
    view.retry.onclick = () => run(async () => { await repo.retryJob(job.id); await repo.markEnqueued({ jobId: job.id, at: performance.now(), timelineId: queue.timelineId }); queue.wake(); await renderRecords(); });
    await view.review.update({ mode, attempts });
  }
  if (measurements) await measurements.refresh();
}
function showPending() {
  pendingPlayer?.dispose(); pendingPlayer = null;
  el('pending').replaceChildren();
  if (!pending) return;
  document.querySelector('.import-panel').open = true;
  const error = document.createElement('p');
  pendingPlayer = createAudioPlayer(pending.blob, { label: 'Оригинал до сохранения', onError: text => { error.textContent = text.replace('сохранён', 'удерживается в памяти'); } });
  el('pending').append(pendingPlayer.element, error);
}
async function savePending() {
  const completeness = pending.recording.completeness;
  message('Сохранение…');
  const startedAt = performance.now();
  const saved = await repo.saveRecording({ ...pending, configId });
  await repo.markEnqueued({ jobId: saved.jobId, at: performance.now(), timelineId: queue.timelineId, audioSaveMs: performance.now() - startedAt })
    .catch(error => { measurementHost.querySelector('[data-m="message"]').textContent = `Оригинал сохранён, но время сохранения не измерено: ${error.message}`; });
  queue.wake();
  pending = null; el('file').value = ''; showPending();
  await renderRecords(); await showStorage();
  message(completeness === 'partial' ? 'Сохранена неполная запись. Проверьте доступную часть оригинала.' : 'Сохранено');
}
async function showStorage(requestPersistence = false) {
  const s = await storageStatus(navigator.storage, { requestPersistence });
  el('storage').textContent = `Постоянное хранение: ${s.persisted === true ? 'разрешено' : s.persisted === false ? 'не подтверждено' : 'неизвестно'}. ` +
    `Занято: ${s.usage ?? 'неизвестно'} байт; квота: ${s.quota ?? 'неизвестно'} байт. ` +
    (s.persisted !== true ? 'Долговременная сохранность не доказана. ' : '') + (s.error ?? '');
}
el('create').onclick = () => run(async () => {
  pending = null; el('file').value = '';
  const session = await repo.createSession({ timelineId: queue.timelineId }); await refreshSessions(session.id); message('Тестовая сессия создана');
});
el('sessions').onchange = () => run(async () => {
  pending = null; el('file').value = ''; await refreshSessions(); message('');
});
el('file').onchange = () => {
  const blob = el('file').files[0];
  if (blob?.size === 0) {
    pending = null; el('file').value = ''; showPending();
    message('Технически незафиксировано: файл пустой, полезного аудио нет.'); updateControls(); return;
  }
  let entry;
  try { entry = measurements?.selectedEntry(); } catch (error) { message(error.message); el('file').value = ''; return; }
  pending = blob ? { blob, imported: true, recording: { id: entry?.recordingId ?? crypto.randomUUID(), sessionId: el('sessions').value,
    taskType: entry?.taskType ?? 'technical-import', presentationId: entry?.presentationId ?? blob.name, provenance: entry?.provenance ?? 'technical-unverified', completeness: 'complete', durationMs: entry?.durationMs ?? null } } : null;
  showPending(); message(''); updateControls();
};
el('save').onclick = () => run(savePending);
el('discard').onclick = () => { if (!pending?.imported) return; pending = null; el('file').value = ''; showPending(); message('Импорт снят. Исходный файл на устройстве не изменён.'); updateControls(); };
el('start').onclick = () => run(async () => {
  const entry = measurements?.selectedEntry();
  const limitMs = el('limit').value === '' ? undefined : Number(el('limit').value) * 1000;
  const recording = { id: entry?.recordingId ?? crypto.randomUUID(), sessionId: el('sessions').value,
    taskType: entry?.taskType ?? 'technical-microphone', presentationId: entry?.presentationId ?? (el('presentation').value.trim() || 'Технический ответ'), provenance: entry?.provenance ?? 'technical-unverified' };
  message('Запрашивается микрофон…');
  const { finished } = await recorder.start({ limitMs });
  recordingActive = true; message('Идёт запись. Завершите ответ кнопкой или дождитесь заданного технического лимита.');
  void finished.then(result => run(async () => {
    recordingActive = false;
    if (result.completeness === 'lost') {
      message('Технически незафиксировано: полезного аудио нет.'); return;
    }
    pending = { blob: result.blob, recording: { ...recording, durationMs: result.durationMs,
      completeness: result.completeness, captureError: result.error?.message ?? null } };
    showPending(); await savePending();
  }));
});
el('stop').onclick = () => {
  el('stop').disabled = true;
  message('Завершение записи…');
  void recorder.stop().catch(error => message(`Ошибка: ${error.message}`));
};
el('delete').onclick = () => run(async () => {
  await queue.stop();
  const deletedId = el('sessions').value;
  await repo.deleteSession(deletedId); pending = null; el('file').value = '';
  for (const [id, view] of recordViews) {
    if (view.sessionId === deletedId) { view.player.dispose(); view.review.dispose(); view.item.remove(); recordViews.delete(id); }
  }
  await refreshSessions(''); message('Тестовая сессия удалена');
});
el('persist').onclick = () => run(() => showStorage(true));
el('review-mode').onchange = () => {
  recordViews.forEach(view => view.review.suspend());
  const url = new URL(location.href); url.searchParams.set('review', el('review-mode').value); history.replaceState(null, '', url);
  void renderRecords().catch(error => message(`Ошибка проверки: ${error.message}`));
};
el('prepare').onclick = async () => {
  if (preparing || !repo) return;
  preparing = true; el('prepare').disabled = true;
  const wasAvailable = queue.available;
  queue.setAvailable(false, 'initializing');
  const startedAt = performance.now();
  el('model-status').textContent = 'Проверка файлов и подготовка модели… Запись ответов остаётся доступной.';
  try {
    const verified = await prepareLocalResources();
    const verifiedAt = performance.now();
    const initialization = await localRecognizer.init(CONFIG);
    if (el('sessions').value) await repo.recordEvent({ type: 'model-preparation', sessionId: el('sessions').value,
      filesMs: verifiedAt - startedAt, initMs: performance.now() - verifiedAt, coldInit: initialization.cold,
      downloadMs: verified.downloadMs ?? null, bytes: verified.files.reduce((sum, f) => sum + f.bytes, 0), runtime: verified.runtime, resources: verified.files });
    // Only historical placeholders from T-01–T-03 are assigned the explicitly selected model.
    for (const session of await repo.listSessions()) await repo.configurePendingJobs(session.id, CONFIG.id);
    if (!wasAvailable && el('sessions').value) await queue.start(el('sessions').value);
    el('model-status').textContent = `Модель готова. Файлы: ${(verifiedAt - startedAt).toFixed(0)} мс; инициализация: ${(performance.now() - verifiedAt).toFixed(0)} мс; runtime ${verified.runtime}.`;
    queue.setAvailable(true);
  } catch (error) { queue.setAvailable(false, 'preparation-failed'); el('model-status').textContent = `Ошибка подготовки: ${error.message}. Оригиналы сохраняются, очередь ожидает.`; }
  finally { preparing = false; el('prepare').disabled = false; }
};
el('end').onclick = () => run(async () => {
  await repo.endSession(el('sessions').value, performance.now(), queue.timelineId); message('Серия закончена. Очередь продолжает работу.');
});
window.addEventListener('pagehide', () => {
  recorder.dispose(); players.forEach(player => player.dispose()); pendingPlayer?.dispose();
  recordViews.forEach(view => view.review.dispose());
  void queue?.stop().catch(() => {});
  localRecognizer.dispose();
  measurements?.dispose();
});
updateControls();
await run(async () => {
  repo = await openRepository();
  queue = createQueue({ repository: repo, recognizer,
    onChange: () => {
      el('queue-status').textContent = queue.available ? 'Исполнитель доступен' : 'Исполнитель недоступен; очередь ожидает восстановления.';
      void renderRecords().catch(error => message(`Ошибка очереди: ${error.message}`));
    }, onError: error => message(`Ошибка очереди: ${error.message}`) });
  measurements = createMeasurements({ repository: repo, host: measurementHost, queue,
    getSessionId: () => el('sessions').value, getViews: () => recordViews, renderRecords,
    selectMode: async mode => { el('review-mode').value = mode; el('review-mode').onchange(); }, onBusyChange: updateControls });
  const sessions = await repo.listSessions();
  const selected = decodeURIComponent(location.hash.slice(1));
  await refreshSessions(sessions.some(s => s.id === selected) ? selected : sessions[0]?.id ?? ''); await showStorage();
});
