import { closeLevel3Desktop } from '../fixtures/level3-desktop-launch.ts';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { _electron as electron, type ElectronApplication } from '@playwright/test';
import { expect, it } from 'vitest';
import { PROFILE_TEMPLATES } from '../../apps/cli/src/profile-templates.ts';
const resultFile = process.env.AXTERM_LEVEL3_PACKAGE_RESULT;
for (const mode of ['shell', 'package'] as const) {
  it.skipIf(process.platform !== 'darwin' || (mode === 'package' && !resultFile))(
    `streams a delayed ${mode} binary upload beyond the ordinary 30-second header deadline, retains the JSON deadline and drains both actual requests`,
    async () => {
      const home = await mkdtemp(join(tmpdir(), 'axterm-desktop-slow-upload-'));
      let application: ElectronApplication | undefined;
      try {
        const profile = join(home, 'profiles/desktop');
        const bundle = join(profile, 'node_modules/@fixture/slow-upload-bundle');
        const plugin = join(profile, 'node_modules/@fixture/slow-upload');
        await mkdir(bundle, { recursive: true });
        await mkdir(plugin, { recursive: true });
        const json = (path: string, value: unknown) => writeFile(path, JSON.stringify(value));
        await json(join(profile, 'package.json'), {
          name: 'isolated-slow-upload',
          private: true,
          dependencies: { '@fixture/slow-upload-bundle': '1.0.0', '@fixture/slow-upload': '1.0.0' },
          axterm: {
            profile: {
              bundles: [...PROFILE_TEMPLATES.desktop!.bundles, '@fixture/slow-upload-bundle'],
            },
          },
        });
        await json(join(bundle, 'package.json'), {
          name: '@fixture/slow-upload-bundle',
          version: '1.0.0',
          axterm: { bundle: { patch: './patch.json' } },
        });
        await json(join(bundle, 'patch.json'), [
          { insert: [{ id: 'slow-upload', name: '@fixture/slow-upload' }] },
        ]);
        await json(join(plugin, 'package.json'), {
          name: '@fixture/slow-upload',
          version: '1.0.0',
          type: 'module',
          exports: { '.': './index.js' },
        });
        // Only the transport fixture is external; no M6 managed installation is claimed.
        await writeFile(
          join(plugin, 'index.js'),
          `
import {setTimeout as delay} from 'node:timers/promises';
import {createHash} from 'node:crypto';
export const inject=['connection'];
export function apply(ctx){
 const lifetime=new AbortController(), active=new Set();let completed=0,canceled=0;
 async function receive(request){
  const signal=AbortSignal.any([request.signal,lifetime.signal]);let reader;
  try{
   const started=performance.now();await delay(33000,undefined,{signal});
   reader=request.body?.getReader();let bytes=0;const hash=createHash('sha256');
   if(reader)for(;;){signal.throwIfAborted();const next=await reader.read();if(next.done)break;bytes+=next.value.byteLength;hash.update(next.value);if(bytes>4*1024*1024)throw new Error('Fixture bound exceeded');}
   completed++;return Response.json({bytes,sha256:hash.digest('hex'),elapsed:performance.now()-started},{headers:{'cache-control':'no-store'}});
  }catch{canceled++;return new Response(null,{status:499});}
  finally{if(reader){try{await reader.cancel();}finally{reader.releaseLock();}}}
 }
 const withdraw=[ctx.connection.fetch.register({path:'/api/fixture/slow-upload',methods:['POST'],requestBody:'streaming',fetch(request){const task=receive(request);active.add(task);void task.finally(()=>active.delete(task));return task;}}),ctx.connection.fetch.register({path:'/api/fixture/upload-state',methods:['GET'],requestBody:'buffered',fetch(){return Response.json({active:active.size,completed,canceled});}})];
 ctx.effect(()=>async()=>{lifetime.abort();await Promise.all(withdraw.map(stop=>stop()));await Promise.allSettled([...active]);});
}
`,
        );
        let executablePath: string, args: string[];
        if (mode === 'package') {
          const record = JSON.parse(await readFile(resultFile!, 'utf8'));
          const appRoot = dirname(dirname(dirname(record.app)));
          const [binary] = await readdir(join(appRoot, 'Contents/MacOS'));
          executablePath = join(appRoot, 'Contents/MacOS', binary!);
          args = [];
        } else {
          executablePath = createRequire(resolve('apps/desktop/package.json'))(
            'electron',
          ) as string;
          const entry = join(home, 'desktop.mjs');
          await writeFile(
            entry,
            `import {app,protocol} from 'electron';
import {DesktopShell} from ${JSON.stringify(pathToFileURL(resolve('apps/desktop/lib/shell/application.js')).href)};
protocol.registerSchemesAsPrivileged([{scheme:'axterm-app',privileges:{standard:true,secure:true,supportFetchAPI:true,corsEnabled:true,stream:true}}]);
app.setPath('userData',${JSON.stringify(join(home, 'desktop'))});
app.whenReady().then(()=>{globalThis.shell=new DesktopShell({home:${JSON.stringify(home)},webRoot:${JSON.stringify(resolve('apps/web/dist'))},hostEntry:${JSON.stringify(resolve('apps/desktop-host/lib/index.js'))},preload:${JSON.stringify(resolve('apps/desktop/lib/shell/preload.cjs'))},environment:{...process.env},visible:false,confirmQuit:async()=>true,recover:async()=> 'quit'});return globalThis.shell.start();});`,
          );
          args = [entry];
        }
        application = await electron.launch({
          executablePath,
          args,
          cwd: home,
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
        const page = await application.firstWindow({ timeout: 15000 });
        const errors: string[] = [];
        page.on('pageerror', (error) => errors.push(error.message));
        await page.locator('[data-axterm-product-workspace]').waitFor({ timeout: 10000 });
        expect(page.url()).toBe('axterm-app://app/');
        expect(await application.evaluate(({ app }) => app.isPackaged)).toBe(mode === 'package');
        const result = await page.evaluate(async () => {
          const start = performance.now();
          const binary = fetch('/api/fixture/slow-upload', {
            method: 'POST',
            body: new Blob([new Uint8Array(4 * 1024 * 1024).fill(255)], {
              type: 'application/octet-stream',
            }),
          }).then(async (response) => ({ status: response.status, value: await response.json() }));
          const ordinary = fetch('/api/fixture/slow-upload', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: '{}',
          }).then((response) => ({ status: response.status, elapsed: performance.now() - start }));
          const [upload, control] = await Promise.all([binary, ordinary]);
          const state = await fetch('/api/fixture/upload-state').then((response) =>
            response.json(),
          );
          return { upload, control, state };
        });
        expect(result.upload.status).toBe(200);
        expect(result.upload.value.bytes).toBe(4 * 1024 * 1024);
        expect(result.upload.value.sha256).toBe(
          createHash('sha256')
            .update(new Uint8Array(4 * 1024 * 1024).fill(255))
            .digest('hex'),
        );
        expect(result.upload.value.elapsed).toBeGreaterThanOrEqual(32000);
        expect(result.control.status).toBe(503);
        expect(result.control.elapsed).toBeGreaterThanOrEqual(29000);
        expect(result.control.elapsed).toBeLessThan(33000);
        expect(result.state).toEqual({ active: 0, completed: 1, canceled: 1 });
        expect(errors).toEqual([]);
        await closeLevel3Desktop(application);
        application = undefined;
      } finally {
        if (application) await closeLevel3Desktop(application).catch(() => {});
        await rm(home, { recursive: true, force: true });
      }
    },
    75000,
  );
}
