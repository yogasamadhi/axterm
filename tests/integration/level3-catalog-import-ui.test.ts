import { openLevel3Settings, level3ContextAction } from '../support/level3-workspace-actions.ts';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { _electron as electron, type ElectronApplication } from '@playwright/test';
import { expect, it } from 'vitest';
const packageResult = process.env.AXTERM_LEVEL3_PACKAGE_RESULT;
for (const mode of ['web', 'package'] as const) {
  it.skipIf(mode === 'package' && (process.platform !== 'darwin' || !packageResult))(
    `imports reviewed SSH Config through the real retained ${mode} UI, Remote and owned file authorization`,
    async () => {
      const home = await mkdtemp(join(tmpdir(), 'axterm-catalog-import-ui-'));
      let host: ChildProcess | undefined;
      let stopped: Promise<unknown> | undefined;
      let app: ElectronApplication | undefined;
      let token = '';
      const diagnostics: string[] = [];
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
              AXTERM_HOME: home,
              AXTERM_LEGACY_HOME: join(home, 'absent-legacy-source'),
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
        const browserErrors: string[] = [];
        page.on('pageerror', (error) =>
          browserErrors.push(error.message.replaceAll(token || 'NO_TOKEN', '[redacted]')),
        );
        const uploads: number[] = [];
        const revokes: string[] = [];
        page.on('response', (response) => {
          if (new URL(response.url()).pathname === '/api/files/import')
            uploads.push(response.status());
        });
        page.on('request', (request) => {
          if (new URL(request.url()).pathname !== '/api/files/revokeFileGrant') return;
          const value = request.postDataJSON() as { payload?: { args?: { id?: unknown } } };
          const id = value.payload?.args?.id;
          if (typeof id === 'string') revokes.push(id);
        });
        if (mode === 'web') {
          await page.locator('#credential').fill(token);
          await page.getByRole('button', { name: 'Connect', exact: true }).click();
        }
        await page.locator('[data-axterm-product-workspace]').waitFor();
        const shots = resolve('out/level3-migration/catalog-import-layouts', mode);
        await mkdir(shots, { recursive: true });
        for (const [locale, label] of [
          ['en', 'English'],
          ['ja', '日本語'],
          ['zh-CN', '简体中文'],
          ['zh-TW', '繁體中文'],
        ]) {
          await openLevel3Settings(page);
          await page.getByTestId('application-language').click();
          await page.getByRole('option', { name: label!, exact: true }).click();
          await expect.poll(() => page.locator('html').getAttribute('lang')).toBe(locale);
          await page.locator('[data-section-close=left]').click();
          const beforeUploads = uploads.length;
          const alias = 'root-' + locale;
          const excluded = 'removed-' + locale;
          const transfer = await page.evaluateHandle(
            ({ alias, excluded }) => {
              const value = new DataTransfer();
              value.items.add(
                new File(
                  [
                    `Host ${alias}\n HostName root.example\n User operator\n IdentityFile /PRIVATE_PATH_DO_NOT_READ\nInclude ~/.ssh/private/*.conf\nHost ${excluded}\n User operator\nHost wild?\n User operator\n`,
                  ],
                  'config',
                  { type: 'text/plain' },
                ),
              );
              return value;
            },
            { alias, excluded },
          );
          await (
            await level3ContextAction(page, '[data-catalog-import-trigger]')
          ).dispatchEvent('drop', { dataTransfer: transfer });
          await transfer.dispose();
          const dialog = page.getByRole('dialog');
          await dialog.waitFor();
          await expect.poll(() => dialog.locator('.ssh-import-item').count()).toBe(3);
          if (mode === 'web') {
            const chooser = page.waitForEvent('filechooser');
            await dialog.locator('.ssh-import-include-actions button').first().click();
            await (
              await chooser
            ).setFiles({
              name: 'extra.conf',
              mimeType: 'text/plain',
              buffer: Buffer.from(`Host included-${locale}\n User operator\n`),
            });
            await expect.poll(() => dialog.locator('.ssh-import-item').count()).toBe(4);
          }

          const root = dialog.locator('.ssh-import-item').filter({ hasText: alias });
          await root.locator('button').first().click();
          const editor = root.locator('textarea');
          const draft = JSON.parse(await editor.inputValue());
          draft.title = 'Reviewed ' + alias;
          draft.description = 'Retained editable preview';
          await editor.fill(JSON.stringify(draft));
          await root.locator('.ssh-import-editor button.primary').click();
          await dialog
            .locator('.ssh-import-item')
            .filter({ hasText: excluded })
            .locator('button')
            .nth(1)
            .click();
          await expect
            .poll(() => dialog.locator('.ssh-import-item').count())
            .toBe(mode === 'web' ? 3 : 2);
          expect(await dialog.innerText()).not.toContain('PRIVATE_PATH_DO_NOT_READ');
          if (locale === 'en')
            await writeFile(
              join(shots, 'controls.json'),
              JSON.stringify(
                await root.locator('.ssh-import-item-actions').evaluate((element) => ({
                  html: element.outerHTML,
                  style: {
                    display: getComputedStyle(element).display,
                    width: getComputedStyle(element).width,
                    flexDirection: getComputedStyle(element).flexDirection,
                  },
                  buttons: [...element.querySelectorAll('button')].map((button) => ({
                    display: getComputedStyle(button).display,
                    width: getComputedStyle(button).width,
                    minWidth: getComputedStyle(button).minWidth,
                    rect: button.getBoundingClientRect().toJSON(),
                  })),
                })),
                null,
                2,
              ),
            );
          const editBounds = await root.locator('button').nth(0).boundingBox();
          const removeBounds = await root.locator('button').nth(1).boundingBox();
          expect(Math.abs(editBounds!.y - removeBounds!.y)).toBeLessThanOrEqual(1);
          expect(removeBounds!.x).toBeGreaterThanOrEqual(editBounds!.x + editBounds!.width);

          for (const viewport of [
            { width: 1280, height: 800 },
            { width: 1440, height: 900 },
            { width: 1920, height: 1080 },
          ]) {
            await page.setViewportSize(viewport);
            for (const zoom of [1, 2]) {
              await app.evaluate(
                ({ BrowserWindow }, scale) =>
                  BrowserWindow.getAllWindows()[0]!.webContents.setZoomFactor(scale),
                zoom,
              );
              await expect
                .poll(() => page.evaluate(() => Math.round(innerWidth)))
                .toBe(Math.round(viewport.width / zoom));
              const confirm = dialog.locator('.ssh-import-footer button.primary');
              await confirm.scrollIntoViewIfNeeded();
              const bounds = await confirm.boundingBox();
              const dimensions = await page.evaluate(() => ({
                width: innerWidth,
                height: innerHeight,
              }));
              expect(bounds!.y).toBeGreaterThanOrEqual(0);
              expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(dimensions.height);
              expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(dimensions.width);
              expect(
                await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth + 1),
              ).toBe(true);
              await page.screenshot({
                path: join(shots, `${locale}-${viewport.width}x${viewport.height}-${zoom}.png`),
              });
            }
          }
          await app.evaluate(({ BrowserWindow }) =>
            BrowserWindow.getAllWindows()[0]!.webContents.setZoomFactor(1),
          );
          await page.setViewportSize({ width: 1280, height: 900 });
          await dialog.locator('.ssh-import-footer button.primary').click();
          await dialog.locator('.ssh-import-metrics').waitFor();
          expect(
            await dialog
              .locator('.ssh-import-item')
              .filter({ hasText: 'Reviewed ' + alias })
              .count(),
          ).toBe(1);
          expect(await dialog.locator('.ssh-import-metrics strong').allTextContents()).toEqual([
            mode === 'web' ? '2' : '1',
            '0',
            '0',
            '2',
            mode === 'web' ? '3' : '4',
          ]);
          await page.screenshot({ path: join(shots, `${locale}-report.png`) });
          expect(uploads.slice(beforeUploads)).toEqual(mode === 'web' ? [200, 200] : [200]);
          const beforeRevokes = revokes.length;
          await dialog.locator('.ssh-import-footer button.primary').click();
          await dialog.waitFor({ state: 'hidden' });
          const revoked = revokes.slice(beforeRevokes);
          expect(revoked).toHaveLength(mode === 'web' ? 2 : 1);
          expect(new Set(revoked).size).toBe(revoked.length);
          for (const id of revoked) {
            await expect
              .poll(() =>
                page.evaluate(async (grantId) => {
                  const result = await fetch(
                    '/api/files/read?grantId=' + encodeURIComponent(grantId) + '&path=config',
                  );
                  await result.body?.cancel();
                  return result.status;
                }, id),
              )
              .toBe(404);
          }
        }
        expect(browserErrors).toEqual([]);
        expect(
          await page.evaluate(() => ({
            cookie: document.cookie,
            local: { ...localStorage },
            session: { ...sessionStorage },
          })),
        ).toEqual({ cookie: '', local: {}, session: {} });
        if (token)
          expect(
            ((await page.locator('body').innerText()) + diagnostics.join('')).includes(token),
          ).toBe(false);
        if (mode === 'package') {
          const closed = new Promise<void>((done) => app!.process().once('close', () => done()));
          await app.evaluate(({ app: application }) => application.quit());
          await closed;
        } else await app.close();
        app = undefined;
      } finally {
        if (app && mode === 'package') app.process().kill('SIGKILL');
        else await app?.close();
        if (host && host.exitCode === null) {
          host.kill('SIGTERM');
          await stopped;
        }
        await rm(home, { recursive: true, force: true });
      }
    },
    60000,
  );
}
