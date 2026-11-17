export const TASK_TYPES = ['auditory', 'naming', 'generalization', 'antonyms', 'fluency', 'images', 'control'];
export const OLDER_PROFILE = [
  ['auditory', 'learning-1'], ['auditory', 'learning-2'], ['auditory', 'learning-3'],
  ['fluency', 'fluency'], ['images', 'images'], ['auditory', 'delayed'],
];
export function validateManifest(input) {
  if (!input || !['technical', 'older-prototype-v1'].includes(input.profile) || !Array.isArray(input.entries) || !input.entries.length) throw new Error('Некорректный манифест серии');
  const ids = new Set();
  const entries = input.entries.map(entry => {
    if (!/^[a-zA-Z0-9_-]{1,80}$/.test(entry.id) || ids.has(entry.id)) throw new Error('Неверный или повторный ID записи');
    ids.add(entry.id);
    if (!TASK_TYPES.includes(entry.taskType) || typeof entry.presentationId !== 'string' || !entry.presentationId.trim() ||
        !['adult', 'child', 'synthetic', 'public-actor', 'technical-unverified'].includes(entry.provenance)) throw new Error('Не задан тип/предъявление/происхождение записи');
    if (entry.hash != null && !/^[a-f0-9]{64}$/.test(entry.hash)) throw new Error('Некорректный SHA-256');
    if (entry.durationMs != null && (!Number.isFinite(entry.durationMs) || entry.durationMs <= 0)) throw new Error('Некорректная длительность');
    return { id: entry.id, taskType: entry.taskType, presentationId: entry.presentationId,
      provenance: entry.provenance, hash: entry.hash ?? null, durationMs: entry.durationMs ?? null,
      expectedOffsetMs: Number.isFinite(entry.expectedOffsetMs) && entry.expectedOffsetMs >= 0 ? entry.expectedOffsetMs : null,
      silence: entry.silence === true, conditions: entry.conditions ?? '', reference: entry.reference ?? null };
  });
  return { profile: input.profile, ageGroup: input.ageGroup ?? null, stage: input.stage ?? null,
    arrivalMode: ['live', 'paced-replay', 'bulk-stress'].includes(input.arrivalMode) ? input.arrivalMode : 'technical',
    scheduleVerified: input.scheduleVerified === true,
    sourceProfileVersion: input.sourceProfileVersion ?? null, fullScenarioVerified: input.fullScenarioVerified === true, entries };
}
export function fullScenario(manifest) {
  return manifest?.profile === 'older-prototype-v1' && manifest.ageGroup === '15-18' && ['before', 'after'].includes(manifest.stage)
    && manifest.sourceProfileVersion === 'older-087c534' && manifest.fullScenarioVerified === true
    && manifest.entries.length === OLDER_PROFILE.length
    && OLDER_PROFILE.every(([type, presentation]) => manifest.entries.filter(e => e.taskType === type && e.presentationId === presentation).length === 1);
}
export const recordingIdFor = (sessionId, entryId) => `${sessionId}:${entryId}`;
