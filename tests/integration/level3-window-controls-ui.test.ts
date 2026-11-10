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
it('routes window control presentation through its owned preload and keeps the Host and terminal alive when hidden', async () => {
  const home = await mkdtemp(join(tmpdir(), 'axterm-window-controls-')),
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
    stage = 'native controls';
    await openLevel3Settings(page);
    await page.getByTestId('application-language').click();
    await page.getByRole('option', { name: 'English', exact: true }).click();
    await browserExpect(page.getByTestId('application-language')).toContainText('English');
    await page.keyboard.press('Escape');
    const controls = page.locator('[data-desktop-window-controls]'),
      toggle = controls.locator('[data-window-action=toggle-fullscreen]');
    await browserExpect(toggle).toBeEnabled();
    const window = await application.browserWindow(page);
    // OS fullscreen/focus is final acceptance; retain the real sender/IPC/preload/Client path here.
    await window.evaluate((target) => {
      let active = false;
      target.setFullScreen = (value: boolean) => {
        active = value;
      };
      target.isFullScreen = () => active;
    });
    await toggle.click();
    await browserExpect(toggle).toHaveAttribute('aria-label', 'Exit full screen');
    await toggle.click();
    await browserExpect(toggle).toHaveAttribute('aria-label', 'Full screen');
    const before = await application.evaluate(() =>
      (globalThis as unknown as { shell: DesktopShell }).shell.snapshot(),
    );
    await window.evaluate((target) => target.close());
    expect(await window.evaluate((target) => target.isVisible())).toBe(false);
    const hidden = await application.evaluate(() =>
      (globalThis as unknown as { shell: DesktopShell }).shell.snapshot(),
    );
    expect(hidden.generation).toBe(before.generation);
    expect(hidden.phase).toBe('ready');
    expect(hidden.windows).toBe(1);
    await application.evaluate(({ app }) => app.emit('activate', {}, false));
    await browserExpect(tab).toBeVisible();
    await browserExpect(tab).toHaveAttribute('aria-controls', id!);
    const input = page.locator('.xterm-helper-textarea');
    await input.focus();
    await input.fill('printf "CONTROL_HOST_ALIVE\\n"');
    await input.press('Enter');
    await expect
      .poll(() => page.locator('.xterm-rows').innerText())
      .toContain('CONTROL_HOST_ALIVE');
    expect(errors).toEqual([]);
    await application.evaluate(async () => {
      await (globalThis as unknown as { shell: DesktopShell }).shell.stop();
    });
  } catch (error) {
    await writeFile(
      'out/level3-migration/sdk/window-controls-ui-diagnostic.json',
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
