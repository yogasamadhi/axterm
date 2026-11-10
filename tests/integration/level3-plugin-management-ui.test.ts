import {
  level3ContextAction,
  openLevel3AiWorkspace,
  openLevel3Settings,
} from '../support/level3-workspace-actions.ts';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, access } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { create as createTar } from 'tar';
import { _electron as electron, type ElectronApplication } from '@playwright/test';
import { expect, it } from 'vitest';
import { dictionaries } from '../../packages/plugins/plugins/src/client/locales.ts';
import { dictionaries as marketDictionaries } from '../../packages/plugins/market/src/client/locales.ts';

const packageResult = process.env.AXTERM_LEVEL3_PACKAGE_RESULT;
// The application scope deliberately does not make this Profile-installed package trusted or built in.
const packageName = '@axterm/external-management-fixture';
const enginePackageName = '@external/managed-engine-fixture';
async function packageArchive(root: string, version: string) {
  const directory = join(root, version),
    source = join(directory, 'package');
  await mkdir(source, { recursive: true });
  const manifest = {
    name: packageName,
    version,
    type: 'module',
    engines: { axterm: version === '2.0.0' ? '>=99' : '^0.10.0' },
    exports: {
      '.': './index.js',
      './client': { browser: './client.browser.js', default: './client.browser.js' },
    },
    scripts: { postinstall: 'node build.js' },
    axterm: {
      bundle: { patch: './cordis.patch.yml' },
      client: { platform: 'web', immediately: true, external: ['@axterm/ui/controls'] },
    },
  };
  await writeFile(join(source, 'package.json'), JSON.stringify(manifest));
  await writeFile(
    join(source, 'cordis.patch.yml'),
    `- insert:\n    - id: managed-external-fixture\n      name: '${packageName}'\n      config:\n        stateFile: ${JSON.stringify(join(root, 'home/managed-external-state'))}\n`,
  );
  await writeFile(
    join(source, 'index.js'),
    `import{writeFileSync}from'node:fs';export const inject=['pluginManager','pluginCommands'];export function apply(ctx,config){ctx.pluginManager.list();if(typeof ctx.pluginCommands.generation!=='string')throw new Error('PUBLIC_COMMANDS_UNAVAILABLE');const path=config.stateFile;writeFileSync(path,'active-${version}');ctx.effect(()=>async()=>{await new Promise(done=>setTimeout(done,30));writeFileSync(path,'disposed-${version}');});}`,
  );
  await writeFile(
    join(source, 'build.js'),
    "import{writeFileSync}from'node:fs';writeFileSync('approved-build-runtime',process.execPath);",
  );
  await writeFile(
    join(source, 'client.browser.js'),
    `window.__ModuleLoader__.load({id:${JSON.stringify(packageName)},factory(require){const React=require('react');const{Button}=require('@axterm/ui/controls');return{inject:['slots','pluginActions'],apply(ctx){${version === '1.2.0' ? "throw new Error('CONTROLLED_CLIENT_ACTIVATION_FAILURE_CANARY');" : ''}ctx.slots.inject('workspace.toolbar',function*(){yield ctx.slots.register({name:'workspace.toolbar',id:'external.management.fixture',order:500},()=>{const facts=React.useSyncExternalStore(ctx.pluginActions.subscribe,ctx.pluginActions.getSnapshot);return React.createElement(Button,{'data-external-management-fixture':'','data-plugin-facts':facts.status},'External ${version}');});});}};}});`,
  );
  const file = join(directory, 'fixture.tgz');
  await createTar({ cwd: directory, file, gzip: true }, ['package']);
  return { manifest, bytes: await readFile(file), fileName: 'fixture-' + version + '.tgz' };
}
async function engineArchive(root: string, profile: string) {
  const directory = join(root, 'engine'),
    source = join(directory, 'package');
  await mkdir(source, { recursive: true });
  const manifest = {
    name: enginePackageName,
    version: '1.0.0',
    type: 'module',
    engines: { axterm: '^0.10.0' },
    exports: { '.': './index.js' },
    axterm: { bundle: { patch: './cordis.patch.yml' } },
  };
  await writeFile(join(source, 'package.json'), JSON.stringify(manifest));
  await writeFile(
    join(source, 'cordis.patch.yml'),
    `- insert:\n    - id: managed-engine-fixture\n      name: '${enginePackageName}'\n      config:\n        directory: ${JSON.stringify(join(root, 'home'))}\n        packageFile: ${JSON.stringify(join(root, 'home/profiles', profile, 'node_modules', enginePackageName, 'package.json'))}\n`,
  );
  await writeFile(
    join(source, 'index.js'),
    `import{writeFileSync,existsSync}from'node:fs';import{join}from'node:path';export const inject=['engines'];export function apply(ctx,config){writeFileSync(join(config.directory,'managed-engine-state'),'registered');ctx.engines.register('managed.engine.fixture',{label:'Managed package Engine',capabilities:{cancellation:true,tools:true,resume:false},async openSession(){return{async run(input,execution){if(input.prompt.includes('self-remove-with-approval')){writeFileSync(join(config.directory,'managed-engine-state'),'asking-removal');try{await execution.tool({callId:'self_remove',name:'plugins.manage',arguments:{request:{action:'command',request:{operation:'remove',name:'@external/managed-engine-fixture'}}}});if(!execution.signal.aborted)await new Promise(done=>execution.signal.addEventListener('abort',done,{once:true}));}finally{await new Promise(done=>setTimeout(done,60));if(!existsSync(config.packageFile))throw new Error('SELF_REMOVED_BEFORE_DRAIN');writeFileSync(join(config.directory,'managed-engine-self-drained'),'drained-with-package-present');}return;}if(input.prompt.includes('wait-for-unload')){writeFileSync(join(config.directory,'managed-engine-state'),'running');await execution.emit({type:'delta',text:'External package Engine waiting'});if(!execution.signal.aborted)await new Promise(done=>execution.signal.addEventListener('abort',done,{once:true}));await new Promise(done=>setTimeout(done,60));if(!existsSync(config.packageFile))throw new Error('ENGINE_REMOVED_BEFORE_DRAIN');writeFileSync(join(config.directory,'managed-engine-drained'),'drained-with-package-present');return;}await execution.emit({type:'delta',text:'External package Engine response'});await execution.emit({type:'completed'});},async close(){writeFileSync(join(config.directory,'managed-engine-state'),'closed');}};}});}`,
  );
  const file = join(directory, 'engine.tgz');
  await createTar({ cwd: directory, file, gzip: true }, ['package']);
  return { manifest, bytes: await readFile(file), fileName: 'engine-fixture-1.0.0.tgz' };
}
for (const mode of ['web', 'package'] as const)
  it.skipIf(mode === 'package' && (!packageResult || process.platform !== 'darwin'))(
    `installs, switches, upgrades and removes a real external Host/UI tarball through the authenticated ${mode} management page`,
    async () => {
      const root = await mkdtemp(join(tmpdir(), 'axterm-plugin-ui-')),
        home = join(root, 'home');
      await mkdir(home);
      const hostArchives = await Promise.all(
        ['1.0.0', '1.1.0', '1.2.0', '2.0.0'].map((version) => packageArchive(root, version)),
      );
      const archives = [
        ...hostArchives,
        await engineArchive(root, mode === 'web' ? 'web' : 'desktop'),
      ];
      const requested: string[] = [];
      let base = '',
        host: ChildProcess | undefined,
        stopped: Promise<unknown> | undefined,
        browser: ElectronApplication | undefined;
      let diagnostic: (() => Promise<unknown>) | undefined;
      const server = createServer((request, response) => {
        const rawPath = decodeURIComponent(new URL(request.url!, 'http://fixture').pathname);
        requested.push(rawPath);
        if (rawPath === '/market-index.json') {
          response.setHeader('content-type', 'application/json');
          response.end(
            JSON.stringify({
              format: 1,
              title: 'Actual local package index',
              plugins: [
                {
                  name: packageName,
                  title: { en: 'Managed external package', 'zh-CN': '真实外部插件' },
                  description: 'Local registry installation fixture',
                  versions: ['2.0.0', '1.1.0', '1.0.0'].map((version) => ({
                    version,
                    publishTimestamp: version === '2.0.0' ? 30 : version === '1.1.0' ? 20 : 10,
                    engines: { axterm: version === '2.0.0' ? '>=99' : '^0.10.0' },
                    source: { type: 'npm', registry: base + 'market/' },
                  })),
                },
              ],
            }),
          );
          return;
        }
        const path = rawPath.startsWith('/market/') ? rawPath.slice('/market'.length) : rawPath;
        if (request.headers.authorization !== 'Bearer PRIVATE_PLUGIN_UI_CANARY') {
          response.writeHead(401);
          response.end();
          return;
        }
        const selected = archives.filter((item) => path === '/' + item.manifest.name);
        if (selected.length) {
          response.setHeader('content-type', 'application/json');
          response.end(
            JSON.stringify({
              name: selected[0]!.manifest.name,
              'dist-tags': {
                latest: selected.some((item) => item.manifest.version === '1.1.0')
                  ? '1.1.0'
                  : '1.0.0',
              },
              versions: Object.fromEntries(
                selected.map((item) => [
                  item.manifest.version,
                  {
                    ...item.manifest,
                    dist: {
                      tarball: base + item.fileName,
                      integrity:
                        'sha512-' + createHash('sha512').update(item.bytes).digest('base64'),
                    },
                  },
                ]),
              ),
            }),
          );
        } else {
          const item = archives.find((item) => path === '/' + item.fileName);
          if (item) {
            response.setHeader('content-type', 'application/octet-stream');
            response.end(item.bytes);
          } else {
            response.writeHead(404);
            response.end();
          }
        }
      });
      server.listen(0, '127.0.0.1');
      await once(server, 'listening');
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Unbound package fixture');
      base = `http://127.0.0.1:${address.port}/`;
      try {
        const profile = mode === 'web' ? 'web' : 'desktop',
          directory = join(home, 'profiles', profile);
        await mkdir(directory, { recursive: true });
        await writeFile(
          join(directory, 'cordis.patch.yml'),
          JSON.stringify([
            { id: 'plugin-manager', config: { registry: base, fallbackRegistries: [] } },
          ]),
        );
        await writeFile(
          join(directory, '.npmrc'),
          `//127.0.0.1:${address.port}/:_authToken=PRIVATE_PLUGIN_UI_CANARY\nalways-auth=true\n@axterm:registry=${base}must-not-select/\n`,
        );
        let executablePath = createRequire(resolve('apps/desktop/package.json'))(
            'electron',
          ) as string,
          args: string[] = [],
          token = '';
        if (mode === 'package') {
          const record = JSON.parse(await readFile(packageResult!, 'utf8')),
            appRoot = dirname(dirname(dirname(record.app)));
          executablePath = join(
            appRoot,
            'Contents/MacOS',
            (await readdir(join(appRoot, 'Contents/MacOS')))[0]!,
          );
        } else {
          const launcher = join(root, 'profile.mjs');
          await writeFile(
            launcher,
            `import{runProfile}from ${JSON.stringify(pathToFileURL(resolve('apps/cli/lib/profile-boot.js')).href)};import{PROFILE_TEMPLATES}from ${JSON.stringify(pathToFileURL(resolve('apps/cli/lib/profile-templates.js')).href)};const app=await runProfile({profile:'web',home:${JSON.stringify(home)},installAnchor:${JSON.stringify(resolve('apps/cli/package.json'))},templates:PROFILE_TEMPLATES,patchFiles:[],args:[],requiredServices:['pluginsController','webStartup'],prepare(ctx){ctx.provide('webAssets',{index:${JSON.stringify(resolve('apps/web/dist/index.html'))},authenticationPage:${JSON.stringify(resolve('apps/web/dist/auth.html'))}});}});process.send(app.ctx.webStartup);`,
          );
          host = spawn(process.execPath, ['--expose-internals', launcher], {
            cwd: root,
            env: {
              ...process.env,
              AXTERM_HOME: home,
              AXTERM_LEGACY_HOME: join(home, 'absent-legacy-source'),
              HTTP_PROXY: '',
              HTTPS_PROXY: '',
              ALL_PROXY: '',
            },
            stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
          });
          stopped = new Promise((done) => host!.once('exit', done));
          const startup = await new Promise<{ url: string; tokenFile: string }>((done, reject) => {
            const timer = setTimeout(() => reject(new Error('Plugin UI startup timeout')), 15000);
            host!.once('message', (value) => {
              clearTimeout(timer);
              done(value as { url: string; tokenFile: string });
            });
            host!.once('error', reject);
            host!.once('exit', () => {
              clearTimeout(timer);
              reject(new Error('Plugin UI Host exited'));
            });
          });
          token = (await readFile(startup.tokenFile, 'utf8')).trim();
          const events = new URL('plugins/events', startup.url);
          expect((await fetch(events)).status).toBe(401);
          expect(
            (await fetch(events, { headers: { origin: 'https://untrusted.example.test' } })).status,
          ).toBe(403);
          const entry = join(root, 'browser.cjs');
          await writeFile(
            entry,
            `const{app,BrowserWindow}=require('electron');app.setPath('userData',${JSON.stringify(join(root, 'browser'))});app.whenReady().then(()=>{const win=new BrowserWindow({show:false,width:1280,height:800,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false}});win.loadURL(${JSON.stringify(startup.url)});});app.on('window-all-closed',()=>app.quit());`,
          );
          args = [entry];
        }
        browser = await electron.launch({
          executablePath,
          args,
          cwd: root,
          timeout: 15000,
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
        });
        const page = await browser.firstWindow({ timeout: 15000 });
        page.setDefaultTimeout(10000);
        const errors: string[] = [];
        const consoleErrors: string[] = [];
        page.on('console', (message) => {
          if (['error', 'warning'].includes(message.type()) && consoleErrors.length < 80)
            consoleErrors.push(
              message
                .text()
                .slice(0, 2000)
                .replaceAll(token || 'ABSENT_TOKEN', '[redacted]')
                .replaceAll('PRIVATE_PLUGIN_UI_CANARY', '[redacted]'),
            );
        });
        diagnostic = async () => ({
          errors,
          consoleErrors,
          body: (
            await page
              .locator('body')
              .innerText({ timeout: 1000 })
              .catch(() => '[window closed]')
          ).slice(0, 32000),
        });
        page.on('pageerror', (error) =>
          errors.push(error.message.replaceAll(token || 'ABSENT_TOKEN', '[redacted]')),
        );
        if (mode === 'web') {
          await page.locator('#credential').fill(token);
          await page.getByRole('button', { name: 'Connect', exact: true }).click();
        }
        await page.locator('[data-axterm-product-workspace]').waitFor();
        await openLevel3Settings(page);
        await page.getByTestId('application-language').click();
        await page.getByRole('option', { name: 'English', exact: true }).click();
        await page.locator('[data-section-close=left]').click();
        await (await level3ContextAction(page, '[data-market-trigger]')).click();
        const market = page.locator('[data-market-dialog]');
        await expect.poll(() => market.innerText()).toContain('No indexes configured.');
        expect(requested.filter((path) => path === '/market-index.json')).toHaveLength(0);
        await market.getByLabel('Index URLs', { exact: true }).fill(base + 'market-index.json');
        await market.getByRole('button', { name: 'Save indexes', exact: true }).click();
        await market.getByRole('button', { name: 'Search', exact: true }).waitFor();
        expect(requested.filter((path) => path === '/market-index.json')).toHaveLength(0);
        await market.getByRole('button', { name: 'Search', exact: true }).click();
        await market.locator('[data-market-version]').selectOption('2.0.0');
        await expect
          .poll(() =>
            market
              .getByRole('button', { name: 'Install selected version', exact: true })
              .isDisabled(),
          )
          .toBe(true);
        await market.locator('[data-market-version]').selectOption('1.0.0');
        await expect
          .poll(() => market.locator('[data-market-install]').innerText())
          .toContain(base + 'market/');
        expect(requested.some((path) => path.startsWith('/market/@'))).toBe(false);
        await market
          .getByLabel('I trust this exact package and registry and want to install it', {
            exact: true,
          })
          .check();
        await market.getByRole('button', { name: 'Install selected version', exact: true }).click();
        const state = () =>
          readFile(join(home, 'managed-external-state'), 'utf8').catch(() => 'absent');
        await expect.poll(state, { timeout: 20000 }).toBe('active-1.0.0');
        expect(requested.some((path) => path.startsWith('/market/@'))).toBe(true);
        expect(requested.some((path) => path.startsWith('/must-not-select/'))).toBe(false);
        await expect.poll(() => market.getByRole('status').innerText()).toBe('Operation recorded.');
        await page.keyboard.press('Escape');
        await (await level3ContextAction(page, '[data-plugins-manager-trigger]')).click();
        const dialog = page.locator('[data-plugins-manager]');
        const row = () =>
          dialog.locator('li').filter({ has: page.locator('strong', { hasText: packageName }) });
        await expect.poll(() => row().innerText()).toContain('1.0.0');
        const marker = join(directory, 'node_modules', packageName, 'approved-build-runtime');
        await expect(access(marker)).rejects.toMatchObject({ code: 'ENOENT' });
        await page.keyboard.press('Escape');
        await expect
          .poll(() => page.locator('[data-external-management-fixture]').allTextContents())
          .toEqual(['External 1.0.0']);
        await expect
          .poll(() =>
            page.locator('[data-external-management-fixture]').getAttribute('data-plugin-facts'),
          )
          .toBe('ready');
        const shots = resolve('out/level3-migration/plugin-management-layouts', mode);
        await mkdir(shots, { recursive: true });
        for (const [language, label] of [
          ['en', 'English'],
          ['ja', '日本語'],
          ['zh-CN', '简体中文'],
          ['zh-TW', '繁體中文'],
        ] as const) {
          await openLevel3Settings(page);
          await page.getByTestId('application-language').click();
          await page.getByRole('option', { name: label, exact: true }).click();
          await expect.poll(() => page.locator('html').getAttribute('lang')).toBe(language);
          await page.locator('[data-section-close=left]').click();
          await (await level3ContextAction(page, '[data-plugins-manager-trigger]')).click();
          await page
            .getByRole('dialog', { name: dictionaries[language].title, exact: true })
            .waitFor();
          for (const viewport of [
            { width: 1280, height: 800 },
            { width: 1440, height: 900 },
            { width: 1920, height: 1080 },
          ]) {
            await page.setViewportSize(viewport);
            for (const zoom of [1, 2]) {
              await browser.evaluate(
                ({ BrowserWindow }, zoom) =>
                  BrowserWindow.getAllWindows()[0]!.webContents.setZoomFactor(zoom),
                zoom,
              );
              await page.screenshot({
                path: join(shots, language + '-' + viewport.width + '-' + zoom + '.png'),
              });
            }
          }
          await browser.evaluate(({ BrowserWindow }) =>
            BrowserWindow.getAllWindows()[0]!.webContents.setZoomFactor(1),
          );
          await page.keyboard.press('Escape');
          await (await level3ContextAction(page, '[data-market-trigger]')).click();
          await page
            .getByRole('dialog', { name: marketDictionaries[language].title, exact: true })
            .waitFor();
          const marketShots = resolve('out/level3-migration/market-layouts', mode);
          await mkdir(marketShots, { recursive: true });
          for (const viewport of [
            { width: 1280, height: 800 },
            { width: 1440, height: 900 },
            { width: 1920, height: 1080 },
          ]) {
            await page.setViewportSize(viewport);
            for (const zoom of [1, 2]) {
              await browser.evaluate(
                ({ BrowserWindow }, zoom) =>
                  BrowserWindow.getAllWindows()[0]!.webContents.setZoomFactor(zoom),
                zoom,
              );
              await page.screenshot({
                path: join(marketShots, language + '-' + viewport.width + '-' + zoom + '.png'),
              });
              expect(
                await page
                  .locator('[data-market-dialog]')
                  .evaluate((node) => node.scrollWidth <= node.clientWidth + 1),
              ).toBe(true);
            }
          }
          await browser.evaluate(({ BrowserWindow }) =>
            BrowserWindow.getAllWindows()[0]!.webContents.setZoomFactor(1),
          );
          await page.keyboard.press('Escape');
        }
        await openLevel3Settings(page);
        await page.getByTestId('application-language').click();
        await page.getByRole('option', { name: 'English', exact: true }).click();
        await page.locator('[data-section-close=left]').click();
        await (await level3ContextAction(page, '[data-plugins-manager-trigger]')).click();
        await dialog.getByRole('button', { name: 'Approve build', exact: true }).click();
        const approval = page.getByRole('dialog', {
          name: 'Run this exact dependency build?',
          exact: true,
        });
        await approval.getByRole('button', { name: 'Cancel', exact: true }).click();
        await expect(access(marker)).rejects.toMatchObject({ code: 'ENOENT' });
        await dialog.getByRole('button', { name: 'Approve build', exact: true }).click();
        await approval.getByRole('button', { name: 'Approve and run', exact: true }).click();
        await expect
          .poll(() => readFile(marker, 'utf8').catch(() => 'absent'), { timeout: 15000 })
          .toBe(mode === 'package' ? executablePath : process.execPath);
        await row().getByRole('button', { name: 'Disable', exact: true }).click();
        await expect.poll(state, { timeout: 15000 }).toBe('disposed-1.0.0');
        await expect.poll(() => page.locator('[data-external-management-fixture]').count()).toBe(0);
        await row().getByRole('button', { name: 'Enable', exact: true }).click();
        await expect.poll(state, { timeout: 15000 }).toBe('active-1.0.0');
        await row().getByRole('button', { name: 'Upgrade', exact: true }).click();
        await expect.poll(state, { timeout: 20000 }).toBe('active-1.1.0');
        await expect(access(marker)).rejects.toMatchObject({ code: 'ENOENT' });
        await dialog
          .getByLabel('Package name and version', { exact: true })
          .fill(packageName + '@2.0.0');
        await dialog.getByLabel('Replace existing version', { exact: true }).check();
        await dialog
          .getByLabel('I trust this package and want to install it', { exact: true })
          .check();
        await dialog.getByRole('button', { name: 'Install', exact: true }).click();
        await expect
          .poll(() => dialog.innerText(), { timeout: 15000 })
          .toContain('The operation was not confirmed.');
        expect(requested).not.toContain('/fixture-2.0.0.tgz');
        expect(await state()).toBe('active-1.1.0');
        await dialog
          .getByLabel('Package name and version', { exact: true })
          .fill(packageName + '@1.2.0');
        await dialog
          .getByLabel('I trust this package and want to install it', { exact: true })
          .check();
        await dialog.getByRole('button', { name: 'Install', exact: true }).click();
        await expect.poll(state, { timeout: 15000 }).toBe('active-1.2.0');
        await expect
          .poll(() => dialog.innerText(), { timeout: 15000 })
          .toContain('This component could not activate.');
        expect(await page.locator('body').innerText()).not.toContain(
          'CONTROLLED_CLIENT_ACTIVATION_FAILURE_CANARY',
        );
        await dialog.getByRole('button', { name: 'Retry client components', exact: true }).click();
        await row().getByRole('button', { name: 'Upgrade', exact: true }).click();
        await expect.poll(state, { timeout: 15000 }).toBe('active-1.1.0');
        await expect
          .poll(() => dialog.innerText(), { timeout: 15000 })
          .not.toContain('This component could not activate.');
        await row().getByRole('button', { name: 'Remove', exact: true }).click();
        await expect.poll(state, { timeout: 15000 }).toBe('disposed-1.1.0');
        await expect.poll(() => row().count()).toBe(0);
        await expect.poll(() => page.locator('[data-external-management-fixture]').count()).toBe(0);
        expect(await state()).toBe('disposed-1.1.0');
        await dialog
          .getByLabel('Package name and version', { exact: true })
          .fill(enginePackageName + '@1.0.0');
        await dialog.getByLabel('Replace existing version', { exact: true }).uncheck();
        await dialog
          .getByLabel('I trust this package and want to install it', { exact: true })
          .check();
        await dialog.getByRole('button', { name: 'Install', exact: true }).click();
        const engineState = () =>
          readFile(join(home, 'managed-engine-state'), 'utf8').catch(() => 'absent');
        await expect.poll(engineState, { timeout: 15000 }).toBe('registered');
        await page.keyboard.press('Escape');
        await openLevel3AiWorkspace(page);
        const config = page.getByRole('dialog', { name: 'AI Config', exact: true });
        await config.getByLabel('Engine', { exact: true }).selectOption('managed.engine.fixture');
        expect(
          await config.locator('[name=baseUrl],[name=apiKey],[name=piModelsJson]').count(),
        ).toBe(0);
        await config.locator('[name=name]').fill('Installed package Engine');
        await config.locator('[name=model]').fill('package-engine-model');
        await config.getByRole('button', { name: 'Save configuration', exact: true }).click();
        await config.waitFor({ state: 'hidden' });
        await page
          .locator('.ai-chat-options select[name=modelId]:visible')
          .selectOption({ label: 'package-engine-model' });
        await page
          .locator('.ai-chat-composer:visible textarea[name=prompt]')
          .fill('Use the installed external package Engine');
        await page
          .locator('.ai-chat-composer:visible')
          .getByRole('button', { name: 'Send message', exact: true })
          .click();
        await page
          .locator('.ai-chat-message.assistant:visible')
          .filter({ hasText: 'External package Engine response' })
          .waitFor();
        await page
          .locator('.ai-chat-composer:visible textarea[name=prompt]')
          .fill('wait-for-unload');
        await page
          .locator('.ai-chat-composer:visible')
          .getByRole('button', { name: 'Send message', exact: true })
          .click();
        await expect.poll(engineState, { timeout: 15000 }).toBe('running');
        await (await level3ContextAction(page, '[data-plugins-manager-trigger]')).click();
        const engineRow = dialog
          .locator('li')
          .filter({ has: page.locator('strong', { hasText: enginePackageName }) });
        await engineRow.getByRole('button', { name: 'Remove', exact: true }).click();
        await expect
          .poll(
            () => readFile(join(home, 'managed-engine-drained'), 'utf8').catch(() => 'absent'),
            { timeout: 15000 },
          )
          .toBe('drained-with-package-present');
        await expect.poll(() => engineRow.count(), { timeout: 15000 }).toBe(0);
        await dialog
          .getByLabel('Package name and version', { exact: true })
          .fill(enginePackageName + '@1.0.0');
        await dialog
          .getByLabel('I trust this package and want to install it', { exact: true })
          .check();
        await dialog.getByRole('button', { name: 'Install', exact: true }).click();
        await expect.poll(engineState, { timeout: 15000 }).toBe('registered');
        await page.keyboard.press('Escape');
        await page
          .locator('.ai-chat-options select[name=modelId]:visible')
          .selectOption({ label: 'package-engine-model' });
        await page
          .locator('.ai-chat-composer:visible textarea[name=prompt]')
          .fill('self-remove-with-approval');
        await page
          .locator('.ai-chat-composer:visible')
          .getByRole('button', { name: 'Send message', exact: true })
          .click();
        const managementApproval = page.getByRole('dialog', {
          name: 'Plugin management requiring approval',
          exact: true,
        });
        await managementApproval.waitFor();
        expect(await managementApproval.innerText()).toContain(enginePackageName);
        const approvalShots = resolve('out/level3-migration/model-plugin-approval-layouts', mode);
        await mkdir(approvalShots, { recursive: true });
        for (const [language, label, title] of [
          ['en', 'English', 'Plugin management requiring approval'],
          ['ja', '日本語', '承認が必要なプラグイン管理'],
          ['zh-CN', '简体中文', '需要审批的插件管理'],
          ['zh-TW', '繁體中文', '需要核准的外掛管理'],
        ] as const) {
          await page.keyboard.press('Escape');
          await openLevel3Settings(page);
          await page.getByTestId('application-language').click();
          await page.getByRole('option', { name: label, exact: true }).click();
          await expect.poll(() => page.locator('html').getAttribute('lang')).toBe(language);
          await page.locator('[data-section-close=left]').click();
          await page.locator('.ai-approval-reminder').click();
          await page.getByRole('dialog', { name: title, exact: true }).waitFor();
          for (const viewport of [
            { width: 1280, height: 800 },
            { width: 1440, height: 900 },
            { width: 1920, height: 1080 },
          ]) {
            await page.setViewportSize(viewport);
            for (const zoom of [1, 2]) {
              await browser.evaluate(
                ({ BrowserWindow }, zoom) =>
                  BrowserWindow.getAllWindows()[0]!.webContents.setZoomFactor(zoom),
                zoom,
              );
              await page.screenshot({
                path: join(approvalShots, language + '-' + viewport.width + '-' + zoom + '.png'),
              });
            }
          }
          await browser.evaluate(({ BrowserWindow }) =>
            BrowserWindow.getAllWindows()[0]!.webContents.setZoomFactor(1),
          );
        }
        await page.keyboard.press('Escape');
        await openLevel3Settings(page);
        await page.getByTestId('application-language').click();
        await page.getByRole('option', { name: 'English', exact: true }).click();
        await page.locator('[data-section-close=left]').click();
        await page.locator('.ai-approval-reminder').click();

        await access(join(directory, 'node_modules', enginePackageName, 'package.json'));
        await managementApproval
          .getByRole('button', { name: 'Approve this request', exact: true })
          .click();
        await expect
          .poll(
            () => readFile(join(home, 'managed-engine-self-drained'), 'utf8').catch(() => 'absent'),
            { timeout: 15000 },
          )
          .toBe('drained-with-package-present');
        await expect
          .poll(
            () =>
              access(join(directory, 'node_modules', enginePackageName, 'package.json')).then(
                () => true,
                () => false,
              ),
            { timeout: 15000 },
          )
          .toBe(false);
        expect(errors).toEqual([]);
        const closed = browser.waitForEvent('close', { timeout: 15000 });
        await browser.evaluate(({ app, dialog }) => {
          // The isolated package can conservatively require confirmation while AI
          // drains. Approve only this explicit Quit action; recovery stays a failure.
          dialog.showMessageBox = ((options: Electron.MessageBoxOptions) => {
            if (
              options.message !== 'Active tasks may be interrupted.' ||
              options.buttons?.join(',') !== 'Cancel,Quit'
            )
              throw new Error('Unexpected native dialog during package exit');
            return Promise.resolve({ response: 1, checkboxChecked: false });
          }) as typeof dialog.showMessageBox;
          app.quit();
        });
        await closed;
        browser = undefined;
      } catch (error) {
        if (diagnostic)
          await writeFile(
            resolve('out/level3-migration/sdk/plugins-ui-diagnostic-' + mode + '.json'),
            JSON.stringify(
              {
                ...((await diagnostic()) as object),
                failure: String(error),
                carrierProcess: browser
                  ? {
                      pid: browser.process().pid,
                      exitCode: browser.process().exitCode,
                      signalCode: browser.process().signalCode,
                    }
                  : undefined,
              },
              null,
              2,
            ),
          );
        throw error;
      } finally {
        if (browser) {
          // The real Desktop intentionally hides on window close. Failed tests must
          // retire their own carrier instead of waiting forever on tray lifetime.
          if (mode === 'package') browser.process().kill('SIGKILL');
          await browser.close().catch(() => {});
        }
        host?.kill('SIGTERM');
        await stopped;
        server.closeAllConnections();
        await new Promise<void>((done) => server.close(() => done()));
        await rm(root, { recursive: true, force: true });
      }
    },
    180_000,
  );
