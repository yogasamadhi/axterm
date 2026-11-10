import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { _electron as electron, type ElectronApplication } from '@playwright/test';
import { expect, it, vi } from 'vitest';
import type { BrowserWindow } from 'electron';
import type { ChildProcess } from 'node:child_process';
import type { ElectronFileChooser } from '../../apps/desktop/src/shell/file-chooser.ts';

/** Actual pinned Electron macOS panels must drain together with their native helpers. */
it.skipIf(process.platform !== 'darwin')(
  'drains actual native panel helpers on caller cancellation and generation retirement',
  async () => {
    const home = await mkdtemp(join(tmpdir(), 'axterm-native-panel-'));
    let application: ElectronApplication | undefined;
    try {
      const entry = join(home, 'panel.mjs');
      await writeFile(
        entry,
        `import {app,BrowserWindow} from 'electron';
      import {ElectronFileChooser} from ${JSON.stringify(pathToFileURL(resolve('apps/desktop/lib/shell/file-chooser.js')).href)};
      app.setPath('userData',${JSON.stringify(home)});app.on('window-all-closed',()=>{});
      app.whenReady().then(()=>{globalThis.createChooser=()=>new ElectronFileChooser(()=>globalThis.parent);globalThis.parent=new BrowserWindow({show:false,webPreferences:{sandbox:true}});globalThis.parent.loadURL('data:text/html,<h1>Native panel owner</h1>');});`,
      );
      application = await electron.launch({
        executablePath: createRequire(resolve('apps/desktop/package.json'))('electron') as string,
        args: [entry],
        timeout: 8000,
        env: { ...process.env, AXTERM_HOME: home },
      });
      await application.firstWindow({ timeout: 8000 });
      for (const kind of ['open-file', 'open-directory', 'save-file'] as const) {
        await application.evaluate(async ({ BrowserWindow }, kind) => {
          const state = globalThis as unknown as {
            parent: BrowserWindow;
            createChooser(): ElectronFileChooser;
            chooser: ElectronFileChooser;
            abort: AbortController;
            settled: boolean;
            pending: Promise<unknown>;
          };
          if (state.parent.isDestroyed())
            state.parent = new BrowserWindow({ show: false, webPreferences: { sandbox: true } });
          state.chooser = state.createChooser();
          state.abort = new AbortController();
          state.settled = false;
          state.pending = state.chooser
            .choose(kind, state.abort.signal)
            .then(
              (value) => ({ value }),
              () => ({ rejected: true }),
            )
            .finally(() => {
              state.settled = true;
            });
        }, kind);
        await vi.waitFor(
          async () =>
            expect(
              await application!.evaluate(() => {
                const state = globalThis as unknown as {
                  chooser: { inspection(): { pending: number; ready: number } };
                };
                return state.chooser.inspection();
              }),
            ).toEqual({ pending: 1, ready: 1 }),
          { timeout: 8000 },
        );
        if (kind === 'open-file')
          expect(
            await application.evaluate(() => {
              const state = globalThis as unknown as { settled: boolean; abort: AbortController };
              state.abort.abort();
              return state.settled;
            }),
          ).toBe(false);
        expect(
          await application.evaluate(async () => {
            const state = globalThis as unknown as {
              parent: BrowserWindow;
              chooser: { retire(): Promise<void>; inspection(): unknown };
              settled: boolean;
              pending: Promise<unknown>;
            };
            await state.chooser.retire();
            return {
              destroyed: state.parent.isDestroyed(),
              settled: state.settled,
              result: await state.pending,
              inspection: state.chooser.inspection(),
            };
          }),
        ).toEqual({
          destroyed: false,
          settled: true,
          result: { rejected: true },
          inspection: { pending: 0, ready: 0 },
        });
      }
      await application.evaluate(() => {
        const state = globalThis as unknown as {
          createChooser(): ElectronFileChooser;
          chooser: ElectronFileChooser;
          pending: Promise<unknown>;
        };
        state.chooser = state.createChooser();
        state.pending = state.chooser
          .choose('open-file', new AbortController().signal)
          .catch(() => {});
      });
      await vi.waitFor(
        async () =>
          expect(
            await application!.evaluate(
              () =>
                (globalThis as unknown as { chooser: ElectronFileChooser }).chooser.inspection()
                  .ready,
            ),
          ).toBe(1),
        { timeout: 8000 },
      );
      const helperPid = await application.evaluate(() => {
        const chooser = (globalThis as unknown as { chooser: ElectronFileChooser })
          .chooser as unknown as { panels: Set<{ child: ChildProcess }> };
        return [...chooser.panels][0]!.child.pid!;
      });
      await application.close();
      application = undefined;
      await vi.waitFor(() => {
        let running = true;
        try {
          process.kill(helperPid, 0);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ESRCH') running = false;
          else throw error;
        }
        expect(running).toBe(false);
      });
    } finally {
      await application?.close();
      await rm(home, { recursive: true, force: true });
    }
  },
  30_000,
);
