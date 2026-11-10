import type {} from '../../packages/plugins/configuration/src/sync.ts';
import type {} from '../../packages/infra/web-startup/src/index.ts';
import { mkdtemp, mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';
import {
  _electron as electron,
  expect as browserExpect,
  type ElectronApplication,
} from '@playwright/test';
import { runProfile } from '../../apps/cli/src/profile-boot.ts';
import { PROFILE_TEMPLATES } from '../../apps/cli/src/profile-templates.ts';
import { openLevel3Settings } from '../support/level3-workspace-actions.ts';

it('recovers a lost inline Vault ACK by readonly outcome and replays a lost Profile ACK with the same captured request', async () => {
  const home = await mkdtemp(join(tmpdir(), 'axterm-sync-settings-ui-'));
  const previous = {
    HOME: process.env.HOME,
    ZDOTDIR: process.env.ZDOTDIR,
    SHELL: process.env.SHELL,
  };
  process.env.HOME = home;
  process.env.ZDOTDIR = home;
  process.env.SHELL = '/bin/bash';
  let host: Awaited<ReturnType<typeof runProfile>> | undefined,
    browser: ElectronApplication | undefined;
  const secret = 'SYNC_INLINE_SECRET_FIXTURE_ONLY';
  try {
    host = await runProfile({
      profile: 'web',
      home,
      installAnchor: resolve('apps/cli/package.json'),
      templates: PROFILE_TEMPLATES,
      patchFiles: [],
      args: [],
      requiredServices: ['configurationSync', 'webStartup', 'clientModules'],
      prepare(ctx) {
        ctx.provide('webAssets', {
          index: resolve('apps/web/dist/index.html'),
          authenticationPage: resolve('apps/web/dist/auth.html'),
        });
      },
    });
    const token = (await readFile(host.ctx.webStartup.tokenFile!, 'utf8')).trim();
    await mkdir(join(home, 'browser'));
    const entry = join(home, 'browser.cjs');
    await writeFile(
      entry,
      `const {app,BrowserWindow}=require('electron');app.setPath('userData',${JSON.stringify(join(home, 'browser'))});app.whenReady().then(()=>new BrowserWindow({show:false,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false}}).loadURL(${JSON.stringify(host.ctx.webStartup.url)}));app.on('window-all-closed',()=>app.quit());`,
    );
    browser = await electron.launch({
      executablePath: createRequire(resolve('apps/desktop/package.json'))('electron') as string,
      args: [entry],
      env: { ...process.env, AXTERM_HOME: home, HTTP_PROXY: '', HTTPS_PROXY: '', ALL_PROXY: '' },
      timeout: 12000,
    });
    const page = await browser.firstWindow();
    page.setDefaultTimeout(7000);
    let credentialRequests = 0,
      outcomeRequests = 0;
    const profileRequests: unknown[] = [];
    await page.route('**/api/configuration/createCredential', async (route) => {
      credentialRequests++;
      await route.fetch();
      await route.abort('failed');
    });
    await page.route('**/api/configuration/getCredentialOutcome', async (route) => {
      outcomeRequests++;
      await route.continue();
    });
    await page.route('**/api/configuration/createSyncProfile', async (route) => {
      profileRequests.push((route.request().postDataJSON() as { payload: unknown }).payload);
      if (profileRequests.length === 1) {
        await route.fetch();
        await route.abort('failed');
      } else await route.continue();
    });
    await page.locator('#credential').fill(token);
    await page.getByRole('button', { name: 'Connect', exact: true }).click();
    await openLevel3Settings(page);
    await page.getByTestId('application-language').click();
    await page.getByRole('option', { name: 'English', exact: true }).click();
    await page.locator('[data-settings-category=sync]').click();
    const sync = page.locator('[data-settings-category-content=sync]');
    await sync.getByRole('tab', { name: 'WebDAV', exact: true }).click();
    const form = sync.locator('form');
    await form.locator('[name=endpointUrl]').fill('http://127.0.0.1:47302/storage/');
    await form.locator('[name=remoteId]').fill('sync-proof.json');
    await form.locator('[name=username]').fill('operator');
    await form.locator('[name=accessSecret]').fill(secret);
    await form.locator('[name=autoSyncDirection]').selectOption('download');
    await form.locator('button.primary').click();
    await browserExpect(sync.locator('[data-sync-credential-pending]')).toBeVisible();
    await browserExpect(form.locator('[name=accessSecret]')).toHaveValue('');
    expect(credentialRequests).toBe(1);
    await sync.locator('[data-sync-credential-outcome]').click();
    await browserExpect(sync.locator('[data-sync-credential-pending]')).toHaveCount(0);
    expect(outcomeRequests).toBe(1);
    await form.locator('button.primary').click();
    await browserExpect(sync.locator('[data-sync-mutation-pending]')).toBeVisible();
    await sync.locator('[data-sync-retry-original]').click();
    await browserExpect(sync.locator('[data-sync-mutation-pending]')).toHaveCount(0);
    expect(credentialRequests).toBe(1);
    expect(profileRequests).toHaveLength(2);
    expect(profileRequests[1]).toEqual(profileRequests[0]);
    expect(JSON.stringify(profileRequests)).not.toContain(secret);
    const profiles = host.ctx.configurationSync.application.snapshot().profiles;
    expect(profiles).toHaveLength(1);
    expect(profiles[0]!.autoSyncDirection).toBe('download');
    expect(profiles[0]!.accessCredentialConfigured).toBe(true);
    expect(await page.locator('body').innerText()).not.toContain(secret);
    expect(
      await page.evaluate(() =>
        JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } }),
      ),
    ).not.toContain(secret);
    await browser.close();
    browser = undefined;
    await host.shutdown.shutdown(0);
    host = undefined;
  } finally {
    await browser?.close().catch(() => {});
    await host?.shutdown.shutdown(0);
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(home, { recursive: true, force: true });
  }
}, 30000);
