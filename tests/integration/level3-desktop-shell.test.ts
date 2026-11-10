import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { _electron as electron, type ElectronApplication } from '@playwright/test';
import { expect, it } from 'vitest';
import type { ChildProcess } from 'node:child_process';
import { installFrameFixture } from '../support/level3-frame.ts';
import type { DesktopShell } from '../../apps/desktop/src/shell/application.ts';
interface HarnessGlobal {
  shell: DesktopShell;
  confirmCount: number;
  quitAllowed: boolean;
}
const executablePath = createRequire(resolve('apps/desktop/package.json'))('electron') as string;
it('boots one owned document, shares a Host between isolated windows, hides on close and confirms unknown-task quit', async () => {
  const home = await mkdtemp(join(tmpdir(), 'axterm-owned-shell-'));
  let shell: ElectronApplication | undefined;
  try {
    await installFrameFixture(home, 'desktop', { taskInspectionFailure: true });
    await mkdir(join(home, 'desktop'), { recursive: true });
    const entry = join(home, 'shell.mjs');
    await writeFile(
      entry,
      `import { app, protocol } from 'electron';
      import { DesktopShell } from ${JSON.stringify(pathToFileURL(resolve('apps/desktop/lib/shell/application.js')).href)};
      protocol.registerSchemesAsPrivileged([{scheme:'axterm-app',privileges:{standard:true,secure:true,supportFetchAPI:true,corsEnabled:true,stream:true}}]);
      app.setPath('userData',${JSON.stringify(join(home, 'desktop'))});
      app.whenReady().then(()=>{
      globalThis.confirmCount=0; globalThis.quitAllowed=false;
      globalThis.shell = new DesktopShell({home:${JSON.stringify(home)},webRoot:${JSON.stringify(resolve('apps/web/dist'))},hostEntry:${JSON.stringify(resolve('apps/desktop-host/lib/index.js'))},preload:${JSON.stringify(resolve('apps/desktop/lib/shell/preload.cjs'))},environment:{...process.env},visible:false,confirmQuit:async()=>{globalThis.confirmCount++;return globalThis.quitAllowed;},recover:async()=>{globalThis.recoveryCalled=true;return 'quit';}});
      globalThis.shell.createWindow();});`,
    );
    shell = await electron.launch({
      executablePath,
      timeout: 8000,
      args: [entry],
      env: { ...process.env, AXTERM_HOME: home, HTTP_PROXY: '', HTTPS_PROXY: '', ALL_PROXY: '' },
    });
    const page = await shell.firstWindow({ timeout: 8000 });
    page.setDefaultTimeout(8000);
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.waitForLoadState('domcontentloaded');
    expect(page.url()).toBe('axterm-app://app/');
    const marker = await page.evaluate(() => {
      (globalThis as { documentMarker?: string }).documentMarker = crypto.randomUUID();
      return (globalThis as { documentMarker?: string }).documentMarker;
    });
    expect(await page.locator('[data-probe-state]').count()).toBe(0);
    await shell.evaluate(async () => {
      await (globalThis as unknown as HarnessGlobal).shell.start();
    });
    await page.locator('[data-probe-state="ready"] output').waitFor();
    const generation = await page.locator('output').getAttribute('data-generation');
    expect(await page.locator('output').textContent()).toBe('0.10.0');
    expect(
      await page.evaluate(() => (globalThis as { documentMarker?: string }).documentMarker),
    ).toBe(marker);
    const origin = await shell.evaluate(
      () => (globalThis as unknown as HarnessGlobal).shell.snapshot().origin as string,
    );
    expect((await fetch(origin)).status).toBe(401);
    expect(
      await page.evaluate(async () => ({
        cookie: document.cookie,
        local: { ...localStorage },
        session: { ...sessionStorage },
        bridge: Object.keys(window.axtermDesktopBoot ?? {}),
        secret: Object.keys(globalThis).filter((key) =>
          /(?:^|_)(?:credential|verifier)(?:$|_)/i.test(key),
        ),
      })),
    ).toEqual({ cookie: '', local: {}, session: {}, bridge: ['ready', 'failed'], secret: [] });
    await page.evaluate(() => {
      const frame = document.createElement('iframe');
      frame.src = 'about:blank';
      document.body.append(frame);
    });
    const subframe = page.frames().find((frame) => frame !== page.mainFrame())!;
    expect(
      await subframe.evaluate(
        async (target) =>
          new Promise<boolean>((resolve) => {
            const socket = new WebSocket(target.replace('http:', 'ws:') + '/api');
            const timer = setTimeout(() => {
              socket.close();
              resolve(false);
            }, 3000);
            socket.onopen = () => {
              clearTimeout(timer);
              socket.close();
              resolve(false);
            };
            socket.onerror = () => {
              clearTimeout(timer);
              resolve(true);
            };
          }),
        origin,
      ),
    ).toBe(true);
    expect(
      await shell.evaluate(async ({ BrowserWindow }) => {
        const alien = new BrowserWindow({
          show: false,
          webPreferences: {
            session: BrowserWindow.getAllWindows()[0]!.webContents.session,
            sandbox: true,
          },
        });
        try {
          await alien.loadURL('axterm-app://app/');
          return false;
        } catch {
          return true;
        } finally {
          alien.destroy();
        }
      }),
    ).toBe(true);
    const expectedWindow = Promise.withResolvers<number>();
    const application = shell;
    const next = shell.waitForEvent('window', {
      predicate: async (candidate) => {
        // The deliberately rejected alien window can emit a delayed Page event.
        // Match the native owner ID rather than treating the next event as authority.
        try {
          const window = await application.browserWindow(candidate);
          try {
            return (
              (await window.evaluate((window) => window.id)) === (await expectedWindow.promise)
            );
          } finally {
            await window.dispose();
          }
        } catch {
          return false;
        }
      },
    });
    expectedWindow.resolve(
      await shell.evaluate(() => (globalThis as unknown as HarnessGlobal).shell.createWindow().id),
    );
    const second = await next;
    await second.locator('[data-probe-state="ready"] output').waitFor({ timeout: 8000 });
    expect(await second.locator('output').getAttribute('data-generation')).toBe(generation);
    expect(
      await shell.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows().map(
          (window) =>
            window.webContents.session === BrowserWindow.getAllWindows()[0]!.webContents.session,
        ),
      ),
    ).toEqual([true, false]);
    await shell.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]!.close();
    });
    expect(
      await shell.evaluate(({ BrowserWindow }) => ({
        count: BrowserWindow.getAllWindows().length,
        visible: BrowserWindow.getAllWindows()[0]!.isVisible(),
      })),
    ).toEqual({ count: 2, visible: false });
    expect(
      await shell.evaluate(async () => {
        const state = globalThis as unknown as HarnessGlobal;
        const outcomes = await Promise.all([state.shell.requestQuit(), state.shell.requestQuit()]);
        if (outcomes[0] !== outcomes[1]) throw Error('Concurrent quit outcomes differed');
        return outcomes[0];
      }),
    ).toBe(false);
    expect(await shell.evaluate(() => (globalThis as unknown as HarnessGlobal).confirmCount)).toBe(
      1,
    );
    expect(await page.locator('output').getAttribute('data-generation')).toBe(generation);
    expect(errors).toEqual([]);
    const exited = shell.waitForEvent('close');
    await shell.evaluate(() => {
      const state = globalThis as unknown as HarnessGlobal;
      state.quitAllowed = true;
      void state.shell.requestQuit();
    });
    await exited;
    shell = undefined;
    await expect(fetch(origin, { signal: AbortSignal.timeout(1000) })).rejects.toThrow();
    expect(await readdir(join(home, 'desktop', 'crashes')).catch(() => [])).toEqual([]);
    expect(await readFile(join(home, 'vault-v2', 'master.key'))).toHaveLength(32);
  } finally {
    await shell
      ?.evaluate(async () => {
        await (globalThis as unknown as HarnessGlobal).shell?.stop();
      })
      .catch(() => {});
    await shell?.close();
    await rm(home, { recursive: true, force: true });
  }
}, 30_000);
it('retires crashed Host authority, records redacted evidence and restarts with one native recovery decision per process', async () => {
  const home = await mkdtemp(join(tmpdir(), 'axterm-shell-recovery-'));
  let shell: ElectronApplication | undefined;
  try {
    await installFrameFixture(home, 'desktop');
    await mkdir(join(home, 'desktop'), { recursive: true });
    const entry = join(home, 'shell.mjs');
    await writeFile(
      entry,
      `import {app,protocol} from 'electron';
      import {readdir} from 'node:fs/promises';
      import {DesktopShell} from ${JSON.stringify(pathToFileURL(resolve('apps/desktop/lib/shell/application.js')).href)};
      protocol.registerSchemesAsPrivileged([{scheme:'axterm-app',privileges:{standard:true,secure:true,supportFetchAPI:true,corsEnabled:true,stream:true}}]);
      app.setPath('userData',${JSON.stringify(join(home, 'desktop'))});
      app.whenReady().then(()=>{
        globalThis.recoveryCount=0;globalThis.reportsAtRecovery=0;
        globalThis.shell=new DesktopShell({home:${JSON.stringify(home)},webRoot:${JSON.stringify(resolve('apps/web/dist'))},hostEntry:${JSON.stringify(resolve('apps/desktop-host/lib/index.js'))},preload:${JSON.stringify(resolve('apps/desktop/lib/shell/preload.cjs'))},environment:{...process.env},visible:false,confirmQuit:async()=>false,recover:async()=>{globalThis.recoveryCount++;globalThis.reportsAtRecovery=(await readdir(${JSON.stringify(join(home, 'desktop/crashes'))})).length;return 'restart';}});
        void globalThis.shell.start();
      });`,
    );
    shell = await electron.launch({
      executablePath,
      timeout: 8000,
      args: [entry],
      env: { ...process.env, AXTERM_HOME: home, HTTP_PROXY: '', HTTPS_PROXY: '', ALL_PROXY: '' },
    });
    const page = await shell.firstWindow();
    page.setDefaultTimeout(8000);
    await page.locator('[data-probe-state="ready"] output').waitFor();
    const previous = await page.locator('output').getAttribute('data-generation');
    const origin = await shell.evaluate(
      () => (globalThis as unknown as HarnessGlobal).shell.snapshot().origin!,
    );
    const crash = () =>
      shell!.evaluate(() => {
        (
          (globalThis as unknown as HarnessGlobal).shell as unknown as {
            host: { child: ChildProcess };
          }
        ).host.child.kill('SIGKILL');
      });
    await crash();
    await expect
      .poll(
        async () =>
          await page
            .locator('output')
            .getAttribute('data-generation')
            .catch(() => null),
        { timeout: 8000 },
      )
      .toSatisfy((value) => typeof value === 'string' && value !== previous);
    expect(
      await shell.evaluate(() => ({
        count: (globalThis as unknown as { recoveryCount: number }).recoveryCount,
        reports: (globalThis as unknown as { reportsAtRecovery: number }).reportsAtRecovery,
      })),
    ).toEqual({ count: 1, reports: 1 });
    await expect(fetch(origin, { signal: AbortSignal.timeout(1000) })).rejects.toThrow();
    const reports = await readdir(join(home, 'desktop/crashes'));
    const report = await readFile(join(home, 'desktop/crashes', reports[0]!), 'utf8');
    expect(JSON.parse(report)).toMatchObject({ code: 'HOST_FAILED', generation: previous });
    expect(report).not.toMatch(/credential|digest|verifier|token|PRIVATE/i);
    await crash();
    await page.waitForURL('axterm-app://shell/recovery');
    await expect
      .poll(() => readdir(join(home, 'desktop/crashes')).then((files) => files.length))
      .toBe(2);
    expect(
      await shell.evaluate(
        () => (globalThis as unknown as { recoveryCount: number }).recoveryCount,
      ),
    ).toBe(1);
    await shell.evaluate(async () => {
      await (globalThis as unknown as HarnessGlobal).shell.stop();
    });
    await shell.close();
    shell = undefined;
  } finally {
    await shell
      ?.evaluate(async () => {
        await (globalThis as unknown as HarnessGlobal).shell?.stop();
      })
      .catch(() => {});
    await shell?.close();
    await rm(home, { recursive: true, force: true });
  }
}, 30_000);
