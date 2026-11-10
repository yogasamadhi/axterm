import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { expect, it } from 'vitest';
import type { ElectronApplication } from '@playwright/test';
import { launchLevel3Desktop, closeLevel3Desktop } from '../fixtures/level3-desktop-launch.ts';

it('boots the real ESM Desktop entry past data-copy preflight and drains its Host on explicit exit', async () => {
  const home = await mkdtemp(join(tmpdir(), 'axterm-main-ready-'));
  let app: ElectronApplication | undefined;
  let nativeProcess: ReturnType<ElectronApplication['process']> | undefined;
  try {
    app = await launchLevel3Desktop({
      executablePath: createRequire(resolve('apps/desktop/package.json'))('electron') as string,
      args: [resolve('apps/desktop'), `--user-data-dir=${home}`],
      env: { ...process.env },
      timeout: 12000,
    });
    nativeProcess = app.process();
    const page = await app.firstWindow({ timeout: 8000 });
    await page.locator('[data-terminal-channel=ready]').waitFor({ timeout: 8000 });
    expect(await page.locator('[data-axterm-product-workspace]').count()).toBe(1);
    expect(await page.locator('body').innerText()).not.toContain('Failed to load plugins');
    await closeLevel3Desktop(app);
    expect(nativeProcess.exitCode).toBe(0);
    app = undefined;
  } finally {
    if (app) {
      if (nativeProcess?.exitCode === null) nativeProcess.kill('SIGKILL');
      await app.close().catch(() => {});
    }
    await rm(home, { recursive: true, force: true });
  }
}, 25000);
