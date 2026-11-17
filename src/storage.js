import { DATABASE_NAME, STORES } from './contracts.js';
import { reviseText, confirmText } from './review.js';
import { validateManifest, recordingIdFor } from './manifest.js';
import { makePlan, transitionTrial } from './benchmark.js';

const request = req => new Promise((resolve, reject) => {
  req.onsuccess = () => resolve(req.result);
  req.onerror = () => reject(req.error);
});

/** Resolves only after commit, never on the success of an individual request. */
async function transaction(db, names, mode, action) {
  const tx = db.transaction(names, mode);
  const completed = new Promise((resolve, reject) => {
    tx.oncomplete = resolve;
    tx.onabort = () => reject(tx.error ?? new DOMException('Транзакция отменена', 'AbortError'));
    tx.onerror = () => {}; // abort supplies the transaction error
  });
  try {
    const result = await action(tx);
    await completed;
    return result;
  } catch (error) {
    try { tx.abort(); } catch { /* already aborted/completed */ }
    await completed.catch(() => {});
    throw error;
  }
}

function required(value, name) {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError(`Не задано: ${name}`);
}

export async function openRepository({ dbName = DATABASE_NAME } = {}) {
  const db = await new Promise((resolve, reject) => {
    const open = indexedDB.open(dbName, 1);
    open.onupgradeneeded = () => {
      for (const name of STORES) {
        const store = open.result.createObjectStore(name, { keyPath: 'id' });
        if (name !== 'sessions') store.createIndex('sessionId', 'sessionId');
        if (name === 'jobs') store.createIndex('recordingConfig', ['recordingId', 'configId'], { unique: true });
      }
    };
    open.onsuccess = () => resolve(open.result);
    open.onerror = () => reject(open.error);
    open.onblocked = () => reject(new Error('Закройте другие вкладки стенда для открытия базы'));
  });
  db.onversionchange = () => db.close();
  let abortNextSave = false;
  async function finishAttempt({ jobId, attemptId, rawText, error, timing }, state) {
    return transaction(db, ['sessions', 'jobs', 'attempts'], 'readwrite', async tx => {
      const jobs = tx.objectStore('jobs'), attempts = tx.objectStore('attempts');
      const job = await request(jobs.get(jobId));
      if (!job || job.state !== 'running' || job.activeAttemptId !== attemptId ||
          !await request(tx.objectStore('sessions').get(job.sessionId))) return false;
      const attempt = await request(attempts.get(attemptId));
      if (!attempt || attempt.state !== 'running' || attempt.jobId !== jobId) return false;
      attempt.state = state; attempt.timing = timing ?? null;
      if (state === 'done') {
        if (typeof rawText !== 'string') throw new TypeError('Исполнитель не вернул текст');
        attempt.rawText = rawText;
      }
      attempt.error = error ? { message: error.message ?? String(error), name: error.name ?? 'Error' } : null;
      job.state = state === 'unavailable' ? 'pending' : state;
      job.activeAttemptId = null; job.lastAttemptId = attemptId; job.lastError = attempt.error;
      await request(attempts.put(attempt)); await request(jobs.put(job));
      return true;
    });
  }
  const repo = {
    dbName,
    close: () => db.close(),
    async createSession(input = {}) {
      const session = { id: input.id ?? crypto.randomUUID(), expectedRecordingIds: input.expectedRecordingIds ?? [],
        timelineId: input.timelineId ?? crypto.randomUUID(), endedAt: null, nextEnqueueSeq: 1 };
      required(session.id, 'sessionId');
      await transaction(db, ['sessions'], 'readwrite', tx => request(tx.objectStore('sessions').add(session)));
      return session;
    },
    listSessions: () => transaction(db, ['sessions'], 'readonly', tx => request(tx.objectStore('sessions').getAll())),
    async snapshot(sessionId) {
      return transaction(db, STORES, 'readonly', async tx => {
        const session = await request(tx.objectStore('sessions').get(sessionId));
        const result = { session };
        for (const name of STORES.filter(n => n !== 'sessions')) result[name] = await request(tx.objectStore(name).index('sessionId').getAll(sessionId));
        return result;
      });
    },
    async recordEvent(input) {
      return transaction(db, ['sessions', 'events'], 'readwrite', async tx => {
        if (!await request(tx.objectStore('sessions').get(input.sessionId))) return false;
        await request(tx.objectStore('events').put({ ...input, id: input.id ?? crypto.randomUUID() })); return true;
      });
    },
    async saveManifest(sessionId, input) {
      const manifest = validateManifest(input);
      return transaction(db, ['sessions', 'recordings'], 'readwrite', async tx => {
        const sessions = tx.objectStore('sessions'), session = await request(sessions.get(sessionId));
        if (!session) throw new Error('Сессия удалена');
        if (await request(tx.objectStore('recordings').index('sessionId').count(sessionId))) throw new Error('Манифест задаётся до первой записи; создайте отдельную тестовую сессию');
        session.manifest = manifest; session.expectedRecordingIds = manifest.entries.map(e => recordingIdFor(sessionId, e.id));
        await request(sessions.put(session)); return manifest;
      });
    },
    async savePassport(sessionId, passport) {
      return transaction(db, ['sessions'], 'readwrite', async tx => {
        const store = tx.objectStore('sessions'), session = await request(store.get(sessionId));
        if (!session) throw new Error('Сессия удалена'); session.passport = passport; await request(store.put(session));
      });
    },
    async startSeries(sessionId, at, timelineId) {
      if (!Number.isFinite(at) || at < 0 || !timelineId) throw new Error('Не заданы часы серии');
      return transaction(db, ['sessions', 'recordings'], 'readwrite', async tx => {
        const store = tx.objectStore('sessions'), session = await request(store.get(sessionId));
        if (!session?.manifest) throw new Error('Сначала задайте манифест');
        if (session.startedAt != null || await request(tx.objectStore('recordings').index('sessionId').count(sessionId))) throw new Error('Начало серии фиксируется до первой записи один раз');
        session.startedAt = at; session.startedTimelineId = timelineId; await request(store.put(session));
      });
    },
    async createBenchmarkPlan(sessionId, { seed, familiar }) {
      if (!Number.isInteger(seed) || seed < 0 || seed > 4294967295) throw new Error('Неверный seed порядка');
      return transaction(db, ['sessions', 'recordings', 'events'], 'readwrite', async tx => {
        const session = await request(tx.objectStore('sessions').get(sessionId));
        if (!session?.manifest) throw new Error('Сначала загрузите манифест серии');
        const records = await request(tx.objectStore('recordings').index('sessionId').getAll(sessionId));
        if (session.expectedRecordingIds.some(id => !records.some(r => r.id === id && r.completeness === 'complete' && r.manifestHashMatches !== false))) throw new Error('Не все ожидаемые полные оригиналы сохранены или SHA-256 не соответствует манифесту');
        const store = tx.objectStore('events');
        if ((await request(store.index('sessionId').getAll(sessionId))).some(e => e.type === 'benchmark-plan')) throw new Error('План сравнения уже создан');
        const entries = session.manifest.entries.map(e => ({ ...e, id: recordingIdFor(sessionId, e.id) }));
        const plan = { id: crypto.randomUUID(), sessionId, type: 'benchmark-plan', seed, familiar: Boolean(familiar), steps: makePlan(entries, seed), nextStep: 0 };
        await request(store.add(plan)); return plan;
      });
    },
    async beginBenchmarkTrial(sessionId, now, timelineId, repeatTrialId) {
      return transaction(db, ['sessions', 'recordings', 'attempts', 'reviews', 'events'], 'readwrite', async tx => {
        const sessions = tx.objectStore('sessions'), session = await request(sessions.get(sessionId));
        if (!session) throw new Error('Сессия удалена');
        const events = tx.objectStore('events'), all = await request(events.index('sessionId').getAll(sessionId));
        if (all.some(e => e.type === 'benchmark-trial' && ['active', 'waiting', 'paused'].includes(e.state))) throw new Error('Предыдущий замер ещё не завершён');
        const plan = all.find(e => e.type === 'benchmark-plan');
        const repeated = repeatTrialId ? all.find(e => e.id === repeatTrialId && e.type === 'benchmark-trial' && e.planId === plan?.id) : null;
        if (repeatTrialId && !repeated) throw new Error('Замер для повтора не найден');
        const orderIndex = repeated?.orderIndex ?? plan?.nextStep, step = plan?.steps[orderIndex];
        if (!step) throw new Error('Нет следующего шага сравнения');
        const record = await request(tx.objectStore('recordings').get(step.id));
        if (!record?.blob.size || record.completeness !== 'complete') throw new Error('Нет полного оригинала для замера');
        const attempts = (await request(tx.objectStore('attempts').index('sessionId').getAll(sessionId)))
          .filter(a => a.recordingId === step.id && a.state === 'done').sort((a, b) => a.attemptSeq - b.attemptSeq);
        const source = attempts.at(-1), mode = step.mode, id = JSON.stringify([step.id, mode]), reviews = tx.objectStore('reviews');
        const previous = await request(reviews.get(id));
        await request(reviews.put({ id, recordingId: step.id, sessionId, mode, text: mode === 'asr' ? source?.rawText ?? '' : '',
          textVersion: (previous?.textVersion ?? 0) + 1, confirmedVersion: null }));
        session.nextTrialSeq = (session.nextTrialSeq ?? 0) + 1;
        const trial = { id: crypto.randomUUID(), sessionId, type: 'benchmark-trial', planId: plan.id, orderIndex,
          recordingId: step.id, mode, trialSeq: session.nextTrialSeq, activeMs: 0, waitingMs: 0, completenessVerified: false,
          openedAt: now, openedTimelineId: timelineId,
          unknownInterval: false, familiar: plan.familiar || Boolean(previous) || all.some(e => e.recordingId === step.id && ['source-exposed', 'benchmark-trial'].includes(e.type)),
          state: mode === 'asr' && !source ? 'waiting' : 'active', phaseStartedAt: now, phaseTimelineId: timelineId, previousReview: previous ?? null };
        plan.paused = false; await request(events.put(plan));
        await request(events.add(trial)); await request(sessions.put(session)); return trial;
      });
    },
    async moveBenchmark(trialId, state, now, timelineId) {
      if (!['active', 'paused', 'interrupted'].includes(state)) throw new Error('Неверное состояние замера');
      return transaction(db, ['sessions', 'events', 'attempts', 'reviews'], 'readwrite', async tx => {
        const events = tx.objectStore('events'), trial = await request(events.get(trialId));
        if (!trial || !await request(tx.objectStore('sessions').get(trial.sessionId))) throw new Error('Замер или сессия удалены');
        if ((await request(events.index('sessionId').getAll(trial.sessionId))).some(e => e.id !== trialId && e.type === 'benchmark-trial' && ['active', 'waiting', 'paused'].includes(e.state))) throw new Error('Другой замер ещё не завершён');
        if (state === 'active' && trial.state === 'waiting') {
          const attempts = (await request(tx.objectStore('attempts').index('sessionId').getAll(trial.sessionId)))
            .filter(a => a.recordingId === trial.recordingId && a.state === 'done').sort((a, b) => a.attemptSeq - b.attemptSeq);
          if (!attempts.length) throw new Error('Расшифровка ещё не готова');
          const reviews = tx.objectStore('reviews'), id = JSON.stringify([trial.recordingId, trial.mode]), review = await request(reviews.get(id));
          await request(reviews.put({ ...review, text: attempts.at(-1).rawText, textVersion: review.textVersion + 1, confirmedVersion: null }));
        }
        const moved = transitionTrial(trial, state, now, timelineId);
        if (state === 'active') moved.completenessVerified = false;
        await request(events.put(moved)); return moved;
      });
    },
    async completeBenchmark(trialId, textVersion, completenessVerified, now, timelineId) {
      return transaction(db, ['sessions', 'events', 'reviews', 'recordings'], 'readwrite', async tx => {
        const events = tx.objectStore('events'), trial = await request(events.get(trialId));
        if (!trial || trial.state !== 'active' || completenessVerified !== true || !await request(tx.objectStore('sessions').get(trial.sessionId))) throw new Error('Нужно активное измерение и проверка дословной полноты');
        const review = await request(tx.objectStore('reviews').get(JSON.stringify([trial.recordingId, trial.mode])));
        const record = await request(tx.objectStore('recordings').get(trial.recordingId));
        confirmText(review, record, textVersion);
        if (review.confirmedVersion !== textVersion) throw new Error('Текст ещё не подтверждён');
        const completed = { ...transitionTrial(trial, 'complete', now, timelineId), completenessVerified: true, completeVersion: textVersion,
          completedAt: now, completedTimelineId: timelineId };
        await request(events.put(completed));
        const plan = await request(events.get(trial.planId)); plan.nextStep = Math.max(plan.nextStep, trial.orderIndex + 1);
        await request(events.put(plan)); return completed;
      });
    },
    async recoverBenchmarks(sessionId, now, timelineId) {
      return transaction(db, ['sessions', 'events'], 'readwrite', async tx => {
        if (!await request(tx.objectStore('sessions').get(sessionId))) return;
        const events = tx.objectStore('events');
        for (const event of await request(events.index('sessionId').getAll(sessionId))) {
          if (event.type === 'benchmark-trial' && ['active', 'waiting'].includes(event.state) && event.phaseTimelineId !== timelineId)
            await request(events.put(transitionTrial(event, 'interrupted', now, timelineId)));
        }
      });
    },
    async recordTranscriptCommit({ jobId, attemptId, savedAt, timelineId, saveMs }) {
      return transaction(db, ['sessions', 'jobs', 'attempts'], 'readwrite', async tx => {
        const job = await request(tx.objectStore('jobs').get(jobId));
        if (!job || !await request(tx.objectStore('sessions').get(job.sessionId))) return false;
        const attempts = tx.objectStore('attempts'), attempt = await request(attempts.get(attemptId));
        if (!attempt || attempt.state !== 'done' || attempt.jobId !== jobId || attempt.timing?.timelineId !== timelineId) return false;
        if (attempt.timing.savedAt == null) { attempt.timing.savedAt = savedAt; attempt.timing.saveMs = saveMs; await request(attempts.put(attempt)); }
        return true;
      });
    },
    async markEnqueued({ jobId, at, timelineId, audioSaveMs }) {
      return transaction(db, ['sessions', 'jobs', 'recordings'], 'readwrite', async tx => {
        const jobs = tx.objectStore('jobs'), job = await request(jobs.get(jobId));
        if (!job || !await request(tx.objectStore('sessions').get(job.sessionId))) return false;
        if (job.state === 'pending' && job.enqueuedAt == null) {
          job.enqueuedAt = at; job.enqueueTimelineId = timelineId; await request(jobs.put(job));
        }
        if (audioSaveMs != null) {
          const records = tx.objectStore('recordings'), record = await request(records.get(job.recordingId));
          if (record && record.audioSaveMs == null) { record.audioSaveMs = audioSaveMs; record.audioCommittedAt = at; record.audioTimelineId = timelineId; await request(records.put(record)); }
        }
        return true;
      });
    },
    getRecording: id => transaction(db, ['recordings'], 'readonly', tx => request(tx.objectStore('recordings').get(id))),
    getReview(recordingId, mode) {
      if (!['asr', 'manual'].includes(mode)) throw new TypeError('Неизвестный режим проверки');
      return transaction(db, ['reviews'], 'readonly', tx => request(tx.objectStore('reviews').get(JSON.stringify([recordingId, mode]))));
    },
    async saveReview({ recordingId, mode, text, expectedVersion }) {
      if (!['asr', 'manual'].includes(mode)) throw new TypeError('Неизвестный режим проверки');
      return transaction(db, ['sessions', 'recordings', 'reviews', 'events'], 'readwrite', async tx => {
        const record = await request(tx.objectStore('recordings').get(recordingId));
        if (!record || !await request(tx.objectStore('sessions').get(record.sessionId))) throw new Error('Сессия или оригинал удалены');
        const reviews = tx.objectStore('reviews'), id = JSON.stringify([recordingId, mode]);
        const previous = await request(reviews.get(id));
        if (expectedVersion != null && expectedVersion !== (previous?.textVersion ?? 0)) throw new Error('Изменилась версия сохранённого текста');
        const review = { ...reviseText(previous, text), id, recordingId, sessionId: record.sessionId, mode };
        if (previous && previous.text !== text) {
          const events = tx.objectStore('events');
          for (const trial of await request(events.index('sessionId').getAll(record.sessionId))) {
            if (trial.type === 'benchmark-trial' && trial.recordingId === recordingId && trial.mode === mode && trial.state !== 'active') {
              if (trial.state === 'complete') trial.state = 'needs-correction';
              trial.completenessVerified = false; trial.unknownInterval = true; await request(events.put(trial));
            }
          }
        }
        await request(reviews.put(review)); return review;
      });
    },
    async confirmReview({ recordingId, mode, textVersion }) {
      if (!['asr', 'manual'].includes(mode)) throw new TypeError('Неизвестный режим проверки');
      return transaction(db, ['sessions', 'recordings', 'reviews'], 'readwrite', async tx => {
        const record = await request(tx.objectStore('recordings').get(recordingId));
        if (!record || !await request(tx.objectStore('sessions').get(record.sessionId))) throw new Error('Сессия или оригинал удалены');
        const reviews = tx.objectStore('reviews'), id = JSON.stringify([recordingId, mode]);
        const updated = confirmText(await request(reviews.get(id)), record, textVersion);
        await request(reviews.put(updated)); return updated;
      });
    },
    listRecordings: sessionId => transaction(db, ['recordings'], 'readonly', tx => request(tx.objectStore('recordings').index('sessionId').getAll(sessionId))),
    listJobs: sessionId => transaction(db, ['jobs'], 'readonly', async tx =>
      (await request(tx.objectStore('jobs').index('sessionId').getAll(sessionId))).sort((a, b) => a.enqueueSeq - b.enqueueSeq)),
    listAttempts: sessionId => transaction(db, ['attempts'], 'readonly', async tx =>
      (await request(tx.objectStore('attempts').index('sessionId').getAll(sessionId))).sort((a, b) => a.attemptSeq - b.attemptSeq)),
    async configurePendingJobs(sessionId, configId) {
      required(configId, 'configId');
      await transaction(db, ['jobs'], 'readwrite', async tx => {
        const store = tx.objectStore('jobs');
        for (const job of await request(store.index('sessionId').getAll(sessionId))) {
          if (job.state === 'pending' && job.configId === 'not-configured') {
            job.configId = configId; await request(store.put(job));
          }
        }
      });
    },
    async claimNext({ sessionId }) {
      return transaction(db, ['sessions', 'jobs', 'recordings', 'attempts'], 'readwrite', async tx => {
        const sessions = tx.objectStore('sessions'), session = await request(sessions.get(sessionId));
        if (!session) return null;
        const jobs = tx.objectStore('jobs');
        const all = await request(jobs.index('sessionId').getAll(sessionId));
        if (all.some(j => j.state === 'running')) return null;
        const job = all.filter(j => j.state === 'pending').sort((a, b) => a.enqueueSeq - b.enqueueSeq)[0];
        if (!job) return null;
        const record = await request(tx.objectStore('recordings').get(job.recordingId));
        if (!record || record.sessionId !== sessionId) throw new Error('Не найден оригинал задания очереди');
        const attemptId = crypto.randomUUID();
        session.nextAttemptSeq = (session.nextAttemptSeq ?? 0) + 1;
        const attempt = { id: attemptId, sessionId, jobId: job.id, recordingId: job.recordingId,
          configId: job.configId, enqueueSeq: job.enqueueSeq, attemptSeq: session.nextAttemptSeq, state: 'running' };
        job.state = 'running'; job.activeAttemptId = attemptId;
        await request(tx.objectStore('attempts').add(attempt)); await request(jobs.put(job)); await request(sessions.put(session));
        return { job, blob: record.blob, attemptId };
      });
    },
    completeAttempt: input => finishAttempt(input, 'done'),
    failAttempt: input => finishAttempt(input, 'error'),
    releaseAttempt: input => finishAttempt(input, 'unavailable'),
    async recoverSession(sessionId) {
      return transaction(db, ['sessions', 'jobs', 'attempts'], 'readwrite', async tx => {
        if (!await request(tx.objectStore('sessions').get(sessionId))) return;
        const jobs = tx.objectStore('jobs'), attempts = tx.objectStore('attempts');
        for (const job of await request(jobs.index('sessionId').getAll(sessionId))) {
          if (job.state !== 'running') continue;
          const attempt = await request(attempts.get(job.activeAttemptId));
          if (attempt) { attempt.state = 'interrupted'; await request(attempts.put(attempt)); }
          job.state = 'pending'; job.activeAttemptId = null; await request(jobs.put(job));
        }
      });
    },
    async retryJob(jobId) {
      return transaction(db, ['sessions', 'jobs', 'attempts'], 'readwrite', async tx => {
        const jobs = tx.objectStore('jobs'), job = await request(jobs.get(jobId));
        if (!job) return false;
        const sessions = tx.objectStore('sessions'), session = await request(sessions.get(job.sessionId));
        if (!session) return false;
        if (job.state === 'pending') return true;
        if (job.activeAttemptId) {
          const attempts = tx.objectStore('attempts'), attempt = await request(attempts.get(job.activeAttemptId));
          if (attempt) { attempt.state = 'interrupted'; await request(attempts.put(attempt)); }
        }
        job.state = 'pending'; job.activeAttemptId = null; job.enqueueSeq = session.nextEnqueueSeq++;
        job.enqueuedAt = null; job.enqueueTimelineId = null;
        await request(jobs.put(job)); await request(sessions.put(session)); return true;
      });
    },
    async endSession(sessionId, endedAt, timelineId) {
      if (!Number.isFinite(endedAt) || endedAt < 0) throw new TypeError('Некорректное время конца серии');
      required(timelineId, 'timelineId');
      return transaction(db, ['sessions'], 'readwrite', async tx => {
        const store = tx.objectStore('sessions'), session = await request(store.get(sessionId));
        if (!session) return false;
        if (session.endedAt == null) { session.endedAt = endedAt; session.timelineId = timelineId; }
        await request(store.put(session)); return true;
      });
    },
    async saveRecording({ recording, blob, configId }) {
      for (const key of ['id', 'sessionId', 'taskType', 'presentationId', 'provenance']) required(recording[key], key);
      required(configId, 'configId');
      if (!(blob instanceof Blob)) throw new TypeError('Нужен оригинал Blob');
      if (!['complete', 'partial'].includes(recording.completeness)) throw new TypeError('Не задана полнота записи');
      // Hashing is deliberately outside the transaction: unrelated async work closes IDB transactions.
      const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', await blob.arrayBuffer()))]
        .map(byte => byte.toString(16).padStart(2, '0')).join('');
      return transaction(db, ['sessions', 'recordings', 'jobs'], 'readwrite', async tx => {
        const sessions = tx.objectStore('sessions');
        const session = await request(sessions.get(recording.sessionId));
        if (!session) throw new Error('Тестовая сессия удалена или не существует');
        let manifestHashMatches = null;
        if (session.manifest) {
          const entry = session.manifest.entries.find(e => recordingIdFor(session.id, e.id) === recording.id);
          if (!entry || entry.taskType !== recording.taskType || entry.presentationId !== recording.presentationId || entry.provenance !== recording.provenance) throw new Error('Запись не соответствует ожидаемому ответу манифеста');
          if (entry.hash) manifestHashMatches = entry.hash === hash;
        }
        const recordings = tx.objectStore('recordings');
        const existing = await request(recordings.get(recording.id));
        if (existing && (existing.hash !== hash || existing.mime !== blob.type ||
            ['sessionId', 'taskType', 'presentationId', 'provenance', 'completeness'].some(key => existing[key] !== recording[key]))) {
          throw new Error('Конфликт ID: сохранённый оригинал нельзя заменить');
        }
        if (!existing) await request(recordings.add({ ...recording, blob, hash, manifestHashMatches, mime: blob.type, bytes: blob.size,
          durationMs: recording.durationMs ?? null }));
        const jobs = tx.objectStore('jobs');
        let job = await request(jobs.index('recordingConfig').get([recording.id, configId]));
        if (!job) {
          const pendingCount = (await request(jobs.index('sessionId').getAll(session.id))).filter(j => j.state === 'pending').length;
          job = { id: crypto.randomUUID(), sessionId: session.id, recordingId: recording.id,
            enqueuedAt: null, enqueueTimelineId: null, queueDepthAtEnqueue: pendingCount + 1,
            configId, enqueueSeq: session.nextEnqueueSeq++, state: 'pending', activeAttemptId: null };
          await request(jobs.add(job));
          await request(sessions.put(session));
        }
        if (import.meta.env.MODE === 'test' && abortNextSave) {
          abortNextSave = false;
          tx.abort();
        }
        return { recordingId: recording.id, jobId: job.id };
      });
    },
    async deleteSession(sessionId) {
      required(sessionId, 'sessionId');
      await transaction(db, STORES, 'readwrite', async tx => {
        await request(tx.objectStore('sessions').delete(sessionId));
        for (const name of STORES.filter(name => name !== 'sessions')) {
          const store = tx.objectStore(name);
          const ids = await request(store.index('sessionId').getAllKeys(sessionId));
          for (const id of ids) await request(store.delete(id));
        }
      });
    },
  };
  if (import.meta.env.MODE === 'test') repo.testing = { abortNextSave: () => { abortNextSave = true; } };
  return repo;
}

export async function storageStatus(storage = navigator.storage, { requestPersistence = false } = {}) {
  if (!storage) return { persisted: null, usage: null, quota: null, error: 'API хранилища недоступен' };
  const status = { persisted: null, usage: null, quota: null, error: null };
  const errors = [];
  try { Object.assign(status, await storage.estimate()); } catch (e) { errors.push(`Оценка места: ${e.message}`); }
  try {
    status.persisted = requestPersistence ? await storage.persist() : await storage.persisted();
  } catch (e) { errors.push(`Постоянное хранение: ${e.message}`); }
  status.error = errors.join('; ') || null;
  return status;
}
