import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 45_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: 'list',
  use: { trace: 'retain-on-failure' },
  projects: [
    {
      name: 'desktop',
      testMatch: [
        'desktop.spec.ts',
        'pi-engine.spec.ts',
        'terminal-selection.spec.ts',
        'ai-workspace.spec.ts',
        'ai-auto-review.spec.ts',
        'top-navigation.spec.ts',
      ],
    },
    { name: 'visual', testMatch: 'visual.spec.ts' },
    { name: 'accessibility', testMatch: 'accessibility.spec.ts' },
    { name: 'performance', testMatch: 'performance.spec.ts' },
    {
      name: 'packaged',
      testMatch: ['packaged.spec.ts', 'ai-auto-review.spec.ts', 'top-navigation.spec.ts'],
    },
    { name: 'dev', testMatch: 'dev.spec.ts' },
  ],
});
