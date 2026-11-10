import { defineConfig } from 'vitest/config';
import rootConfig from '../../vitest.config.ts';

const duration = Number(process.env.AXTERM_SOAK_DURATION_MS ?? 60_000);

export default defineConfig({
  ...rootConfig,
  test: {
    ...rootConfig.test,
    include: ['tests/soak/**/*.test.ts'],
    environment: 'node',
    execArgv: [...(rootConfig.test?.execArgv ?? []), '--expose-gc'],
    fileParallelism: false,
    maxWorkers: 1,
    testTimeout: duration + 180_000,
    hookTimeout: 60_000,
    restoreMocks: true,
  },
});
