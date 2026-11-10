import { showLevel3Hosts } from '../support/level3-workspace-actions.ts';
import { closeLevel3Tab } from '../support/level3-tab-actions.ts';
import { openLevel3Settings } from '../support/level3-workspace-actions.ts';
import { once } from 'node:events';
import type * as Ssh2 from 'ssh2';
import { DatabaseSync } from 'node:sqlite';
import { EncryptedVault } from '@axterm/infra-credential-vault';

import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import {
  expect as browserExpect,
  _electron as electron,
  type ElectronApplication,
} from '@playwright/test';
import { expect, it } from 'vitest';
import { launchLevel3Desktop, closeLevel3Desktop } from '../fixtures/level3-desktop-launch.ts';
const packageResult = process.env.AXTERM_LEVEL3_PACKAGE_RESULT;
for (const mode of ['web', 'package'] as const) {
  it.skipIf(mode === 'package' && (process.platform !== 'darwin' || !packageResult))(
    `manages retained Host cards and group filters through owned ${mode} Catalog Clients`,
    async () => {
      const home = await mkdtemp(join(tmpdir(), 'axterm-catalog-workspace-ui-'));
      const sshWire = createRequire(resolve('packages/plugins/connections/package.json'))(
        'ssh2',
      ) as typeof Ssh2;
      const peers = new Set<Ssh2.Connection>();
      let authentications = 0;
      let probeReceived = false;
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
                    probeReceived = true;
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
        const executablePath = createRequire(resolve('apps/desktop/package.json'))(
          'electron',
        ) as string;
        let args: string[] = [];
        if (mode === 'web') {
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
        const launch = mode === 'package' ? launchLevel3Desktop : electron.launch.bind(electron);
        app = await launch({
          executablePath,
          args: mode === 'package' ? [`--user-data-dir=${home}`] : args,
          cwd: home,
          env: {
            ...process.env,
            AXTERM_HOME: home,
            AXTERM_LEGACY_HOME: join(home, 'absent-legacy-source'),
            PATH: process.env.PATH!,
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
        await openLevel3Settings(page);
        await page.getByTestId('application-language').click();
        await page.getByRole('option', { name: 'English', exact: true }).click();
        await expect.poll(() => page.locator('html').getAttribute('lang')).toBe('en');
        await page.locator('[data-section-close=left]').click();
        await showLevel3Hosts(page);
        await page.locator('[data-catalog-manager-open]').click();
        const manager = page.locator('[data-catalog-manager]');
        await manager.getByRole('button', { name: 'New group', exact: true }).click();
        const group = page.getByRole('dialog');
        await group.locator('form input').first().fill('Operations');
        await group.getByRole('button', { name: 'Create', exact: true }).click();
        await group.waitFor({ state: 'hidden' });
        await manager.getByRole('button', { name: 'Add host', exact: true }).click();
        const ssh = page.getByRole('dialog');
        await ssh.locator('input[name="name"]').fill('Managed SSH');
        await ssh.locator('input[name="hostname"]').fill('127.0.0.1');
        await ssh.locator('input[name="port"]').fill(String(sshAddress.port));
        await ssh.getByRole('switch', { name: 'Use SSH Agent', exact: true }).click();
        await ssh.locator('input[name="username"]').fill('operator');
        await ssh.locator('input[name="password"]').fill('MANAGER_UI_SECRET_CANARY');
        await ssh.locator('select[name="groupId"]').selectOption({ label: 'Operations' });
        await ssh.locator('button[value="save"]').click();
        await ssh.waitFor({ state: 'hidden' });
        await manager.locator('[data-bookmark-protocol="ssh"]').waitFor();
        let credentialCreates = 0;
        page.on('request', (request) => {
          if (request.url().endsWith('/api/configuration/createCredential')) credentialCreates++;
        });
        await manager.getByRole('button', { name: 'Add host', exact: true }).click();
        await ssh.locator('input[name="name"]').fill('Managed SSH');
        await ssh.locator('input[name="hostname"]').fill('127.0.0.1');
        await ssh.locator('input[name="port"]').fill(String(sshAddress.port));
        await ssh.locator('input[name="username"]').fill('operator');
        await ssh.locator('input[name="password"]').fill('MANAGER_UI_SECRET_CANARY');
        await ssh.getByRole('switch', { name: 'Use SSH Agent', exact: true }).click();
        await ssh.locator('select[name="groupId"]').selectOption({ label: 'Operations' });
        await ssh.locator('button[value="save"]').click();
        await ssh.locator('.ssh-overwrite-confirmation').waitFor();
        await ssh.getByRole('button', { name: 'Cancel', exact: true }).click();
        expect(credentialCreates).toBe(0);
        await ssh.locator('button[value="save"]').click();
        await ssh.getByRole('button', { name: 'Overwrite', exact: true }).click();
        await ssh.waitFor({ state: 'hidden' });
        expect(credentialCreates).toBe(1);
        await manager.getByRole('button', { name: 'Add Web', exact: true }).click();
        const web = page.locator('form[data-protocol="web"]');
        await web.locator('input[name="name"]').fill('Managed Web');
        await web.locator('input[name="url"]').fill('https://example.test/managed');
        await web.locator('button[value="save"]').click();
        await web.waitFor({ state: 'hidden' });
        const cards = manager.locator('.host-card');
        await expect.poll(() => cards.count()).toBe(2);
        await manager.getByRole('button', { name: /^Operations/ }).click();
        await expect.poll(() => cards.count()).toBe(1);
        await browserExpect(cards.first()).toHaveAttribute('data-bookmark-protocol', 'ssh');
        await manager.getByRole('button', { name: /^All/ }).click();
        await expect.poll(() => cards.count()).toBe(2);
        const search = manager.locator('.host-search input');
        await search.fill('Managed Web');
        await expect.poll(() => cards.count()).toBe(1);
        const webCard = manager.locator('[data-bookmark-protocol="web"]');
        await webCard.getByRole('button', { name: 'Edit', exact: true }).click();
        await web.locator('input[name="name"]').fill('Managed Web updated');
        await web.locator('button[value="save"]').click();
        await web.waitFor({ state: 'hidden' });
        await browserExpect(webCard).toContainText('Managed Web updated');
        await webCard.getByRole('button', { name: 'Duplicate', exact: true }).click();
        await expect.poll(() => cards.count()).toBe(2);
        await search.fill('Managed SSH');
        const hostCard = manager.locator('[data-bookmark-protocol="ssh"]');
        await hostCard.getByRole('button', { name: 'Connect', exact: true }).click();
        const trust = page.locator('[data-interaction-kind=unknownHostKey]');
        await trust.waitFor();
        await trust.getByRole('button', { name: 'Trust and connect', exact: true }).click();
        const sshTerminals = page.locator('[data-terminal-id]').filter({
          has: page.getByRole('tab', { name: 'SSH', exact: true }),
        });
        const currentTerminal = sshTerminals.filter({ visible: true });
        await browserExpect(currentTerminal).toHaveAttribute('data-terminal-channel', 'ready');
        await currentTerminal
          .locator('.xterm-helper-textarea')
          .pressSequentially('AXTERM_MANAGER_PROBE');
        await currentTerminal.locator('.xterm-helper-textarea').press('Enter');
        await expect.poll(() => probeReceived).toBe(true);
        await expect
          .poll(() => currentTerminal.locator('.xterm-rows').textContent())
          .toContain('MANAGER_REMOTE_READY');
        expect(authentications).toBe(1);
        await hostCard.getByRole('button', { name: 'Open terminal', exact: true }).click();
        await expect.poll(() => page.locator('[data-terminal-channel="ready"]').count()).toBe(2);
        await browserExpect(sshTerminals).toHaveCount(1);
        await expect
          .poll(() =>
            sshTerminals.evaluateAll((elements) =>
              elements.every(
                (element) => element.getAttribute('data-terminal-channel') === 'ready',
              ),
            ),
          )
          .toBe(true);
        expect(authentications).toBe(1);
        while (await page.locator('.workspace-tab-entry').count()) {
          const before = await page.locator('.workspace-tab-entry').count();
          await closeLevel3Tab(
            page,
            page.locator('[data-workspace-global-tabs]').getByRole('tab').first(),
          );
          await browserExpect(page.locator('.workspace-tab-entry')).toHaveCount(before - 1);
        }

        page.once('dialog', (dialog) => {
          void dialog.accept();
        });
        await hostCard.getByRole('button', { name: 'Delete', exact: true }).click();
        await expect.poll(() => hostCard.count()).toBe(0);
        await manager.locator('.bookmark-manager-back').click();
        await browserExpect(page.locator('[data-catalog-manager-open]')).toBeVisible();
        await page.locator('[data-catalog-manager-open]').click();
        await search.fill('');
        await expect.poll(() => cards.count()).toBe(2);
        expect(browserErrors).toEqual([]);
        if (mode === 'package') await closeLevel3Desktop(app);
        else await app.close();
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
          expect(db.prepare('SELECT count(*) AS n FROM bookmarks').get()).toMatchObject({ n: 2 });
          expect(db.prepare('SELECT count(*) AS n FROM bookmark_groups').get()).toMatchObject({
            n: 1,
          });
        } finally {
          db.close();
        }
        expect(
          (await readFile(join(home, 'data-v2/axterm.sqlite'))).includes(
            Buffer.from('MANAGER_UI_SECRET_CANARY'),
          ),
        ).toBe(false);
        const vault = new EncryptedVault(join(home, 'vault-v2'));
        try {
          await vault.open();
          const refs = await vault.list();
          expect(refs).toHaveLength(2);
          expect(await vault.get(refs[0]!.ref)).toBe('MANAGER_UI_SECRET_CANARY');
          expect(await vault.get(refs[1]!.ref)).toBe('MANAGER_UI_SECRET_CANARY');
        } finally {
          await vault.close();
        }
      } catch (error) {
        if (app) {
          const page = await app.firstWindow();
          const directory = resolve('out/level3-migration/host-manager-smoke', mode);
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
                probeReceived,
                terminals: await page.locator('[data-terminal-id]').evaluateAll((elements) =>
                  elements.map((element) => ({
                    id: element.getAttribute('data-terminal-id'),
                    channel: element.getAttribute('data-terminal-channel'),
                    active: element.hasAttribute('data-axterm-directory-drop'),
                    bounds: element.getBoundingClientRect().toJSON(),
                    hostBounds: element.querySelector('.xterm')?.getBoundingClientRect().toJSON(),
                    focused: element.contains(document.activeElement),
                    screen: element.querySelector('.xterm-rows')?.textContent,
                  })),
                ),
              },
              null,
              2,
            ),
          );
        }
        throw error;
      } finally {
        if (app && mode === 'package') await closeLevel3Desktop(app);
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
