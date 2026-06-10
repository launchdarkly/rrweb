import { resolve } from 'path';
import { existsSync } from 'fs';
import { defineConfig, Plugin } from 'vitest/config';

const packagesDir = resolve(__dirname, 'packages');
const pluginsDir = resolve(__dirname, 'packages/plugins');

/**
 * Resolve bare @rrweb/* and sibling package imports to source/dist within
 * this monorepo. This is needed because the workspace package names are
 * @highlight-run/* scoped, but source code uses the unscoped @rrweb/* names.
 */
function rrwebResolvePlugin(): Plugin {
  return {
    name: 'rrweb-resolve',
    enforce: 'pre',
    resolveId(source) {
      // @rrweb/replay/dist/style.css → packages/replay/dist/style.css
      if (source === '@rrweb/replay/dist/style.css') {
        return resolve(packagesDir, 'replay/dist/style.css');
      }
      // @rrweb/<plugin-name> → packages/plugins/<plugin-name>/src/index.ts
      if (source.startsWith('@rrweb/rrweb-plugin-')) {
        const name = source.slice('@rrweb/'.length);
        const src = resolve(pluginsDir, name, 'src/index.ts');
        if (existsSync(src)) return src;
      }
      // @rrweb/<name> → packages/<name>/src/index.ts
      if (source.startsWith('@rrweb/')) {
        const name = source.slice('@rrweb/'.length);
        const src = resolve(packagesDir, name, 'src/index.ts');
        if (existsSync(src)) return src;
      }
      // rrweb/dist/style.css → packages/rrweb/dist/style.css
      if (source === 'rrweb/dist/style.css') {
        return resolve(packagesDir, 'rrweb/dist/style.css');
      }
      // rrweb → packages/rrweb/src/index.ts
      if (source === 'rrweb') {
        return resolve(packagesDir, 'rrweb/src/index.ts');
      }
      // rrweb-snapshot → packages/rrweb-snapshot/src/index.ts
      if (source === 'rrweb-snapshot') {
        return resolve(packagesDir, 'rrweb-snapshot/src/index.ts');
      }
      // rrdom → packages/rrdom/src/index.ts
      if (source === 'rrdom') {
        return resolve(packagesDir, 'rrdom/src/index.ts');
      }
      return null;
    },
  };
}

export default defineConfig({
  plugins: [rrwebResolvePlugin()],
  test: {
    /**
     * Keeps old (pre-jest 29) snapshot format
     * its a bit ugly and harder to read than the new format,
     * so we might want to remove this in its own PR
     */
    snapshotFormat: {
      escapeString: true,
      printBasicPrototype: true,
    },
    /**
     * Use forks instead of threads for Vite 6 compatibility
     * Vite 6 has issues with worker threads not cleaning up properly
     * causing tests to hang indefinitely
     */
    pool: 'forks',
  },
});
