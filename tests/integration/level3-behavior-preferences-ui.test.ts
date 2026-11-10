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
it('applies retained file/accessibility/tab preferences to existing and new views and preserves them on refresh', async () => {
  const home = await mkdtemp(join(tmpdir(), 'axterm-behavior-ui-'));
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
    const { app, page } = await launch();
    await page.locator('[data-terminal-channel=ready]').waitFor();
    await openLevel3Settings(page);
    await page.getByTestId('application-language').click();
    await page.getByRole('option', { name: 'English', exact: true }).click();
    await browserExpect(page.getByTestId('application-language')).toContainText('English');
    const behavior = page.locator('[data-behavior-settings]');
    await behavior
      .getByRole('checkbox', { name: 'Enable terminal screen reader support', exact: true })
      .click();
    await browserExpect(behavior.getByRole('status')).toHaveText('Setting saved.');
    await browserExpect(page.locator('.xterm-accessibility')).toHaveCount(1);
    await behavior.getByRole('checkbox', { name: 'Show session numbers', exact: true }).click();
    await browserExpect(behavior.getByRole('status')).toHaveText('Setting saved.');
    await behavior
      .getByRole('checkbox', { name: 'Switch tabs on pointer hover', exact: true })
      .click();
    await browserExpect(behavior.getByRole('status')).toHaveText('Setting saved.');
    await behavior
      .getByRole('checkbox', {
        name: 'Refresh local and remote files when opening SFTP',
        exact: true,
      })
      .click();
    await browserExpect(behavior.getByRole('status')).toHaveText('Setting saved.');
    await behavior
      .getByRole('textbox', { name: 'External editor executable', exact: true })
      .fill('/usr/bin/true');
    await behavior.getByRole('button', { name: 'Save editor', exact: true }).click();
    await browserExpect(behavior.getByRole('status')).toHaveText('Setting saved.');
    await page.keyboard.press('Escape');
    await app.evaluate(
      ({ app }, cwd) =>
        app.emit('second-instance', {}, ['-tp', 'local', '--title', 'Hover target'], cwd),
      home,
    );
    await browserExpect(page.locator('[data-terminal-channel=ready]')).toHaveCount(2);
    await browserExpect(
      page.locator('[data-terminal-channel=ready] .xterm-accessibility'),
    ).toHaveCount(2);
    const tabs = page.locator('[role=tab][data-tab-id]');
    await browserExpect(tabs.locator('.tab-number')).toHaveCount(0);
    await tabs.first().hover();
    await browserExpect(tabs.first()).toHaveAttribute('aria-selected', 'true');
    await page.reload();
    await browserExpect(page.locator('[role=tab][data-tab-id]')).toHaveCount(2);
    await page.locator('[role=tab][data-tab-id]').last().click();
    await browserExpect(page.locator('[data-terminal-channel=ready]')).toHaveCount(2);
    await browserExpect(page.locator('.xterm-accessibility')).toHaveCount(2);
    await browserExpect(page.locator('[role=tab][data-tab-id] .tab-number')).toHaveCount(0);
    expect(errors).toEqual([]);
    await stop();
  } catch (error) {
    await writeFile(
      'out/level3-migration/sdk/behavior-ui-diagnostic.json',
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
