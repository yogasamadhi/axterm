import { closeLevel3Tab } from '../support/level3-tab-actions.ts';
import { openLevel3Settings } from '../support/level3-workspace-actions.ts';
import { once } from 'node:events';
import type * as Ssh2 from 'ssh2';
import { DatabaseSync } from 'node:sqlite';
import { EncryptedVault } from '@axterm/infra-credential-vault';

import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import {
  expect as browserExpect,
  _electron as electron,
  type ElectronApplication,
} from '@playwright/test';
import { expect, it } from 'vitest';
const packageResult = process.env.AXTERM_LEVEL3_PACKAGE_RESULT;
for (const mode of ['web'] as ('web' | 'package')[]) {
  it.skipIf(mode === 'package' && (process.platform !== 'darwin' || !packageResult))(
    `opens retained New Session and Quick Connect through owned ${mode} admissions`,
    async () => {
      const home = await mkdtemp(join(tmpdir(), 'axterm-catalog-workspace-ui-'));
      const sshWire = createRequire(resolve('packages/plugins/connections/package.json'))(
        'ssh2',
      ) as typeof Ssh2;
      const peers = new Set<Ssh2.Connection>();
      let authentications = 0;
      const sshServer = new sshWire.Server(
        { hostKeys: [sshWire.utils.generateKeyPairSync('ecdsa', { bits: 256 }).private] },
        (peer) => {
          peers.add(peer);
          peer.on('error', () => {});
          peer.once('close', () => peers.delete(peer));
          peer.on('authentication', (request) => {
            if (
              request.method === 'password' &&
              request.username === 'operator' &&
              request.password === 'MANAGER_UI_SECRET_CANARY'
            ) {
              authentications++;
              request.accept();
            } else request.reject(['password']);
          });
          peer.on('ready', () =>
            peer.on('session', (accept) => {
              const session = accept();
              session.on('pty', (approve) => approve?.());
              session.on('shell', (approve) => {
                const channel = approve();
                channel.on('error', () => {});
                let received = '';
                channel.on('data', (chunk: Buffer) => {
                  received = (received + chunk.toString()).slice(-4096);
                  if (received.includes('AXTERM_MANAGER_PROBE')) {
                    channel.write('\r\nMANAGER_REMOTE_READY\r\n');
                    received = '';
                  }
                });
              });
            }),
          );
        },
      );
      sshServer.listen(0, '127.0.0.1');
      await once(sshServer, 'listening');
      const sshAddress = sshServer.address();
      if (!sshAddress || typeof sshAddress === 'string')
        throw new Error('Unbound manager SSH fixture');
      let host: ChildProcess | undefined;
      let stopped: Promise<unknown> | undefined;
      let app: ElectronApplication | undefined;
      let token = '';
      const diagnostics: string[] = [];
      const browserErrors: string[] = [];
      try {
        let executablePath = createRequire(resolve('apps/desktop/package.json'))(
          'electron',
        ) as string;
        let args: string[] = [];
        if (mode === 'package') {
          const record = JSON.parse(await readFile(packageResult!, 'utf8'));
          const appRoot = dirname(dirname(dirname(record.app)));
          const [binary] = await readdir(join(appRoot, 'Contents/MacOS'));
          executablePath = join(appRoot, 'Contents/MacOS', binary!);
        } else {
          const launcher = join(home, 'profile.mjs');
          await writeFile(
            launcher,
            `import {runProfile} from ${JSON.stringify(pathToFileURL(resolve('apps/cli/lib/profile-boot.js')).href)};
import {PROFILE_TEMPLATES} from ${JSON.stringify(pathToFileURL(resolve('apps/cli/lib/profile-templates.js')).href)};
const application=await runProfile({profile:'web',home:${JSON.stringify(home)},installAnchor:${JSON.stringify(resolve('apps/cli/package.json'))},templates:PROFILE_TEMPLATES,patchFiles:[],args:[],requiredServices:['catalogController','webStartup','clientModules','files'],prepare(ctx){ctx.provide('webAssets',{index:${JSON.stringify(resolve('apps/web/dist/index.html'))},authenticationPage:${JSON.stringify(resolve('apps/web/dist/auth.html'))}});}});
process.send(application.ctx.get('webStartup'));`,
          );
          host = spawn(process.execPath, ['--expose-internals', launcher], {
            cwd: home,
            env: {
              ...process.env,
              HOME: home,
              ZDOTDIR: home,
              AXTERM_HOME: home,
              AXTERM_LEGACY_HOME: join(home, 'absent-legacy-source'),
              SSH_AUTH_SOCK: '',
              HTTP_PROXY: '',
              HTTPS_PROXY: '',
              ALL_PROXY: '',
            },
            stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
          });
          stopped = new Promise((done) => host!.once('exit', done));
          host.stdout?.on('data', (data) => diagnostics.push(String(data)));
          host.stderr?.on('data', (data) => diagnostics.push(String(data)));
          const startup = await new Promise<{ url: string; tokenFile: string }>((done, reject) => {
            const timer = setTimeout(
              () => reject(new Error('Catalog Profile startup timeout')),
              15000,
            );
            host!.once('message', (value) => {
              clearTimeout(timer);
              done(value as { url: string; tokenFile: string });
            });
            host!.once('error', (error) => {
              clearTimeout(timer);
              reject(error);
            });
            host!.once('exit', () => {
              clearTimeout(timer);
              reject(new Error('Catalog Profile exited before readiness'));
            });
          });
          token = (await readFile(startup.tokenFile, 'utf8')).trim();
          const browser = join(home, 'browser.cjs');
          await writeFile(
            browser,
            `const {app,BrowserWindow}=require('electron');app.setPath('userData',${JSON.stringify(join(home, 'browser'))});app.whenReady().then(()=>{new BrowserWindow({show:false,width:1280,height:900,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false}}).loadURL(${JSON.stringify(startup.url)});});app.on('window-all-closed',()=>app.quit());`,
          );
          args = [browser];
        }
        app = await electron.launch({
          executablePath,
          args,
          cwd: home,
          env: {
            ...process.env,
            AXTERM_HOME: home,
            AXTERM_LEGACY_HOME: join(home, 'absent-legacy-source'),
            PATH: mode === 'package' ? '/usr/bin:/bin' : process.env.PATH!,
            NODE_OPTIONS: '',
            NODE_PATH: '',
            HTTP_PROXY: '',
            HTTPS_PROXY: '',
            ALL_PROXY: '',
          },
          timeout: 15000,
        });
        const page = await app.firstWindow({ timeout: 15000 });
        page.setDefaultTimeout(8000);

        page.on('pageerror', (error) =>
          browserErrors.push(error.message.replaceAll(token || 'NO_TOKEN', '[redacted]')),
        );
        if (mode === 'web') {
          await page.locator('#credential').fill(token);
          await page.getByRole('button', { name: 'Connect', exact: true }).click();
        }
        await page.locator('[data-axterm-product-workspace]').waitFor();
        await page.locator('[data-terminal-channel=ready]:visible').waitFor();
        await page.locator('[data-workspace-global-tabs] .tab-close').click();
        await openLevel3Settings(page);
        await page.getByTestId('application-language').click();
        await page.getByRole('option', { name: 'English', exact: true }).click();
        await expect.poll(() => page.locator('html').getAttribute('lang')).toBe('en');
        await page.locator('[data-section-close=left]').click();
        await openLevel3Settings(page);
        const settings = page.locator('[data-configuration-settings]');
        await settings.locator('[data-settings-category="terminal"]').click();
        const profile = page.locator('[data-terminal-profile-form]');
        await profile.locator('input[name="name"]').fill('Menu terminal');
        await profile.locator('input[name="fontSize"]').fill('14');
        await profile.locator('button.primary').click();
        await browserExpect(page.locator('[data-terminal-profiles]')).toContainText(
          'Menu terminal',
        );
        await page.locator('[data-section-close=left]').click();
        const menu = page.locator('[data-catalog-session-menu]');
        await page.locator('[data-catalog-new-session]').click();
        await menu.locator('#quick-connect').fill('invalid host with spaces');
        await menu.locator('#quick-connect').press('Enter');
        await browserExpect(menu.locator('[role=alert]')).toBeVisible();
        await page.locator('[data-catalog-new-session]').click();
        await menu.waitFor({ state: 'hidden' });
        await page.locator('[data-catalog-new-session]').click();
        await menu.waitFor();
        await menu.locator('#terminal-profile').selectOption({ label: 'Menu terminal' });
        await menu.getByRole('button', { name: /Local terminal/ }).click();
        const current = page.locator('[data-terminal-channel="ready"]:visible .xterm');
        await current.waitFor();
        await current.click();
        await page.keyboard.type("printf 'AXTERM_NEW_%s' SESSION_OK; echo");
        await page.keyboard.press('Enter');
        await expect
          .poll(() => current.locator('.xterm-rows').textContent(), { timeout: 6000 })
          .toContain('AXTERM_NEW_SESSION_OK');
        await closeLevel3Tab(page);
        await browserExpect(page.locator('.workspace-tab-entry')).toHaveCount(0);
        for (const [url, protocol, field, value] of [
          [
            'ftp://operator:QUICK_UI_SECRET_CANARY@ftp.example.test:2121',
            'ftp',
            'hostname',
            'ftp.example.test',
          ],
          [
            'telnet://operator:QUICK_UI_SECRET_CANARY@telnet.example.test:2323',
            'telnet',
            'hostname',
            'telnet.example.test',
          ],
          [
            'rdp://operator:QUICK_UI_SECRET_CANARY@rdp.example.test:3390',
            'rdp',
            'hostname',
            'rdp.example.test',
          ],
          [
            'vnc://operator:QUICK_UI_SECRET_CANARY@vnc.example.test:5901',
            'vnc',
            'hostname',
            'vnc.example.test',
          ],
          [
            'spice://operator:QUICK_UI_SECRET_CANARY@spice.example.test:5902',
            'spice',
            'hostname',
            'spice.example.test',
          ],
          ['serial://COM4?opts={"baudRate":57600}', 'serial', 'path', 'COM4'],
          [
            'https://example.test/retained?tab=one',
            'web',
            'url',
            'https://example.test/retained?tab=one',
          ],
        ] as const) {
          await page.locator('[data-catalog-new-session]').click();
          await menu.locator('#quick-connect').fill(url);
          await menu.locator('#quick-connect').press('Enter');
          const form = page.locator('form[data-protocol="' + protocol + '"]');
          await browserExpect(form.locator('[name="' + field + '"]')).toHaveValue(value);
          if (protocol !== 'serial' && protocol !== 'web')
            await browserExpect(form.locator('[name="password"]')).toHaveValue(
              'QUICK_UI_SECRET_CANARY',
            );
          if (protocol === 'serial')
            await browserExpect(form.locator('[name="baudRate"]')).toHaveValue('57600');
          await page.keyboard.press('Escape');
          await form.waitFor({ state: 'hidden' });
        }
        await page.locator('[data-catalog-new-session]').click();
        await menu
          .locator('#quick-connect')
          .fill('ssh://operator:MANAGER_UI_SECRET_CANARY@127.0.0.1:' + sshAddress.port);
        await menu.locator('#quick-connect').press('Enter');
        const trust = page.locator('[data-interaction-kind=unknownHostKey]');
        await trust.waitFor();
        await trust.getByRole('button', { name: 'Trust and connect', exact: true }).click();
        await current.waitFor();
        await current.click();
        await page.keyboard.type('AXTERM_MANAGER_PROBE');
        await page.keyboard.press('Enter');
        await expect
          .poll(() => current.locator('.xterm-rows').textContent(), { timeout: 6000 })
          .toContain('MANAGER_REMOTE_READY');
        expect(authentications).toBe(1);
        await closeLevel3Tab(page);
        await browserExpect(page.locator('.workspace-tab-entry')).toHaveCount(0);
        await page.locator('[data-activity-item=newBookmark]').click();
        const editor = page.locator('form.host-protocol-form');
        await editor.waitFor();
        await page.keyboard.press('Escape');
        await editor.waitFor({ state: 'hidden' });
        expect(browserErrors).toEqual([]);
        await app.close();
        app = undefined;
        if (host) {
          host.kill('SIGTERM');
          expect(await stopped).toBe(0);
          host = undefined;
        }
        await expect.poll(() => peers.size).toBe(0);
        const db = new DatabaseSync(join(home, 'data-v2/axterm.sqlite'), { readOnly: true });
        try {
          expect(db.prepare('SELECT count(*) AS n FROM hosts').get()).toMatchObject({ n: 0 });
          expect(db.prepare('SELECT count(*) AS n FROM bookmarks').get()).toMatchObject({ n: 0 });
          expect(db.prepare('SELECT count(*) AS n FROM terminal_profiles').get()).toMatchObject({
            n: 1,
          });
        } finally {
          db.close();
        }
        const bytes = await readFile(join(home, 'data-v2/axterm.sqlite'));
        expect(bytes.includes(Buffer.from('QUICK_UI_SECRET_CANARY'))).toBe(false);
        expect(bytes.includes(Buffer.from('MANAGER_UI_SECRET_CANARY'))).toBe(false);
        const vault = new EncryptedVault(join(home, 'vault-v2'));
        try {
          await vault.open();
          expect(await vault.list()).toHaveLength(0);
        } finally {
          await vault.close();
        }
      } catch (error) {
        if (app) {
          const page = await app.firstWindow();
          const directory = resolve('out/level3-migration/new-session-smoke', mode);
          await mkdir(directory, { recursive: true });
          await page.screenshot({ path: join(directory, 'failure.png') });
          await writeFile(
            join(directory, 'failure.json'),
            JSON.stringify(
              {
                body: (await page.locator('body').innerText()).replaceAll(
                  token || 'NO_TOKEN',
                  '[redacted]',
                ),
                error: String(error),
                layout: (await page.getByRole('dialog').count())
                  ? await page.getByRole('dialog').evaluate((element) => {
                      const bounds = element.getBoundingClientRect();
                      return {
                        root: {
                          width: element.clientWidth,
                          scroll: element.scrollWidth,
                          bounds: bounds.toJSON(),
                        },
                        overflow: [...element.querySelectorAll<HTMLElement>('*')]
                          .filter((child) => {
                            const box = child.getBoundingClientRect();
                            return (
                              box.width &&
                              (box.right > bounds.right + 1 || box.left < bounds.left - 1)
                            );
                          })
                          .map((child) => ({
                            tag: child.tagName,
                            name: child.getAttribute('name'),
                            classes: child.className,
                            bounds: child.getBoundingClientRect().toJSON(),
                            width: getComputedStyle(child).width,
                            margin: getComputedStyle(child).margin,
                            position: getComputedStyle(child).position,
                          })),
                      };
                    })
                  : undefined,
                browserErrors,
                diagnostics,
              },
              null,
              2,
            ),
          );
        }
        throw error;
      } finally {
        if (app && mode === 'package') app.process().kill('SIGKILL');
        else await app?.close();
        if (host && host.exitCode === null) {
          host.kill('SIGTERM');
          await stopped;
        }
        for (const peer of peers) peer.end();
        await new Promise<void>((done) => sshServer.close(() => done()));
        await rm(home, { recursive: true, force: true });
      }
    },
    60000,
  );
}
