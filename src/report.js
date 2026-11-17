import { evaluateSeries, compareReview, errorSummary } from './metrics.js';
import { fullScenario, recordingIdFor, TASK_TYPES } from './manifest.js';
import { CONFIG, MODEL_FILES, RUNTIME_FILES } from './config.js';
const number = n => Number.isFinite(n) && n >= 0 ? n : null;
export function buildReport({ session, recordings = [], attempts = [], reviews = [], events = [], jobs = [] }) {
  const expectedIds = session?.manifest?.entries.map(e => recordingIdFor(session.id, e.id)) ?? [];
  const availability = events.filter(e => e.type === 'availability');
  const execution = jobs.length && jobs.every(j => j.configId === CONFIG.id) ? 'real' : jobs.length && jobs.every(j => j.configId === 'test-fifo-v1') ? 'test' : 'unknown';
  const loggedArrivals = Number.isFinite(session?.startedAt) && session.startedTimelineId === session.timelineId
    && expectedIds.every(id => recordings.some(r => r.id === id && r.audioTimelineId === session.timelineId && r.audioCommittedAt >= session.startedAt));
  const paced = ['live', 'paced-replay'].includes(session?.manifest?.arrivalMode) && session.manifest.scheduleVerified === true;
  const series = evaluateSeries({ expectedIds, attempts, endedAt: session?.endedAt, timelineId: session?.timelineId,
    fullScenario: execution === 'real' && fullScenario(session?.manifest) && paced && loggedArrivals && expectedIds.every(id => recordings.some(r => r.id === id && r.completeness === 'complete' && r.manifestHashMatches !== false)),
    availability, availabilityKnown: availability.length > 0 && !events.some(e => e.type === 'journal-gap') });
  const pairs = expectedIds.map(id => {
    const side = mode => {
      if (!recordings.some(r => r.id === id && r.completeness === 'complete' && r.manifestHashMatches !== false)) return null;
      const trial = events.filter(e => e.type === 'benchmark-trial' && e.recordingId === id && e.mode === mode).sort((a, b) => b.trialSeq - a.trialSeq)[0];
      const review = reviews.find(r => r.recordingId === id && r.mode === mode);
      return trial ? { ...trial, textVersion: review?.textVersion, confirmedVersion: review?.confirmedVersion } : null;
    };
    return { id, manual: side('manual'), asr: side('asr') };
  });
  const comparison = compareReview({ expectedIds, pairs });
  const pseudonyms = new Map([...new Set([...expectedIds, ...recordings.map(r => r.id)])].map((id, i) => [id, `R${String(i + 1).padStart(3, '0')}`]));
  const allowedStatus = s => ['pass', 'fail', 'insufficient-data'].includes(s) ? s : 'insufficient-data';
  const cleanMetric = metric => ({ status: allowedStatus(metric.status), remainingMs: number(metric.remainingMs), restorationMs: number(metric.restorationMs),
    manualMs: number(metric.manualMs), asrMs: number(metric.asrMs), ratio: number(metric.ratio), waitingMs: number(metric.waitingMs), completedPairs: number(metric.completedPairs) });
  const report = { schemaVersion: 1, execution, experimentDecision: 'not-evaluated', technicalOnly: execution !== 'real' || !fullScenario(session?.manifest),
    scheduleDeclaredVerified: session?.manifest?.scheduleVerified === true,
    passport: { device: ['desktop', 'huawei-matepad-se-11', 'other-tablet'].includes(session?.passport?.device) ? session.passport.device : 'unknown',
      os: ['windows', 'android', 'harmonyos', 'linux', 'macos'].includes(session?.passport?.os) ? session.passport.os : 'unknown',
      browserVersion: /^\d{1,4}(\.\d{1,5}){0,3}$/.test(session?.passport?.browserVersion) ? session.passport.browserVersion : null },
    config: { id: CONFIG.id, revision: CONFIG.revision, transformers: CONFIG.transformers,
    device: CONFIG.device, dtype: CONFIG.dtype, numThreads: CONFIG.numThreads, language: 'russian', task: 'transcribe', chunkSeconds: 30, strideSeconds: 5 },
    series: cleanMetric(series), comparison: cleanMetric(comparison), expectedCount: expectedIds.length,
    maxPending: jobs.length ? Math.max(...jobs.map(j => number(j.queueDepthAtEnqueue) ?? 0)) : null,
    records: recordings.map(r => {
      const processing = attempts.filter(a => a.recordingId === r.id).sort((a, b) => a.attemptSeq - b.attemptSeq);
      const latest = processing.filter(a => a.state === 'done').at(-1);
      const audit = events.find(e => e.type === 'error-audit' && e.recordingId === r.id && e.attemptId === latest?.id);
      const verifiedAudit = audit?.verified === true && latest && audit.attemptId === latest.id ? audit : null;
      const errors = verifiedAudit ? errorSummary({ ...verifiedAudit, rawNonEmpty: Boolean(latest.rawText?.trim()) }) : null;
      return { id: pseudonyms.get(r.id), taskType: TASK_TYPES.includes(r.taskType) ? r.taskType : 'control',
        bytes: number(r.bytes), hash: /^[a-f0-9]{64}$/.test(r.hash) ? r.hash : null, hashMatchesManifest: typeof r.manifestHashMatches === 'boolean' ? r.manifestHashMatches : null, durationMs: number(r.durationMs), audioSaveMs: number(r.audioSaveMs), complete: r.completeness === 'complete',
        arrivalMs: r.audioTimelineId === session?.startedTimelineId && Number.isFinite(session?.startedAt) ? number(r.audioCommittedAt - session.startedAt) : null,
        expectedArrivalMs: number(session?.manifest?.entries.find(e => recordingIdFor(session.id, e.id) === r.id)?.expectedOffsetMs),
        attempts: processing.map(a => ({ state: ['done', 'error', 'unavailable', 'interrupted', 'running'].includes(a.state) ? a.state : 'error',
          decodeMs: number(a.timing?.decodeMs), inferenceMs: number(a.timing?.inferenceMs), saveMs: number(a.timing?.saveMs),
          queueWaitMs: number(a.timing?.queueWaitMs), processingMs: number(a.timing?.durationMs), audioDurationMs: number(a.timing?.audioDurationMs),
          inferenceToAudioRatio: a.timing?.audioDurationMs > 0 ? number(a.timing.inferenceMs / a.timing.audioDurationMs) : null })),
        wordErrorRatio: number(errors?.wordErrorRatio), falseNonEmpty: errors?.falseNonEmpty === true,
        errorCounts: Object.fromEntries(['referenceWords', 'omissions', 'substitutions', 'insertions', 'lostRepeats', 'orderErrors', 'seamErrors'].map(key => [key, verifiedAudit ? number(verifiedAudit[key]) : null])),
        reviews: ['manual', 'asr'].map(mode => {
          const pair = pairs.find(p => p.id === r.id)?.[mode];
          return { mode, activeMs: number(pair?.activeMs), waitingMs: number(pair?.waitingMs), complete: pair?.state === 'complete',
            completenessVerified: pair?.completenessVerified === true && pair?.completeVersion === pair?.textVersion && pair?.textVersion === pair?.confirmedVersion,
            unknownInterval: pair?.unknownInterval === true, familiar: pair?.familiar === true,
            listeningCount: pair ? events.filter(e => e.type === 'listening' && e.trialId === pair.id).length : null,
            segments: (pair?.segments ?? []).filter(s => ['active', 'waiting'].includes(s.kind)).map(s => ({ kind: s.kind, durationMs: number(s.durationMs) })) };
        }) };
    }),
    preparation: events.filter(e => e.type === 'model-preparation').map(e => ({ filesMs: number(e.filesMs), initMs: number(e.initMs),
      downloadMs: number(e.downloadMs), coldInit: typeof e.coldInit === 'boolean' ? e.coldInit : null,
      bytes: number(e.bytes), runtime: e.runtime === CONFIG.runtime ? CONFIG.runtime : null,
      resources: (e.resources ?? []).filter(f => [...MODEL_FILES.map(n => `/models/${CONFIG.model}/${n}`), ...RUNTIME_FILES.map(n => `/runtime/${n}`)].includes(f.path))
        .map(f => ({ name: f.path, bytes: number(f.bytes), sha256: /^[a-f0-9]{64}$/.test(f.sha256) ? f.sha256 : null })) })),
  };
  report.groups = TASK_TYPES.map(taskType => {
    const rows = report.records.filter(r => r.taskType === taskType);
    const verified = rows.filter(r => r.errorCounts.referenceWords != null);
    const matching = pairs.filter(p => recordings.some(r => r.id === p.id && r.taskType === taskType));
    const compared = compareReview({ expectedIds: matching.map(p => p.id), pairs: matching });
    return { taskType, count: rows.length, auditedCount: verified.length,
      errors: Object.fromEntries(['referenceWords', 'omissions', 'substitutions', 'insertions', 'lostRepeats', 'orderErrors', 'seamErrors']
        .map(key => [key, verified.length && verified.every(r => r.errorCounts[key] != null) ? verified.reduce((sum, r) => sum + r.errorCounts[key], 0) : null])),
      manualMs: number(compared.manualMs), asrMs: number(compared.asrMs), ratio: number(compared.ratio), completedPairs: number(compared.completedPairs) };
  });
  for (const group of report.groups) {
    group.wordErrorRatio = group.errors.referenceWords > 0 && ['omissions', 'substitutions', 'insertions'].every(key => group.errors[key] != null)
      ? (group.errors.omissions + group.errors.substitutions + group.errors.insertions) / group.errors.referenceWords : null;
    group.falseNonEmptyCount = report.records.filter(r => r.taskType === group.taskType && r.falseNonEmpty).length;
  }
  report.pairIntervals = pairs.map(pair => {
    const ordered = [pair.manual, pair.asr].filter(Boolean).sort((a, b) => a.trialSeq - b.trialSeq);
    return { id: pseudonyms.get(pair.id), betweenApproachesMs: ordered.length === 2 && ordered[0].completedTimelineId === ordered[1].openedTimelineId
      ? number(ordered[1].openedAt - ordered[0].completedAt) : null };
  });
  report.plan = { seed: number(events.find(e => e.type === 'benchmark-plan')?.seed),
    order: (events.find(e => e.type === 'benchmark-plan')?.steps ?? []).map(step => ({ id: pseudonyms.get(step.id) ?? null, mode: step.mode === 'manual' ? 'manual' : 'asr' })) };
  return report;
}
