import { closeLevel3Tab } from '../support/level3-tab-actions.ts';
import { showLevel3ContextActions } from '../support/level3-workspace-actions.ts';
import { openLevel3Bookmark, openLevel3Settings } from '../support/level3-workspace-actions.ts';
import { startFtpFixture } from '../fixtures/ftp-wire.ts';
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
it('launches an FTP bookmark through its owner into the titled Files workspace and explicitly disconnects', async () => {
  const home = await mkdtemp(join(tmpdir(), 'axterm-files-workspace-ui-'));
  let host: ChildProcess | undefined,
    app: ElectronApplication | undefined,
    stopped: Promise<unknown> | undefined;
  const ftp = await startFtpFixture({
    username: 'operator',
    password: 'FTP_UI_WIRE_SECRET',
    initialFiles: { '/uploads/notes.txt': 'FTP_FILE_BODY' },
  });
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
    await page.locator('[data-bookmark-protocol="ftp"]').click();
    const form = page.locator('form[data-protocol="ftp"]');
    await form.waitFor();
    await form.locator('input[name="name"]').fill('FTP UI fixture');
    await form.locator('input[name="hostname"]').fill('127.0.0.1');
    await form.locator('input[name="port"]').fill(String(ftp.port));
    await form.locator('input[name="username"]').fill('operator');
    await form.locator('input[name="password"]').fill('FTP_UI_WIRE_SECRET');
    await form.locator('input[name="initialDirectory"]').fill('/uploads');
    await form.locator('button[value="connect"]').click();
    await form.waitFor({ state: 'hidden' });
    const tab = page.getByRole('tab', { name: 'FTP UI fixture', exact: true });
    await tab.waitFor();
    await showLevel3ContextActions(page);
    await browserExpect(page.getByRole('button', { name: 'Files', exact: true })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await page.keyboard.press('Escape');
    const workspace = page.locator('[data-files-workspace]');
    await workspace.waitFor();
    const remote = workspace.locator('.file-pane-remote');
    await remote.getByRole('button', { name: 'notes.txt', exact: true }).waitFor();
    await browserExpect(remote.locator('input').filter({ visible: true }).first()).toHaveValue(
      '/uploads',
    );
    await remote.getByRole('button', { name: /Disconnect/ }).click();
    await expect
      .poll(() => remote.getByRole('button', { name: 'notes.txt', exact: true }).count())
      .toBe(0);
    const target = await tab.getAttribute('aria-controls');
    await closeLevel3Tab(
      page,
      page.locator('[data-workspace-global-tabs]').locator(`[aria-controls="${target}"]`),
    );
    await workspace.waitFor({ state: 'hidden' });
    expect(diagnostics.join('')).not.toContain('did not activate');
    expect(errors).toEqual([]);
  } catch (error) {
    await writeFile(
      'out/level3-migration/sdk/ftp-files-ui-diagnostic.json',
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
    await ftp.close();
    await rm(home, { recursive: true, force: true });
  }
}, 40_000);
