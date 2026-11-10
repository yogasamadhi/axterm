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
it('persists DSH shortcuts through actual Electron input with controlled focus, refresh and window-local ownership', async () => {
  const home = await mkdtemp(join(tmpdir(), 'axterm-native-shortcuts-')),
    errors: string[] = [];
  let application: ElectronApplication | undefined,
    stage = 'launch';
  try {
    await mkdir(join(home, 'desktop'));
    const entry = join(home, 'shell.mjs');
    await writeFile(
      entry,
      `import{app,protocol}from'electron';import{DesktopShell}from${JSON.stringify(pathToFileURL(resolve('apps/desktop/lib/shell/application.js')).href)};protocol.registerSchemesAsPrivileged([{scheme:'axterm-app',privileges:{standard:true,secure:true,supportFetchAPI:true,corsEnabled:true,stream:true}}]);app.setPath('userData',${JSON.stringify(join(home, 'desktop'))});app.whenReady().then(()=>{globalThis.shell=new DesktopShell({home:${JSON.stringify(home)},webRoot:${JSON.stringify(resolve('apps/web/dist'))},hostEntry:${JSON.stringify(resolve('apps/desktop-host/lib/index.js'))},preload:${JSON.stringify(resolve('apps/desktop/lib/shell/preload.cjs'))},environment:{...process.env,SHELL:'/bin/bash'},visible:true,confirmQuit:async()=>true,recover:async()=> 'quit'});globalThis.shell.start();app.emit('second-instance',{},['-tp','local','--title','Native Primary'],${JSON.stringify(home)});});`,
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

    await page.getByRole('tab', { name: 'Native Primary', exact: true }).waitFor();
    await page.locator('[data-terminal-channel=ready]').waitFor();
    await application.evaluate(({ app, BrowserWindow }) => {
      app.focus({ steal: true });
      const window = BrowserWindow.getAllWindows()[0]!;
      // Controlled focus tests real Electron routing while the host screen is locked; OS-focus certification remains final-matrix work.
      window.isFocused = () => true;
      const trace: unknown[] = [];
      (globalThis as unknown as { shortcutTrace: unknown[] }).shortcutTrace = trace;
      window.webContents.on('before-input-event', (event, input) => {
        if (trace.length >= 64) trace.shift();
        trace.push({
          type: input.type,
          code: input.code,
          alt: input.alt,
          composing: input.isComposing,
          frame: !!window.webContents.focusedFrame,
          focused: window.isFocused(),
          enabled: window.isEnabled(),
          prevented: event.defaultPrevented,
        });
      });

      window.focus();
    });
    stage = 'retained-native-session-keys';
    const nativeKey = async (keyCode: string, modifiers: Array<'alt' | 'meta' | 'control'>) => {
      await (
        await application!.browserWindow(page)
      ).evaluate(
        (window, input) => {
          window.webContents.sendInputEvent({ type: 'keyDown', ...input });
          window.webContents.sendInputEvent({ type: 'keyUp', ...input });
        },
        { keyCode, modifiers },
      );
    };
    await nativeKey('N', ['alt']);
    await browserExpect(page.locator('[data-catalog-session-menu]')).toBeVisible();
    await nativeKey('N', ['alt']);
    await browserExpect(page.locator('[data-catalog-session-menu]')).toBeHidden();
    await nativeKey('N', [process.platform === 'darwin' ? 'meta' : 'control']);
    await browserExpect(page.locator('form.host-protocol-form')).toBeVisible();
    await page.keyboard.press('Escape');
    await browserExpect(page.locator('form.host-protocol-form')).toBeHidden();
    stage = 'settings';
    await openLevel3Settings(page);
    await page.getByTestId('application-language').click();
    await page.getByRole('option', { name: 'English', exact: true }).click();
    await page.locator('[data-settings-category=shortcuts]').click();
    const preferences = page.locator('[data-shortcut-preferences]'),
      row = preferences.locator('[data-shortcut-action=app_newTab]');
    await browserExpect(row).toContainText('New local terminal');
    await row.getByRole('button', { name: 'Edit New local terminal', exact: true }).click();
    const editor = page.getByRole('dialog', { name: 'Edit shortcut', exact: true }),
      recorder = editor.locator('[data-shortcut-recording]');
    stage = 'record';
    await recorder.focus();
    await recorder.press('Alt+z');
    await browserExpect(recorder).toContainText('Z');
    await editor.getByRole('button', { name: 'Apply', exact: true }).click();
    await editor.waitFor({ state: 'hidden' });
    await browserExpect(row.locator('kbd')).toContainText('Z');
    await page.keyboard.press('Escape');
    stage = 'native-dispatch';
    await page.locator('.xterm-helper-textarea').first().focus();
    await (
      await application.browserWindow(page)
    ).evaluate((window) => {
      window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Z', modifiers: ['alt'] });
      window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Z', modifiers: ['alt'] });
    });
    await browserExpect(page.locator('[data-workspace-global-tabs]').getByRole('tab')).toHaveCount(
      2,
    );
    await browserExpect(page.locator('[data-terminal-channel=ready]')).toHaveCount(2);
    stage = 'refresh';
    await page.reload();
    await page.locator('[data-terminal-channel=ready]').waitFor();
    await browserExpect(page.locator('[data-workspace-global-tabs]').getByRole('tab')).toHaveCount(
      2,
    );
    await openLevel3Settings(page);
    await page.locator('[data-settings-category=shortcuts]').click();
    await browserExpect(row.locator('kbd')).toContainText('Z');
    await page.keyboard.press('Escape');
    await page.getByRole('tab', { name: 'Native Primary', exact: true }).click();
    stage = 'search';
    await page.locator('.xterm-helper-textarea').first().focus();
    await (
      await application.browserWindow(page)
    ).evaluate((window) => {
      const modifiers: Array<'meta' | 'control'> = [
        process.platform === 'darwin' ? 'meta' : 'control',
      ];
      window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'F', modifiers });
      window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'F', modifiers });
    });
    await browserExpect(page.locator('.terminal-search')).toBeVisible();
    await page.keyboard.press('Escape');
    stage = 'second-window';
    const opened = application.waitForEvent('window');
    await application.evaluate(() => {
      const window = (globalThis as unknown as { shell: DesktopShell }).shell.createWindow();
      window.isFocused = () => true;
    });
    const other = await opened;
    other.setDefaultTimeout(7000);
    other.on('pageerror', (error) => errors.push(error.message));
    await browserExpect(other.locator('[data-workspace-global-tabs]').getByRole('tab')).toHaveCount(
      2,
    );
    await other.locator('[data-workspace-global-tabs]').getByRole('tab').first().click();
    await other.locator('[data-terminal-channel=ready]').waitFor();
    await other.bringToFront();
    await openLevel3Settings(other);
    await other.locator('[data-settings-category=shortcuts]').click();
    await browserExpect(other.locator('[data-shortcut-action=app_newTab] kbd')).toContainText('Z');
    await other.keyboard.press('Escape');
    await other.locator('.xterm-helper-textarea').first().focus();
    await (
      await application.browserWindow(other)
    ).evaluate((window) => {
      window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Z', modifiers: ['alt'] });
      window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Z', modifiers: ['alt'] });
    });
    await browserExpect(other.locator('[data-workspace-global-tabs]').getByRole('tab')).toHaveCount(
      3,
    );
    await browserExpect(
      page.getByRole('tab', { name: 'Native Primary', exact: true }),
    ).toHaveAttribute('aria-selected', 'true');
    expect(errors).toEqual([]);
    await application.evaluate(async () => {
      await (globalThis as unknown as { shell: DesktopShell }).shell.stop();
    });
  } catch (error) {
    await writeFile(
      'out/level3-migration/sdk/shortcuts-ui-diagnostic.json',
      JSON.stringify(
        {
          stage,
          errors,
          trace: await application?.evaluate(
            () => (globalThis as unknown as { shortcutTrace?: unknown[] }).shortcutTrace,
          ),
          console: await application
            ?.windows()[0]
            ?.consoleMessages()
            .then((messages) =>
              messages.map((message) => ({ type: message.type(), text: message.text() })),
            ),
          browser: await application
            ?.windows()[0]
            ?.evaluate(() => {
              const boot = (
                window as Window & {
                  __AXTERM_BOOT__?: { modules?: { id: string }[]; entries?: unknown };
                }
              ).__AXTERM_BOOT__;
              return {
                platform: document.documentElement.dataset.platform,
                keyboard: typeof (window as Window & { axtermDesktopKeyboard?: unknown })
                  .axtermDesktopKeyboard,
                modules: boot?.modules?.map((row) => row.id),
                entries: boot?.entries,
              };
            })
            .catch(() => undefined),
          shell: await application
            ?.evaluate(() => {
              const shell = (
                globalThis as unknown as {
                  shell: {
                    snapshot(): ReturnType<DesktopShell['snapshot']>;
                    keyboard: {
                      windows: Map<number, { keys: Set<string>; snapshot?: { status: string } }>;
                    };
                  };
                }
              ).shell;
              return {
                snapshot: shell.snapshot(),
                keys: [...shell.keyboard.windows].map(([id, state]) => ({
                  id,
                  keys: state.keys.size,
                  status: state.snapshot?.status,
                  recording: (state as { recording?: boolean }).recording,
                  bindings: [...state.keys],
                })),
              };
            })
            .catch(() => undefined),
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
