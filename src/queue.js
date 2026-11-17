/** One in-flight transcribe, including while switching sessions. Availability is explicit. */
export function createQueue({ repository, recognizer, clock = { now: () => performance.now() }, onChange = () => {}, onError = () => {} }) {
  let sessionId = null, available = false, availabilityReason = 'not-initialized', draining = false, requested = false, epoch = 0;
  const timelineId = crypto.randomUUID();
  const journalGaps = new Set();
  function availabilityEvent() {
    const sid = sessionId;
    if (sid && repository.recordEvent) void repository.recordEvent({ type: 'availability', sessionId: sid,
      available, reason: availabilityReason, at: clock.now(), timelineId }).then(async () => {
        if (journalGaps.has(sid)) {
          const saved = await repository.recordEvent({ type: 'journal-gap', sessionId: sid, at: clock.now(), timelineId });
          if (saved !== false) journalGaps.delete(sid);
        }
      }).catch(error => { journalGaps.add(sid); onError(error); });
  }
  const emit = () => { try { onChange(); } catch (error) { onError(error); } };
  async function drain() {
    if (draining) return;
    draining = true;
    try {
      do {
        requested = false;
        while (sessionId && available) {
          const sid = sessionId, generation = epoch;
          const entry = await repository.claimNext({ sessionId: sid });
          if (!entry) break;
          if (epoch !== generation) { await repository.recoverSession(sid); continue; }
          if (!available) {
            await repository.releaseAttempt({ jobId: entry.job.id, attemptId: entry.attemptId,
              error: { message: 'Исполнитель стал недоступен до запуска' } });
            emit(); break;
          }
          emit();
          const { job, attemptId, blob } = entry;
          const timing = { timelineId, startedAt: clock.now() };
          timing.queueWaitMs = job.enqueueTimelineId === timelineId && Number.isFinite(job.enqueuedAt)
            ? Math.max(0, timing.startedAt - job.enqueuedAt) : null;
          let result, failure;
          try {
            result = await recognizer.transcribe({ sessionId: sid, jobId: job.id, recordingId: job.recordingId ?? job.id,
              configId: job.configId, attemptId, blob });
          } catch (error) { failure = error; }
          if (generation !== epoch) continue;
          timing.finishedAt = clock.now(); timing.durationMs = Math.max(0, timing.finishedAt - timing.startedAt);
          if (failure) {
            const input = { jobId: job.id, attemptId, error: failure, timing };
            if (failure.unavailable) { available = false; availabilityReason = 'runtime-failure'; availabilityEvent(); await repository.releaseAttempt(input); }
            else await repository.failAttempt(input);
          } else {
            const accepted = await repository.completeAttempt({ jobId: job.id, attemptId, rawText: result.rawText,
              timing: { ...timing, decodeMs: result.decodeMs ?? null, inferenceMs: result.inferenceMs ?? null, audioDurationMs: result.audioDurationMs ?? null } });
            if (accepted && repository.recordTranscriptCommit) {
              const savedAt = clock.now();
              await repository.recordTranscriptCommit({ jobId: job.id, attemptId, savedAt, timelineId, saveMs: Math.max(0, savedAt - timing.finishedAt) });
            }
          }
          emit();
        }
      } while (requested && sessionId && available);
    } catch (error) {
      // An IDB failure is not a bad audio file. Pause; recovery on start invalidates the unfinished attempt.
      available = false; availabilityReason = 'storage-failure'; availabilityEvent(); onError(error); emit();
    } finally {
      draining = false;
      if (requested && sessionId && available) void drain();
    }
  }
  function wake() { requested = true; void drain(); }
  return {
    async start(id) {
      const generation = ++epoch, old = sessionId;
      sessionId = null;
      if (old) await repository.recoverSession(old);
      if (generation !== epoch) return;
      await repository.recoverSession(id);
      if (generation !== epoch) return;
      sessionId = id; availabilityEvent(); wake();
    },
    async stop() {
      epoch++; const old = sessionId; sessionId = null;
      if (old) await repository.recoverSession(old);
    },
    setAvailable(value, reason = 'unavailable') {
      const recoveringFailure = !available && !value && ['runtime-failure', 'storage-failure', 'preparation-failed'].includes(availabilityReason) && reason === 'initializing';
      available = Boolean(value);
      if (!recoveringFailure) availabilityReason = available ? 'ready' : reason;
      availabilityEvent(); emit(); if (available) wake();
    },
    wake,
    get available() { return available; },
    get journalIncomplete() { return journalGaps.has(sessionId); },
    timelineId,
  };
}
