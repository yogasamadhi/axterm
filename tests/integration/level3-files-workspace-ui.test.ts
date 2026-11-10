import { closeLevel3Tab } from '../support/level3-tab-actions.ts';
import { openLevel3Section } from '../support/level3-workspace-actions.ts';
import { openLevel3Settings } from '../support/level3-workspace-actions.ts';
import { once } from 'node:events';
import type * as Ssh2 from 'ssh2';
import { installSftpWire } from '../fixtures/sftp-wire.ts';
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
it('uses the owned Files workspace for local facts, retained context commands, keyboard selection and tab cleanup', async () => {
  const home = await mkdtemp(join(tmpdir(), 'axterm-files-workspace-ui-'));
  let host: ChildProcess | undefined,
    app: ElectronApplication | undefined,
    stopped: Promise<unknown> | undefined;
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
    await openLevel3Section(page, 'files');
    const workspace = page.locator('[data-files-workspace]');
    await workspace.waitFor();
    const local = workspace.locator('[data-axterm-directory-drop]');
    await local.getByRole('button', { name: 'seed.txt', exact: true }).waitFor();
    const split = workspace.getByRole('separator', {
      name: 'Resize the local and remote panes',
      exact: true,
    });
    for (let index = 0; index < 8; index++) await split.press('ArrowLeft');
    await browserExpect(split).toHaveAttribute('aria-valuenow', '25');
    for (let index = 0; index < 12; index++) await split.press('ArrowRight');
    await browserExpect(split).toHaveAttribute('aria-valuenow', '75');
    for (let index = 0; index < 5; index++) await split.press('ArrowLeft');
    await browserExpect(split).toHaveAttribute('aria-valuenow', '50');
    await local.getByRole('button', { name: 'seed.txt', exact: true }).click({ button: 'right' });
    await page.getByRole('menu').getByRole('menuitem', { name: 'New file', exact: true }).click();
    let dialog = page.getByRole('dialog');
    await dialog.getByRole('textbox').fill('created.txt');
    await dialog.getByRole('button', { name: 'Create', exact: true }).click();
    await dialog.waitFor({ state: 'hidden' });
    await local.getByRole('button', { name: 'created.txt', exact: true }).waitFor();
    expect(await readFile(join(home, 'workspace/created.txt'), 'utf8')).toBe('');
    await local
      .getByRole('button', { name: 'created.txt', exact: true })
      .click({ button: 'right' });
    await page.getByRole('menu').getByRole('menuitem', { name: 'Rename', exact: true }).click();
    dialog = page.getByRole('dialog');
    await dialog.getByRole('textbox').fill('renamed.txt');
    await dialog.getByRole('button', { name: 'Save', exact: true }).click();
    await dialog.waitFor({ state: 'hidden' });
    const renamed = local.getByRole('button', { name: 'renamed.txt', exact: true });
    await renamed.waitFor();
    await renamed.click();
    await renamed.press('Home');
    await expect
      .poll(() =>
        local
          .locator('[data-file-index="0"]')
          .evaluate((element) => element === document.activeElement),
      )
      .toBe(true);
    await renamed.click({ button: 'right' });
    await page
      .getByRole('menu')
      .getByRole('menuitem', { name: /^Delete/ })
      .click();
    await renamed.waitFor({ state: 'hidden' });
    await expect(readFile(join(home, 'workspace/renamed.txt'), 'utf8')).rejects.toMatchObject({
      code: 'ENOENT',
    });
    const filesTab = page.getByRole('tab', { name: 'Files', exact: true });
    await browserExpect(filesTab).toBeVisible();
    const tabId = await filesTab.getAttribute('aria-controls');
    expect(tabId).toMatch(/workspace-session-files:/);
    await closeLevel3Tab(
      page,
      page.locator('[data-workspace-global-tabs]').locator(`[aria-controls="${tabId}"]`),
    );
    await workspace.waitFor({ state: 'hidden' });
    expect(errors).toEqual([]);
  } catch (error) {
    await writeFile(
      'out/level3-migration/sdk/files-workspace-ui-diagnostic.json',
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
    await rm(home, { recursive: true, force: true });
  }
}, 40_000);

it('edits, compares and streams through real SFTP in the owned Files UI', async () => {
  const home = await mkdtemp(join(tmpdir(), 'axterm-files-workspace-ui-'));
  let host: ChildProcess | undefined,
    app: ElectronApplication | undefined,
    stopped: Promise<unknown> | undefined;
  let token = '';
  const errors: string[] = [],
    diagnostics: string[] = [];
  const ssh = createRequire(resolve('packages/plugins/connections/package.json'))(
    'ssh2',
  ) as typeof Ssh2;
  const peers = new Set<Ssh2.Connection>(),
    channels = new Set<ReturnType<typeof installSftpWire>>(),
    remoteRoot = join(home, 'remote');
  await mkdir(remoteRoot);
  await writeFile(join(remoteRoot, 'remote.txt'), 'initial remote text');
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
          auth.password === 'FILES_UI_WIRE_SECRET'
        )
          auth.accept();
        else auth.reject(['password']);
      });
      peer.on('ready', () =>
        peer.on('session', (accept) => {
          const session = accept();
          session.on('pty', (approve) => approve?.());
          session.on('shell', (approve) => {
            const channel = approve();
            channel.on('error', () => {});
            channel.write('\x1b]633;P;Cwd=/\x07');
            channel.on('data', () => {});
          });
          session.on('sftp', (approve) => {
            const channel = installSftpWire(approve(), remoteRoot, { atomicReplace: true });
            channels.add(channel);
            void channel.closed.then(() => channels.delete(channel));
          });
        }),
      );
    },
  );
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw Error('SFTP_FIXTURE_UNBOUND');
  try {
    await mkdir(join(home, 'workspace/folder'), { recursive: true });
    await writeFile(join(home, 'workspace/seed.txt'), 'LOCAL_FILE_BODY');
    await writeFile(join(home, 'workspace/.hidden'), 'hidden');
    const launcher = join(home, 'profile.mjs');
    await writeFile(
      launcher,
      `import{runProfile}from${JSON.stringify(pathToFileURL(resolve('apps/cli/lib/profile-boot.js')).href)};import{PROFILE_TEMPLATES}from${JSON.stringify(pathToFileURL(resolve('apps/cli/lib/profile-templates.js')).href)};const application=await runProfile({profile:'web',home:${JSON.stringify(home)},installAnchor:${JSON.stringify(resolve('apps/cli/package.json'))},templates:PROFILE_TEMPLATES,patchFiles:[],args:[],requiredServices:['webStartup','clientModules','filesController'],prepare(ctx){ctx.provide('webAssets',{index:${JSON.stringify(resolve('apps/web/dist/index.html'))},authenticationPage:${JSON.stringify(resolve('apps/web/dist/auth.html'))}});}});const initial=await application.ctx.fileGrants.create({kind:'home-directory'});process.send({...application.ctx.webStartup,initialDirectoryGrantId:initial.grantId});`,
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
    const startup = await new Promise<{
      url: string;
      tokenFile: string;
      initialDirectoryGrantId: string;
    }>((done, reject) => {
      const timer = setTimeout(() => reject(Error('FILES_PROFILE_STARTUP_TIMEOUT')), 10_000);
      host!.once('message', (message) => {
        clearTimeout(timer);
        done(message as { url: string; tokenFile: string; initialDirectoryGrantId: string });
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
    await page.locator('[data-terminal-channel="ready"]').waitFor();
    const initialTerminalCount = await page.locator('[data-terminal-id]').count();
    await page.locator('[data-catalog-new-session]').click();
    const menu = page.locator('[data-catalog-session-menu]');
    await menu
      .locator('#quick-connect')
      .fill(
        'ssh://operator:FILES_UI_WIRE_SECRET@127.0.0.1:' +
          address.port +
          '?title=SSH%20custom%20title',
      );
    await menu.locator('#quick-connect').press('Enter');
    const trust = page.locator('[data-interaction-kind=unknownHostKey]');
    await trust.waitFor();
    await trust.getByRole('button', { name: 'Trust and connect', exact: true }).click();
    const sshTab = page.getByRole('tab', { name: 'SSH custom title', exact: true });
    await sshTab.waitFor();
    const sshPanel = page.locator(
      '[id=' + JSON.stringify(await sshTab.getAttribute('aria-controls')) + ']',
    );
    await sshPanel.locator('[data-terminal-channel="ready"]').waitFor();
    await sshPanel
      .locator('[data-terminal-id]')
      .click({ button: 'right', position: { x: 120, y: 80 } });
    const transferMenu = page.getByRole('menu');
    await transferMenu
      .getByRole('menuitem', { name: 'Send file with XMODEM', exact: true })
      .waitFor();
    await transferMenu
      .getByRole('menuitem', { name: 'Receive file with XMODEM', exact: true })
      .waitFor();
    await transferMenu
      .getByRole('menuitem', { name: 'Review interrupted downloads', exact: true })
      .waitFor();
    await page.keyboard.press('Escape');
    await transferMenu.waitFor({ state: 'hidden' });
    await browserExpect(sshPanel.locator('.xterm-helper-textarea')).toBeFocused();
    await openLevel3Section(page, 'files');
    const workspace = page.locator('[data-files-workspace]');
    await workspace.waitFor();
    const remote = workspace.locator('.file-pane-remote');
    const row = remote.getByRole('button', { name: 'remote.txt', exact: true });
    await row.waitFor();
    await row.dblclick();
    const editor = page.locator('.remote-editor');
    await editor.waitFor();
    await expect
      .poll(() => editor.locator('.cm-content').innerText())
      .toContain('initial remote text');
    await editor.locator('.cm-content').fill('saved through the owned SFTP editor');
    await editor.getByRole('button', { name: 'Save', exact: true }).click();
    await expect
      .poll(() => readFile(join(remoteRoot, 'remote.txt'), 'utf8'))
      .toBe('saved through the owned SFTP editor');
    await editor.getByRole('button', { name: 'Close editor', exact: true }).click();
    await editor.waitFor({ state: 'hidden' });
    const local = workspace.locator('[data-axterm-directory-drop]');
    await local.getByRole('button', { name: 'seed.txt', exact: true }).click();
    await row.click();
    await workspace.getByRole('button', { name: 'Compare', exact: true }).click();
    const comparison = page.getByRole('dialog', { name: 'Compare files', exact: true });
    await comparison.waitFor();
    await comparison.getByRole('button', { name: 'Close', exact: true }).click();
    await comparison.waitFor({ state: 'hidden' });
    await row.click({ button: 'right' });
    await page
      .getByRole('menu')
      .getByRole('menuitem', { name: /Download/ })
      .click();
    const confirm = page.getByRole('dialog');
    await confirm.waitFor();
    await confirm.getByRole('button', { name: /^download$/i }).click();
    await confirm.waitFor({ state: 'hidden' });
    await expect
      .poll(() => readFile(join(home, 'workspace/remote.txt'), 'utf8').catch(() => undefined))
      .toBe('saved through the owned SFTP editor');
    const filesTab = page.getByRole('tab', { name: 'Files', exact: true });
    const tabId = await filesTab.getAttribute('aria-controls');
    await closeLevel3Tab(
      page,
      page.locator('[data-workspace-global-tabs]').locator(`[aria-controls="${tabId}"]`),
    );
    await workspace.waitFor({ state: 'hidden' });
    await expect.poll(() => channels.size).toBe(0);
    const trigger = page.locator('[data-transfers-trigger]');
    await trigger.click();
    const center = page.getByRole('dialog', { name: 'Transfer center', exact: true });
    await center.waitFor();
    await browserExpect(center).toContainText('Completed');
    await center.getByRole('button', { name: 'Close transfer center', exact: true }).click();
    await center.waitFor({ state: 'hidden' });
    await browserExpect(trigger).toBeFocused();
    await trigger.click();
    await center.waitFor();
    await center.getByRole('button', { name: 'Clear completed', exact: true }).click();
    await expect.poll(() => center.locator('article').count()).toBe(0);
    await trigger.click();
    await center.waitFor({ state: 'hidden' });
    const terminalTabsBefore = await page
      .locator('[data-workspace-global-tabs]')
      .getByRole('tab')
      .count();
    await page.locator('[data-catalog-new-session]').click();
    await menu
      .locator('#quick-connect')
      .fill(
        'ssh://operator:FILES_UI_WIRE_SECRET@127.0.0.1:' +
          address.port +
          '?title=Files-only%20fixture&opts=' +
          encodeURIComponent(JSON.stringify({ enableSsh: false })),
      );
    await menu.locator('#quick-connect').press('Enter');
    await page.getByRole('tab', { name: 'Files-only fixture', exact: true }).waitFor();
    await workspace
      .locator('.file-pane-remote')
      .getByRole('button', { name: 'remote.txt', exact: true })
      .waitFor();
    expect(await page.locator('[data-workspace-global-tabs]').getByRole('tab').count()).toBe(
      terminalTabsBefore + 1,
    );
    expect(await page.locator('[data-terminal-id]').count()).toBe(initialTerminalCount + 1);
    const filesOnly = page.getByRole('tab', { name: 'Files-only fixture', exact: true });
    await closeLevel3Tab(page, filesOnly);
    await workspace.waitFor({ state: 'hidden' });
    await page.locator('[data-catalog-new-session]').click();
    await menu
      .locator('#quick-connect')
      .fill(
        'ssh://operator:FILES_UI_WIRE_SECRET@127.0.0.1:' +
          address.port +
          '?title=Combined%20fixture&opts=' +
          encodeURIComponent(
            JSON.stringify({ initialDirectoryGrantId: startup.initialDirectoryGrantId }),
          ),
      );
    await menu.locator('#quick-connect').press('Enter');
    await expect
      .poll(() => page.getByRole('tab', { name: 'Combined fixture', exact: true }).count())
      .toBe(2);
    await workspace
      .locator('.file-pane-remote')
      .getByRole('button', { name: 'remote.txt', exact: true })
      .waitFor();
    await workspace
      .locator('[data-axterm-directory-drop]')
      .getByRole('button', { name: 'seed.txt', exact: true })
      .waitFor();
    expect(await page.locator('[data-terminal-id]').count()).toBe(initialTerminalCount + 2);

    // The retained terminal drop workflow uses the existing Files grant handoff and actual SFTP queue.
    await sshTab.click();
    const dropped = await page.evaluateHandle(() => {
      const data = new DataTransfer();
      data.items.add(
        new File(['TERMINAL_SFTP_DROP_BODY'], 'terminal-drop.txt', { type: 'text/plain' }),
      );
      return data;
    });
    try {
      await sshPanel.locator('[data-terminal-id]').dispatchEvent('drop', { dataTransfer: dropped });
    } finally {
      await dropped.dispose();
    }
    const dropDialog = page.getByRole('dialog', {
      name: 'How should dropped files be handled?',
      exact: true,
    });
    await dropDialog.waitFor();
    await dropDialog
      .getByRole('button', { name: 'Upload to current directory', exact: true })
      .click();
    await expect
      .poll(() => readFile(join(remoteRoot, 'terminal-drop.txt'), 'utf8'))
      .toBe('TERMINAL_SFTP_DROP_BODY');
    await dropDialog.waitFor({ state: 'hidden' });

    // The same SSH terminal also hosts the retained paired SFTP surface.
    const toolbar = sshPanel.locator('.terminal-session-toolbar');
    await toolbar.getByRole('tab', { name: 'SFTP', exact: true }).click();
    const pairedFiles = sshPanel.locator('[data-files-workspace]');
    await pairedFiles
      .locator('.file-pane-remote')
      .getByRole('button', { name: 'remote.txt', exact: true })
      .dblclick();
    const pairedEditor = pairedFiles.locator('.remote-editor');
    await expect
      .poll(() => pairedEditor.locator('.cm-content').innerText())
      .toContain('saved through the owned SFTP editor');
    await pairedEditor.getByRole('button', { name: 'Close editor', exact: true }).click();
    await toolbar.getByRole('tab', { name: 'SSH', exact: true }).click();
    await browserExpect(sshPanel.locator('.terminal-content')).toBeVisible();
    await browserExpect(sshPanel.locator('.xterm-helper-textarea')).toBeFocused();
    expect(await page.locator('[data-terminal-id]').count()).toBe(initialTerminalCount + 2);

    expect(diagnostics.some((text) => /did not activate/.test(text))).toBe(false);
    expect(errors).toEqual([]);
  } catch (error) {
    await writeFile(
      'out/level3-migration/sdk/files-sftp-ui-diagnostic.json',
      JSON.stringify(
        {
          geometry: await app?.windows()[0]?.evaluate(() =>
            [
              '.app-shell',
              '.tabbar',
              '.workspace-session-tabs',
              '.workspace-toolbar',
              '[data-workspace-more-toggle]',
              '.explorer-header',
            ].map((selector) => ({
              selector,
              rect: document.querySelector(selector)?.getBoundingClientRect().toJSON(),
              style: document.querySelector(selector)
                ? {
                    width: getComputedStyle(document.querySelector(selector)!).width,
                    flex: getComputedStyle(document.querySelector(selector)!).flex,
                    columns: getComputedStyle(document.querySelector(selector)!)
                      .gridTemplateColumns,
                  }
                : undefined,
            })),
          ),
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
    for (const peer of peers) peer.end();
    await new Promise<void>((done) => server.close(() => done()));
    await rm(home, { recursive: true, force: true });
  }
}, 40_000);
