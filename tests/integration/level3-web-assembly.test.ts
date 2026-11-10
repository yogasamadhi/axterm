import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { _electron as electron, type ElectronApplication } from '@playwright/test';
import { expect, it } from 'vitest';

const electronPath = createRequire(resolve('apps/desktop/package.json'))('electron') as string;
it('boots an authenticated real Profile, delivers independent Client factories and renders a generated Remote model through Slots', async () => {
  const home = await mkdtemp(join(tmpdir(), 'axterm-web-assembly-'));
  let host: ChildProcess | undefined;
  let shell: ElectronApplication | undefined;
  let stopped: Promise<unknown> | undefined;
  const diagnostics: string[] = [];
  try {
    const profile = join(home, 'profiles/web');
    const bundle = join(profile, 'node_modules/@fixture/bundle');
    const frame = join(profile, 'node_modules/@fixture/frame');
    await mkdir(bundle, { recursive: true });
    await mkdir(frame, { recursive: true });
    await writeFile(
      join(profile, 'package.json'),
      JSON.stringify({
        name: 'fixture-web-profile',
        private: true,
        dependencies: { '@fixture/bundle': '1.0.0', '@fixture/frame': '1.0.0' },
        axterm: {
          profile: { bundles: ['@axterm/bundle-base', '@axterm/bundle-web', '@fixture/bundle'] },
        },
      }),
    );
    await writeFile(
      join(bundle, 'package.json'),
      JSON.stringify({
        name: '@fixture/bundle',
        version: '1.0.0',
        dependencies: { '@fixture/frame': '1.0.0' },
        axterm: { bundle: { patch: './patch.json' } },
      }),
    );
    await writeFile(
      join(bundle, 'patch.json'),
      JSON.stringify([{ insert: [{ id: 'fixture-frame', name: '@fixture/frame' }] }]),
    );
    await writeFile(
      join(frame, 'package.json'),
      JSON.stringify({
        name: '@fixture/frame',
        version: '1.0.0',
        type: 'module',
        exports: {
          '.': './index.js',
          './client': { browser: './client.browser.js', default: './client.js' },
        },
        axterm: {
          client: {
            platform: 'web',
            immediately: true,
            external: ['@axterm/plugin-desktop/client'],
          },
        },
      }),
    );
    await writeFile(join(frame, 'index.js'), 'export function apply() {}');
    // Test-only frame; the product workspace is migrated separately without replacing visual baselines.
    await writeFile(
      join(frame, 'client.browser.js'),
      `window.__ModuleLoader__.load({id:'@fixture/frame',factory(require){
      const React=require('react');const C=require('@axterm/ui/controls');const h=React.createElement;
      return {inject:['slots','desktopRuntimeModel'],apply(ctx){
        const model=ctx.desktopRuntimeModel;
        ctx.slots.register({name:'root'},function RuntimeProbe(){
          const state=React.useSyncExternalStore(model.subscribe,model.getSnapshot);
          const [selected,setSelected]=React.useState('first');
          const input=React.useRef(null);
          return h('main',{'data-probe-state':state.status},state.status==='ready'
            ? h('output',{'data-generation':state.baseline.metadata.generation},state.baseline.version.appVersion)
            : state.status,
            h(C.Dialog,null,h(C.DialogTrigger,{asChild:true},h(C.Button,null,'Open controls')),
              h(C.DialogContent,{closeLabel:'Close controls',onOpenAutoFocus:event=>{event.preventDefault();input.current?.focus();}},
                h(C.DialogTitle,null,'Connection controls'),h(C.DialogDescription,null,'Keyboard and portal acceptance probe'),
                h(C.Label,{htmlFor:'host-input'},'Host'),h(C.Input,{id:'host-input',ref:input,defaultValue:'localhost'}),
                h(C.Label,{htmlFor:'notes-input'},'Notes'),h(C.Textarea,{id:'notes-input'}),
                h(C.Select,{value:selected,onValueChange:setSelected},h(C.SelectTrigger,{'aria-label':'Protocol'},h(C.SelectValue)),h(C.SelectContent,null,
                  h(C.SelectItem,{value:'first'},'SSH'),h(C.SelectItem,{value:'second'},'SFTP'),h(C.SelectItem,{value:'disabled',disabled:true},'Unavailable'))),
                h('output',{'data-selected':''},selected),
                h(C.Tabs,{defaultValue:'general'},h(C.TabsList,{'aria-label':'Settings sections'},h(C.TabsTrigger,{value:'general'},'General'),h(C.TabsTrigger,{value:'advanced'},'Advanced')),
                  h(C.TabsContent,{value:'general'},'General settings'),h(C.TabsContent,{value:'advanced'},'Advanced settings')),
                h(C.TooltipProvider,{delayDuration:0},h(C.Tooltip,null,h(C.TooltipTrigger,{asChild:true},h(C.Button,null,'Help')),h(C.TooltipContent,null,'Protocol help'))),
                h(C.DialogFooter,null,h(C.DialogClose,{asChild:true},h(C.Button,null,'Done'))))));
        });
      }};
    }});`,
    );
    const script = `import {runProfile} from ${JSON.stringify(pathToFileURL(resolve('apps/cli/lib/profile-boot.js')).href)};
      const app=await runProfile({profile:'web',home:${JSON.stringify(home)},installAnchor:${JSON.stringify(resolve('apps/cli/package.json'))},templates:{},patchFiles:[],args:[],requiredServices:['webStartup','clientModules','typertGateway','storageDomain'],prepare(ctx){ctx.provide('webAssets',{index:${JSON.stringify(resolve('apps/web/dist/index.html'))},authenticationPage:${JSON.stringify(resolve('apps/web/dist/auth.html'))}});}});
      process.send(app.ctx.get('webStartup'));`;
    host = spawn(process.execPath, ['--expose-internals', '--input-type=module', '-e', script], {
      cwd: resolve('.'),
      env: { ...process.env, AXTERM_HOME: home, HTTP_PROXY: '', HTTPS_PROXY: '', ALL_PROXY: '' },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    host.stdout?.on('data', (chunk) => diagnostics.push(String(chunk)));
    host.stderr?.on('data', (chunk) => diagnostics.push(String(chunk)));
    stopped = new Promise((done) => host!.once('exit', done));
    const startup = await new Promise<{ url: string; tokenFile: string }>((done, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`Profile startup timeout: ${diagnostics.join('')}`)),
        8000,
      );
      host!.once('message', (message) => {
        clearTimeout(timer);
        done(message as { url: string; tokenFile: string });
      });
      host!.once('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
      host!.once('exit', () => {
        clearTimeout(timer);
        reject(new Error(`Profile exited before readiness: ${diagnostics.join('')}`));
      });
    });
    const token = (await readFile(startup.tokenFile, 'utf8')).trim();
    expect(startup.url).not.toContain(token);
    const unauthenticated = await fetch(startup.url, { signal: AbortSignal.timeout(5000) });
    expect(unauthenticated.status).toBe(401);
    expect(await unauthenticated.text()).toContain('id="credential"');
    expect((await fetch(new URL('/?token=rejected', startup.url))).status).toBe(400);
    const main = join(home, 'electron-main.cjs');
    await writeFile(
      main,
      `const {app,BrowserWindow}=require('electron');
      app.whenReady().then(()=>{const win=new BrowserWindow({show:false,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false}});win.loadURL(process.env.AXTERM_ASSEMBLY_URL);});app.on('window-all-closed',()=>app.quit());`,
    );
    shell = await electron.launch({
      executablePath: electronPath,
      args: [main],
      env: { ...process.env, AXTERM_ASSEMBLY_URL: startup.url },
    });
    const page = await shell.firstWindow({ timeout: 8000 });
    page.setDefaultTimeout(8000);
    const browserErrors: string[] = [];
    page.on('pageerror', (error) => browserErrors.push(error.message));
    const browserConsole: string[] = [];
    page.on('console', (message) => {
      browserConsole.push(message.text().replaceAll(token, '[redacted]'));
    });
    await page.locator('#credential').fill(token);
    await page.getByRole('button', { name: 'Connect', exact: true }).click();
    try {
      await page.locator('[data-probe-state="ready"] output').waitFor();
    } catch {
      throw new Error(
        JSON.stringify({
          body: (await page.locator('body').textContent())?.replaceAll(token, '[redacted]'),
          browserErrors,
          browserConsole,
        }),
      );
    }
    expect(await page.locator('output').textContent()).toBe('0.10.0');
    expect(await page.locator('output').getAttribute('data-generation')).toMatch(/^[0-9a-f-]{36}$/);
    // A real browser exercises the public shared controls through the platform seed,
    // not a separate React root or a feature-local copy of Radix.
    expect(await page.locator('style[data-plugin="@axterm/ui"]').count()).toBe(1);
    const trigger = page.getByRole('button', { name: 'Open controls', exact: true });
    await trigger.click();
    const dialog = page.getByRole('dialog', { name: 'Connection controls' });
    await dialog.waitFor();
    expect(
      await page
        .getByLabel('Host', { exact: true })
        .evaluate((el) => el === document.activeElement),
    ).toBe(true);
    expect(await dialog.evaluate((el) => !el.closest('main'))).toBe(true);
    await page.getByLabel('Host', { exact: true }).fill('fixture.example');
    await page.getByLabel('Notes', { exact: true }).fill('Keyboard acceptance');
    await page.getByRole('combobox', { name: 'Protocol' }).focus();
    await page.keyboard.press('Space');
    await page.getByRole('option', { name: 'SFTP', exact: true }).waitFor();
    await page.keyboard.press('End');
    await expect
      .poll(() =>
        page
          .getByRole('option', { name: 'SFTP', exact: true })
          .evaluate((el) => el === document.activeElement),
      )
      .toBe(true);
    await page.keyboard.press('Enter');
    expect(await page.locator('[data-selected]').textContent()).toBe('second');
    await shell.evaluate(({ BrowserWindow }) => {
      for (const window of BrowserWindow.getAllWindows()) window.webContents.focus();
    });
    await page.getByRole('tab', { name: 'General', exact: true }).focus();
    await page.keyboard.press('ArrowRight');
    await page.getByRole('tabpanel', { name: 'Advanced', exact: true }).waitFor();
    expect(
      await page.getByRole('tab', { name: 'Advanced', exact: true }).getAttribute('aria-selected'),
    ).toBe('true');
    await page.getByRole('button', { name: 'Help', exact: true }).focus();
    await page.getByRole('tooltip').waitFor();
    expect(await page.getByRole('tooltip').textContent()).toContain('Protocol help');
    await page.getByRole('button', { name: 'Close controls', exact: true }).focus();
    await page.keyboard.press('Tab');
    expect(
      await page
        .getByLabel('Host', { exact: true })
        .evaluate((el) => el === document.activeElement),
    ).toBe(true);
    await page.keyboard.press('Escape');
    await dialog.waitFor({ state: 'hidden' });
    await expect.poll(() => trigger.evaluate((el) => el === document.activeElement)).toBe(true);
    await trigger.click();
    await dialog.waitFor();
    await page.getByRole('button', { name: 'Done', exact: true }).click();
    await dialog.waitFor({ state: 'hidden' });
    expect(browserErrors).toEqual([]);
    expect(
      await page.evaluate(() => ({
        local: { ...localStorage },
        session: { ...sessionStorage },
        cookie: document.cookie,
      })),
    ).toEqual({ local: {}, session: {}, cookie: '' });
    expect(diagnostics.join('')).not.toContain(token);
    expect(await page.locator('body').textContent()).not.toContain(token);
    await shell.close();
    shell = undefined;
    host.kill('SIGTERM');
    expect(await stopped).toBe(0);
    await expect(readFile(startup.tokenFile)).rejects.toMatchObject({ code: 'ENOENT' });
  } finally {
    await shell?.close();
    if (host && host.exitCode === null) {
      host.kill('SIGKILL');
      await stopped;
    }
    await rm(home, { recursive: true, force: true });
  }
}, 30_000);
