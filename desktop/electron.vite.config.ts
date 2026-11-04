import { defineConfig } from 'electron-vite';
import react from '@vitejs/plugin-react';
import { version } from './package.json';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { LocalBuildInfoSchema } from './src/version-check/protocol';
import { resolveBuildMode } from './src/runtime-mode';

const buildInfo = LocalBuildInfoSchema.parse(
  process.env.OBSERVER_LOCAL_BUILD_INFO
    ? JSON.parse(process.env.OBSERVER_LOCAL_BUILD_INFO)
    : { buildId: randomUUID(), version, createdAt: new Date().toISOString() },
);

export default defineConfig({
  main: {
    define: {
      __OBSERVER_RUNTIME_MODE__: JSON.stringify(resolveBuildMode(process.env)),
      __OBSERVER_BASE_CONFIG__: JSON.stringify(
        readFileSync(new URL('../observer.yaml', import.meta.url), 'utf8'),
      ),
      __OBSERVER_PUBLISH_CONFIG__: JSON.stringify(
        readFileSync(
          new URL('../observer.publish.yaml', import.meta.url),
          'utf8',
        ),
      ),
      __OBSERVER_LOCAL_BUILD__: JSON.stringify(buildInfo),
      __OBSERVER_PROJECT_ROOT__: JSON.stringify(
        path.resolve(fileURLToPath(new URL('..', import.meta.url))),
      ),
    },
  },
  preload: {
    build: {
      externalizeDeps: false,
      rollupOptions: { output: { format: 'cjs', entryFileNames: 'index.cjs' } },
    },
  },
  renderer: {
    plugins: [react()],
    define: { __OBSERVER_VERSION__: JSON.stringify(version) },
  },
});
