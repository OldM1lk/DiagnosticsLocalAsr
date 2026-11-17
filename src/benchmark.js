export function transitionTrial(trial, nextState, now, timelineId) {
  const result = { ...trial };
  if (['active', 'waiting'].includes(trial.state)) {
    if (trial.phaseTimelineId !== timelineId || !Number.isFinite(now) || now < trial.phaseStartedAt) result.unknownInterval = true;
    else {
      const durationMs = now - trial.phaseStartedAt;
      result[trial.state === 'active' ? 'activeMs' : 'waitingMs'] += durationMs;
      result.segments = [...(trial.segments ?? []), { kind: trial.state, durationMs }];
    }
  }
  result.state = nextState; result.phaseStartedAt = now; result.phaseTimelineId = timelineId;
  return result;
}
export function makePlan(entries, seed) {
  let state = seed >>> 0;
  const random = () => { state = (Math.imul(1664525, state) + 1013904223) >>> 0; return state / 4294967296; };
  const shuffle = input => {
    const result = [...input]; for (let i = result.length - 1; i > 0; i--) { const j = Math.floor(random() * (i + 1)); [result[i], result[j]] = [result[j], result[i]]; } return result;
  };
  const first = [];
  for (const type of new Set(entries.map(e => e.taskType))) {
    const group = shuffle(entries.filter(e => e.taskType === type));
    group.forEach((entry, i) => first.push({ id: entry.id, mode: i < Math.ceil(group.length / 2) ? 'manual' : 'asr' }));
  }
  return [...shuffle(first), ...shuffle(first.map(s => ({ ...s, mode: s.mode === 'manual' ? 'asr' : 'manual' })))];
}
