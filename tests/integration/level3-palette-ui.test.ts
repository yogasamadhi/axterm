import { openLevel3Settings } from '../support/level3-workspace-actions.ts';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
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
it('opens the owned palette, searches captured terminal actions and switches sidebar/session without recreating resources', async () => {
  const home = await mkdtemp(join(tmpdir(), 'axterm-palette-')),
    errors: string[] = [];
  let application: ElectronApplication | undefined,
    stage = 'launch';
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
    const page = await application.firstWindow({ timeout: 7000 });
    page.setDefaultTimeout(7000);
    page.on('pageerror', (error) => errors.push(error.message));
    const tab = page.getByRole('tab', { name: 'Native Primary', exact: true });
    await tab.waitFor();
    await page.locator('[data-terminal-channel=ready]').waitFor();
    const id = await tab.getAttribute('aria-controls');
    stage = 'palette';
    await openLevel3Settings(page);
    await page.getByTestId('application-language').click();
    await page.getByRole('option', { name: 'English', exact: true }).click();
    await browserExpect(page.getByTestId('application-language')).toContainText('English');
    await page.keyboard.press('Escape');
    const shell = page.locator('[data-axterm-product-workspace]');
    const before = await shell.getAttribute('data-sidebar');
    await page.locator('.xterm-helper-textarea').focus();
    await page.keyboard.press('Meta+b');
    await browserExpect(shell).toHaveAttribute(
      'data-sidebar',
      before === 'open' ? 'closed' : 'open',
    );
    await page.keyboard.press('Meta+b');
    await browserExpect(shell).toHaveAttribute('data-sidebar', before!);
    await page.keyboard.press('Meta+k');
    const palette = page.locator('.command-palette');
    await palette.waitFor();
    await browserExpect(palette).toHaveAttribute('aria-label', 'Command palette');
    const query = palette.getByRole('combobox');
    await browserExpect(query).toBeFocused();
    await query.fill('Search terminal');
    const action = palette.locator('[data-palette-id="shortcut:terminal.search"]');
    await action.waitFor();
    await browserExpect(action).toHaveAttribute('aria-disabled', 'false');
    await query.press('Enter');
    await browserExpect(palette).toHaveCount(0);
    await page.locator('.terminal-search').waitFor();
    await page.keyboard.press('Escape');
    await page.locator('.xterm-helper-textarea').focus();
    await page.keyboard.press('Meta+k');
    await palette.waitFor();
    await query.fill('Native Primary');
    const session = palette
      .locator('[data-palette-id^="session:"]')
      .filter({ hasText: 'Native Primary' });
    await session.click();
    await browserExpect(tab).toHaveAttribute('aria-controls', id!);
    await page.locator('.xterm-helper-textarea').focus();
    await page.keyboard.press('Meta+k');
    await palette.waitFor();
    await query.fill('no-such-action-135779');
    await browserExpect(palette.getByRole('status')).toBeVisible();
    await query.press('Escape');
    await browserExpect(palette).toHaveCount(0);
    expect(errors).toEqual([]);
    await application.evaluate(async () => {
      await (globalThis as unknown as { shell: DesktopShell }).shell.stop();
    });
  } catch (error) {
    await writeFile(
      'out/level3-migration/sdk/palette-ui-diagnostic.json',
      JSON.stringify(
        {
          stage,
          errors,
          console: await application
            ?.windows()[0]
            ?.consoleMessages()
            .then((messages) =>
              messages.map((message) => ({ type: message.type(), text: message.text() })),
            ),
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
