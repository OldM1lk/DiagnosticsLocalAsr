/** Loaded only by the test build. These results are not speech recognition. */
export function createTestRecognizer() {
  let delayNext = false, failNext = false, unavailableNext = false, release;
  return {
    holdNext() { delayNext = true; },
    release() { release?.(); release = undefined; },
    failNext() { failNext = true; },
    unavailableNext() { unavailableNext = true; },
    async transcribe({ recordingId }) {
      if (delayNext) {
        delayNext = false;
        await new Promise(resolve => { release = resolve; });
      }
      if (unavailableNext) { unavailableNext = false; throw Object.assign(new Error('Тестовый отказ исполнителя'), { unavailable: true }); }
      if (failNext) { failNext = false; throw new Error('Тестовая ошибка файла'); }
      return { rawText: `ТЕСТОВЫЙ РЕЗУЛЬТАТ ${recordingId} — не распознавание речи` };
    },
  };
}
