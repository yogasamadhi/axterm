import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/**/*.test.ts', 'tests/integration/**/*.test.ts', 'tests/unit/**/*.test.ts'],
    exclude: [...configDefaults.exclude, 'tests/unit/parity.test.ts'],
    environment: 'node',
    // Runtime and loopback integration fixtures contend on process/socket startup
    // above this level; keep the per-test 10-second gate deterministic instead of
    // weakening its timeout.
    maxWorkers: 2,
    testTimeout: 10_000,
    hookTimeout: 10_000,
    restoreMocks: true,
  },
});
