import { defineConfig } from 'vitest/config';

const duration = Number(process.env.AXTERM_SOAK_DURATION_MS ?? 60_000);

export default defineConfig({
  test: {
    include: ['tests/soak/**/*.test.ts'],
    environment: 'node',
    fileParallelism: false,
    maxWorkers: 1,
    testTimeout: duration + 180_000,
    hookTimeout: 60_000,
    restoreMocks: true,
  },
});
