import { openLevel3Settings } from '../support/level3-workspace-actions.ts';
import { Context } from '@deepseek-ai/cordis';
import Storage from '@axterm/infra-storage';
import * as Schema from '@axterm/data-schema';
import * as Relational from '@axterm/infra-storage-relational';
import * as Domains from '@axterm/infra-storage-domain';
import { NativeFileGrantRegistry } from '@axterm/infra-desktop-native';
import type { FileGrants } from '@axterm/plugin-api/host';
import { GrantedStreamingFiles } from '../../packages/plugins/files/src/adapters/streaming-files.ts';
import { TerminalStageStore } from '../../packages/plugins/terminals/src/adapters/terminal-transfer/stage-store.ts';
import { PrivateTerminalStaging } from '../../packages/plugins/terminals/src/adapters/terminal-transfer/private-staging.ts';
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
it('reviews and explicitly removes a private interrupted terminal download in the retained product dialog', async () => {
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
    const profile = join(home, 'profiles/web');
    await mkdir(profile, { recursive: true });
    await mkdir(join(home, 'downloads'));
    await writeFile(
      join(profile, 'cordis.patch.yml'),
      JSON.stringify([
        { id: 'local-file-grants', disabled: true },
        {
          id: 'terminals',
          config: {
            stagingDirectory: join(profile, 'terminal-stages'),
            shell: '/bin/sh',
            shellArgs: ['-f'],
            cwd: home,
            env: { HOME: home, HISTFILE: '/dev/null', ENV: '' },
            maxSessions: 2,
          },
        },
      ]),
    );
    await seedInterruptedStage(home);
    const launcher = join(home, 'profile.mjs');
    const moduleUrl = (path: string) => JSON.stringify(pathToFileURL(resolve(path)).href);
    await writeFile(
      launcher,
      `
      import{runProfile}from${moduleUrl('apps/cli/lib/profile-boot.js')};
      import{PROFILE_TEMPLATES}from${moduleUrl('apps/cli/lib/profile-templates.js')};
      import{ShellFileGrantCapabilities}from${moduleUrl('packages/infra/desktop-native/lib/index.js')};
      import FileGrants from${moduleUrl('packages/infra/desktop-native/lib/files.js')};
      import{join}from'node:path';
      const home=${JSON.stringify(home)};
      const application=await runProfile({profile:'web',home,installAnchor:${JSON.stringify(resolve('apps/cli/package.json'))},templates:PROFILE_TEMPLATES,patchFiles:[],args:[],requiredServices:['webStartup','clientModules','filesController'],prepare(ctx){
        const lifetime=new AbortController();
        const caps=new ShellFileGrantCapabilities(ctx.runtimeIdentity.generation,{choose:async()=>join(home,'downloads'),defaultDirectory:kind=>join(home,kind==='home'?'workspace':'downloads'),retire:()=>{}},join(home,'native-imports'));
        const handlers=caps.handlers();new FileGrants(ctx,{generation:ctx.runtimeIdentity.generation,signal:lifetime.signal,call:async(method,input,signal)=>handlers[method](input,signal??lifetime.signal)});
        ctx.effect(()=>async()=>{lifetime.abort();await caps.close();});
        ctx.provide('webAssets',{index:${JSON.stringify(resolve('apps/web/dist/index.html'))},authenticationPage:${JSON.stringify(resolve('apps/web/dist/auth.html'))}});

      }});process.send(application.ctx.webStartup);
    `,
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
    const terminal = page.locator('[data-terminal-id]');
    await page.locator('[data-terminal-channel="ready"]').waitFor();
    await terminal.click({ button: 'right', position: { x: 120, y: 80 } });
    await page.getByRole('menuitem', { name: 'Review interrupted downloads', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Interrupted download files', exact: true });
    await dialog.waitFor();
    await browserExpect(dialog).toContainText('Terminal download');
    const row = dialog.locator('li');
    await browserExpect(row).toHaveCount(1);
    await row
      .getByRole('button')
      .filter({ hasText: /remove/i })
      .click();
    await row
      .getByRole('button')
      .filter({ hasText: /confirm/i })
      .click();
    await expect.poll(() => dialog.locator('li').count()).toBe(0);
    await dialog
      .getByRole('button')
      .filter({ hasText: /leave|close/i })
      .click();
    await dialog.waitFor({ state: 'hidden' });
    expect(errors).toEqual([]);
    expect(diagnostics.join('')).not.toContain('did not activate');
  } catch (error) {
    await writeFile(
      'out/level3-migration/sdk/terminal-recovery-ui-diagnostic.json',
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

async function seedInterruptedStage(home: string) {
  const ctx = new Context(),
    generation = crypto.randomUUID(),
    registry = new NativeFileGrantRegistry(generation);
  const grants = {
    authorize: async (id, permission, signal) => ({
      authority: await registry.authorize(id, permission, signal),
      signal: signal ?? new AbortController().signal,
      assert: () => signal?.throwIfAborted(),
      dispose: () => {},
    }),
  } satisfies Pick<FileGrants, 'authorize'>;
  const files = new GrantedStreamingFiles(() => grants);
  let staging: PrivateTerminalStaging | undefined;
  try {
    await ctx.plugin(Storage);
    await ctx.plugin(Schema);
    await ctx.plugin(Relational, {
      path: join(home, 'data-v2/axterm.sqlite'),
      schema: 'productSchema',
    });
    await ctx.plugin(Domains, { backend: 'relational' });
    const domain = await ctx.storage.domain.open(Schema.productDomains.terminalTransferStages),
      store = new TerminalStageStore(domain, 'web', generation);
    staging = new PrivateTerminalStaging(
      join(home, 'profiles/web/terminal-stages'),
      files,
      grants as FileGrants,
      store,
    );
    const grant = await registry.createTrustedPath(join(home, 'downloads'), 'directory', [
      'read',
      'write',
    ]);
    const stage = await staging.prepare(
      grant.grantId,
      'download',
      'xmodem',
      new AbortController().signal,
    );
    await writeFile(join(stage.path, 'incomplete.part'), 'PRIVATE_INTERRUPTED_BYTES');
    await stage.close();
  } finally {
    await staging?.close();
    await files.close();
    registry.close();
    await ctx.fiber.dispose();
  }
}
