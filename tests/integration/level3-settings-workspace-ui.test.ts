import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { expect, it } from 'vitest';
import { expect as browserExpect, type ElectronApplication } from '@playwright/test';
import { launchLevel3Desktop, closeLevel3Desktop } from '../fixtures/level3-desktop-launch.ts';
import { openLevel3Settings } from '../support/level3-workspace-actions.ts';

it('restores owned full-page settings and eight destinations without closing or recreating the hidden terminal', async () => {
  const home = await mkdtemp(join(tmpdir(), 'axterm-settings-page-'));
  let app: ElectronApplication | undefined;
  let child: ReturnType<ElectronApplication['process']> | undefined;
  try {
    app = await launchLevel3Desktop({
      executablePath: createRequire(resolve('apps/desktop/package.json'))('electron') as string,
      args: [resolve('apps/desktop'), `--user-data-dir=${home}`],
      env: { ...process.env },
      timeout: 12000,
    });
    child = app.process();
    const page = await app.firstWindow();
    page.setDefaultTimeout(7000);
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    const terminal = page.locator('[data-terminal-channel=ready]');
    await terminal.waitFor();
    const id = await terminal.getAttribute('data-terminal-id');
    await page.setViewportSize({ width: 1440, height: 900 });
    await openLevel3Settings(page);
    const settings = page.locator('[data-configuration-settings]');
    await browserExpect(settings).toBeVisible();
    await browserExpect(terminal).toBeHidden();
    await browserExpect(page.getByRole('dialog')).toHaveCount(0);
    const tabs = page.locator('nav').filter({ has: page.locator('[data-settings-tab=setting]') });
    await browserExpect(tabs.getByRole('button')).toHaveCount(8);
    const bounds = await page.locator('main').boundingBox();
    expect(bounds).toMatchObject({ x: 0, y: 0, width: 1400, height: 900 });
    await settings.locator('[data-settings-category=ai]').click();
    await browserExpect(page.locator('[data-ai-provider-settings] form')).toBeVisible();
    await browserExpect(page.locator('[data-ai-provider-settings] select').first()).toContainText(
      'Pi',
    );
    await settings.locator('[data-settings-category=terminal]').click();
    await browserExpect(
      settings.locator('[data-settings-category-content=terminal]'),
    ).toBeVisible();
    await page.screenshot({
      path: 'out/level3-migration/sdk/settings-page-preview.png',
      animations: 'disabled',
    });
    await tabs.locator('[data-settings-tab=themes]').click();
    await browserExpect(tabs.locator('[data-settings-tab=themes]')).toHaveAttribute(
      'aria-current',
      'page',
    );
    await tabs.locator('[data-settings-destination=triggers]').click();
    await browserExpect(page.locator('[data-configuration-settings]')).toHaveCount(0);
    await browserExpect(tabs.locator('[data-settings-destination=triggers]')).toHaveAttribute(
      'aria-current',
      'page',
    );
    await tabs.locator('[data-settings-tab=profiles]').click();
    await browserExpect(page.getByTestId('connection-profile-form')).toBeVisible();
    const window = await app.browserWindow(page);
    await app.evaluate(({ app }) => app.focus({ steal: true }));
    await window.evaluate((window) => {
      window.show();
      window.focus();
      window.webContents.focus();
    });
    await browserExpect.poll(() => window.evaluate((window) => window.isFocused())).toBe(true);
    await window.evaluate((window) => {
      window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'W', modifiers: ['alt'] });
      window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'W', modifiers: ['alt'] });
    });
    await browserExpect(settings).toHaveCount(0);
    await browserExpect(terminal).toBeVisible();
    expect(await terminal.getAttribute('data-terminal-id')).toBe(id);
    await openLevel3Settings(page);
    await page.keyboard.press('Escape');
    await browserExpect(terminal).toBeVisible();
    const input = terminal.locator('.xterm-helper-textarea');
    await input.pressSequentially("printf 'SETTINGS_%s\\n' SURVIVED");
    await input.press('Enter');
    await browserExpect(terminal.locator('.xterm-rows')).toContainText('SETTINGS_SURVIVED');
    expect(await terminal.getAttribute('data-terminal-id')).toBe(id);
    await browserExpect(page.locator('[data-workspace-global-tabs]').getByRole('tab')).toHaveCount(
      1,
    );
    expect(errors).toEqual([]);
    await closeLevel3Desktop(app);
    expect(child.exitCode).toBe(0);
    app = undefined;
  } finally {
    if (app) {
      if (child?.exitCode === null) child.kill('SIGKILL');
      await app.close().catch(() => {});
    }
    await rm(home, { recursive: true, force: true });
  }
}, 40000);
