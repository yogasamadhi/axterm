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
it('saves and selects a named layout, persists it across a cold Host and explicitly recreates its session without cold replay', async () => {
  const home = await mkdtemp(join(tmpdir(), 'axterm-named-ui-'));
  let application: ElectronApplication | undefined,
    stage = 'launch';
  const errors: string[] = [];
  try {
    await mkdir(join(home, 'desktop'));
    const entry = join(home, 'shell.mjs');
    await writeFile(
      entry,
      `import{app,protocol}from'electron';import{DesktopShell}from${JSON.stringify(pathToFileURL(resolve('apps/desktop/lib/shell/application.js')).href)};protocol.registerSchemesAsPrivileged([{scheme:'axterm-app',privileges:{standard:true,secure:true,supportFetchAPI:true,corsEnabled:true,stream:true}}]);app.setPath('userData',${JSON.stringify(join(home, 'desktop'))});app.whenReady().then(()=>{globalThis.shell=new DesktopShell({home:${JSON.stringify(home)},webRoot:${JSON.stringify(resolve('apps/web/dist'))},hostEntry:${JSON.stringify(resolve('apps/desktop-host/lib/index.js'))},preload:${JSON.stringify(resolve('apps/desktop/lib/shell/preload.cjs'))},environment:{...process.env,SHELL:'/bin/bash'},visible:false,confirmQuit:async()=>true,recover:async()=> 'quit'});globalThis.shell.start();});`,
    );
    const launch = async () => {
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
      page.setDefaultTimeout(5000);
      page.on('pageerror', (error) => errors.push(error.message));
      await page.locator('[data-workspace-presentation=ready]').waitFor();
      return { app, page };
    };
    let { app, page } = await launch();
    await app.evaluate(
      ({ app }, cwd) =>
        app.emit('second-instance', {}, ['-tp', 'local', '--title', 'Saved Session'], cwd),
      home,
    );
    const tab = page.getByRole('tab', { name: 'Saved Session', exact: true });
    await tab.waitFor();
    await page.locator('[data-terminal-channel=ready]').waitFor();
    const original = await tab.getAttribute('aria-controls');
    await openLevel3Settings(page);
    await page.getByTestId('application-language').click();
    await page.getByRole('option', { name: 'English', exact: true }).click();
    await browserExpect(page.getByTestId('application-language')).toContainText('English');
    await page
      .getByRole('checkbox', { name: 'Restore the saved layout on startup', exact: true })
      .click();
    await browserExpect(page.locator('[data-behavior-settings] [role=status]')).toHaveText(
      'Setting saved.',
    );
    await page.keyboard.press('Escape');
    stage = 'save';
    await page.getByRole('button', { name: 'Layout', exact: true }).click();
    await page.locator('[data-layout-choice=c2]').click();
    await page.getByRole('button', { name: 'Layout', exact: true }).click();
    await page.getByRole('button', { name: 'Workspace', exact: true }).click();
    await page.getByRole('textbox', { name: 'Workspace name', exact: true }).fill('Review layout');
    await page
      .locator('[data-named-workspaces]')
      .getByRole('button', { name: 'Save', exact: true })
      .click();
    await browserExpect(
      page
        .locator('[data-named-workspaces]')
        .getByRole('button', { name: /Review layout/ })
        .first(),
    ).toBeVisible();
    await page.getByRole('textbox', { name: 'Workspace name', exact: true }).fill('Review layout');
    await page
      .locator('[data-named-workspaces]')
      .getByRole('button', { name: 'Save', exact: true })
      .click();
    const confirm = page.getByRole('dialog', { name: /Overwrite it/ });
    await confirm.waitFor();
    await confirm.getByRole('button', { name: 'Cancel', exact: true }).click();
    await page.keyboard.press('Escape');
    stage = 'cold stop';
    await app.evaluate(async () => {
      await (globalThis as unknown as { shell: DesktopShell }).shell.stop();
    });
    await app.close();
    application = undefined;
    stage = 'cold start';
    ({ app, page } = await launch());
    expect(await page.locator('[data-terminal-channel]').count()).toBe(0);
    await browserExpect(page.locator('[data-workspace-grid] > section')).toHaveCount(2);
    await page.getByRole('button', { name: 'Layout', exact: true }).click();
    await page.getByRole('button', { name: 'Workspace', exact: true }).click();
    await page
      .locator('[data-named-workspaces]')
      .getByRole('button', { name: /Review layout/ })
      .first()
      .click();
    await page.keyboard.press('Escape');
    stage = 'explicit recreation';
    const restored = page.getByRole('tab', { name: 'Saved Session', exact: true }).first();
    await restored.waitFor();
    await page.locator('[data-terminal-channel=ready]').waitFor();
    expect(await restored.getAttribute('aria-controls')).not.toBe(original);
    expect(errors).toEqual([]);
    await app.evaluate(async () => {
      await (globalThis as unknown as { shell: DesktopShell }).shell.stop();
    });
  } catch (error) {
    await writeFile(
      'out/level3-migration/sdk/named-ui-diagnostic.json',
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
});
