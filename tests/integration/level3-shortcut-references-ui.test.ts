import { openLevel3Section } from '../support/level3-workspace-actions.ts';
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
it('retains Quick Command shortcut metadata as a conflict reference without replacing application bindings', async () => {
  const home = await mkdtemp(join(tmpdir(), 'axterm-shortcut-references-')),
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
    stage = 'metadata';
    await openLevel3Settings(page);
    await page.getByTestId('application-language').click();
    await page.getByRole('option', { name: 'English', exact: true }).click();
    await browserExpect(page.getByTestId('application-language')).toContainText('English');
    await page.keyboard.press('Escape');
    await openLevel3Section(page, 'commands');
    const root = page.locator('.automation-root');
    await root
      .locator('.quick-command-toolbar')
      .getByRole('button', { name: 'New quick command', exact: true })
      .click();
    const form = root.locator('.quick-command-form');
    await form.getByLabel('Name', { exact: true }).fill('Metadata conflict');
    await form.getByLabel('Shortcut', { exact: true }).fill('Option+Shift+Z');
    await form
      .getByRole('textbox', { name: 'Step 1 command', exact: true })
      .fill('printf METADATA_ONLY');
    await form.getByRole('button', { name: 'Save', exact: true }).click();
    await root.getByRole('treeitem', { name: /Metadata conflict/ }).waitFor();
    await openLevel3Settings(page);
    await page.locator('[data-settings-category=shortcuts]').click();
    const preferences = page.locator('[data-shortcut-preferences]');
    await preferences
      .locator('[data-shortcut-action="app_newTab"]')
      .getByRole('button', { name: 'Edit New local terminal', exact: true })
      .click();
    const capture = preferences.locator('.shortcut-editor .shortcut-capture');
    await browserExpect(capture).toHaveAttribute('tabindex', '0');
    await capture.focus();
    await capture.press('Alt+Shift+Z');
    await browserExpect(preferences.locator('.shortcut-editor')).toContainText('Metadata conflict');
    await preferences
      .locator('.shortcut-editor')
      .getByRole('button', { name: 'Apply', exact: true })
      .click();
    await browserExpect(preferences.locator('.shortcut-editor')).toBeVisible();
    await preferences
      .locator('.shortcut-editor')
      .getByRole('button', { name: 'Cancel', exact: true })
      .click();
    await browserExpect(preferences.locator('[data-shortcut-action="app_newTab"]')).toContainText(
      'Q',
    );
    await page.keyboard.press('Escape');
    expect(errors).toEqual([]);
    await application.evaluate(async () => {
      await (globalThis as unknown as { shell: DesktopShell }).shell.stop();
    });
  } catch (error) {
    await writeFile(
      'out/level3-migration/sdk/references-ui-diagnostic.json',
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
