import { closeLevel3Tab } from '../support/level3-tab-actions.ts';
import type {} from '@axterm/infra-web-startup';
import { openLevel3Settings } from '../support/level3-workspace-actions.ts';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { once } from 'node:events';
import type * as Ssh2 from 'ssh2';
import { _electron as electron, type ElectronApplication } from '@playwright/test';
import { expect, it, vi } from 'vitest';
import { installConnectionUiDriver } from '../support/level3-connection-ui-driver.ts';
import { runProfile } from '../../apps/cli/src/profile-boot.ts';
import { dictionaries } from '../../packages/plugins/connections/src/client/ui/locales.ts';
import { dictionaries as historyDictionaries } from '../../packages/plugins/catalog/src/client/ui/locales.ts';
import { PROFILE_TEMPLATES } from '../../apps/cli/src/profile-templates.ts';
const ssh = createRequire(resolve('packages/plugins/connections/package.json'))(
  'ssh2',
) as typeof Ssh2;
const packageResult = process.env.AXTERM_LEVEL3_PACKAGE_RESULT;
for (const mode of ['web', 'package'] as const) {
  it.skipIf(mode === 'package' && (!packageResult || process.platform !== 'darwin'))(
    `uses the real global ${mode} connection dialog to reject unknown keys, authenticate with transient keyboard answers and explicitly replace changed keys`,
    async () => {
      const home = await mkdtemp(join(tmpdir(), 'axterm-connection-interaction-ui-'));
      const peers = new Set<Ssh2.Connection>();
      let authentications = 0;
      const createServer = () =>
        new ssh.Server(
          { hostKeys: [ssh.utils.generateKeyPairSync('ecdsa', { bits: 256 }).private] },
          (peer) => {
            peers.add(peer);
            peer.on('error', () => {});
            peer.once('close', () => peers.delete(peer));
            peer.on('ready', () =>
              peer.on('session', (accept) => {
                const session = accept();
                session.on('pty', (approve) => approve?.());
                session.on('shell', (approve) => {
                  const channel = approve();
                  channel.on('error', () => {});
                  channel.on('data', (chunk: Buffer) => channel.write(chunk));
                });
              }),
            );
            peer.on('authentication', (request) => {
              if (request.method !== 'keyboard-interactive' || request.username !== 'fixture') {
                request.reject(['keyboard-interactive']);
                return;
              }
              request.prompt(
                [{ prompt: 'One-time answer', echo: false }],
                'Controlled SSH challenge',
                'Verify the transient answer',
                (answers) => {
                  if (answers[0] === 'TRANSIENT_SSH_UI_CANARY') {
                    authentications++;
                    request.accept();
                  } else request.reject(['keyboard-interactive']);
                },
              );
            });
          },
        );
      let server = createServer();
      server.listen(0, '127.0.0.1');
      await once(server, 'listening');
      const address = server.address();
      if (typeof address === 'string' || !address) throw new Error('Unbound SSH UI fixture');
      let application: Awaited<ReturnType<typeof runProfile>> | undefined;
      let browser: ElectronApplication | undefined;
      try {
        await installConnectionUiDriver(home, mode === 'web' ? 'web' : 'desktop', address.port);
        let token = '';
        if (mode === 'web') {
          application = await runProfile({
            profile: 'web',
            home,
            installAnchor: resolve('apps/cli/package.json'),
            templates: PROFILE_TEMPLATES,
            patchFiles: [],
            args: [],
            requiredServices: ['connectionsController', 'webStartup', 'clientModules'],
            prepare(ctx) {
              ctx.provide('webAssets', {
                index: resolve('apps/web/dist/index.html'),
                authenticationPage: resolve('apps/web/dist/auth.html'),
              });
            },
          });
          const startup = application.ctx.webStartup;
          token = (await readFile(startup.tokenFile!, 'utf8')).trim();
          const entry = join(home, 'browser.cjs');
          await writeFile(
            entry,
            `const{app,BrowserWindow}=require('electron');app.setPath('userData',${JSON.stringify(join(home, 'browser'))});app.whenReady().then(()=>{const win=new BrowserWindow({show:false,width:1280,height:800,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false}});win.loadURL(process.env.AXTERM_CONNECTION_UI_URL);});app.on('window-all-closed',()=>app.quit());`,
          );
          browser = await electron.launch({
            executablePath: createRequire(resolve('apps/desktop/package.json'))(
              'electron',
            ) as string,
            args: [entry],
            cwd: home,
            env: { ...process.env, AXTERM_HOME: home, AXTERM_CONNECTION_UI_URL: startup.url },
          });
        } else {
          const record = JSON.parse(await readFile(packageResult!, 'utf8'));
          const root = dirname(dirname(dirname(record.app)));
          const [name] = await readdir(join(root, 'Contents/MacOS'));
          browser = await electron.launch({
            executablePath: join(root, 'Contents/MacOS', name!),
            args: [],
            cwd: home,
            timeout: 15000,
            env: {
              ...process.env,
              AXTERM_HOME: home,
              AXTERM_LEGACY_HOME: join(home, 'absent-legacy-source'),
              PATH: '/usr/bin:/bin',
              NODE_OPTIONS: '',
              NODE_PATH: '',
              HTTP_PROXY: '',
              HTTPS_PROXY: '',
              ALL_PROXY: '',
            },
          });
        }
        const page = await browser.firstWindow({ timeout: 10000 });
        page.setDefaultTimeout(8000);
        const errors: string[] = [];
        page.on('pageerror', (error) =>
          errors.push(token ? error.message.replaceAll(token, '[redacted]') : error.message),
        );
        page.on('console', (message) => {
          if (message.type() === 'error')
            errors.push(
              message
                .text()
                .replaceAll(token || 'ABSENT_CREDENTIAL_SENTINEL', '[redacted]')
                .replaceAll('TRANSIENT_SSH_UI_CANARY', '[redacted]'),
            );
        });
        if (mode === 'web') {
          await page.locator('#credential').fill(token);
          await page.getByRole('button', { name: 'Connect', exact: true }).click();
        }
        await page.locator('[data-axterm-product-workspace]').waitFor();
        await openLevel3Settings(page);
        await page.getByTestId('application-language').click();
        await page.getByRole('option', { name: 'English', exact: true }).click();
        await expect.poll(() => page.locator('html').getAttribute('lang')).toBe('en');
        await page.locator('[data-section-close=left]').click();
        const driver = page.locator('[data-connection-ui-driver]');
        const connect = async () => {
          const previous = await driver.getAttribute('data-id');
          await page.locator('#connection-ui-create').click();
          await expect.poll(() => driver.getAttribute('data-id')).not.toBe(previous);
          expect(await driver.getAttribute('data-error')).toBe('false');
          return { id: (await driver.getAttribute('data-id'))! };
        };
        const assertState = async (id: string, state: string) => {
          expect(await driver.getAttribute('data-id')).toBe(id);
          await expect.poll(() => driver.getAttribute('data-state')).toBe(state);
        };
        const close = async (id: string) => {
          expect(await driver.getAttribute('data-id')).toBe(id);
          await page.locator('#connection-ui-close').click();
          await assertState(id, 'absent');
          await expect.poll(() => driver.getAttribute('data-busy')).toBe('false');
          expect(await driver.getAttribute('data-error')).toBe('false');
        };
        const shots = resolve('out/level3-migration/connection-ui-layouts', mode);
        await mkdir(shots, { recursive: true });
        const selectLocale = async (locale: string, label: string) => {
          await openLevel3Settings(page);
          await page.getByTestId('application-language').click();
          await page.getByRole('option', { name: label, exact: true }).click();
          await expect.poll(() => page.locator('html').getAttribute('lang')).toBe(locale);
          await page.locator('[data-section-close=left]').click();
        };
        const capture = async (kind: 'unknownHostKey' | 'changedHostKey') => {
          for (const [locale, label] of [
            ['en', 'English'],
            ['ja', '日本語'],
            ['zh-CN', '简体中文'],
            ['zh-TW', '繁體中文'],
          ] as const) {
            await selectLocale(locale, label);
            const pending = await connect();
            const dialog = page.getByRole('dialog', {
              name: dictionaries[locale][
                kind === 'unknownHostKey'
                  ? 'interaction.unknownHostKeyTitle'
                  : 'interaction.changedHostKeyTitle'
              ],
              exact: true,
            });
            await dialog.waitFor();
            const reject = dialog.getByRole('button', {
              name: dictionaries[locale]['panels.reject'],
              exact: true,
            });
            for (const viewport of [
              { width: 1280, height: 800 },
              { width: 1440, height: 900 },
              { width: 1920, height: 1080 },
            ]) {
              await page.setViewportSize(viewport);
              for (const scale of [1, 2]) {
                await browser!.evaluate(
                  ({ BrowserWindow }, zoom) =>
                    BrowserWindow.getAllWindows()[0]!.webContents.setZoomFactor(zoom),
                  scale,
                );
                await expect
                  .poll(() => page.evaluate(() => Math.round(innerWidth)))
                  .toBe(viewport.width / scale);
                await reject.scrollIntoViewIfNeeded();
                const bounds = await reject.boundingBox();
                const viewportHeight = await page.evaluate(() => innerHeight);
                expect(bounds!.y).toBeGreaterThanOrEqual(0);
                expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(viewportHeight);
                expect(await dialog.evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(
                  true,
                );
                await page.screenshot({
                  path: join(shots, `${kind}-${locale}-${viewport.width}-${scale}x.png`),
                });
              }
            }
            await browser!.evaluate(({ BrowserWindow }) =>
              BrowserWindow.getAllWindows()[0]!.webContents.setZoomFactor(1),
            );
            await page.setViewportSize({ width: 1280, height: 800 });
            await reject.click();
            await dialog.waitFor({ state: 'hidden' });
            await assertState(pending.id, 'failed');
          }
          await selectLocale('en', 'English');
        };
        const rejected = await connect();
        const unknown = page.getByRole('dialog', {
          name: 'First connection to this host',
          exact: true,
        });
        await unknown.waitFor().catch(async (cause) => {
          throw new Error(
            JSON.stringify({
              state: await driver.getAttribute('data-state'),
              headings: await page.getByRole('heading').allTextContents(),
              errors,
              styles: await page
                .locator('style[data-plugin]')
                .evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-plugin'))),
            }),
            { cause },
          );
        });
        await expect
          .poll(() => page.evaluate(() => document.activeElement?.textContent?.trim()))
          .toBe('Reject');
        expect(authentications).toBe(0);
        await unknown.getByRole('button', { name: 'Reject', exact: true }).click();
        await unknown.waitFor({ state: 'hidden' });
        await assertState(rejected.id, 'failed');
        expect(authentications).toBe(0);
        await capture('unknownHostKey');
        const accepted = await connect();
        await unknown.waitFor();
        await page.screenshot({ path: join(shots, 'unknown-en-1280.png') });
        await unknown.getByRole('button', { name: 'Trust and connect', exact: true }).click();
        const keyboard = page.locator('[data-interaction-kind=keyboardInteractive]');
        await keyboard.waitFor();
        const answer = keyboard.locator('input[type=password]');
        await answer.fill('TRANSIENT_SSH_UI_CANARY');
        expect(await page.locator('body').innerText()).not.toContain('TRANSIENT_SSH_UI_CANARY');
        await keyboard.getByRole('button', { name: 'Confirm', exact: true }).click();
        await keyboard.waitFor({ state: 'hidden' });
        await assertState(accepted.id, 'ready');
        expect(authentications).toBe(1);
        await close(accepted.id);
        await vi.waitFor(() => expect(peers.size).toBe(0));
        await new Promise<void>((done) => server.close(() => done()));
        server = createServer();
        server.listen(address.port, '127.0.0.1');
        await once(server, 'listening');
        await capture('changedHostKey');
        const changedConnection = await connect();
        const changed = page.getByRole('dialog', { name: 'Remote host key changed', exact: true });
        await changed.waitFor();
        await changed.getByText('High risk', { exact: true }).waitFor();
        const replace = changed.getByRole('button', {
          name: 'Replace key and connect',
          exact: true,
        });
        await replace.click();
        await changed
          .locator('[id^=host-key-confirmation-error-]')
          .filter({ hasText: 'confirmation checkbox' })
          .waitFor();
        expect(authentications).toBe(1);
        await page.screenshot({ path: join(shots, 'changed-en-1280.png') });
        await changed.locator('input[name=remember]').check();
        await replace.click();
        await keyboard.waitFor();
        await keyboard.locator('input[type=password]').fill('TRANSIENT_SSH_UI_CANARY');
        await keyboard.getByRole('button', { name: 'Confirm', exact: true }).click();
        await assertState(changedConnection.id, 'ready');
        expect(authentications).toBe(2);
        await close(changedConnection.id);
        await page.locator('#connection-ui-open-workspace').click();
        await keyboard.waitFor();
        await keyboard.locator('input[type=password]').fill('TRANSIENT_SSH_UI_CANARY');
        await keyboard.getByRole('button', { name: 'Confirm', exact: true }).click();
        await expect.poll(() => driver.getAttribute('data-opened-terminal')).not.toBe('');
        expect(await driver.getAttribute('data-error')).toBe('false');
        const terminalId = (await driver.getAttribute('data-opened-terminal'))!;
        const terminal = page.locator(
          `[data-terminal-id="${terminalId}"][data-terminal-channel="ready"]`,
        );
        await terminal.waitFor();
        await terminal.locator('.xterm-screen').click();
        await expect
          .poll(() => page.evaluate(() => document.activeElement?.className))
          .toContain('xterm-helper-textarea');
        await page.keyboard.insertText('WORKSPACE_SSH_UI_MARKER');
        await expect
          .poll(() => terminal.locator('.xterm-screen').innerText())
          .toContain('WORKSPACE_SSH_UI_MARKER');
        await page.screenshot({ path: join(shots, 'active-tab-en-1280.png') });
        await closeLevel3Tab(page);
        await terminal.waitFor({ state: 'detached' });
        await page.locator('#connection-ui-close-workspace').click();
        await expect.poll(() => driver.getAttribute('data-workspace-connection')).toBe('');
        expect(await driver.getAttribute('data-error')).toBe('false');
        expect(authentications).toBe(3);
        await expect.poll(() => driver.getAttribute('data-history-count')).toBe('3');
        await page.locator('#connection-ui-open-history').click();
        await keyboard.waitFor();
        await keyboard.locator('input[type=password]').fill('TRANSIENT_SSH_UI_CANARY');
        await keyboard.getByRole('button', { name: 'Confirm', exact: true }).click();
        await expect.poll(() => driver.getAttribute('data-opened-terminal')).not.toBe('');
        const historyTerminalId = (await driver.getAttribute('data-opened-terminal'))!;
        expect(historyTerminalId).not.toBe(terminalId);
        const historyTerminal = page.locator(
          `[data-terminal-id="${historyTerminalId}"][data-terminal-channel="ready"]`,
        );
        await historyTerminal.waitFor();
        await historyTerminal.locator('.xterm-screen').click();
        await page.keyboard.insertText('HISTORY_SSH_UI_MARKER');
        await expect
          .poll(() => historyTerminal.locator('.xterm-screen').innerText())
          .toContain('HISTORY_SSH_UI_MARKER');
        await closeLevel3Tab(
          page,
          page
            .locator('[data-workspace-global-tabs]')
            .locator(`[data-tab-id="${historyTerminalId}"]`),
        );
        await page.locator('#connection-ui-close-workspace').click();
        await expect.poll(() => driver.getAttribute('data-workspace-connection')).toBe('');
        expect(authentications).toBe(4);
        // The actual product history contribution, with no fixture command forwarding.
        if (!(await page.locator('.sidebar-tabs').isVisible()))
          await page.locator('[data-activity-item=bookmarks]').click();
        await page
          .locator('.sidebar-tabs')
          .getByRole('button', { name: 'History', exact: true })
          .click();
        const historyPanel = page.locator('aside.workspace-sidebar .connection-history-panel');
        expect(await historyPanel.getAttribute('aria-label')).toBe('Connection history');
        await historyPanel.locator('.connection-history-main').first().waitFor();
        await historyPanel.getByRole('switch', { name: 'Sort by usage frequency' }).check();
        await expect.poll(() => historyPanel.getByRole('switch').isChecked()).toBe(true);
        const secretDialog = page
          .getByRole('dialog')
          .filter({ has: page.locator('input[name=secret]') });
        const secretShots = resolve('out/level3-migration/history-ui-layouts', mode);
        await mkdir(secretShots, { recursive: true });
        for (const [locale, label] of [
          ['en', 'English'],
          ['ja', '日本語'],
          ['zh-CN', '简体中文'],
          ['zh-TW', '繁體中文'],
        ] as const) {
          await selectLocale(locale, label);
          await page.locator('.sidebar-tabs button').nth(1).click();
          await historyPanel.locator('.connection-history-main').first().click();
          await secretDialog.waitFor();
          await expect
            .poll(() => page.evaluate(() => document.activeElement?.getAttribute('name')))
            .toBe('secret');
          for (const viewport of [
            { width: 1280, height: 800 },
            { width: 1440, height: 900 },
            { width: 1920, height: 1080 },
          ]) {
            await page.setViewportSize(viewport);
            for (const scale of [1, 2]) {
              await browser!.evaluate(
                ({ BrowserWindow }, zoom) =>
                  BrowserWindow.getAllWindows()[0]!.webContents.setZoomFactor(zoom),
                scale,
              );
              const submit = secretDialog.getByRole('button', {
                name: historyDictionaries[locale]['history.connect'],
                exact: true,
              });
              await submit.scrollIntoViewIfNeeded();
              const bounds = await submit.boundingBox();
              expect(bounds!.y).toBeGreaterThanOrEqual(0);
              expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(
                await page.evaluate(() => innerHeight),
              );
              expect(
                await secretDialog.evaluate((node) => node.scrollWidth <= node.clientWidth),
              ).toBe(true);
              await page.screenshot({
                path: join(secretShots, `secret-${locale}-${viewport.width}-${scale}x.png`),
              });
            }
          }
          await browser!.evaluate(({ BrowserWindow }) =>
            BrowserWindow.getAllWindows()[0]!.webContents.setZoomFactor(1),
          );
          await page.setViewportSize({ width: 1280, height: 800 });
          await secretDialog
            .getByRole('button', {
              name: historyDictionaries[locale]['common.cancel'],
              exact: true,
            })
            .click();
          await secretDialog.waitFor({ state: 'hidden' });
        }
        await selectLocale('en', 'English');
        await page.locator('.sidebar-tabs button').nth(1).click();
        await historyPanel.locator('.connection-history-main').first().click();
        await secretDialog.waitFor();
        await secretDialog.locator('input[name=secret]').fill('TRANSIENT_SSH_UI_CANARY');
        await secretDialog.getByRole('button', { name: 'Connect', exact: true }).click();
        await keyboard.waitFor();
        await keyboard.locator('input[type=password]').fill('TRANSIENT_SSH_UI_CANARY');
        await keyboard.getByRole('button', { name: 'Confirm', exact: true }).click();
        await secretDialog.waitFor({ state: 'hidden' });
        await expect.poll(() => driver.getAttribute('data-history-count')).toBe('5');
        const admitted = page
          .locator('[data-workspace-global-tabs]')
          .getByRole('tab', { name: '127.0.0.1', exact: true });
        await admitted.click();
        const controls = await admitted.getAttribute('aria-controls');
        const actualHistoryTerminal = page
          .locator('#' + controls)
          .locator('[data-terminal-channel=ready]');
        await actualHistoryTerminal.waitFor();
        await actualHistoryTerminal.locator('.xterm-screen').click();
        await page.keyboard.insertText('OWNED_HISTORY_PANEL_MARKER');
        await expect
          .poll(() => actualHistoryTerminal.locator('.xterm-screen').innerText())
          .toContain('OWNED_HISTORY_PANEL_MARKER');
        await closeLevel3Tab(page, admitted);
        await page.locator('#connection-ui-close-ready').click();
        await expect.poll(() => driver.getAttribute('data-busy')).toBe('false');
        expect(authentications).toBe(5);
        await historyPanel
          .getByRole('button', { name: /^Save .* as a bookmark$/ })
          .first()
          .click();
        await expect.poll(() => historyPanel.locator('button:disabled').count()).toBe(0);
        const historyShots = resolve('out/level3-migration/history-ui-layouts', mode);
        await mkdir(historyShots, { recursive: true });
        for (const [locale, label] of [
          ['en', 'English'],
          ['ja', '日本語'],
          ['zh-CN', '简体中文'],
          ['zh-TW', '繁體中文'],
        ] as const) {
          await selectLocale(locale, label);
          await page.locator('.sidebar-tabs button').nth(1).click();
          const panel = historyPanel;
          for (const viewport of [
            { width: 1280, height: 800 },
            { width: 1440, height: 900 },
            { width: 1920, height: 1080 },
          ]) {
            await page.setViewportSize(viewport);
            for (const scale of [1, 2]) {
              await browser!.evaluate(
                ({ BrowserWindow }, zoom) =>
                  BrowserWindow.getAllWindows()[0]!.webContents.setZoomFactor(zoom),
                scale,
              );
              await expect
                .poll(() => page.evaluate(() => Math.round(innerWidth)))
                .toBe(viewport.width / scale);
              expect(await panel.evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(
                true,
              );
              await page.screenshot({
                path: join(historyShots, `${locale}-${viewport.width}-${scale}x.png`),
              });
            }
          }
        }
        await browser!.evaluate(({ BrowserWindow }) =>
          BrowserWindow.getAllWindows()[0]!.webContents.setZoomFactor(1),
        );
        await page.setViewportSize({ width: 1280, height: 800 });
        await selectLocale('en', 'English');
        await page.locator('.sidebar-tabs button').nth(1).click();
        const recording = historyPanel.getByRole('checkbox', {
          name: 'Record connection history',
          exact: true,
        });
        await recording.click();
        await expect.poll(() => recording.isChecked()).toBe(false);
        await historyPanel.getByText('Connection history is disabled', { exact: true }).waitFor();
        await recording.click();
        await expect.poll(() => recording.isChecked()).toBe(true);
        await historyPanel
          .getByText('Successfully connected SSH hosts will appear here', { exact: true })
          .waitFor();

        await page.locator('#connection-ui-create').click();
        await keyboard.waitFor();
        await keyboard.locator('input[type=password]').fill('TRANSIENT_SSH_UI_CANARY');
        await keyboard.getByRole('button', { name: 'Confirm', exact: true }).click();
        await expect.poll(() => driver.getAttribute('data-state')).toBe('ready');
        await close((await driver.getAttribute('data-id'))!);
        await historyPanel.locator('.connection-history-row').first().waitFor();
        await historyPanel
          .getByRole('button', { name: /^Delete the connection history for / })
          .first()
          .click();
        await historyPanel
          .getByText('Successfully connected SSH hosts will appear here', { exact: true })
          .waitFor();
        // Clear a separately recorded successful connection through the product command.
        await page.locator('#connection-ui-create').click();
        await keyboard.waitFor();
        await keyboard.locator('input[type=password]').fill('TRANSIENT_SSH_UI_CANARY');
        await keyboard.getByRole('button', { name: 'Confirm', exact: true }).click();
        await expect.poll(() => driver.getAttribute('data-state')).toBe('ready');
        await close((await driver.getAttribute('data-id'))!);
        await historyPanel.locator('.connection-history-row').first().waitFor();
        await historyPanel
          .getByRole('button', { name: 'Clear connection history', exact: true })
          .click();
        await historyPanel
          .getByText('Successfully connected SSH hosts will appear here', { exact: true })
          .waitFor();

        expect(
          await page.evaluate(() => ({
            cookie: document.cookie,
            local: { ...localStorage },
            session: { ...sessionStorage },
          })),
        ).toEqual({ cookie: '', local: {}, session: {} });
        if (token) expect(await page.locator('body').innerText()).not.toContain(token);
        expect(errors).toEqual([]);
        if (mode === 'package') {
          const closed = browser.waitForEvent('close');
          await browser.evaluate(({ app }) => app.quit());
          await closed;
          browser = undefined;
        }
      } catch (error) {
        if (browser) {
          try {
            const directory = resolve('out/level3-migration/connection-ui-layouts', mode);
            await mkdir(directory, { recursive: true });
            let details: Record<string, unknown>;
            try {
              const page = await browser.firstWindow({ timeout: 1000 });
              details = {
                language: await page.locator('html').getAttribute('lang', { timeout: 1000 }),
                switches: await page.locator('[role=switch]').evaluateAll((nodes) =>
                  nodes.map((node) => ({
                    text: node.textContent,
                    label: node.getAttribute('aria-label'),
                    labelledBy: node.getAttribute('aria-labelledby'),
                    bounds: node.getBoundingClientRect().toJSON(),
                    section: node.closest('section')?.className,
                  })),
                ),
              };
            } catch {
              details = { window: 'unavailable; preserve original failure' };
            }
            await writeFile(
              join(directory, 'failure.json'),
              JSON.stringify(
                {
                  error: String(error),
                  ...details,
                },
                null,
                2,
              ),
            );
          } catch {
            // Diagnostic IO must not replace the original journey failure.
          }
        }
        throw error;
      } finally {
        if (browser) {
          if (mode === 'package') browser.process().kill('SIGKILL');
          await browser.close().catch(() => {});
        }
        await application?.shutdown.shutdown(0);
        for (const peer of peers) peer.end();
        await new Promise<void>((done) => server.close(() => done()));
        await rm(home, { recursive: true, force: true });
      }
    },
    90000,
  );
}
