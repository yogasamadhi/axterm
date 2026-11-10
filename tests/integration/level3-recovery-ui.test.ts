import { level3ContextAction } from '../support/level3-workspace-actions.ts';
import { openLevel3Settings } from '../support/level3-workspace-actions.ts';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { _electron as electron, type ElectronApplication } from '@playwright/test';
import { mkdtemp, mkdir, writeFile, readFile, readdir, access, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { it, expect } from 'vitest';
import {
  prepareProfileRecovery,
  PROFILE_RECOVERY_MARKER,
} from '../../packages/infra/profile-recovery/src/index.ts';
import { PROFILE_TEMPLATES } from '../../apps/cli/src/profile-templates.ts';
const execute = promisify(execFile);
const packageResult = process.env.AXTERM_LEVEL3_PACKAGE_RESULT;
for (const mode of ['shell', 'package'] as const)
  it.skipIf(mode === 'package' && (!packageResult || process.platform !== 'darwin'))(
    `recovers the ${mode} without evaluating Profile code and visibly retains recovery across restart`,
    async () => {
      const home = await mkdtemp(join(tmpdir(), 'axterm-recovery-ui-'));
      const directory = join(home, 'profiles/desktop');
      const external = join(directory, 'node_modules/@axterm/external-recovery-fixture');
      const canary = join(home, 'EXTERNAL_EXECUTED');
      let browser: ElectronApplication | undefined;
      let packageApp: string | undefined;
      try {
        await mkdir(external, { recursive: true });
        const manifest = JSON.stringify({
          name: 'recovery-fixture',
          private: true,
          dependencies: { '@axterm/external-recovery-fixture': '1.0.0' },
          axterm: {
            profile: {
              bundles: [...PROFILE_TEMPLATES.desktop!.bundles, '@axterm/external-recovery-fixture'],
            },
          },
        });
        await writeFile(join(directory, 'package.json'), manifest);
        await writeFile(
          join(external, 'package.json'),
          JSON.stringify({
            name: '@axterm/external-recovery-fixture',
            version: '1.0.0',
            type: 'module',
            exports: './index.js',
            axterm: { bundle: { patch: './patch.yml' } },
          }),
        );
        await writeFile(
          join(external, 'index.js'),
          `import{writeFileSync}from'node:fs';writeFileSync(${JSON.stringify(canary)},'executed');throw new Error('EXTERNAL_RECOVERY_CODE_RAN');`,
        );
        await writeFile(
          join(external, 'patch.yml'),
          '- insert:\n    - id: external-recovery-fixture\n      name: "@axterm/external-recovery-fixture"\n',
        );
        const brokenPatch = 'invalid: [Profile patch must never be parsed in recovery';
        await writeFile(join(directory, 'cordis.patch.yml'), brokenPatch);
        await writeFile(
          join(home, 'cordis.patch.yml'),
          'invalid: [home patch must never be parsed in recovery',
        );
        await writeFile(join(directory, 'user-data'), 'retained user data');
        let executablePath = createRequire(resolve('apps/desktop/package.json'))(
          'electron',
        ) as string;
        const args: string[] = [];
        if (mode === 'package') {
          const record = JSON.parse(await readFile(packageResult!, 'utf8'));
          packageApp = record.app;
          const appRoot = dirname(dirname(dirname(record.app)));
          executablePath = join(
            appRoot,
            'Contents/MacOS',
            (await readdir(join(appRoot, 'Contents/MacOS')))[0]!,
          );
          // The source Shell case exercises the native action. This case proves that
          // its persistent marker is respected by the actual source-free application.
          await prepareProfileRecovery(home, 'desktop');
        } else {
          const entry = join(home, 'shell.mjs');
          await writeFile(
            entry,
            `import{app,protocol}from'electron';import{DesktopShell}from ${JSON.stringify(pathToFileURL(resolve('apps/desktop/lib/shell/application.js')).href)};
protocol.registerSchemesAsPrivileged([{scheme:'axterm-app',privileges:{standard:true,secure:true,supportFetchAPI:true,corsEnabled:true,stream:true}}]);app.setPath('userData',${JSON.stringify(join(home, 'desktop'))});app.whenReady().then(()=>{globalThis.recoveries=0;globalThis.shell=new DesktopShell({home:${JSON.stringify(home)},webRoot:${JSON.stringify(resolve('apps/web/dist'))},hostEntry:${JSON.stringify(resolve('apps/desktop-host/lib/index.js'))},preload:${JSON.stringify(resolve('apps/desktop/lib/shell/preload.cjs'))},environment:{...process.env},visible:false,confirmQuit:async()=>true,recover:async()=>{globalThis.recoveries++;return'backup-restart';}});void globalThis.shell.start();});`,
          );
          args.push(entry);
        }
        for (let attempt = 0; attempt < 2; attempt++) {
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
          page.setDefaultTimeout(15000);
          await page.locator('[data-axterm-product-workspace]').waitFor();
          await (await level3ContextAction(page, '[data-desktop-recovery-trigger]')).click();
          const dialog = page.locator('[data-desktop-recovery]');
          await dialog.waitFor();
          expect(await dialog.locator('[data-recovery-home]').innerText()).toBe(home);
          expect(await dialog.locator('[data-recovery-command]').innerText()).toBe(
            'axterm plugin --profile desktop recovery clear --confirm',
          );
          if (attempt === 0) {
            const shots = resolve('out/level3-migration/recovery-layouts', mode);
            await mkdir(shots, { recursive: true });
            await page.keyboard.press('Escape');
            for (const [language, label, title, close] of [
              ['en', 'English', 'Recovery mode', 'Close'],
              ['ja', '日本語', '復旧モード', '閉じる'],
              ['zh-CN', '简体中文', '恢复模式', '关闭'],
              ['zh-TW', '繁體中文', '復原模式', '關閉'],
            ] as const) {
              await openLevel3Settings(page);
              await page.getByTestId('application-language').click();
              await page.getByRole('option', { name: label, exact: true }).click();
              await page.locator('[data-section-close=left]').click();
              await (await level3ContextAction(page, '[data-desktop-recovery-trigger]')).click();
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
                    path: join(shots, language + '-' + viewport.width + '-' + zoom + '.png'),
                  });
                }
              }
              await browser.evaluate(({ BrowserWindow }) =>
                BrowserWindow.getAllWindows()[0]!.webContents.setZoomFactor(1),
              );
              await dialog.getByRole('button', { name: close, exact: true }).click();
            }
          }
          expect(await page.locator('[data-plugins-manager-trigger]').count()).toBe(0);
          expect(await page.locator('[data-market-trigger]').count()).toBe(0);
          await expect(access(canary)).rejects.toMatchObject({ code: 'ENOENT' });
          expect(await readFile(join(directory, 'package.json'), 'utf8')).toBe(manifest);
          expect(await readFile(join(directory, 'user-data'), 'utf8')).toBe('retained user data');
          const marker = JSON.parse(
            await readFile(join(directory, PROFILE_RECOVERY_MARKER), 'utf8'),
          );
          expect(marker.phase).toBe('ready');
          expect(await readFile(join(directory, marker.backup), 'utf8')).toBe(brokenPatch);
          if (mode === 'shell')
            expect(
              await browser.evaluate(() => (globalThis as { recoveries?: number }).recoveries),
            ).toBe(attempt === 0 ? 1 : 0);
          const closed = browser.waitForEvent('close', { timeout: 15000 });
          await browser.evaluate(({ app, dialog }) => {
            dialog.showMessageBox = ((options: Electron.MessageBoxOptions) => {
              if (options.message !== 'Active tasks may be interrupted.')
                throw new Error('Unexpected recovery dialog');
              return Promise.resolve({ response: 1, checkboxChecked: false });
            }) as typeof dialog.showMessageBox;
            app.quit();
          });
          await closed;
          browser = undefined;
        }
        expect(
          (await readdir(join(home, 'profiles'))).filter((name) => name.startsWith('.recovery-')),
        ).toEqual([]);
        if (packageApp) {
          const marker = JSON.parse(
            await readFile(join(directory, PROFILE_RECOVERY_MARKER), 'utf8'),
          );
          const cli = join(
            dirname(
              createRequire(join(packageApp, 'package.json')).resolve('@axterm/cli/profile-boot'),
            ),
            'index.js',
          );
          const result = await execute(
            executablePath,
            [
              '--expose-internals',
              cli,
              'plugin',
              '--profile',
              'desktop',
              'recovery',
              'clear',
              '--confirm',
            ],
            {
              cwd: home,
              env: {
                ...process.env,
                AXTERM_HOME: home,
                AXTERM_LEGACY_HOME: join(home, 'absent-legacy-source'),
                PATH: '/usr/bin:/bin',
                ELECTRON_RUN_AS_NODE: '1',
                NODE_OPTIONS: '',
                NODE_PATH: '',
              },
              timeout: 15000,
            },
          );
          expect(JSON.parse(result.stdout)).toEqual({ profile: 'desktop', recovery: false });
          await expect(access(join(directory, PROFILE_RECOVERY_MARKER))).rejects.toMatchObject({
            code: 'ENOENT',
          });
          expect(await readFile(join(directory, marker.backup), 'utf8')).toBe(brokenPatch);
          await expect(access(canary)).rejects.toMatchObject({ code: 'ENOENT' });
        }
      } finally {
        if (browser) {
          browser.process().kill('SIGKILL');
          await browser.close().catch(() => {});
        }
        await rm(home, { recursive: true, force: true });
      }
    },
    90_000,
  );
