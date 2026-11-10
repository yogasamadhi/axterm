import { openLevel3Settings } from '../support/level3-workspace-actions.ts';
import { mkdtemp, mkdir, writeFile, rm, lstat } from 'node:fs/promises';
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
import type { IpcMainInvokeEvent } from 'electron';
it('streams a dropped File, preserves its path across renderer reload and inserts trusted directory paths without executing Enter', async () => {
  const home = await mkdtemp(join(tmpdir(), 'axterm-terminal-drop-ui-')),
    errors: string[] = [],
    directory = join(home, 'native directory');
  let application: ElectronApplication | undefined,
    stage = 'launch';
  try {
    await mkdir(join(home, 'desktop'));
    await mkdir(directory);
    const entry = join(home, 'shell.mjs');
    await writeFile(
      entry,
      `import{app,protocol}from'electron';import{DesktopShell}from${JSON.stringify(pathToFileURL(resolve('apps/desktop/lib/shell/application.js')).href)};protocol.registerSchemesAsPrivileged([{scheme:'axterm-app',privileges:{standard:true,secure:true,supportFetchAPI:true,corsEnabled:true,stream:true}}]);app.setPath('userData',${JSON.stringify(join(home, 'desktop'))});app.whenReady().then(()=>{globalThis.shell=new DesktopShell({home:${JSON.stringify(home)},webRoot:${JSON.stringify(resolve('apps/web/dist'))},hostEntry:${JSON.stringify(resolve('apps/desktop-host/lib/index.js'))},preload:${JSON.stringify(resolve('apps/desktop/lib/shell/preload.cjs'))},environment:{...process.env,SHELL:'/bin/bash'},visible:false,confirmQuit:async()=>true,recover:async()=> 'quit'});globalThis.shell.start();});`,
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
    await page.locator('[data-terminal-channel=ready]').waitFor();
    await openLevel3Settings(page);
    await page.getByTestId('application-language').click();
    await page.getByRole('option', { name: 'English', exact: true }).click();
    await page.locator('[data-section-close=left]').click();
    const terminal = page.locator('[data-terminal-channel=ready]'),
      input = terminal.locator('.xterm-helper-textarea'),
      rows = terminal.locator('.xterm-rows');
    stage = 'streamed File import';
    await input.fill('cat ');
    const data = await page.evaluateHandle(() => {
      const data = new DataTransfer();
      data.items.add(
        new File(['DROP_CONTENT_SENTINEL\n'], 'native-file.txt', { type: 'text/plain' }),
      );
      return data;
    });
    try {
      await terminal.dispatchEvent('drop', { dataTransfer: data });
    } finally {
      await data.dispose();
    }
    const dialog = page.getByRole('dialog', {
      name: 'How should dropped files be handled?',
      exact: true,
    });
    await dialog.waitFor();
    await browserExpect(
      dialog.getByRole('button', { name: 'Upload to current directory', exact: true }),
    ).toBeDisabled();
    await dialog.getByRole('button', { name: 'Insert temporary local paths', exact: true }).click();
    await dialog.waitFor({ state: 'hidden' });
    await browserExpect(rows).toContainText('native-file.txt');
    expect(await rows.innerText()).not.toContain('DROP_CONTENT_SENTINEL');
    stage = 'retained across reload';
    await page.reload();
    await terminal.waitFor();
    await input.press('Enter');
    await browserExpect(rows).toContainText('DROP_CONTENT_SENTINEL');
    stage = 'trusted native directory ticket';
    await input.fill('printf "%s\\n" ');
    const id = await terminal.getAttribute('data-terminal-id');
    const tickets = await application.evaluate(async ({ BrowserWindow }, path) => {
      const window = BrowserWindow.getAllWindows()[0]!;
      const shell = (
        globalThis as unknown as {
          shell: {
            directoryDrop(
              event: IpcMainInvokeEvent,
              input: unknown,
            ): Promise<{ tickets: readonly string[] }>;
          };
        }
      ).shell;
      return (
        await shell.directoryDrop(
          {
            sender: window.webContents,
            senderFrame: window.webContents.mainFrame,
          } as unknown as IpcMainInvokeEvent,
          [path],
        )
      ).tickets;
    }, directory);
    await page.evaluate(
      ({ tickets, id }) =>
        window.postMessage(
          { type: 'axterm:native-directory-drop', ownerToken: id, tickets },
          location.origin,
        ),
      { tickets, id },
    );
    await browserExpect(rows).toContainText('native directory');
    await input.press('Enter');
    await browserExpect(rows).toContainText(directory);
    expect((await lstat(directory)).isDirectory()).toBe(true);
    const refusal = await application.evaluate(async ({ BrowserWindow }, path) => {
      const window = BrowserWindow.getAllWindows()[0]!;
      const shell = (
        globalThis as unknown as {
          shell: { directoryDrop(event: IpcMainInvokeEvent, input: unknown): Promise<unknown> };
        }
      ).shell;
      try {
        await shell.directoryDrop(
          {
            sender: window.webContents,
            senderFrame: window.webContents.mainFrame,
          } as unknown as IpcMainInvokeEvent,
          [path, path + '-missing'],
        );
        return '';
      } catch (error) {
        return String(error);
      }
    }, directory);
    expect(refusal).toBe('Error: DESKTOP_DROP_FAILED');
    expect(refusal).not.toContain(home);
    expect(errors).toEqual([]);
    await application.evaluate(async () => {
      await (globalThis as unknown as { shell: DesktopShell }).shell.stop();
    });
  } catch (error) {
    await writeFile(
      'out/level3-migration/sdk/terminal-drop-ui-diagnostic.json',
      JSON.stringify(
        {
          stage,
          errors,
          bodies: await Promise.all(
            application?.windows().map((p) =>
              p
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
