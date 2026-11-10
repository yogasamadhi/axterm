import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { _electron as electron, type ElectronApplication } from '@playwright/test';
import { expect, it, vi } from 'vitest';
import type { ChildProcess } from 'node:child_process';
import type { DesktopShell } from '../../apps/desktop/src/shell/application.ts';
import type { ElectronFileChooser } from '../../apps/desktop/src/shell/file-chooser.ts';
import { installFileFrameFixture } from '../support/level3-file-frame.ts';
interface State {
  shell: Pick<DesktopShell, 'stop'> & {
    host: { child: ChildProcess; inspect(): Promise<{ active: boolean; known: boolean }> };
  };
  chooser: ElectronFileChooser;
  recoveries: number;
  recoveryNavigationRequested: boolean;
  releaseRecoveryNavigation: () => Promise<void>;
}
it.skipIf(process.platform !== 'darwin')(
  'drains a live native file panel on Host crash and restores the generated Client model in a fresh Desktop generation',
  async () => {
    const home = await mkdtemp(join(tmpdir(), 'axterm-files-shell-'));
    let app: ElectronApplication | undefined;
    try {
      await installFileFrameFixture(home);
      await mkdir(join(home, 'desktop'), { recursive: true });
      const entry = join(home, 'shell.mjs');
      await writeFile(
        entry,
        `import {app,protocol,BrowserWindow} from 'electron';
      import {DesktopShell} from ${JSON.stringify(pathToFileURL(resolve('apps/desktop/lib/shell/application.js')).href)};
      import {ElectronFileChooser} from ${JSON.stringify(pathToFileURL(resolve('apps/desktop/lib/shell/file-chooser.js')).href)};
      protocol.registerSchemesAsPrivileged([{scheme:'axterm-app',privileges:{standard:true,secure:true,supportFetchAPI:true,corsEnabled:true,stream:true}}]);
      app.setPath('userData',${JSON.stringify(join(home, 'desktop'))});app.whenReady().then(()=>{globalThis.recoveries=0;
        globalThis.shell=new DesktopShell({home:${JSON.stringify(home)},webRoot:${JSON.stringify(resolve('apps/web/dist'))},hostEntry:${JSON.stringify(resolve('apps/desktop-host/lib/index.js'))},preload:${JSON.stringify(resolve('apps/desktop/lib/shell/preload.cjs'))},environment:{...process.env},visible:false,
          fileChooser:()=>{globalThis.chooser=new ElectronFileChooser(()=>BrowserWindow.getAllWindows()[0]);return globalThis.chooser;},recover:async()=>{if(BrowserWindow.getAllWindows()[0].webContents.getURL()!=='axterm-app://shell/recovery')throw new Error('Recovery document has not navigated');globalThis.recoveries++;return 'restart';}});globalThis.shell.start();});`,
      );
      app = await electron.launch({
        executablePath: createRequire(resolve('apps/desktop/package.json'))('electron') as string,
        args: [entry],
        timeout: 8000,
        env: { ...process.env, AXTERM_HOME: home, HTTP_PROXY: '', HTTPS_PROXY: '', ALL_PROXY: '' },
      });
      const page = await app.firstWindow();
      page.setDefaultTimeout(8000);
      const errors: string[] = [];
      page.on('pageerror', (error) => errors.push(error.message));
      page.on('console', (message) => {
        if (message.type() === 'error') errors.push(message.text().slice(0, 2048));
      });
      await page
        .locator('[data-file-state="ready"]')
        .waitFor()
        .catch(async (error) => {
          throw new Error(
            JSON.stringify({
              url: page.url(),
              errors,
              body: (
                await page
                  .locator('body')
                  .innerText({ timeout: 1000 })
                  .catch(() => '<closed>')
              ).slice(0, 4096),
            }),
            { cause: error },
          );
        });
      const generation = await page.locator('main').getAttribute('data-file-generation');
      await page.locator('#exercise-files').click({ force: true });
      await page.locator('[data-file-operations="done"]').waitFor();
      await page.locator('#choose').click({ force: true });
      await vi.waitFor(
        async () =>
          expect(
            await app!.evaluate(() => (globalThis as unknown as State).chooser.inspection()),
          ).toEqual({ pending: 1, ready: 1 }),
        { timeout: 8000 },
      );
      expect(
        await app.evaluate(() => (globalThis as unknown as State).shell.host.inspect()),
      ).toEqual({ active: true, known: true });
      const oldChooser = await app.evaluateHandle(() => (globalThis as unknown as State).chooser);
      await app.evaluate(({ BrowserWindow }) => {
        const window = BrowserWindow.getAllWindows()[0]!;
        const load = window.loadURL.bind(window);
        window.loadURL = (url, ...options) => {
          if (url !== 'axterm-app://shell/recovery') return load(url, ...options);
          const state = globalThis as unknown as State;
          state.recoveryNavigationRequested = true;
          return new Promise<void>((resolve, reject) => {
            state.releaseRecoveryNavigation = () => load(url, ...options).then(resolve, reject);
          });
        };
      });
      await app.evaluate(() => (globalThis as unknown as State).shell.host.child.kill('SIGKILL'));
      await vi.waitFor(
        async () =>
          expect(await oldChooser.evaluate((chooser) => chooser.inspection())).toEqual({
            pending: 0,
            ready: 0,
          }),
        { timeout: 8000 },
      );
      expect(
        await app.evaluate(async () => {
          await new Promise<void>((resolve) => setImmediate(resolve));
          return (globalThis as unknown as State).recoveries;
        }),
      ).toBe(0);
      expect(
        await app.evaluate(() => (globalThis as unknown as State).recoveryNavigationRequested),
      ).toBe(true);
      await app.evaluate(() => (globalThis as unknown as State).releaseRecoveryNavigation());
      await expect
        .poll(
          () =>
            page
              .locator('main')
              .getAttribute('data-file-generation')
              .catch(() => null),
          { timeout: 8000 },
        )
        .toSatisfy(
          (value) => typeof value === 'string' && value.length > 0 && value !== generation,
        );
      expect(await oldChooser.evaluate((chooser) => chooser.inspection())).toEqual({
        pending: 0,
        ready: 0,
      });
      await oldChooser.dispose();
      expect(await page.locator('[data-grant-count]').getAttribute('data-grant-count')).toBe('0');
      expect(await app.evaluate(() => (globalThis as unknown as State).recoveries)).toBe(1);
      await app.evaluate(async () => {
        await (globalThis as unknown as State).shell.stop();
      });
    } finally {
      await app
        ?.evaluate(async () => {
          await (globalThis as unknown as State).shell?.stop();
        })
        .catch(() => {});
      await app?.close();
      await rm(home, { recursive: true, force: true });
    }
  },
  30_000,
);
