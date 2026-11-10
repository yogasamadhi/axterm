import { showLevel3Hosts } from '../support/level3-workspace-actions.ts';
import {
  level3ContextAction,
  openLevel3AiWorkspace,
  openLevel3Settings,
} from '../support/level3-workspace-actions.ts';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { DatabaseSync } from 'node:sqlite';
import { _electron as electron, type ElectronApplication } from '@playwright/test';
import { expect, it } from 'vitest';
import { piSseStart, piSseText, piSseEnd } from '../fixtures/pi-sse.ts';
import { dictionaries } from '../../packages/plugins/ai/src/client/ui/locales.ts';
const packageResult = process.env.AXTERM_LEVEL3_PACKAGE_RESULT;
for (const mode of ['web', 'package'] as const) {
  it.skipIf(mode === 'package' && (!packageResult || process.platform !== 'darwin'))(
    `generates, reviews and explicitly saves an SSH bookmark through the actual retained ${mode} AI dialog and Catalog owner`,
    async () => {
      const home = await mkdtemp(join(tmpdir(), 'axterm-ai-bookmark-ui-'));
      let requests = 0,
        host: ChildProcess | undefined,
        stopped: Promise<unknown> | undefined,
        browser: ElectronApplication | undefined,
        token = '';
      const draft = {
        name: 'AI draft host',
        title: 'AI draft bookmark',
        hostname: 'example.test',
        port: 22,
        username: 'fixture',
        authType: 'password',
        favorite: false,
        description: 'Visible AI bookmark metadata',
      };
      const server = createServer((request, response) => {
        requests++;
        if (request.headers.authorization !== 'Bearer BOOKMARK_UI_PRIVATE_KEY_CANARY') {
          response.writeHead(401);
          response.end();
          return;
        }
        request.resume();
        request.once('end', () => {
          response.writeHead(200, { 'content-type': 'text/event-stream' });
          response.end(
            piSseStart('openai-chat') +
              piSseText('openai-chat', JSON.stringify(draft)) +
              piSseEnd('openai-chat'),
          );
        });
      });
      server.listen(0, '127.0.0.1');
      await once(server, 'listening');
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Unbound bookmark fixture');
      try {
        let executablePath = createRequire(resolve('apps/desktop/package.json'))(
            'electron',
          ) as string,
          args: string[] = [];
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
const app=await runProfile({profile:'web',home:${JSON.stringify(home)},installAnchor:${JSON.stringify(resolve('apps/cli/package.json'))},templates:PROFILE_TEMPLATES,patchFiles:[],args:[],requiredServices:['aiController','catalogController','webStartup','clientModules'],prepare(ctx){ctx.provide('webAssets',{index:${JSON.stringify(resolve('apps/web/dist/index.html'))},authenticationPage:${JSON.stringify(resolve('apps/web/dist/auth.html'))}});}});process.send(app.ctx.get('webStartup'));`,
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
            stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
          });
          stopped = new Promise((done) => host!.once('exit', done));
          const startup = await new Promise<{ url: string; tokenFile: string }>((done, reject) => {
            const timer = setTimeout(
              () => reject(new Error('Bookmark Profile startup timeout')),
              15000,
            );
            host!.once('message', (value) => {
              clearTimeout(timer);
              done(value as { url: string; tokenFile: string });
            });
            host!.once('error', reject);
            host!.once('exit', () => {
              clearTimeout(timer);
              reject(new Error('Bookmark Profile exited before readiness'));
            });
          });
          token = (await readFile(startup.tokenFile, 'utf8')).trim();
          const entry = join(home, 'browser.cjs');
          await writeFile(
            entry,
            `const{app,BrowserWindow}=require('electron');app.setPath('userData',${JSON.stringify(join(home, 'browser'))});app.whenReady().then(()=>{const win=new BrowserWindow({show:false,width:1280,height:800,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false}});win.loadURL(${JSON.stringify(startup.url)});});app.on('window-all-closed',()=>app.quit());`,
          );
          args = [entry];
        }
        browser = await electron.launch({
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
        const page = await browser.firstWindow({ timeout: 15000 });
        page.setDefaultTimeout(8000);
        const errors: string[] = [];
        page.on('pageerror', (error) =>
          errors.push(error.message.replaceAll(token || 'ABSENT_TOKEN', '[redacted]')),
        );
        if (mode === 'web') {
          await page.locator('#credential').fill(token);
          await page.getByRole('button', { name: 'Connect', exact: true }).click();
        }
        await page.locator('[data-axterm-product-workspace]').waitFor();
        const locale = async (value: string, label: string) => {
          await openLevel3Settings(page);
          await page.getByTestId('application-language').click();
          await page.getByRole('option', { name: label, exact: true }).click();
          await expect.poll(() => page.locator('html').getAttribute('lang')).toBe(value);
          await page.locator('[data-section-close=left]').click();
        };
        await locale('en', 'English');
        await openLevel3AiWorkspace(page);
        const config = page.getByRole('dialog', { name: 'AI Config', exact: true });
        await config.waitFor();
        await config.locator('[name=name]').fill('Bookmark provider');
        await config.locator('[name=baseUrl]').fill(`http://127.0.0.1:${address.port}/v1`);
        await config.locator('[name=model]').fill('bookmark-fixture-model');
        await config.locator('[name=apiKey]').fill('BOOKMARK_UI_PRIVATE_KEY_CANARY');
        await config.getByRole('button', { name: 'Save configuration', exact: true }).click();
        await config.waitFor({ state: 'hidden' });
        expect(requests).toBe(0);
        const shots = resolve('out/level3-migration/ai-bookmark-layouts', mode);
        await mkdir(shots, { recursive: true });
        for (const [language, label] of [
          ['en', 'English'],
          ['ja', '日本語'],
          ['zh-CN', '简体中文'],
          ['zh-TW', '繁體中文'],
        ] as const) {
          await locale(language, label);
          await showLevel3Hosts(page);
          const text = dictionaries[language];
          await (await level3ContextAction(page, '[data-ai-bookmark-trigger]')).click();
          const dialog = page.getByRole('dialog', { name: text['aiBookmark.title'], exact: true });
          await dialog.waitFor();
          await dialog
            .getByRole('combobox', { name: text['aiBookmark.model'], exact: true })
            .click();
          await page.getByRole('option').filter({ hasText: 'bookmark-fixture-model' }).click();
          await dialog
            .locator('textarea[name=description]')
            .fill('Create a controlled SSH bookmark for the review flow');
          const capture = async (stage: string, button: string) => {
            for (const viewport of [
              { width: 1280, height: 800 },
              { width: 1440, height: 900 },
              { width: 1920, height: 1080 },
            ]) {
              await page.setViewportSize(viewport);
              for (const scale of [1, 2]) {
                await browser!.evaluate(
                  ({ BrowserWindow }, zoom) =>
                    BrowserWindow.getAllWindows()[0]!.webContents.setZoomFactor(zoom),
                  scale,
                );
                const action = dialog.getByRole('button', { name: button, exact: true });
                await action.scrollIntoViewIfNeeded();
                const bounds = await action.boundingBox();
                expect(bounds!.y).toBeGreaterThanOrEqual(0);
                expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(
                  await page.evaluate(() => innerHeight),
                );
                expect(await dialog.evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(
                  true,
                );
                await page.screenshot({
                  path: join(shots, `${stage}-${language}-${viewport.width}-${scale}x.png`),
                });
              }
            }
            await browser!.evaluate(({ BrowserWindow }) =>
              BrowserWindow.getAllWindows()[0]!.webContents.setZoomFactor(1),
            );
            await page.setViewportSize({ width: 1280, height: 800 });
          };
          await capture('generate', text['aiBookmark.generate']);
          expect(requests).toBe(['en', 'ja', 'zh-CN', 'zh-TW'].indexOf(language));
          await dialog
            .getByRole('button', { name: text['aiBookmark.generate'], exact: true })
            .click();
          await dialog.getByText(text['aiBookmark.reviewTitle'], { exact: true }).waitFor();
          await capture('review', text['aiBookmark.save']);
          expect(requests).toBe(['en', 'ja', 'zh-CN', 'zh-TW'].indexOf(language) + 1);
          expect(await dialog.innerText()).not.toContain('BOOKMARK_UI_PRIVATE_KEY_CANARY');
          if (language === 'zh-TW') {
            await dialog
              .getByLabel(text['hosts.displayName'], { exact: true })
              .fill('Reviewed AI host');
            await dialog
              .getByLabel(text['hosts.bookmarkTitle'], { exact: true })
              .fill('Reviewed SSH bookmark');
            await dialog.getByLabel(text['hosts.port'], { exact: true }).fill('2222');
            await dialog
              .getByRole('button', { name: text['aiBookmark.save'], exact: true })
              .click();
          } else
            await dialog.getByRole('button', { name: text['common.cancel'], exact: true }).click();
          await dialog.waitFor({ state: 'hidden' });
        }
        expect(requests).toBe(4);
        expect(errors).toEqual([]);
        expect(
          await page.evaluate(() => ({
            cookie: document.cookie,
            local: { ...localStorage },
            session: { ...sessionStorage },
          })),
        ).toEqual({ cookie: '', local: {}, session: {} });
        const closed = browser.waitForEvent('close');
        await browser.evaluate(({ app }) => app.quit());
        await closed;
        browser = undefined;
        if (host) {
          host.kill('SIGTERM');
          expect(await stopped).toBe(0);
          host = undefined;
        }
        const db = new DatabaseSync(join(home, 'data-v2/axterm.sqlite'), { readOnly: true });
        try {
          const rows = db
            .prepare(
              'SELECT h.name,h.hostname,h.port,h.credential_ref,b.title,b.host_id FROM hosts h JOIN bookmarks b ON b.host_id=h.id WHERE h.name=?',
            )
            .all('Reviewed AI host');
          expect(rows).toHaveLength(1);
          expect(rows[0]).toMatchObject({
            name: 'Reviewed AI host',
            hostname: 'example.test',
            port: 2222,
            credential_ref: null,
            title: 'Reviewed SSH bookmark',
          });
          expect(
            db.prepare('SELECT count(*) AS n FROM hosts WHERE name=?').get('AI draft host'),
          ).toMatchObject({ n: 0 });
        } finally {
          db.close();
        }
      } finally {
        server.closeAllConnections();
        await new Promise<void>((done) => server.close(() => done()));
        if (browser) {
          if (mode === 'package') browser.process().kill('SIGKILL');
          await browser.close().catch(() => {});
        }
        if (host && host.exitCode === null) {
          host.kill('SIGKILL');
          await stopped;
        }
        await rm(home, { recursive: true, force: true });
      }
    },
    90000,
  );
}
