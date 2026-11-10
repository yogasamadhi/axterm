import { configDefaults, defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
import hostConfig from './tsconfig.host.json';

// A constrained developer host can serialize fixtures while preserving their exact deadlines.
const workers = process.env.AXTERM_TEST_WORKERS;
if (workers !== undefined && workers !== '1' && workers !== '2')
  throw new Error('AXTERM_TEST_WORKERS must be 1 or 2');

export default defineConfig({
  esbuild: { jsx: 'automatic' },
  resolve: {
    alias: Object.entries(hostConfig.compilerOptions.paths).map(([name, paths]) => ({
      find: new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`),
      // The fixed Pi core executes its verified build; public.ts is its declaration-only Host face.
      replacement: fileURLToPath(
        new URL(
          name === '@axterm/engine-pi-core' ? './packages/pi-engine/dist/index.js' : paths[0]!,
          import.meta.url,
        ),
      ),
    })),
  },
  test: {
    include: [
      'apps/desktop-host/tests/**/*.test.ts',
      'apps/web/tests/**/*.test.ts',
      'packages/**/*.test.ts',
      'packages/**/*.test.tsx',
      'tests/integration/**/*.test.ts',
      'tests/unit/**/*.test.ts',
    ],
    exclude: [...configDefaults.exclude, 'tests/unit/parity.test.ts'],
    environment: 'node',
    // Profile/module resolution uses the same Node internal Loader as production HMR.
    execArgv: ['--expose-internals'],
    // Runtime and loopback integration fixtures contend on process/socket startup
    // above this level; keep the per-test 10-second gate deterministic instead of
    // weakening its timeout.
    maxWorkers: 2,
    ...(workers === '1' ? { maxWorkers: 1 } : {}),
    testTimeout: 10_000,
    hookTimeout: 10_000,
    restoreMocks: true,
  },
});
