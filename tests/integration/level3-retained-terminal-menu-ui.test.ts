import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { expect, it } from 'vitest';
import { expect as browserExpect, type ElectronApplication } from '@playwright/test';
import { launchLevel3Desktop, closeLevel3Desktop } from '../fixtures/level3-desktop-launch.ts';
import { interactionDictionaries } from '../../packages/plugins/terminals/src/client/interactions/locales.ts';
it('retains live selection menu availability, explicit clipboard permission failures and real viewport collision including120x100', async () => {
  const home = await mkdtemp(join(tmpdir(), 'axterm-retained-terminal-menu-'));
  let app: ElectronApplication | undefined;
  try {
    app = await launchLevel3Desktop({
      executablePath: createRequire(resolve('apps/desktop/package.json'))('electron') as string,
      args: [resolve('apps/desktop'), `--user-data-dir=${home}`],
      env: { ...process.env },
      timeout: 12000,
    });
    const page = await app.firstWindow();
    await app.evaluate(({ BrowserWindow }) => {
      for (const window of BrowserWindow.getAllWindows()) window.hide();
    });
    page.setDefaultTimeout(5000);
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.locator('[data-terminal-channel=ready]').waitFor();
    await page.setViewportSize({ width: 1000, height: 760 });
    const lang = await page.locator('html').getAttribute('lang'),
      text =
        interactionDictionaries[lang as keyof typeof interactionDictionaries] ??
        interactionDictionaries.en;
    const terminal = page.locator('[data-terminal-id]').first(),
      canvas = terminal.locator('.terminal-canvas'),
      input = terminal.locator('.xterm-helper-textarea'),
      menu = page.locator('.terminal-context-menu');
    await input.fill("printf '\\nAXTERM_MENU_RETAINED_PROBE\\n'");
    await input.press('Enter');
    await browserExpect(canvas).toContainText('AXTERM_MENU_RETAINED_PROBE');
    await terminal.dispatchEvent('contextmenu', { clientX: 980, clientY: 740 });
    await browserExpect(menu).toBeVisible();
    for (const key of [
      'interaction.copy',
      'interaction.pasteSelected',
      'terminal.explainWithAi',
    ] as const)
      await browserExpect(
        menu.getByRole('menuitem', { name: text[key], exact: true }),
      ).toBeDisabled();
    for (const key of [
      'interaction.paste',
      'interaction.selectAll',
      'interaction.clear',
      'interaction.search',
    ] as const)
      await browserExpect(
        menu.getByRole('menuitem', { name: text[key], exact: true }),
      ).toBeEnabled();
    await browserExpect
      .poll(() =>
        menu.evaluate((el) => {
          const r = el.getBoundingClientRect();
          return r.x >= 0 && r.y >= 0 && r.right <= innerWidth + 1 && r.bottom <= innerHeight + 1;
        }),
      )
      .toBe(true);
    await menu.getByRole('menuitem', { name: text['interaction.selectAll'], exact: true }).click();
    await terminal.dispatchEvent('contextmenu', { clientX: 500, clientY: 400 });
    for (const key of [
      'interaction.copy',
      'interaction.pasteSelected',
      'terminal.explainWithAi',
    ] as const)
      await browserExpect(
        menu.getByRole('menuitem', { name: text[key], exact: true }),
      ).toBeEnabled();
    await page.evaluate(() =>
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: {
          writeText: async () => {
            throw Error('private-runtime-problem-title');
          },
          readText: async () => {
            throw Error('private-host-clipboard-detail');
          },
        },
      }),
    );
    await menu
      .getByRole('menuitem', { name: text['interaction.copy'], exact: true })
      .evaluate((button) => (button as HTMLButtonElement).click());
    await browserExpect(terminal.getByRole('alert')).toContainText(
      text['terminal.clipboardCopyError'],
    );
    await browserExpect(page.locator('body')).not.toContainText('private-runtime-problem-title');
    await terminal.dispatchEvent('contextmenu', { clientX: 500, clientY: 400 });
    await menu
      .getByRole('menuitem', { name: text['interaction.paste'], exact: true })
      .evaluate((button) => (button as HTMLButtonElement).click());
    await browserExpect(terminal.getByRole('alert')).toContainText(
      text['terminal.clipboardPasteError'],
    );
    await browserExpect(page.locator('body')).not.toContainText('private-host-clipboard-detail');
    await page.setViewportSize({ width: 120, height: 100 });
    expect(await page.evaluate(() => ({ width: innerWidth, height: innerHeight }))).toEqual({
      width: 120,
      height: 100,
    });
    await terminal.dispatchEvent('contextmenu', { clientX: -20, clientY: -5 });
    await browserExpect(menu).toBeVisible();
    await browserExpect
      .poll(() =>
        menu.evaluate((el) => {
          const r = el.getBoundingClientRect();
          return r.x >= 0 && r.y >= 0 && r.right <= innerWidth + 1 && r.bottom <= innerHeight + 1;
        }),
      )
      .toBe(true);
    await page.keyboard.press('Escape');
    expect(errors).toEqual([]);
  } finally {
    if (app) await closeLevel3Desktop(app);
    await rm(home, { recursive: true, force: true });
  }
}, 20000);
