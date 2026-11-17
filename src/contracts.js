/**
 * Все длительности — миллисекунды. Только тестовые данные, одна активная вкладка.
 * @typedef {{id:string, expectedRecordingIds:string[], endedAt:number|null, timelineId:string, nextEnqueueSeq:number}} Session
 * @typedef {{id:string, sessionId:string, taskType:string, presentationId:string, provenance:string, completeness:'complete'|'partial', mime:string, bytes:number, hash:string, durationMs:number|null, blob:Blob}} Recording
 * @typedef {{id:string, sessionId:string, recordingId:string, configId:string, enqueueSeq:number, state:'pending'|'running'|'done'|'error', activeAttemptId:string|null}} Job
 * @typedef {{id:string, sessionId:string, recordingId:string, mode:'asr'|'manual', text:string, textVersion:number, confirmedVersion:number|null}} Review
 */
export const DATABASE_NAME = 'diagnostics-local-asr-experiment-v1';
export const STORES = ['sessions', 'recordings', 'jobs', 'attempts', 'reviews', 'events'];
