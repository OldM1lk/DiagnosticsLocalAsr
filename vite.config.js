import { defineConfig, loadEnv } from 'vite';

export default defineConfig(({ mode }) => {
  const { APP_BASE_PATH = '/' } = loadEnv(mode, process.cwd(), 'APP_BASE_PATH');
  if (!/^\/(?:[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*\/?)?$/.test(APP_BASE_PATH)) {
    throw new Error('APP_BASE_PATH must be a URL path such as /DiagnosticsLocalAsr/');
  }
  return { base: APP_BASE_PATH.endsWith('/') ? APP_BASE_PATH : `${APP_BASE_PATH}/` };
});
