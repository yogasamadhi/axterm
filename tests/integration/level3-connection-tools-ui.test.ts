import { openLevel3Section } from '../support/level3-workspace-actions.ts';
import { openLevel3Bookmark, openLevel3Settings } from '../support/level3-workspace-actions.ts';
import { once } from 'node:events';
import type { Duplex } from 'node:stream';
import { createServer as createHttpServer } from 'node:http';
import { createConnection, createServer } from 'node:net';
import type * as Ssh2 from 'ssh2';
import { installSshForwardingWire } from '../fixtures/ssh-forwarding-wire.ts';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import {
  _electron as electron,
  expect as browserExpect,
  type ElectronApplication,
} from '@playwright/test';
import { expect, it } from 'vitest';
it('uses the retained tunnel/proxy/known-host UI through owned Client models and real SSH forwarding', async () => {
  const home = await mkdtemp(join(tmpdir(), 'axterm-files-workspace-ui-'));
  let host: ChildProcess | undefined,
    app: ElectronApplication | undefined,
    stopped: Promise<unknown> | undefined;
  const ssh = createRequire(resolve('packages/plugins/connections/package.json'))(
    'ssh2',
  ) as typeof Ssh2;
  const peers = new Set<Ssh2.Connection>(),
    sockets = new Set<Duplex>(),
    forwarders = new Set<ReturnType<typeof installSshForwardingWire>>();
  const echo = createServer((socket) => {
    sockets.add(socket);
    socket.on('error', () => {});
    socket.once('close', () => sockets.delete(socket));
    socket.pipe(socket);
  });
  echo.listen(0, '127.0.0.1');
  await once(echo, 'listening');
  const echoAddress = echo.address();
  if (!echoAddress || typeof echoAddress === 'string') throw Error('ECHO_UNBOUND');
  const server = new ssh.Server(
    { hostKeys: [ssh.utils.generateKeyPairSync('ecdsa', { bits: 256 }).private] },
    (peer) => {
      peers.add(peer);
      peer.on('error', () => {});
      peer.once('close', () => peers.delete(peer));
      peer.on('authentication', (auth) => {
        if (
          auth.method === 'password' &&
          ((auth.username === 'operator' && auth.password === 'TOOLS_UI_WIRE_SECRET') ||
            (auth.username === 'jump-user' && auth.password === 'HOP_UI_SECRET'))
        )
          auth.accept();
        else auth.reject(['password']);
      });
      peer.on('ready', () => {
        forwarders.add(installSshForwardingWire(peer));
        peer.on('session', (accept) => {
          const session = accept();
          session.on('pty', (approve) => approve?.());
          session.on('shell', (approve) => {
            const channel = approve();
            channel.on('error', () => {});
            channel.on('data', () => {});
          });
        });
      });
    },
  );
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw Error('SSH_UNBOUND');
  let proxyAuthenticated = false;
  const proxyServer = createHttpServer();
  proxyServer.on('connect', (request, socket) => {
    sockets.add(socket);
    socket.on('error', () => {});
    socket.once('close', () => sockets.delete(socket));
    proxyAuthenticated =
      request.headers['proxy-authorization'] ===
      'Basic ' + Buffer.from('proxy-user:TOOLS_PROXY_SECRET').toString('base64');
    if (!proxyAuthenticated) {
      socket.end('HTTP/1.1 407 Proxy Authentication Required\r\n\r\n');
      return;
    }
    const upstream = createConnection({ host: '127.0.0.1', port: echoAddress.port });
    sockets.add(upstream);
    upstream.on('error', () => socket.destroy());
    socket.once('close', () => upstream.destroy());
    upstream.once('close', () => {
      sockets.delete(upstream);
      socket.destroy();
    });
    upstream.once('connect', () => {
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      socket.pipe(upstream).pipe(socket);
    });
  });
  proxyServer.listen(0, '127.0.0.1');
  await once(proxyServer, 'listening');
  const proxyAddress = proxyServer.address();
  if (!proxyAddress || typeof proxyAddress === 'string') throw Error('PROXY_UNBOUND');
  let token = '';
  const errors: string[] = [],
    diagnostics: string[] = [];
  try {
    await mkdir(join(home, 'workspace/folder'), { recursive: true });
    await writeFile(join(home, 'workspace/seed.txt'), 'LOCAL_FILE_BODY');
    await writeFile(join(home, 'workspace/.hidden'), 'hidden');
    const launcher = join(home, 'profile.mjs');
    await writeFile(
      launcher,
      `import{runProfile}from${JSON.stringify(pathToFileURL(resolve('apps/cli/lib/profile-boot.js')).href)};import{PROFILE_TEMPLATES}from${JSON.stringify(pathToFileURL(resolve('apps/cli/lib/profile-templates.js')).href)};const application=await runProfile({profile:'web',home:${JSON.stringify(home)},installAnchor:${JSON.stringify(resolve('apps/cli/package.json'))},templates:PROFILE_TEMPLATES,patchFiles:[],args:[],requiredServices:['webStartup','clientModules','filesController'],prepare(ctx){ctx.provide('webAssets',{index:${JSON.stringify(resolve('apps/web/dist/index.html'))},authenticationPage:${JSON.stringify(resolve('apps/web/dist/auth.html'))}});}});process.send(application.ctx.webStartup);`,
    );
    host = spawn(process.execPath, ['--expose-internals', launcher], {
      cwd: home,
      env: {
        ...process.env,
        HOME: home,
        AXTERM_HOME: home,
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
      const timer = setTimeout(() => reject(Error('FILES_PROFILE_STARTUP_TIMEOUT')), 10_000);
      host!.once('message', (message) => {
        clearTimeout(timer);
        done(message as { url: string; tokenFile: string });
      });
      host!.once('exit', () => {
        clearTimeout(timer);
        reject(Error('FILES_PROFILE_EXITED'));
      });
    });
    token = (await readFile(startup.tokenFile, 'utf8')).trim();
    const browser = join(home, 'browser.cjs');
    await writeFile(
      browser,
      `const{app,BrowserWindow}=require('electron');app.setPath('userData',${JSON.stringify(join(home, 'browser'))});app.whenReady().then(()=>new BrowserWindow({show:false,width:1440,height:1000,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false}}).loadURL(${JSON.stringify(startup.url)}));app.on('window-all-closed',()=>app.quit());`,
    );
    app = await electron.launch({
      executablePath: createRequire(resolve('apps/desktop/package.json'))('electron') as string,
      args: [browser],
      env: { ...process.env, HOME: home, AXTERM_HOME: home },
      timeout: 10_000,
    });
    const page = await app.firstWindow();
    page.setDefaultTimeout(6000);
    page.on('pageerror', (error) => errors.push(error.message.replaceAll(token, '[redacted]')));
    page.on('dialog', (dialog) => dialog.accept());
    await page.locator('#credential').fill(token);
    await page.getByRole('button', { name: 'Connect', exact: true }).click();
    await page.locator('[data-axterm-product-workspace]').waitFor();
    await openLevel3Settings(page);
    await page.getByTestId('application-language').click();
    await page.getByRole('option', { name: 'English', exact: true }).click();
    await expect.poll(() => page.locator('html').getAttribute('lang')).toBe('en');
    await page.locator('[data-section-close=left]').click();
    await openLevel3Bookmark(page);
    const editor = page.getByRole('dialog');
    await editor.locator('input[name="name"]').fill('Tunnel UI fixture');
    await editor.locator('input[name="hostname"]').fill('127.0.0.1');
    await editor.locator('input[name="username"]').fill('operator');
    await editor.locator('input[name="password"]').fill('TOOLS_UI_WIRE_SECRET');
    await editor.locator('input[name="port"]').fill(String(address.port));
    await editor.locator('button[value="save-and-connect"]').click();
    const trust = page.locator('[data-interaction-kind=unknownHostKey]');
    await trust.waitFor();
    await trust.locator('input[name="remember"]').check();
    await trust.getByRole('button', { name: 'Trust and connect', exact: true }).click();
    await page.locator('[data-terminal-channel="ready"]:visible').waitFor();
    await editor.locator('form.host-protocol-form').waitFor({ state: 'hidden' });
    const tab = page.getByRole('tab', { name: 'Tunnel UI fixture', exact: true });
    await tab.waitFor();
    await openLevel3Section(page, 'tunnels');
    const tunnelPage = page.locator('.tunnel-manager');
    await tunnelPage.waitFor();
    await tunnelPage.locator('input[name="name"]').fill('UI forwarding');
    await tunnelPage.locator('input[name="targetPort"]').fill(String(echoAddress.port));
    await tunnelPage.getByRole('button', { name: 'Save profile', exact: true }).click();
    const row = page.locator('.tunnel-profile-row').filter({ hasText: 'UI forwarding' });
    await row.waitFor();
    await row.getByRole('button', { name: 'Start UI forwarding', exact: true }).click();
    await browserExpect(row.locator('.tunnel-status')).toHaveText('Running');
    const description = await row.locator('small').first().textContent();
    const port = Number(description?.match(/127\.0\.0\.1:(\d+) →/)?.[1]);
    expect(port).toBeGreaterThan(0);
    const response = await new Promise<Buffer>((done, reject) => {
      const socket = createConnection({ host: '127.0.0.1', port });
      const chunks: Buffer[] = [];
      socket.on('error', reject);
      socket.on('data', (bytes) => chunks.push(bytes));
      socket.once('connect', () => socket.end('OWNED_UI_FORWARDING'));
      socket.once('close', () => done(Buffer.concat(chunks)));
    });
    expect(response.toString()).toBe('OWNED_UI_FORWARDING');
    await page.locator('[data-section-close=left]').click();
    await tab.click();
    await page.locator('[data-terminal-channel="ready"]:visible').waitFor();
    await browserExpect(tunnelPage).toBeHidden();
    await openLevel3Section(page, 'tunnels');
    await row.getByRole('button', { name: 'Stop UI forwarding', exact: true }).click();
    await browserExpect(
      row.getByRole('button', { name: 'Start UI forwarding', exact: true }),
    ).toBeVisible();
    await row.getByRole('button', { name: 'Delete UI forwarding', exact: true }).click();
    await row.waitFor({ state: 'hidden' });
    const reservation = createServer();
    reservation.listen(0, '127.0.0.1');
    await once(reservation, 'listening');
    const reserved = reservation.address();
    if (!reserved || typeof reserved === 'string') throw Error('STARTUP_PORT_UNBOUND');
    const startupPort = reserved.port;
    await new Promise<void>((done) => reservation.close(() => done()));
    await page.locator('[data-section-close=left]').click();
    await page.locator('[data-catalog-new-session]').click();
    const quick = page.locator('[data-catalog-session-menu] #quick-connect');
    await quick.fill(
      'ssh://operator:TOOLS_UI_WIRE_SECRET@127.0.0.1:' +
        address.port +
        '?title=Advanced%20startup&opts=' +
        encodeURIComponent(
          JSON.stringify({
            connectionHoppings: [
              {
                host: '127.0.0.1',
                port: address.port,
                username: 'jump-user',
                password: 'HOP_UI_SECRET',
              },
            ],
            sshTunnels: [
              {
                name: 'Quick startup',
                sshTunnel: 'forwardLocalToRemote',
                sshTunnelLocalHost: '127.0.0.1',
                sshTunnelLocalPort: startupPort,
                sshTunnelRemoteHost: '127.0.0.1',
                sshTunnelRemotePort: echoAddress.port,
              },
            ],
          }),
        ),
    );
    await quick.press('Enter');
    await page.getByRole('tab', { name: 'Advanced startup', exact: true }).waitFor();
    const startupResponse = await new Promise<Buffer>((done, reject) => {
      const socket = createConnection({ host: '127.0.0.1', port: startupPort }),
        chunks: Buffer[] = [];
      socket.on('error', reject);
      socket.on('data', (bytes) => chunks.push(bytes));
      socket.once('connect', () => socket.end('HOP_AND_INLINE_TUNNEL'));
      socket.once('close', () => done(Buffer.concat(chunks)));
    });
    expect(startupResponse.toString()).toBe('HOP_AND_INLINE_TUNNEL');

    await openLevel3Settings(page);
    const settings = page.locator('[data-configuration-settings]');
    const proxy = settings.locator('section[aria-labelledby=proxy-settings-title]');
    await proxy.waitFor();
    await proxy.locator('select[name="proxyMode"]').selectOption('custom');
    await proxy.locator('input[name="proxyUrl"]').fill('http://127.0.0.1:' + proxyAddress.port);
    await proxy.locator('input[name="proxyUsername"]').fill('proxy-user');
    await proxy.locator('input[name="proxyPassword"]').fill('TOOLS_PROXY_SECRET');
    // An unrelated accepted appearance write must not destroy the proxy draft.
    await page.getByTestId('application-appearance').click();
    await page.getByRole('option', { name: 'Light', exact: true }).click();
    await browserExpect(page.locator('html')).toHaveAttribute('data-ax-theme', 'light');
    await browserExpect(proxy.locator('select[name=proxyMode]')).toHaveValue('custom');
    await browserExpect(proxy.locator('input[name=proxyPassword]')).toHaveValue(
      'TOOLS_PROXY_SECRET',
    );

    await proxy.getByRole('button', { name: 'Save proxy', exact: true }).click();
    await browserExpect(proxy.locator('input[name="proxyPassword"]')).toHaveValue('');
    await browserExpect(proxy.getByRole('status')).toContainText('Global SSH proxy saved.');
    await proxy.locator('input[name="proxyTargetHost"]').fill('127.0.0.1');
    await proxy.locator('input[name="proxyTargetPort"]').fill(String(echoAddress.port));
    await proxy.getByRole('button', { name: 'Test proxy', exact: true }).click();
    await browserExpect(
      proxy.getByRole('status').filter({ hasText: 'is available' }),
    ).toBeVisible();
    expect(proxyAuthenticated).toBe(true);
    await proxy.locator('select[name="proxyMode"]').selectOption('direct');
    await proxy.getByRole('button', { name: 'Save proxy', exact: true }).click();
    await browserExpect(proxy.getByRole('status')).toContainText('Global SSH proxy saved.');
    const known = settings.getByRole('region', { name: 'Known host keys', exact: true });
    await known.getByRole('button', { name: 'Revoke trust', exact: true }).click();
    await browserExpect(known.getByText('No host keys are saved.', { exact: false })).toBeVisible();
    expect(diagnostics.join('')).not.toContain('did not activate');
    expect(errors).toEqual([]);
  } catch (error) {
    await writeFile(
      'out/level3-migration/sdk/connection-tools-ui-diagnostic.json',
      JSON.stringify(
        {
          errors,
          diagnostics: diagnostics.map((text) =>
            token ? text.replaceAll(token, '[redacted]') : text,
          ),
          body: await app
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
    await app?.close();
    if (host && host.exitCode === null) {
      host.kill('SIGTERM');
      await stopped;
    }
    await Promise.all([...forwarders].map((owner) => owner.close()));
    for (const peer of peers) peer.end();
    await new Promise<void>((done) => server.close(() => done()));
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((done) => proxyServer.close(() => done()));
    await new Promise<void>((done) => echo.close(() => done()));
    await rm(home, { recursive: true, force: true });
  }
}, 40_000);
