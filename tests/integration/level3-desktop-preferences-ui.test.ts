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
it('applies owned window preferences and global key, retains them across refresh and persists DSH window zoom', async () => {
  const home = await mkdtemp(join(tmpdir(), 'axterm-window-preferences-')),
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
    stage = 'window preferences';
    await openLevel3Settings(page);
    await page.getByTestId('application-language').click();
    await page.getByRole('option', { name: 'English', exact: true }).click();
    await browserExpect(page.getByTestId('application-language')).toContainText('English');
    const form = page.locator('[data-desktop-window-preferences]');
    await form.waitFor();
    await form.getByRole('spinbutton', { name: /^Window opacity/ }).fill('0.9');
    await form.getByRole('spinbutton', { name: /^Interface zoom/ }).fill('1.25');
    await form.getByRole('button', { name: 'Save window preferences', exact: true }).click();
    const window = await application.browserWindow(page);
    await expect
      .poll(() => window.evaluate((target) => target.webContents.getZoomFactor()))
      .toBe(1.25);
    await expect.poll(() => window.evaluate((target) => target.getOpacity())).toBeCloseTo(0.9, 1);
    await page.keyboard.press('Escape');
    await page.reload();
    await page.locator('[data-terminal-channel=ready]').waitFor();
    await openLevel3Settings(page);
    await browserExpect(form.getByRole('spinbutton', { name: /^Window opacity/ })).toHaveValue(
      '0.9',
    );
    await browserExpect(form.getByRole('spinbutton', { name: /^Interface zoom/ })).toHaveValue(
      '1.25',
    );
    await page.locator('[data-settings-category=shortcuts]').click();
    const global = page.locator('[data-desktop-global-hotkey]');
    await global.getByRole('button', { name: 'Edit', exact: true }).click();
    const editor = page.locator('[data-desktop-global-editor]'),
      capture = editor.locator('.shortcut-capture');
    await browserExpect(capture).toHaveAttribute('tabindex', '0');
    await capture.focus();
    await capture.press('Alt+Shift+U');
    await editor.getByRole('button', { name: 'Apply', exact: true }).click();
    await browserExpect(editor).toHaveCount(0);
    await browserExpect(global.locator('kbd')).toContainText('U');
    expect(
      await application.evaluate(({ globalShortcut }) =>
        globalShortcut.isRegistered('Alt+Shift+U'),
      ),
    ).toBe(true);
    await global.getByRole('button', { name: 'Edit', exact: true }).click();
    await browserExpect(capture).toHaveAttribute('tabindex', '0');
    expect(
      await application.evaluate(({ globalShortcut }) =>
        globalShortcut.isRegistered('Alt+Shift+U'),
      ),
    ).toBe(false);
    await editor.getByRole('button', { name: 'Disable', exact: true }).click();
    await browserExpect(editor).toHaveCount(0);
    expect(
      await application.evaluate(({ globalShortcut }) =>
        globalShortcut.isRegistered('Alt+Shift+U'),
      ),
    ).toBe(false);
    await page.keyboard.press('Escape');
    await (
      await application.browserWindow(page)
    ).evaluate((target) => {
      target.isFocused = () => true;
      target.webContents.sendInputEvent({ type: 'keyDown', keyCode: '=', modifiers: ['meta'] });
      target.webContents.sendInputEvent({ type: 'keyUp', keyCode: '=', modifiers: ['meta'] });
    });
    await expect
      .poll(() => window.evaluate((target) => target.webContents.getZoomFactor()))
      .toBe(1.4);
    await page.reload();
    await page.locator('[data-terminal-channel=ready]').waitFor();
    await expect
      .poll(() => window.evaluate((target) => target.webContents.getZoomFactor()))
      .toBe(1.4);
    await browserExpect(tab).toHaveAttribute('aria-controls', id!);
    expect(errors).toEqual([]);
    await application.evaluate(async () => {
      await (globalThis as unknown as { shell: DesktopShell }).shell.stop();
    });
  } catch (error) {
    await writeFile(
      'out/level3-migration/sdk/window-preferences-ui-diagnostic.json',
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
