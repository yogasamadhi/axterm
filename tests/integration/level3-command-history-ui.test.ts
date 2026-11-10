import { openLevel3Settings } from '../support/level3-workspace-actions.ts';
import { historyDictionaries } from '../../packages/plugins/terminals/src/client/history/locales.ts';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import {
  _electron as electron,
  type ElectronApplication,
  expect as browserExpect,
} from '@playwright/test';
import { expect, it } from 'vitest';
import type { DesktopShell } from '../../apps/desktop/src/shell/application.ts';
it('records safe shell history once across native windows and reload, inserts drafts without execution and purges on opt-out', async () => {
  const home = await mkdtemp(join(tmpdir(), 'axterm-command-history-')),
    errors: string[] = [];
  let application: ElectronApplication | undefined;
  let stage = 'launch';
  try {
    await mkdir(join(home, 'desktop'));
    const entry = join(home, 'shell.mjs');
    await writeFile(
      entry,
      `import{app,protocol}from'electron';import{DesktopShell}from${JSON.stringify(pathToFileURL(resolve('apps/desktop/lib/shell/application.js')).href)};protocol.registerSchemesAsPrivileged([{scheme:'axterm-app',privileges:{standard:true,secure:true,supportFetchAPI:true,corsEnabled:true,stream:true}}]);app.setPath('userData',${JSON.stringify(join(home, 'desktop'))});app.whenReady().then(()=>{globalThis.shell=new DesktopShell({home:${JSON.stringify(home)},webRoot:${JSON.stringify(resolve('apps/web/dist'))},hostEntry:${JSON.stringify(resolve('apps/desktop-host/lib/index.js'))},preload:${JSON.stringify(resolve('apps/desktop/lib/shell/preload.cjs'))},environment:{...process.env,SHELL:'/bin/bash'},visible:false,confirmQuit:async()=>true,recover:async()=> 'quit'});globalThis.shell.start();app.emit('second-instance',{},['-tp','local','--title','Native Primary'],${JSON.stringify(home)});});`,
    );
    application = await electron.launch({
      executablePath: createRequire(resolve('apps/desktop/package.json'))('electron') as string,
      args: [entry],
      env: {
        ...process.env,
        HOME: home,
        ZDOTDIR: home,
        AXTERM_HOME: home,
        HTTP_PROXY: '',
        HTTPS_PROXY: '',
        ALL_PROXY: '',
      },
      timeout: 10000,
    });
    stage = 'first-window';
    const page = await application.firstWindow({ timeout: 7000 });
    stage = 'workspace';
    page.setDefaultTimeout(7000);
    page.on('pageerror', (error) => errors.push(error.message));
    const root = page.locator('[data-axterm-product-workspace]');
    const first = page.getByRole('tab', { name: 'Native Primary', exact: true });
    await first.waitFor();
    await page.locator('[data-terminal-channel=ready]').waitFor();
    await browserExpect(root).toHaveAttribute('data-workspace-presentation', 'ready');
    stage = 'shell-integration';
    const primaryId = await first.getAttribute('aria-controls');
    await page
      .locator('.terminal-canvas[data-shell-integration=active]')
      .waitFor({ timeout: 10000 });
    const lang = await page.locator('html').getAttribute('lang');
    const text =
      historyDictionaries[lang as keyof typeof historyDictionaries] ?? historyDictionaries.en;
    stage = 'history-opt-in';
    const popup = page.locator('.command-history-popover');
    const open = async () => {
      if (!(await popup.isVisible())) await page.locator('.status-command-history').click();
    };
    await open();
    await page.getByRole('button', { name: text['commandHistory.enable'], exact: true }).click();
    await browserExpect(popup.locator('.command-history-list')).toBeVisible();
    const effects = join(home, 'effects.txt'),
      command = `printf HIST_ONCE >> '${effects}'`;
    await page.locator('.status-command-history').click();
    const submit = async (value: string) => {
      const input = page.locator('.xterm-helper-textarea').first();
      await input.fill(value);
      await input.press('Enter');
    };
    stage = 'first-command';
    await submit(command);
    await browserExpect
      .poll(() => readFile(effects, 'utf8').catch(() => ''), { timeout: 7000 })
      .toBe('HIST_ONCE');
    await open();
    await browserExpect(popup.locator('.command-history-item-text')).toHaveText(command);
    await browserExpect(popup.locator('.command-history-count')).toHaveText('1');
    stage = 'reload';
    await page.reload();
    await page.locator('.terminal-canvas[data-shell-integration=active]').waitFor();
    await open();
    await browserExpect(popup.locator('.command-history-count')).toHaveText('1');
    stage = 'second-viewer';
    const opened = application.waitForEvent('window', { timeout: 7000 });
    await application.evaluate(() => {
      (globalThis as unknown as { shell: DesktopShell }).shell.createWindow();
    });
    const other = await opened;
    other.setDefaultTimeout(7000);
    other.on('pageerror', (error) => errors.push(error.message));
    await other.locator('[data-workspace-global-tabs]').getByRole('tab').first().click();
    await other.locator('[data-terminal-channel=ready]').waitFor({ state: 'attached' });
    stage = 'second-command';
    await page.locator('.status-command-history').click();
    await submit(command);
    await browserExpect
      .poll(() => readFile(effects, 'utf8').catch(() => ''), { timeout: 7000 })
      .toBe('HIST_ONCEHIST_ONCE');
    await open();
    await browserExpect(popup.locator('.command-history-count')).toHaveText('2');
    await popup.locator('.command-history-search-field input').fill('no-such-command');
    await browserExpect(popup.locator('.command-history-item-text')).toHaveCount(0);
    await popup.locator('.command-history-search-field input').fill('HIST_ONCE');
    await browserExpect(popup.locator('.command-history-item-text')).toHaveText(command);
    await popup.locator('.command-history-item-text').click();
    await browserExpect(popup).toHaveCount(0);
    expect(await readFile(effects, 'utf8')).toBe('HIST_ONCEHIST_ONCE');
    await page.locator('.xterm-helper-textarea').first().press('Control+u');
    await openLevel3Settings(page);
    await page.locator('[data-settings-category=terminal]').click();
    stage = 'privacy-opt-out';
    const historyToggle = page.getByRole('checkbox', {
      name: text['commandHistory.enabled'],
      exact: true,
    });
    await historyToggle.click();
    await browserExpect(historyToggle).not.toBeChecked();
    await page.keyboard.press('Escape');
    await open();
    await browserExpect(popup.locator('.command-history-disabled')).toBeVisible();
    await page.getByRole('button', { name: text['commandHistory.enable'], exact: true }).click();
    await browserExpect(popup.locator('.command-history-item-text')).toHaveCount(0);
    await browserExpect(
      page.getByRole('tab', { name: 'Native Primary', exact: true }),
    ).toHaveAttribute('aria-controls', primaryId!);
    expect(errors).toEqual([]);
  } catch (error) {
    await writeFile(
      'out/level3-migration/sdk/history-ui-diagnostic.json',
      JSON.stringify(
        {
          stage,
          crashes: await Promise.all(
            (await readdir(join(home, 'desktop/crashes')).catch(() => []))
              .filter((name) => name.endsWith('.json'))
              .map((name) => readFile(join(home, 'desktop/crashes', name), 'utf8')),
          ),
          errors,
          bodies: await Promise.all(
            application?.windows().map((page) =>
              page
                .locator('body')
                .innerText()
                .catch(() => '<unavailable>'),
            ) ?? [],
          ),
        },
        null,
        2,
      ),
    );
    throw error;
  } finally {
    if (application) {
      await application
        .evaluate(async () => {
          await (globalThis as unknown as { shell: DesktopShell }).shell.stop();
        })
        .catch(() => {});
      await application.close().catch(() => {});
    }
    await rm(home, { recursive: true, force: true });
  }
}, 30000);
