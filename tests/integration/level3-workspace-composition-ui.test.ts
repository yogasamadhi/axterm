import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { expect, it } from 'vitest';
import { expect as browserExpect, type ElectronApplication } from '@playwright/test';
import { launchLevel3Desktop, closeLevel3Desktop } from '../fixtures/level3-desktop-launch.ts';

it('keeps owner actions alive behind the closed chrome menu, preserves rail ordering and routes actual Settings and AI actions', async () => {
  const home = await mkdtemp(join(tmpdir(), 'axterm-composed-chrome-'));
  let app: ElectronApplication | undefined,
    nativeProcess: ReturnType<ElectronApplication['process']> | undefined;
  try {
    app = await launchLevel3Desktop({
      executablePath: createRequire(resolve('apps/desktop/package.json'))('electron') as string,
      args: [resolve('apps/desktop'), `--user-data-dir=${home}`],
      env: { ...process.env },
      timeout: 12000,
    });
    nativeProcess = app.process();
    const page = await app.firstWindow();
    page.setDefaultTimeout(7000);
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.locator('[data-terminal-channel=ready]').waitFor();
    await page.setViewportSize({ width: 1440, height: 900 });
    const more = page.getByRole('button', { name: '更多操作', exact: true });
    await browserExpect(page.locator('[data-workspace-more-actions]')).toBeHidden();
    await page.locator('[data-activity-item=setting]').click();
    await browserExpect(page.getByTestId('application-language')).toBeVisible();
    await page.keyboard.press('Escape');
    await browserExpect(page.locator('[data-configuration-settings]')).toBeHidden();
    await more.click();
    await browserExpect(page.locator('[data-workspace-more-actions]')).toBeVisible();
    await browserExpect(page.locator('[data-catalog-import-trigger]')).toBeVisible();
    await browserExpect(page.locator('[data-catalog-new-bookmark]')).toBeVisible();
    await page.keyboard.press('Escape');
    await browserExpect(page.locator('[data-workspace-more-actions]')).toBeHidden();
    expect(await more.evaluate((element) => element.ownerDocument.activeElement === element)).toBe(
      true,
    );
    await browserExpect(page.getByRole('tab', { name: '本地 1', exact: true })).toBeVisible();
    if (!(await page.locator('[data-catalog-manager-open]').isVisible()))
      await page.locator('[data-activity-item=bookmarks]').click();
    await page.locator('[data-catalog-manager-open]').click();
    await browserExpect(page.locator('[data-catalog-manager] .host-manager-toolbar')).toHaveCSS(
      'grid-template-columns',
      '242px 242px',
    );
    await browserExpect(page.locator('[data-catalog-manager]')).toHaveCSS(
      'background-color',
      'rgb(37, 37, 37)',
    );
    await page.getByRole('button', { name: 'AI 助手', exact: true }).click();
    await browserExpect(page.locator('.ai-panel-embedded')).toBeVisible();
    expect(await page.locator('.activity-bar nav button').count()).toBe(4);
    await page.getByRole('button', { name: '关闭 AI 助手', exact: true }).click();
    await browserExpect(page.locator('.ai-inspector')).toBeHidden();
    await page.locator('[data-ai-sidebar-toggle]').click();
    await page.locator('[data-ai-open-workspace]').click();
    await browserExpect(page.getByRole('dialog')).toBeVisible();
    await page.keyboard.press('Escape');
    await browserExpect(page.getByRole('tab', { name: 'AI 助手', exact: true })).toBeVisible();
    expect(errors).toEqual([]);
    await closeLevel3Desktop(app);
    app = undefined;
  } finally {
    if (app) {
      if (nativeProcess?.exitCode === null) nativeProcess.kill('SIGKILL');
      await app.close().catch(() => {});
    }
    await rm(home, { recursive: true, force: true });
  }
}, 25000);
