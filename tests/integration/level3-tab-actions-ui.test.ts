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
it('duplicates captured tabs on double-click, closes on middle-click and keeps assigned numbers after moving', async () => {
  const home = await mkdtemp(join(tmpdir(), 'axterm-tab-actions-ui-'));
  let application: ElectronApplication | undefined;
  const stage = 'preferences';
  const errors: string[] = [];
  try {
    await mkdir(join(home, 'desktop'));
    const entry = join(home, 'shell.mjs');
    const launch = async (native = false) => {
      await writeFile(
        entry,
        `import{app,protocol}from'electron';import{DesktopShell}from${JSON.stringify(pathToFileURL(resolve('apps/desktop/lib/shell/application.js')).href)};protocol.registerSchemesAsPrivileged([{scheme:'axterm-app',privileges:{standard:true,secure:true,supportFetchAPI:true,corsEnabled:true,stream:true}}]);app.setPath('userData',${JSON.stringify(join(home, 'desktop'))});app.whenReady().then(()=>{globalThis.shell=new DesktopShell({home:${JSON.stringify(home)},webRoot:${JSON.stringify(resolve('apps/web/dist'))},hostEntry:${JSON.stringify(resolve('apps/desktop-host/lib/index.js'))},preload:${JSON.stringify(resolve('apps/desktop/lib/shell/preload.cjs'))},environment:{...process.env,SHELL:'/bin/bash'},visible:false,confirmQuit:async()=>true,recover:async()=> 'quit'});globalThis.shell.start();${native ? `app.emit('second-instance',{},['-tp','local','--title','Native takes priority'],${JSON.stringify(home)});` : ''}});`,
      );
      const app = await electron.launch({
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
      application = app;
      const page = await app.firstWindow({ timeout: 7000 });
      page.setDefaultTimeout(6000);
      page.on('pageerror', (error) => errors.push(error.message));
      return { app, page };
    };
    const stop = async () => {
      const app = application!;
      await app.evaluate(async () => {
        await (globalThis as unknown as { shell: DesktopShell }).shell.stop();
      });
      const child = app.process();
      await app.close();
      if (child.exitCode === null) child.kill('SIGKILL');
      application = undefined;
    };
    const { page } = await launch();
    await page.locator('[data-terminal-channel=ready]').waitFor();
    await openLevel3Settings(page);
    await page.getByTestId('application-language').click();
    await page.getByRole('option', { name: 'English', exact: true }).click();
    await browserExpect(page.getByTestId('application-language')).toContainText('English');
    await page.keyboard.press('Escape');
    const tabs = page.locator('[role=tab][data-tab-id]'),
      original = await tabs.first().getAttribute('data-tab-id');
    await tabs.first().dblclick();
    await browserExpect(tabs).toHaveCount(2);
    await browserExpect(page.locator('[data-terminal-channel=ready]')).toHaveCount(2);
    const duplicate = tabs.filter({ has: page.locator('.tab-number', { hasText: '2' }) });
    await browserExpect(duplicate).toHaveCount(1);
    await duplicate.click({ button: 'middle' });
    await browserExpect(tabs).toHaveCount(1);
    await browserExpect(tabs.first()).toHaveAttribute('data-tab-id', original!);
    await page.getByRole('button', { name: 'Layout', exact: true }).click();
    await page.locator('[data-layout-choice=c2]').click();
    await tabs.first().dblclick();
    await browserExpect(page.locator('[data-terminal-channel=ready]')).toHaveCount(2);
    const global = page.locator('[role=tablist]').first().locator('[role=tab][data-tab-id]');
    await browserExpect(global).toHaveCount(2);
    await global.last().focus();
    await page.keyboard.press('Alt+Shift+ArrowLeft');
    await browserExpect(global.first().locator('.tab-number')).not.toHaveText('1');
    await browserExpect(global.last().locator('.tab-number')).toHaveText('1');
    expect(errors).toEqual([]);
    await stop();
  } catch (error) {
    await writeFile(
      'out/level3-migration/sdk/tab-actions-ui-diagnostic.json',
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
      const child = application.process();
      await application.close().catch(() => undefined);
      if (child.exitCode === null) child.kill('SIGKILL');
    }
    await rm(home, { recursive: true, force: true });
  }
}, 30_000);
