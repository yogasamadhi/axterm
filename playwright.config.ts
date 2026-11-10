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
        'level3-legal.spec.ts',
        'level3-ftp-widget.spec.ts',
        'level3-terminal-transfer.spec.ts',
        'level3-windows-terminal.spec.ts',
        'level3-platform-window.spec.ts',
        'level3-retained-native.spec.ts',
        'level3-retained-history.spec.ts',
        'pi-engine.spec.ts',
        'level3-terminal-selection.spec.ts',
        'level3-terminal-explanation.spec.ts',
        'top-navigation.spec.ts',
      ],
    },
    { name: 'visual', testMatch: 'visual.spec.ts' },
    { name: 'accessibility', testMatch: 'accessibility.spec.ts' },
    { name: 'performance', testMatch: 'performance.spec.ts' },
    {
      name: 'packaged',
      testMatch: [
        'level3-windows-terminal.spec.ts',
        'level3-platform-window.spec.ts',
        'level3-platform-artifacts.spec.ts',
        'top-navigation.spec.ts',
        'level3-terminal-transfer.spec.ts',
        'level3-legal.spec.ts',
        'level3-ftp-widget.spec.ts',
      ],
    },
    { name: 'dev', testMatch: 'dev.spec.ts' },
  ],
});
