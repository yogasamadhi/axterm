import { openLevel3TabMenu } from '../support/level3-tab-actions.ts';
import { openLevel3Bookmark, openLevel3Settings } from '../support/level3-workspace-actions.ts';
import { terminalInformationOutputs } from '../fixtures/terminal-information.ts';
import { REMOTE_TERMINAL_INFORMATION_COMMANDS } from '../../packages/plugins/terminals/src/application/terminal-information-model.ts';
import { randomUUID } from 'node:crypto';
import { runProfile } from '../../apps/cli/src/profile-boot.ts';
import { PROFILE_TEMPLATES } from '../../apps/cli/src/profile-templates.ts';
import type { ConfigurationController } from '../../packages/plugins/configuration/src/index.ts';
import { once } from 'node:events';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import type * as Ssh2 from 'ssh2';
import {
  _electron as electron,
  type ElectronApplication,
  expect as browserExpect,
} from '@playwright/test';
import { expect, it } from 'vitest';
import type { DesktopShell } from '../../apps/desktop/src/shell/application.ts';
it('recovers owned SSH shells with retained reload snapshots, explicit retry/cancel and configured automatic recovery', async () => {
  const home = await mkdtemp(join(tmpdir(), 'axterm-session-ssh-')),
    ssh = createRequire(resolve('packages/plugins/connections/package.json'))(
      'ssh2',
    ) as typeof Ssh2,
    peers = new Set<Ssh2.Connection>(),
    input: string[] = [],
    execs: string[] = [],
    errors: string[] = [];
  let shells = 0;
  const restored = new Set<number>();
  const server = new ssh.Server(
    { hostKeys: [ssh.utils.generateKeyPairSync('ecdsa', { bits: 256 }).private] },
    (peer) => {
      peers.add(peer);
      peer.on('error', () => {});
      peer.once('close', () => peers.delete(peer));
      peer.on('authentication', (auth) => {
        if (
          auth.method === 'password' &&
          auth.username === 'operator' &&
          auth.password === 'SESSION_SSH_CANARY'
        )
          auth.accept();
        else auth.reject(['password']);
      });
      peer.on('ready', () =>
        peer.on('session', (accept) => {
          const session = accept();
          session.on('pty', (approve) => approve?.());
          session.on('shell', (approve) => {
            const channel = approve(),
              id = ++shells;
            let initialized = false,
              tail = '';
            channel.on('error', () => {});
            channel.on('data', (data: Buffer) => {
              tail = (tail + data.toString()).slice(-32 * 1024);
              if (input.length < 128) input.push(data.toString().slice(0, 256));
              if (!initialized) {
                initialized = true;
                channel.write(
                  '\x1b]633;A\x07\x1b]633;P;Cwd=/fixture/reload\x07SSH_SHELL_' + id + '\r\n',
                );
              }
              if (tail.includes('VISIBLE_SOURCE\r')) {
                channel.write('VISIBLE_SOURCE_ACK\r\n');
                tail = tail.replaceAll('VISIBLE_SOURCE\r', '');
              }
              if (tail.includes("cd -- '/fixture/reload'\r")) {
                restored.add(id);
                channel.write('RESTORED_DIRECTORY_' + id + '\r\n');
                tail = '';
              }
            });
          });
          session.on('exec', (approve, _reject, info) => {
            const group = Object.entries(REMOTE_TERMINAL_INFORMATION_COMMANDS).find(
              ([, command]) => command === info.command,
            )?.[0] as keyof typeof terminalInformationOutputs | undefined;
            const probe = !group && info.command.includes('${SHELL:-}');
            if (!probe) execs.push(info.command);
            const channel = approve();
            channel.on('error', () => {});
            channel.exit(0);
            channel.end(
              group
                ? terminalInformationOutputs[group]
                : probe
                  ? '/bin/bash'
                  : 'SESSION_EXEC_DONE\n',
            );
          });
        }),
      );
    },
  );
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = (server.address() as { port: number }).port;
  let application: ElectronApplication | undefined;
  try {
    const prepared = await runProfile({
      profile: 'web',
      home,
      installAnchor: resolve('apps/cli/package.json'),
      templates: PROFILE_TEMPLATES,
      patchFiles: [],
      args: [],
      requiredServices: ['configurationController', 'webStartup'],
      prepare(ctx) {
        ctx.provide('webAssets', {
          index: resolve('apps/web/dist/index.html'),
          authenticationPage: resolve('apps/web/dist/auth.html'),
        });
      },
    });
    try {
      const configuration = prepared.ctx.get('configurationController') as ConfigurationController;
      const current = configuration.getSettings();
      configuration.updateSettings(
        randomUUID(),
        {
          terminal: { restoreTerminalSessionOnReload: true },
          monitor: { remoteMonitorBarEnabled: true },
        },
        `"v${current.version}"`,
      );
    } finally {
      await prepared.shutdown.shutdown(0);
    }
    await mkdir(join(home, 'desktop'));
    const entry = join(home, 'shell.mjs');
    await writeFile(
      entry,
      `import{app,protocol}from'electron';import{DesktopShell}from${JSON.stringify(pathToFileURL(resolve('apps/desktop/lib/shell/application.js')).href)};protocol.registerSchemesAsPrivileged([{scheme:'axterm-app',privileges:{standard:true,secure:true,supportFetchAPI:true,corsEnabled:true,stream:true}}]);app.setPath('userData',${JSON.stringify(join(home, 'desktop'))});app.whenReady().then(()=>{globalThis.shell=new DesktopShell({home:${JSON.stringify(home)},webRoot:${JSON.stringify(resolve('apps/web/dist'))},hostEntry:${JSON.stringify(resolve('apps/desktop-host/lib/index.js'))},preload:${JSON.stringify(resolve('apps/desktop/lib/shell/preload.cjs'))},environment:{...process.env},visible:true,confirmQuit:async()=>true,recover:async()=> 'quit'});globalThis.shell.start();});`,
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
    const page = await application.firstWindow();
    page.setDefaultTimeout(7000);
    page.on('pageerror', (error) => errors.push(error.message));
    await page.locator('[data-axterm-product-workspace]').waitFor();
    await openLevel3Settings(page);
    await page.getByTestId('application-language').click();
    await page.getByRole('option', { name: 'English', exact: true }).click();
    await page.locator('[data-section-close=left]').click();
    await openLevel3Bookmark(page);
    const editor = page.getByRole('dialog');
    await editor.locator('input[name="name"]').fill('Session SSH');
    await editor.locator('input[name="hostname"]').fill('127.0.0.1');
    await editor.locator('input[name="username"]').fill('operator');
    await editor.locator('input[name="password"]').fill('SESSION_SSH_CANARY');
    await editor.locator('input[name="port"]').fill(String(port));
    await editor.locator('#ssh-bookmark-tab-settings').click();
    await editor.locator('select[name="reconnectMode"]').selectOption('automatic');
    await editor.locator('input[name="reconnectDelayMs"]').fill('3000');
    await editor.locator('button[value="save-and-connect"]').click();
    const trust = page.locator('[data-interaction-kind=unknownHostKey]');
    await trust.locator('input[name="remember"]').check();
    await trust.getByRole('button', { name: 'Trust and connect', exact: true }).click();
    await page.locator('[data-terminal-channel=ready]').waitFor();
    await editor.locator('form.host-protocol-form').waitFor({ state: 'hidden' });
    let terminal = page.locator('[data-terminal-id]').first();
    const original = await terminal.getAttribute('data-terminal-id');
    if (!original) throw Error('Missing initial shell');
    await terminal.locator('.xterm-helper-textarea').fill('VISIBLE_SOURCE');
    await terminal.locator('.xterm-helper-textarea').press('Enter');
    await browserExpect(terminal.locator('.terminal-canvas')).toContainText('VISIBLE_SOURCE_ACK');
    await browserExpect(page.locator('.remote-monitor-bar')).toContainText('monitor-host');
    expect(execs.length).toBeGreaterThanOrEqual(8);
    await openLevel3TabMenu(page, original);
    await page.locator('[data-session-action="reload"]').click();
    await browserExpect(page.locator(`[data-terminal-id="${original}"]`)).toHaveCount(0);
    terminal = page.locator('[data-terminal-id]').first();
    await browserExpect(terminal).toHaveAttribute('data-terminal-channel', 'ready');
    await browserExpect(terminal.locator('.terminal-canvas')).toContainText('VISIBLE_SOURCE_ACK');
    await browserExpect.poll(() => restored.has(2)).toBe(true);
    expect(shells).toBe(2);
    const manualId = await terminal.getAttribute('data-terminal-id');
    for (const peer of [...peers]) peer.end();
    const overlay = terminal.locator('.terminal-reconnect-overlay');
    await overlay.hover();
    await overlay.getByRole('button', { name: 'Stop reconnecting', exact: true }).click();
    await browserExpect(
      overlay.getByRole('button', { name: 'Stop reconnecting', exact: true }),
    ).toHaveCount(0);
    await overlay.getByRole('button', { name: 'Reconnect now', exact: true }).click();
    await browserExpect(page.locator(`[data-terminal-id="${manualId}"]`)).toHaveCount(0);
    terminal = page.locator('[data-terminal-id]').first();
    await browserExpect(terminal).toHaveAttribute('data-terminal-channel', 'ready');
    await browserExpect.poll(() => restored.has(3)).toBe(true);
    expect(shells).toBe(3);
    const beforeAutomatic = await terminal.getAttribute('data-terminal-id');
    for (const peer of [...peers]) peer.end();
    await browserExpect(page.locator(`[data-terminal-id="${beforeAutomatic}"]`)).toHaveCount(0);
    terminal = page.locator('[data-terminal-id]').first();
    await browserExpect(terminal).toHaveAttribute('data-terminal-channel', 'ready');
    await browserExpect(terminal.locator('.terminal-canvas')).toContainText('VISIBLE_SOURCE_ACK');
    await browserExpect.poll(() => restored.has(4)).toBe(true);
    expect(shells).toBe(4);
    expect(await page.locator('[data-terminal-id]').count()).toBe(1);
    expect(errors).toEqual([]);
    await application.evaluate(async () => {
      await (globalThis as unknown as { shell: DesktopShell }).shell.stop();
    });
  } catch (error) {
    await writeFile(
      'out/level3-migration/sdk/session-ssh-ui-diagnostic.json',
      JSON.stringify(
        {
          errors,
          shells,
          restored: [...restored],
          inputChunks: input.length,
          execCount: execs.length,
          body: await application
            ?.windows()[0]
            ?.locator('body')
            .innerText()
            .catch(() => '<unavailable>'),
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
    for (const peer of peers) peer.end();
    await new Promise<void>((done) => server.close(() => done()));
    await rm(home, { recursive: true, force: true });
  }
}, 20000);
