import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
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
it('refreshes actual native resume channels once without replaying PTY work and preserves the same terminal', async () => {
  const home = await mkdtemp(join(tmpdir(), 'axterm-native-power-')),
    effects = join(home, 'effects.txt'),
    errors: string[] = [];
  let application: ElectronApplication | undefined;
  try {
    await mkdir(join(home, 'desktop'));
    const entry = join(home, 'shell.mjs');
    await writeFile(
      entry,
      `import{app,protocol}from'electron';import{DesktopShell}from${JSON.stringify(pathToFileURL(resolve('apps/desktop/lib/shell/application.js')).href)};protocol.registerSchemesAsPrivileged([{scheme:'axterm-app',privileges:{standard:true,secure:true,supportFetchAPI:true,corsEnabled:true,stream:true}}]);app.setPath('userData',${JSON.stringify(join(home, 'desktop'))});app.whenReady().then(()=>{globalThis.shell=new DesktopShell({home:${JSON.stringify(home)},webRoot:${JSON.stringify(resolve('apps/web/dist'))},hostEntry:${JSON.stringify(resolve('apps/desktop-host/lib/index.js'))},preload:${JSON.stringify(resolve('apps/desktop/lib/shell/preload.cjs'))},environment:{...process.env,SHELL:'/bin/bash'},visible:false,confirmQuit:async()=>true,recover:async()=> 'quit'});globalThis.shell.start();app.emit('second-instance',{},['-tp','local','--title','Power Resume'],${JSON.stringify(home)});});`,
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
    await page.getByRole('tab', { name: 'Power Resume', exact: true }).waitFor();
    await page.locator('.terminal-canvas[data-shell-integration=active]').waitFor();

    const terminal = page.locator('.terminal-canvas[data-shell-integration=active]');
    const view = page.locator('[data-terminal-id]').filter({ has: terminal });
    const tabId = await view.getAttribute('data-terminal-id');
    expect(tabId).toMatch(/^[0-9a-f-]{36}$/u);
    const input = terminal.locator('textarea.xterm-helper-textarea');
    await input.focus();
    await input.pressSequentially(`printf A >> '${effects}'`);
    await input.press('Enter');
    await browserExpect.poll(() => readFile(effects, 'utf8').catch(() => '')).toBe('A');
    await application.evaluate(({ powerMonitor }) => {
      powerMonitor.emit('suspend');
      powerMonitor.emit('resume');
    });
    const notice = page.locator('[data-testid=session-recovery][data-recovery-kind=resumed]');
    await browserExpect(notice).toBeVisible();
    await browserExpect(notice).toContainText('Runtime');
    await browserExpect(page.getByTestId('runtime-state')).toHaveAttribute('data-state', 'ready');
    await browserExpect(view).toHaveAttribute('data-terminal-id', tabId!);
    await notice.getByRole('button').first().click();
    await browserExpect(page.getByTestId('runtime-state')).toHaveAttribute('data-state', 'ready');
    await notice.getByRole('button').last().click();
    await browserExpect(notice).toHaveCount(0);
    await input.focus();
    await input.pressSequentially(`printf B >> '${effects}'`);
    await input.press('Enter');
    await browserExpect.poll(() => readFile(effects, 'utf8').catch(() => '')).toBe('AB');
    expect(errors).toEqual([]);
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
}, 25000);
