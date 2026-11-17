const time = n => Number.isFinite(n) && n >= 0 && n < 1e12;
const insufficient = reason => ({ status: 'insufficient-data', reason });
export function evaluateSeries({ expectedIds, attempts, endedAt, timelineId, fullScenario: full,
  availability = [], availabilityKnown = true }) {
  if (!full || !expectedIds?.length || new Set(expectedIds).size !== expectedIds.length) return insufficient('full-manifest-required');
  if (!time(endedAt) || !timelineId) return insufficient('series-end-required');
  const successful = [], missingIds = [];
  let failed = false;
  for (const id of expectedIds) {
    const entries = attempts.filter(a => a.recordingId === id).sort((a, b) => a.attemptSeq - b.attemptSeq);
    const done = entries.find(a => a.state === 'done');
    if (!done) { missingIds.push(id); failed ||= entries.some(a => a.state === 'error'); } else successful.push(done);
  }
  if (missingIds.length) return { status: failed ? 'fail' : 'insufficient-data', reason: 'missing-transcripts', missingIds };
  if (successful.some(a => a.timing?.timelineId !== timelineId || !time(a.timing?.savedAt))) return insufficient('unknown-clock-interval');
  const last = Math.max(...successful.map(a => a.timing.savedAt));
  const remainingMs = Math.max(0, last - endedAt);
  if (!availabilityKnown) return { ...insufficient('availability-not-recorded'), remainingMs };
  if (remainingMs > 0) {
    if (availability.some(e => e.timelineId !== timelineId || !time(e.at))) return { ...insufficient('unknown-availability-interval'), remainingMs };
    const events = availability.filter(e => e.at <= last).sort((a, b) => a.at - b.at);
    const atEnd = events.filter(e => e.at <= endedAt).at(-1);
    const outage = e => e?.available === false && !['initializing', 'not-initialized'].includes(e.reason);
    const outages = events.filter(e => outage(e) && e.at >= endedAt);
    const restored = events.filter(e => e.available === true && e.at >= (outages.at(-1)?.at ?? endedAt)).at(-1);
    if (availability.length && !atEnd) return { ...insufficient('unknown-availability-interval'), remainingMs,
      restorationMs: outages.length && restored ? Math.max(0, last - restored.at) : null };
    if (outage(atEnd) || outages.length) {
      return { ...insufficient('processing-unavailable'), remainingMs,
        restorationMs: restored ? Math.max(0, last - restored.at) : null };
    }
  }
  return { status: remainingMs <= 300000 ? 'pass' : 'fail', remainingMs, missingIds: [] };
}
export function compareReview({ expectedIds, pairs }) {
  if (!expectedIds?.length || new Set(expectedIds).size !== expectedIds.length || pairs.length !== expectedIds.length ||
      expectedIds.some(id => pairs.filter(p => p.id === id).length !== 1)) return insufficient('incomplete-pairs');
  const valid = side => side && side.state === 'complete' && side.completenessVerified === true && !side.unknownInterval
    && Number.isFinite(side.activeMs) && side.activeMs >= 0 && Number.isFinite(side.waitingMs) && side.waitingMs >= 0
    && side.textVersion > 0 && side.textVersion === side.confirmedVersion && side.textVersion === side.completeVersion;
  if (pairs.some(p => !valid(p.manual) || !valid(p.asr))) return insufficient('unverified-or-stale-pair');
  const manualMs = pairs.reduce((sum, p) => sum + p.manual.activeMs, 0), asrMs = pairs.reduce((sum, p) => sum + p.asr.activeMs, 0);
  if (manualMs <= 0) return insufficient('zero-manual-time');
  return { status: asrMs <= manualMs * 0.75 ? 'pass' : 'fail', manualMs, asrMs, ratio: asrMs / manualMs,
    waitingMs: pairs.reduce((sum, p) => sum + p.manual.waitingMs + p.asr.waitingMs, 0), completedPairs: pairs.length };
}
export function errorSummary({ referenceWords, omissions, substitutions, insertions, rawNonEmpty }) {
  const valid = [referenceWords, omissions, substitutions, insertions].every(n => Number.isSafeInteger(n) && n >= 0);
  return { wordErrorRatio: valid && referenceWords > 0 ? (omissions + substitutions + insertions) / referenceWords : null,
    falseNonEmpty: referenceWords === 0 && rawNonEmpty === true, insertions: valid ? insertions : null };
}
