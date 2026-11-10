import { showLevel3Hosts } from '../support/level3-workspace-actions.ts';
import { openLevel3Bookmark, openLevel3Settings } from '../support/level3-workspace-actions.ts';
import { DatabaseSync } from 'node:sqlite';
import { EncryptedVault } from '@axterm/infra-credential-vault';
import { dictionaries } from '../../packages/plugins/catalog/src/client/ui/locales.ts';
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
    `edits retained connection bookmarks through the actual ${mode} Slots, models and Remote owners`,
    async () => {
      const home = await mkdtemp(join(tmpdir(), 'axterm-catalog-workspace-ui-'));
      let host: ChildProcess | undefined;
      let stopped: Promise<unknown> | undefined;
      let app: ElectronApplication | undefined;
      let token = '';
      const diagnostics: string[] = [];
      const browserErrors: string[] = [];
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

        page.on('pageerror', (error) =>
          browserErrors.push(error.message.replaceAll(token || 'NO_TOKEN', '[redacted]')),
        );
        if (mode === 'web') {
          await page.locator('#credential').fill(token);
          await page.getByRole('button', { name: 'Connect', exact: true }).click();
        }
        await page.locator('[data-axterm-product-workspace]').waitFor();
        const shots = resolve('out/level3-migration/catalog-workspace-layouts', mode);
        await mkdir(shots, { recursive: true });
        for (const [locale, label] of [
          ['en', 'English'],
          ['ja', '日本語'],
          ['zh-CN', '简体中文'],
          ['zh-TW', '繁體中文'],
        ] as const) {
          await openLevel3Settings(page);
          await page.getByTestId('application-language').click();
          await page.getByRole('option', { name: label, exact: true }).click();
          await expect.poll(() => page.locator('html').getAttribute('lang')).toBe(locale);
          await page.locator('[data-section-close=left]').click();
          await showLevel3Hosts(page);
          await openLevel3Bookmark(page);
          const dialog = page.getByRole('dialog');
          await dialog.locator('form.host-protocol-form').waitFor();
          await dialog.locator('input[name="name"]').fill('SSH ' + locale);
          await dialog.locator('input[name="hostname"]').fill('ssh.example.test');
          await dialog.locator('input[name="username"]').fill('operator');
          await dialog.locator('input[name="password"]').fill('EDITOR_UI_SECRET_CANARY');
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
              const save = dialog.locator('button[value="save"]');
              await save.scrollIntoViewIfNeeded();
              const bounds = await save.boundingBox();
              const dimensions = await page.evaluate(() => ({
                width: innerWidth,
                height: innerHeight,
              }));
              expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(dimensions.width + 1);
              expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(dimensions.height + 1);
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
          await dialog.locator('button[value="save"]').click();
          await dialog.waitFor({ state: 'hidden' });
          await expect
            .poll(() => page.locator('[data-bookmark-title="SSH ' + locale + '"]').count())
            .toBe(1);
          const sshRow = page.locator('[data-bookmark-title="SSH ' + locale + '"]');
          await sshRow.focus();
          await page.keyboard.press('Shift+F10');
          await page
            .getByRole('menuitem', { name: dictionaries[locale]['bookmarkTree.edit'], exact: true })
            .click();
          const sshEdit = page.getByRole('dialog');
          expect(await sshEdit.locator('input[name="password"]').inputValue()).toBe('');
          await sshEdit.locator('#ssh-bookmark-tab-settings').click();
          await sshEdit.locator('details.ssh-startup-settings > summary').click();
          await sshEdit.locator('input[name="sshStartupDirectory"]').fill('/srv/app');
          await sshEdit.locator('#ssh-bookmark-tab-quickCommands').click();
          await sshEdit.locator('.bookmark-quick-command-field > header button').click();
          await sshEdit.locator('.bookmark-quick-command-row input').fill('Version');
          await sshEdit.locator('.bookmark-quick-command-row textarea').fill('printf version');
          await sshEdit.locator('button[value="save"]').click();
          await sshEdit.waitFor({ state: 'hidden' });
          if (locale !== 'en') continue;
          for (const protocol of ['ftp', 'telnet', 'serial', 'rdp', 'vnc', 'spice', 'web']) {
            await openLevel3Bookmark(page);
            await page.locator('[data-bookmark-protocol="' + protocol + '"]').click();
            const form = page.locator('form[data-protocol="' + protocol + '"]');
            await form.waitFor();
            await form.locator('input[name="name"]').fill('Saved ' + protocol);
            if (await form.locator('input[name="hostname"]').count())
              await form.locator('input[name="hostname"]').fill(protocol + '.example.test');
            if (await form.locator('input[name="username"]').count())
              await form.locator('input[name="username"]').fill('operator');
            if (await form.locator('input[name="password"]').count())
              await form.locator('input[name="password"]').fill('PROTOCOL_UI_SECRET_CANARY');
            if (protocol === 'serial')
              await form.locator('input[name="path"]').fill('/dev/axterm-fixture');
            if (protocol === 'web')
              await form.locator('input[name="url"]').fill('https://example.test/retained');
            await form.locator('button[value="save"]').click();
            await form.waitFor({ state: 'hidden' });
            const row = page.locator('[data-bookmark-title="Saved ' + protocol + '"]');
            await row.waitFor();
            await row.hover();
            await row.locator('.bookmark-row-actions button').last().click();
            await page
              .getByRole('menuitem', { name: dictionaries.en['bookmarkTree.edit'], exact: true })
              .click();
            const edit = page.locator('form[data-protocol="' + protocol + '"]');
            await edit.waitFor();
            expect(await edit.locator('input[name="name"]').inputValue()).toBe('Saved ' + protocol);
            if (await edit.locator('input[name="password"]').count())
              expect(await edit.locator('input[name="password"]').inputValue()).toBe('');
            await edit.locator('input[name="name"]').fill('Edited ' + protocol);
            await edit.locator('button[value="save"]').click();
            await edit.waitFor({ state: 'hidden' });
            await page.locator('[data-bookmark-title="Edited ' + protocol + '"]').waitFor();
          }
          const groupRequests: unknown[] = [];
          let loseGroupAck = mode === 'web';
          const groupRoute = '**/api/catalog/createBookmarkGroup';
          if (mode === 'web')
            await page.route(groupRoute, async (route) => {
              groupRequests.push((route.request().postDataJSON() as { payload: unknown }).payload);
              if (loseGroupAck) {
                loseGroupAck = false;
                await route.fetch();
                await route.abort('failed');
              } else await route.continue();
            });
          await page.locator('.bookmark-tree-add-root').click();
          const groupDialog = page.getByRole('dialog');
          await groupDialog.locator('input[maxlength="80"]').fill('Editor group');
          await groupDialog.locator('button[type="submit"]').click();
          if (mode === 'web') {
            await groupDialog
              .getByRole('button', { name: dictionaries.en['history.retryPending'], exact: true })
              .click();
            expect(groupRequests).toHaveLength(2);
            expect(groupRequests[1]).toEqual(groupRequests[0]);
            await page.unroute(groupRoute);
          }
          await groupDialog.waitFor({ state: 'hidden' });
          const groupRow = page.getByRole('treeitem').filter({ hasText: 'Editor group' });
          await groupRow.locator('.bookmark-row-main').click();
          const webRow = page.locator('[data-bookmark-title="Edited web"]');
          await webRow.focus();
          await page.keyboard.press('Shift+F10');
          await page
            .getByRole('menuitem', { name: dictionaries.en['bookmarkTree.edit'], exact: true })
            .click();
          const webForm = page.locator('form[data-protocol="web"]');
          await webForm.locator('select[name="groupId"]').selectOption({ label: 'Editor group' });
          await webForm.locator('button[value="save"]').click();
          await webForm.waitFor({ state: 'hidden' });
          await webRow.waitFor();
          for (const title of ['Edited web', 'SSH en']) {
            const row = page.locator('[data-bookmark-title="' + title + '"]');
            await row.focus();
            await page.keyboard.press('Shift+F10');
            await page
              .getByRole('menuitem', {
                name: dictionaries.en['bookmarkTree.duplicate'],
                exact: true,
              })
              .click();
            const copied = page.locator(
              '[data-bookmark-title="' + title + ' ' + dictionaries.en['app.copyNoun'] + '"]',
            );
            await copied.waitFor();
            await copied.focus();
            await page.keyboard.press('Shift+F10');
            page.once('dialog', (dialog) => dialog.accept());
            await page
              .getByRole('menuitem', { name: dictionaries.en['bookmarkTree.delete'], exact: true })
              .click();
            await copied.waitFor({ state: 'hidden' });
          }
          await groupRow.focus();
          await page.keyboard.press('Shift+F10');
          page.once('dialog', (dialog) => dialog.accept());
          await page
            .getByRole('menuitem', {
              name: dictionaries.en['bookmarkTree.delete'],
              exact: true,
            })
            .click();
          await groupRow.waitFor({ state: 'hidden' });
          await webRow.waitFor();
        }
        expect(browserErrors).toEqual([]);
        expect(
          await page.evaluate(() => ({
            cookie: document.cookie,
            local: { ...localStorage },
            session: { ...sessionStorage },
          })),
        ).toEqual({
          cookie: '',
          local: {
            'axterm-bookmark-tree-ui': JSON.stringify({
              state: { expandedGroupIds: [] },
              version: 0,
            }),
          },
          session: {},
        });
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
        if (host) {
          host.kill('SIGTERM');
          expect(await stopped).toBe(0);
          host = undefined;
        }
        const db = new DatabaseSync(join(home, 'data-v2/axterm.sqlite'), { readOnly: true });
        let refs: string[] = [];
        try {
          expect(db.prepare('SELECT count(*) AS n FROM hosts').get()).toMatchObject({ n: 4 });
          expect(db.prepare('SELECT count(*) AS n FROM bookmarks').get()).toMatchObject({ n: 11 });
          expect(db.prepare('SELECT count(*) AS n FROM bookmark_groups').get()).toMatchObject({
            n: 0,
          });
          expect(db.prepare('SELECT auth_type FROM hosts').all()).toEqual(
            Array.from({ length: 4 }, () => ({ auth_type: 'password' })),
          );
          refs = db
            .prepare('SELECT credential_ref AS ref FROM hosts')
            .all()
            .map((value) => String(value.ref));
          expect(new Set(refs).size).toBe(4);
        } finally {
          db.close();
        }
        const bytes = await readFile(join(home, 'data-v2/axterm.sqlite'));
        expect(bytes.includes(Buffer.from('EDITOR_UI_SECRET_CANARY'))).toBe(false);
        expect(bytes.includes(Buffer.from('PROTOCOL_UI_SECRET_CANARY'))).toBe(false);
        const vault = new EncryptedVault(join(home, 'vault-v2'));
        try {
          await vault.open();
          expect(await vault.list()).toHaveLength(9);
          for (const ref of refs) expect(await vault.get(ref)).toBe('EDITOR_UI_SECRET_CANARY');
        } finally {
          await vault.close();
        }
      } catch (error) {
        if (app) {
          const page = await app.firstWindow();
          const directory = resolve('out/level3-migration/catalog-workspace-layouts', mode);
          await mkdir(directory, { recursive: true });
          await page.screenshot({ path: join(directory, 'failure.png') });
          await writeFile(
            join(directory, 'failure.json'),
            JSON.stringify(
              {
                body: (await page.locator('body').innerText()).replaceAll(
                  token || 'NO_TOKEN',
                  '[redacted]',
                ),
                error: String(error),
                layout: (await page.getByRole('dialog').count())
                  ? await page.getByRole('dialog').evaluate((element) => {
                      const bounds = element.getBoundingClientRect();
                      return {
                        root: {
                          width: element.clientWidth,
                          scroll: element.scrollWidth,
                          bounds: bounds.toJSON(),
                        },
                        overflow: [...element.querySelectorAll<HTMLElement>('*')]
                          .filter((child) => {
                            const box = child.getBoundingClientRect();
                            return (
                              box.width &&
                              (box.right > bounds.right + 1 || box.left < bounds.left - 1)
                            );
                          })
                          .map((child) => ({
                            tag: child.tagName,
                            name: child.getAttribute('name'),
                            classes: child.className,
                            bounds: child.getBoundingClientRect().toJSON(),
                            width: getComputedStyle(child).width,
                            margin: getComputedStyle(child).margin,
                            position: getComputedStyle(child).position,
                          })),
                      };
                    })
                  : undefined,
                browserErrors,
                diagnostics,
              },
              null,
              2,
            ),
          );
        }
        throw error;
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
    180000,
  );
}
