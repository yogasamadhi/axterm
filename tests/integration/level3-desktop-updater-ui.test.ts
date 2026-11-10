import { openLevel3Settings } from '../support/level3-workspace-actions.ts';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import {
  _electron as electron,
  type ElectronApplication,
  expect as browserExpect,
} from '@playwright/test';
import { expect, it } from 'vitest';
import type { DesktopShell } from '../../apps/desktop/src/shell/application.ts';
import { canonicalManifestRecord } from '../../apps/desktop/src/shell/signed-release-updater.ts';
import type { SignedUpdateManifest } from '@axterm/plugin-api/desktop';
it('checks and downloads a real signed local update through Shell/Host/Remote/model/Slot before one explicit installer action', async () => {
  const home = await mkdtemp(join(tmpdir(), 'axterm-updater-ui-')),
    errors: string[] = [],
    bytes = Buffer.from('isolated signed installer fixture');
  const keys = generateKeyPairSync('ed25519');
  let requests = 0;
  const server = createServer((request, response) => {
    requests++;
    if (request.url === '/manifest.json') {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify(manifest));
    } else if (request.url === '/Axterm-fixture.zip') {
      response.setHeader('content-length', bytes.length);
      response.end(bytes);
    } else {
      response.writeHead(404);
      response.end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw Error('NO_FIXTURE_PORT');
  const origin = `http://127.0.0.1:${address.port}`;
  const manifest: SignedUpdateManifest = {
    version: '99.0.0',
    publishedAt: '2026-11-08T00:00:00.000Z',
    notes: 'Local acceptance fixture',
    artifact: {
      url: origin + '/Axterm-fixture.zip',
      fileName: 'Axterm-fixture.zip',
      size: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      signature: 'placeholder',
    },
  };
  manifest.artifact.signature = sign(
    null,
    Buffer.from(canonicalManifestRecord(manifest)),
    keys.privateKey,
  ).toString('base64');
  let application: ElectronApplication | undefined,
    stage = 'launch';
  try {
    await mkdir(join(home, 'desktop'));
    const entry = join(home, 'shell.mjs'),
      installed = join(home, 'installer-actions.json');
    await writeFile(
      entry,
      `import{app,protocol}from'electron';import{readFile,writeFile}from'node:fs/promises';import{createHash}from'node:crypto';import{DesktopShell}from${JSON.stringify(pathToFileURL(resolve('apps/desktop/lib/shell/application.js')).href)};protocol.registerSchemesAsPrivileged([{scheme:'axterm-app',privileges:{standard:true,secure:true,supportFetchAPI:true,corsEnabled:true,stream:true}}]);app.setPath('userData',${JSON.stringify(join(home, 'desktop'))});app.whenReady().then(()=>{let opens=0;globalThis.shell=new DesktopShell({home:${JSON.stringify(home)},webRoot:${JSON.stringify(resolve('apps/web/dist'))},hostEntry:${JSON.stringify(resolve('apps/desktop-host/lib/index.js'))},preload:${JSON.stringify(resolve('apps/desktop/lib/shell/preload.cjs'))},environment:{...process.env,SHELL:'/bin/bash',AXTERM_UPDATE_MANIFEST_URL:${JSON.stringify(origin + '/manifest.json')},AXTERM_UPDATE_PUBLIC_KEY_BASE64:${JSON.stringify(keys.publicKey.export({ format: 'der', type: 'spki' }).toString('base64'))}},visible:false,confirmQuit:async()=>true,recover:async()=> 'quit',openInstaller:async path=>{await writeFile(${JSON.stringify(installed)},JSON.stringify({opens:++opens,sha256:createHash('sha256').update(await readFile(path)).digest('hex')}));return '';}});globalThis.shell.start();});`,
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
    const page = await application.firstWindow({ timeout: 7000 });
    page.setDefaultTimeout(7000);
    page.on('pageerror', (error) => errors.push(error.message));
    await openLevel3Settings(page);
    await page.getByTestId('application-language').click();
    await page.getByRole('option', { name: 'English', exact: true }).click();
    const panel = page.getByRole('region', { name: 'Updater', exact: true });
    await browserExpect(
      panel.getByRole('heading', { name: 'Up to date', exact: true }),
    ).toBeVisible();
    expect(requests).toBe(0);
    stage = 'signed check';
    await panel.getByRole('button', { name: 'Check for updates', exact: true }).click();
    await browserExpect(
      panel.getByRole('heading', { name: 'Update available', exact: true }),
    ).toBeVisible();
    await browserExpect(panel.getByText('99.0.0', { exact: true })).toBeVisible();
    stage = 'streamed download';
    await panel.getByRole('button', { name: 'Download', exact: true }).click();
    await browserExpect(
      panel.getByRole('heading', { name: 'Ready to install', exact: true }),
    ).toBeVisible();
    expect(await readFile(join(home, 'desktop', 'updates', 'Axterm-fixture.zip'))).toEqual(bytes);
    stage = 'explicit installer';
    await panel.getByRole('button', { name: 'Open installer', exact: true }).click();
    await expect
      .poll(async () => JSON.parse(await readFile(installed, 'utf8')))
      .toEqual({ opens: 1, sha256: manifest.artifact.sha256 });
    expect(requests).toBe(2);
    expect(errors).toEqual([]);
    await application.evaluate(async () => {
      await (globalThis as unknown as { shell: DesktopShell }).shell.stop();
    });
  } catch (error) {
    await writeFile(
      'out/level3-migration/sdk/updater-ui-diagnostic.json',
      JSON.stringify(
        {
          stage,
          errors,
          bodies: await Promise.all(
            application?.windows().map((p) =>
              p
                .locator('body')
                .innerText()
                .catch(() => '<unavailable>'),
            ) ?? [],
          ),
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
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await rm(home, { recursive: true, force: true });
  }
}, 30000);
