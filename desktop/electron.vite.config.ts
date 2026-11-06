import { defineConfig } from 'electron-vite';
import react from '@vitejs/plugin-react';
import { version } from './package.json';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { LocalBuildInfoSchema } from './src/version-check/protocol';
import { resolveBuildMode } from './src/runtime-mode';

const buildInfo = LocalBuildInfoSchema.parse(
  process.env.OBSERVER_LOCAL_BUILD_INFO
    ? JSON.parse(process.env.OBSERVER_LOCAL_BUILD_INFO)
    : { buildId: randomUUID(), version, createdAt: new Date().toISOString() },
);
const mode = resolveBuildMode(process.env);

export default defineConfig({
  main: {
    define: {
      __OBSERVER_RUNTIME_MODE__: JSON.stringify(mode),
      __OBSERVER_PUBLISH_CONFIG__: JSON.stringify(
        mode === 'publish'
          ? readFileSync(new URL('../observer.yaml', import.meta.url), 'utf8')
          : '',
      ),
      __OBSERVER_LOCAL_BUILD__: JSON.stringify(buildInfo),
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
    define: {
      __OBSERVER_VERSION__: JSON.stringify(version),
      __OBSERVER_SIDEBAR_VERSION__: JSON.stringify(
        `v${version}${mode === 'dev' ? ' dev' : ''}`,
      ),
    },
  },
});
