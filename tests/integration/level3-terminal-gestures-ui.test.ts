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
it('retains reviewed wheel bindings across physical shortcut saves, refresh and one explicit default reset', async () => {
  const home = await mkdtemp(join(tmpdir(), 'axterm-terminal-gestures-')),
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
    stage = 'settings';
    await openLevel3Settings(page);
    await page.getByTestId('application-language').click();
    await page.getByRole('option', { name: 'English', exact: true }).click();
    await page.locator('[data-settings-category=shortcuts]').click();
    const preferences = page.locator('[data-shortcut-preferences]'),
      row = preferences.locator('[data-shortcut-gesture=terminal_zoominTerminal]');
    await row.waitFor();
    await row
      .getByRole('button', { name: 'Edit Increase terminal font size', exact: true })
      .click();
    const editor = preferences.locator('[data-terminal-gesture-editor]'),
      capture = editor.locator('.shortcut-capture');
    await browserExpect(capture).toHaveAttribute('tabindex', '0');
    await capture.press('Tab');
    await browserExpect(capture.locator('button').first()).toBeFocused();
    await capture.focus();
    await capture.press('Backspace');
    await capture.dispatchEvent('wheel', { deltaY: -1, ctrlKey: true, shiftKey: true });
    await browserExpect(capture.locator('kbd')).toHaveText('ctrl+shift+wheelup');
    await editor.getByRole('button', { name: 'Apply', exact: true }).click();
    await editor.waitFor({ state: 'hidden' });
    await browserExpect(row.locator('kbd')).toContainText('Shift');
    stage = 'physical-preservation';
    await preferences
      .locator('[data-shortcut-action=app_newTab]')
      .getByRole('button', { name: 'Edit New local terminal', exact: true })
      .click();
    const physical = page.getByRole('dialog', { name: 'Edit shortcut', exact: true });
    await physical.locator('[data-shortcut-recording]').focus();
    await physical.locator('[data-shortcut-recording]').press('Alt+z');
    await physical.getByRole('button', { name: 'Apply', exact: true }).click();
    await physical.waitFor({ state: 'hidden' });
    await browserExpect(row.locator('kbd')).toContainText('Shift');
    await page.keyboard.press('Escape');
    stage = 'live-wheel';
    await page
      .locator('[data-terminal-channel=ready]')
      .dispatchEvent('wheel', { deltaY: -1, ctrlKey: true, shiftKey: true });
    const input = page.locator('.xterm-helper-textarea').first();
    await input.fill("printf 'GESTURE_PTY_ALIVE\n'");
    await input.press('Enter');
    await browserExpect(page.locator('.terminal-canvas')).toContainText('GESTURE_PTY_ALIVE');
    await browserExpect(tab).toHaveAttribute('aria-controls', id!);
    stage = 'refresh';
    await page.reload();
    await page.locator('[data-terminal-channel=ready]').waitFor();
    await openLevel3Settings(page);
    await page.locator('[data-settings-category=shortcuts]').click();
    await browserExpect(row.locator('kbd')).toContainText('Shift');
    await browserExpect(preferences.locator('[data-shortcut-action=app_newTab] kbd')).toContainText(
      'Z',
    );
    stage = 'atomic-reset';
    await preferences.getByRole('button', { name: 'Restore defaults', exact: true }).click();
    await browserExpect(row.locator('kbd')).not.toContainText('Shift');
    await browserExpect(preferences.locator('[data-shortcut-action=app_newTab] kbd')).toContainText(
      'Q',
    );
    await page.keyboard.press('Escape');
    expect(errors).toEqual([]);
    await application.evaluate(async () => {
      await (globalThis as unknown as { shell: DesktopShell }).shell.stop();
    });
  } catch (error) {
    await writeFile(
      'out/level3-migration/sdk/gestures-ui-diagnostic.json',
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
