import { openLevel3Settings } from '../support/level3-workspace-actions.ts';
import { DatabaseSync } from 'node:sqlite';
import { EncryptedVault } from '@axterm/infra-credential-vault';

import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import {
  expect as browserExpect,
  _electron as electron,
  type ElectronApplication,
} from '@playwright/test';
import { expect, it } from 'vitest';
const packageResult = process.env.AXTERM_LEVEL3_PACKAGE_RESULT;
for (const mode of ['web'] as ('web' | 'package')[]) {
  it.skipIf(mode === 'package' && (process.platform !== 'darwin' || !packageResult))(
    `manages connection and terminal Profiles through composed settings and owned ${mode} Clients`,
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
        await openLevel3Settings(page);
        await page.getByTestId('application-language').click();
        await page.getByRole('option', { name: 'English', exact: true }).click();
        await expect.poll(() => page.locator('html').getAttribute('lang')).toBe('en');
        const settings = page.locator('[data-configuration-settings]');
        await page.locator('[data-settings-tab="profiles"]').click();
        const profileForm = page.getByTestId('connection-profile-form');
        await profileForm.locator('input[name="name"]').fill('Shared operators');
        await profileForm.locator('input[name="ssh.username"]').fill('operator');
        await profileForm.locator('input[name="ssh.password"]').fill('PROFILE_UI_SECRET_CANARY');
        const chooser = page.waitForEvent('filechooser');
        await profileForm.locator('button.connection-profile-file-import').first().click();
        await (
          await chooser
        ).setFiles({
          name: 'operator.pem',
          mimeType: 'text/plain',
          buffer: Buffer.from('PROFILE_UI_FILE_CANARY'),
        });
        await browserExpect(
          profileForm.locator('button.connection-profile-file-import').first(),
        ).toHaveText('operator.pem');
        for (const protocol of ['telnet', 'vnc', 'rdp', 'ftp', 'spice']) {
          await profileForm
            .getByRole('tab', {
              name: protocol === 'telnet' ? 'Telnet' : protocol.toUpperCase(),
              exact: true,
            })
            .click();
          await profileForm
            .locator(`input[name="${protocol}.username"]`)
            .fill(protocol + '-operator');
          await profileForm
            .locator(`input[name="${protocol}.password"]`)
            .fill('PROFILE_UI_SECRET_CANARY');
        }
        await profileForm.getByRole('button', { name: 'Save profile', exact: true }).click();
        const profileList = page.locator('.connection-profile-list');
        await profileList.getByRole('button', { name: /^Shared operators/ }).click();
        await profileForm.locator('input[name="name"]').fill('Shared operators updated');
        // Blank secret fields preserve all existing references.
        await profileForm.getByRole('button', { name: 'Update profile', exact: true }).click();
        await browserExpect(
          profileList.getByRole('button', { name: /^Shared operators updated/ }),
        ).toBeVisible();
        await page.locator('[data-settings-tab="setting"]').click();
        await settings.locator('[data-settings-category="terminal"]').click();
        const terminalForm = page.locator('[data-terminal-profile-form]');
        await terminalForm.locator('input[name="name"]').fill('Development terminal');
        await terminalForm.locator('input[name="shell"]').fill('/bin/sh');
        await terminalForm.locator('textarea[name="shellArgs"]').fill('-l');
        await terminalForm.locator('textarea[name="env"]').fill('EDITOR=vim');
        await terminalForm.locator('input[name="fontSize"]').fill('16');
        await terminalForm.locator('select[name="encoding"]').selectOption('utf-8');
        await terminalForm.locator('button[type="submit"], button.primary').click();
        const terminalList = page.locator('[data-terminal-profiles] .list');
        await browserExpect(
          terminalList.getByText('Development terminal', { exact: true }),
        ).toBeVisible();
        await terminalList.getByRole('button', { name: 'Edit', exact: true }).click();
        await terminalForm.locator('input[name="name"]').fill('Development terminal updated');
        await terminalForm.locator('button[type="submit"], button.primary').click();
        await browserExpect(
          terminalList.getByText('Development terminal updated', { exact: true }),
        ).toBeVisible();
        const defaultProfile = page.locator('.terminal-default-profile-settings select');
        await defaultProfile.selectOption({ label: 'Development terminal updated' });
        await expect
          .poll(() => defaultProfile.locator('option:checked').innerText())
          .toBe('Development terminal updated');
        await defaultProfile.selectOption('');
        await browserExpect(defaultProfile).toHaveValue('');
        await terminalForm.locator('input[name="name"]').fill('Disposable terminal');
        await terminalForm.locator('button[type="submit"], button.primary').click();
        const disposable = terminalList
          .locator('.list-row')
          .filter({ hasText: 'Disposable terminal' });
        await disposable.waitFor();
        page.once('dialog', (dialog) => {
          void dialog.accept();
        });
        await disposable.getByRole('button', { name: 'Delete', exact: true }).click();
        await browserExpect(
          terminalList.getByText('Disposable terminal', { exact: true }),
        ).toHaveCount(0);
        await page.locator('[data-settings-tab="profiles"]').click();
        await profileList.getByRole('button', { name: /^Shared operators updated/ }).click();
        page.once('dialog', (dialog) => {
          void dialog.accept();
        });
        await profileForm.getByRole('button', { name: 'Delete', exact: true }).click();
        await browserExpect(
          profileList.getByRole('button', { name: /^Shared operators updated/ }),
        ).toHaveCount(0);
        expect(browserErrors).toEqual([]);
        await app.close();
        app = undefined;
        if (host) {
          host.kill('SIGTERM');
          expect(await stopped).toBe(0);
          host = undefined;
        }
        const db = new DatabaseSync(join(home, 'data-v2/axterm.sqlite'), { readOnly: true });
        try {
          expect(db.prepare('SELECT count(*) AS n FROM connection_profiles').get()).toMatchObject({
            n: 0,
          });
          const rows = db.prepare('SELECT name, payload FROM terminal_profiles').all();
          expect(rows).toHaveLength(1);
          expect(rows[0]?.name).toBe('Development terminal updated');
          expect(JSON.parse(String(rows[0]?.payload))).toMatchObject({
            fontSize: 16,
            env: { EDITOR: 'vim' },
          });
        } finally {
          db.close();
        }
        const bytes = await readFile(join(home, 'data-v2/axterm.sqlite'));
        expect(bytes.includes(Buffer.from('PROFILE_UI_SECRET_CANARY'))).toBe(false);
        expect(bytes.includes(Buffer.from('PROFILE_UI_FILE_CANARY'))).toBe(false);
        const vault = new EncryptedVault(join(home, 'vault-v2'));
        try {
          await vault.open();
          const metadata = await vault.list();
          expect(metadata).toHaveLength(7);
          const secrets = await Promise.all(metadata.map((value) => vault.get(value.ref)));
          expect(secrets.filter((value) => value === 'PROFILE_UI_SECRET_CANARY')).toHaveLength(6);
          expect(secrets.filter((value) => value === 'PROFILE_UI_FILE_CANARY')).toHaveLength(1);
        } finally {
          await vault.close();
        }
      } catch (error) {
        if (app) {
          const page = await app.firstWindow();
          const directory = resolve('out/level3-migration/profile-settings-smoke', mode);
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
    60000,
  );
}
