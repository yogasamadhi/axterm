import { closeLevel3Tab } from '../support/level3-tab-actions.ts';
import { openLevel3Settings } from '../support/level3-workspace-actions.ts';
import { hostSchema, createHostSchema } from '@axterm/plugin-api/catalog';
import { randomUUID } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { _electron as electron, type ElectronApplication } from '@playwright/test';
import { expect, it, vi } from 'vitest';
const electronPath = createRequire(resolve('apps/desktop/package.json'))('electron') as string;
it('uses the real product Slots, four language facts and theme media without a fixture UI or browser persistence', async () => {
  const home = await mkdtemp(join(tmpdir(), 'axterm-presentation-ui-'));
  let host: ChildProcess | undefined;
  let shell: ElectronApplication | undefined;
  let stopped: Promise<unknown> | undefined;
  const diagnostics: string[] = [];
  let remote: Buffer | undefined;
  let uploads = 0;
  const syncServer = createServer(async (request, response) => {
    if (!request.headers.authorization?.startsWith('Basic ')) {
      response.writeHead(401);
      response.end();
      return;
    }
    if (request.method === 'MKCOL') {
      response.writeHead(201);
      response.end();
      return;
    }
    if (request.method === 'GET') {
      response.writeHead(remote ? 200 : 404, remote ? { etag: '"sync-' + uploads + '"' } : {});
      response.end(remote);
      return;
    }
    if (request.method === 'PUT') {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      remote = Buffer.concat(chunks);
      uploads++;
      response.writeHead(201, { etag: '"sync-' + uploads + '"' });
      response.end();
      return;
    }
    response.writeHead(405);
    response.end();
  });
  await new Promise<void>((done) => syncServer.listen(0, '127.0.0.1', done));
  try {
    const launcher = join(home, 'profile.mjs');
    await writeFile(
      launcher,
      `import {runProfile} from ${JSON.stringify(pathToFileURL(resolve('apps/cli/lib/profile-boot.js')).href)};
   import {PROFILE_TEMPLATES} from ${JSON.stringify(pathToFileURL(resolve('apps/cli/lib/profile-templates.js')).href)};
   const application=await runProfile({profile:'web',home:${JSON.stringify(home)},installAnchor:${JSON.stringify(resolve('apps/cli/package.json'))},templates:PROFILE_TEMPLATES,patchFiles:[],args:[],requiredServices:['webStartup','clientModules','typertGateway','storageDomain'],prepare(ctx){ctx.provide('webAssets',{index:${JSON.stringify(resolve('apps/web/dist/index.html'))},authenticationPage:${JSON.stringify(resolve('apps/web/dist/auth.html'))}});}});
   process.send(application.ctx.get('webStartup'));`,
    );
    host = spawn(process.execPath, ['--expose-internals', launcher], {
      cwd: home,
      env: {
        ...process.env,
        HOME: home,
        AXTERM_HOME: home,
        HTTP_PROXY: '',
        HTTPS_PROXY: '',
        ALL_PROXY: '',
      },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    host.stdout?.on('data', (chunk) => diagnostics.push(String(chunk)));
    host.stderr?.on('data', (chunk) => diagnostics.push(String(chunk)));
    stopped = new Promise((done) => host!.once('exit', done));
    const startup = await new Promise<{ url: string; tokenFile: string }>((done, reject) => {
      const timer = setTimeout(() => reject(new Error('Product Profile startup timeout')), 10000);
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
        reject(new Error('Product Profile exited before readiness: ' + diagnostics.join('')));
      });
    });
    const token = (await readFile(startup.tokenFile, 'utf8')).trim();
    const main = join(home, 'browser.cjs');
    await writeFile(
      main,
      `const {app,BrowserWindow}=require('electron');app.setPath('userData',${JSON.stringify(join(home, 'browser'))});app.whenReady().then(()=>{const win=new BrowserWindow({show:false,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false}});win.webContents.session.on('will-download',(_event,item)=>item.setSavePath(${JSON.stringify(join(home, 'browser-configuration.json'))}));win.loadURL(process.env.AXTERM_PRESENTATION_URL);});app.on('window-all-closed',()=>app.quit());`,
    );
    shell = await electron.launch({
      executablePath: electronPath,
      args: [main],
      env: { ...process.env, HOME: home, AXTERM_HOME: home, AXTERM_PRESENTATION_URL: startup.url },
    });
    const page = await shell.firstWindow({ timeout: 10000 });
    page.setDefaultTimeout(8000);
    const browserErrors: string[] = [];
    page.on('pageerror', (error) =>
      browserErrors.push(error.message.replaceAll(token, '[redacted]')),
    );
    await page.locator('#credential').fill(token);
    await page.getByRole('button', { name: 'Connect', exact: true }).click();
    await page.locator('[data-axterm-product-workspace]').waitFor();
    await page.locator('[data-terminal-channel=ready]:visible').waitFor();
    await page.locator('[data-workspace-global-tabs] .tab-close').click();
    const profile = JSON.parse(await readFile(join(home, 'profiles/web/package.json'), 'utf8'));
    expect(profile.axterm.profile.bundles).toContain('@axterm/bundle-workspace');
    expect(profile.axterm.profile.bundles.join(' ')).not.toContain('@fixture');
    await openLevel3Settings(page);
    const dialog = page.locator('[data-configuration-settings]');
    await dialog.waitFor();
    for (const [id, label, newTerminal] of [
      ['en', 'English', 'New terminal'],
      ['ja', '日本語', '新しいターミナル'],
      ['zh-TW', '繁體中文', '新增終端機'],
      ['zh-CN', '简体中文', '新建终端'],
      ['en', 'English', 'New terminal'],
    ] as const) {
      await page.getByTestId('application-language').click();
      await page.keyboard.press('Alt+q');
      await page.getByRole('option', { name: label, exact: true }).click();
      await expect.poll(() => page.locator('html').getAttribute('lang')).toBe(id);
      await expect
        .poll(() => page.locator('[data-activity-item=setting]').getAttribute('aria-label'))
        .toBe(id === 'en' ? 'Settings' : id === 'zh-CN' ? '设置' : '設定');
      expect(
        await page
          .locator('.tabbar')
          .getByRole('button', { name: newTerminal, exact: true, includeHidden: true })
          .count(),
      ).toBe(1);
    }
    await dialog.locator('[data-settings-category="password"]').click();
    const credentials = page.locator('[data-configuration-credentials]');
    await credentials.locator('#credential-label').fill('UI saved credential');
    await credentials.locator('#credential-secret').fill('UI_PRIVATE_SECRET_CANARY');
    await credentials.getByRole('button', { name: 'Save credential', exact: true }).click();
    const savedRow = credentials
      .locator('[data-credential-ref]')
      .filter({ hasText: 'UI saved credential' });
    await savedRow.waitFor();
    expect(await credentials.locator('#credential-secret').inputValue()).toBe('');
    expect(await page.locator('body').innerText()).not.toContain('UI_PRIVATE_SECRET_CANARY');
    const beforeReplacement = await savedRow.innerText();
    await savedRow.getByRole('button', { name: 'Replace secret', exact: true }).click();
    await credentials.locator('#credential-secret').fill('UI_REPLACED_SECRET_CANARY');
    await credentials
      .locator('form')
      .getByRole('button', { name: 'Replace secret', exact: true })
      .click();
    await expect.poll(() => savedRow.innerText()).not.toBe(beforeReplacement);
    expect(await credentials.locator('#credential-secret').inputValue()).toBe('');
    await savedRow.getByRole('button', { name: 'Delete credential', exact: true }).click();
    expect(await savedRow.count()).toBe(1);
    await savedRow.getByRole('button', { name: 'Confirm deletion', exact: true }).click();
    await savedRow.waitFor({ state: 'detached' });
    expect(
      await page.evaluate(() => ({ local: { ...localStorage }, session: { ...sessionStorage } })),
    ).toEqual({ local: {}, session: {} });
    await dialog.locator('[data-settings-category="common"]').click();
    const portable = page.locator('[data-configuration-portable]');
    await portable
      .getByRole('button', { name: 'Export Axterm configuration', exact: true })
      .click();
    const exportFile = join(home, 'browser-configuration.json');
    await vi.waitFor(
      async () =>
        expect(JSON.parse(await readFile(exportFile, 'utf8')).format).toBe('axterm-configuration'),
      { timeout: 8000 },
    );
    const exported = JSON.parse(await readFile(exportFile, 'utf8'));
    const sourceId = randomUUID();
    const at = new Date().toISOString();
    exported.data.hosts.push(
      hostSchema.parse({
        ...createHostSchema.parse({
          name: 'Reviewed browser import',
          hostname: 'reviewed.example.test',
          username: 'operator',
        }),
        id: sourceId,
        createdAt: at,
        updatedAt: at,
        version: 1,
      }),
    );
    const upload = {
      name: 'reviewed-configuration.json',
      mimeType: 'application/json',
      buffer: Buffer.from(JSON.stringify(exported)),
    };
    const inspectionChooser = page.waitForEvent('filechooser');
    await portable.getByRole('button', { name: 'Inspect Axterm file', exact: true }).click();
    await (await inspectionChooser).setFiles(upload);
    await portable.locator('[data-configuration-inspection]').waitFor();
    const [previewChooser] = await Promise.all([
      page.waitForEvent('filechooser'),
      portable.getByRole('button', { name: 'Import Axterm configuration', exact: true }).click(),
    ]);
    await previewChooser.setFiles(upload);
    await portable.locator('[data-configuration-preview]').waitFor();
    await portable.getByRole('button', { name: /^Import [0-9]+ items$/, exact: true }).click();
    await portable.locator('[data-configuration-import-result]').waitFor();
    await portable.locator('[data-configuration-preview]').waitFor({ state: 'detached' });
    await portable
      .getByRole('button', { name: 'Export Axterm configuration', exact: true })
      .click();
    await vi.waitFor(
      async () => {
        const document = JSON.parse(await readFile(exportFile, 'utf8'));
        expect(document.data.hosts).toHaveLength(1);
        expect(document.data.hosts[0].name).toBe('Reviewed browser import');
        expect(document.data.hosts[0].id).not.toBe(sourceId);
      },
      { timeout: 8000 },
    );
    await dialog.locator('[data-settings-category="password"]').click();
    // Exercise the actual Sync Slot and generated Remote against a real loopback WebDAV service.
    await credentials.locator('#credential-label').fill('UI sync access');
    await credentials.locator('#credential-secret').fill('UI_SYNC_PRIVATE_CANARY');
    await credentials.getByRole('button', { name: 'Save credential', exact: true }).click();
    const syncCredential = credentials
      .locator('[data-credential-ref]')
      .filter({ hasText: 'UI sync access' });
    await syncCredential.waitFor();
    await dialog.locator('[data-settings-category="sync"]').click();
    const sync = page.locator('section[aria-labelledby=data-sync-title]');
    await sync.getByRole('tab', { name: /^WebDAV(?: Configured)?$/ }).click();
    await sync.locator('input[name=name]').fill('Reviewed sync');
    const syncAddress = syncServer.address();
    if (!syncAddress || typeof syncAddress === 'string') throw new Error('Missing sync fixture');
    await sync
      .locator('input[name=endpointUrl]')
      .fill('http://127.0.0.1:' + syncAddress.port + '/dav');
    await sync.locator('input[name=remoteId]').fill('reviewed-configuration');
    await sync.locator('input[name=username]').fill('operator');
    await sync.locator('input[name=accessSecret]').fill('UI_SYNC_PRIVATE_CANARY');
    await sync.getByRole('button', { name: 'Save profile', exact: true }).click();
    const syncRow = sync.locator('form');
    await syncRow.waitFor();
    await syncRow.getByRole('button', { name: 'Upload', exact: true }).click();
    await expect.poll(() => uploads).toBe(1);
    await sync.getByText('Recent sync actions', { exact: true }).click();
    await expect.poll(() => sync.locator('details').innerText()).toContain('completed');
    expect(remote?.toString()).not.toContain('UI_SYNC_PRIVATE_CANARY');
    await syncRow.getByRole('button', { name: 'Compare', exact: true }).click();
    await sync.locator('.data-sync-compare-table').waitFor();
    expect((await sync.locator('.data-sync-compare-table').innerText()).toLowerCase()).toContain(
      'equal',
    );
    await page.reload();
    await page.locator('[data-axterm-product-workspace]').waitFor();
    // ADR-143 admits a fresh default terminal when this Web workspace has no live tabs.
    await page.locator('[data-terminal-channel=ready]:visible').waitFor();
    await page.locator('[data-workspace-global-tabs] .tab-close').click();
    await openLevel3Settings(page);
    await dialog.locator('[data-settings-category="sync"]').click();
    await sync.getByRole('tab', { name: /^WebDAV(?: Configured)?$/ }).click();
    await syncRow.waitFor();
    expect(uploads).toBe(1);
    await sync.getByText('Recent sync actions', { exact: true }).click();
    expect(await sync.locator('details').innerText()).toContain('completed');
    await syncRow.getByRole('button', { name: 'Download', exact: true }).click();
    await sync.locator('.data-sync-preview').waitFor();
    await sync.getByRole('button', { name: 'Confirm and apply', exact: true }).click();
    await sync.locator('.data-sync-preview').waitFor({ state: 'detached' });
    expect(uploads).toBe(1);
    await syncRow.getByRole('button', { name: 'Delete', exact: true }).click();
    await page
      .getByRole('dialog')
      .getByRole('button', { name: 'Confirm profile deletion', exact: true })
      .click();
    await page.getByRole('dialog').waitFor({ state: 'detached' });
    await sync
      .locator('form')
      .getByRole('button', { name: 'Upload', exact: true, includeHidden: true })
      .waitFor({ state: 'detached' });
    await dialog.locator('[data-settings-category="password"]').click();
    // Removing a sync profile retains globally shared saved credentials.
    expect(await syncCredential.count()).toBe(1);
    await syncCredential.getByRole('button', { name: 'Delete credential', exact: true }).click();
    await syncCredential.getByRole('button', { name: 'Confirm deletion', exact: true }).click();
    await syncCredential.waitFor({ state: 'detached' });
    expect(await page.locator('body').innerText()).not.toContain('UI_SYNC_PRIVATE_CANARY');
    await dialog.locator('[data-settings-category="common"]').click();
    await page.getByTestId('application-appearance').click();
    await page.getByRole('option', { name: 'Light', exact: true }).click();
    await expect.poll(() => page.locator('html').getAttribute('data-ax-theme')).toBe('light');
    expect(
      await page
        .locator('[data-axterm-product-workspace]')
        .evaluate((el) => getComputedStyle(el).backgroundColor),
    ).toBe('rgb(245, 245, 245)');
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.getByTestId('application-appearance').click();
    await page.getByRole('option', { name: 'System', exact: true }).click();
    await expect.poll(() => page.locator('html').getAttribute('data-ax-theme')).toBe('dark');
    await page.emulateMedia({ colorScheme: 'light' });
    await expect.poll(() => page.locator('html').getAttribute('data-ax-theme')).toBe('light');
    await page.getByTestId('application-appearance').click();
    await page.getByRole('option', { name: 'Dark', exact: true }).click();
    await expect.poll(() => page.locator('html').getAttribute('data-ax-theme')).toBe('dark');
    await page.getByRole('checkbox', { name: 'Hide hosts and IP addresses', exact: true }).click();
    await expect
      .poll(() =>
        page
          .getByRole('checkbox', { name: 'Hide hosts and IP addresses', exact: true })
          .isChecked(),
      )
      .toBe(true);
    await page.locator('[data-section-close=left]').click();
    await dialog.waitFor({ state: 'hidden' });
    expect(await page.locator('style[data-plugin="@axterm/infra-ui-theme"]').count()).toBe(1);
    expect(await page.locator('style[data-plugin="@axterm/ui"]').count()).toBe(1);
    await page
      .locator('.tabbar')
      .getByRole('button', { name: 'New terminal', exact: true })
      .click();
    const terminal = page.locator('[data-terminal-channel="ready"] .xterm');
    await terminal.waitFor({ timeout: 15000 });
    await terminal.click();
    await page.keyboard.type("printf 'AXTERM_WEB_%s' PRESENTATION_OK; echo");
    await page.keyboard.press('Enter');
    await expect
      .poll(() => terminal.locator('.xterm-rows').textContent(), { timeout: 6000 })
      .toContain('AXTERM_WEB_PRESENTATION_OK');
    await closeLevel3Tab(page);
    await expect
      .poll(() => page.locator('[data-workspace-global-tabs]').getByRole('tab').count())
      .toBe(0);

    await page.reload();
    await page.locator('[data-axterm-product-workspace]').waitFor();
    // ADR-143 admits a fresh default terminal when this Web workspace has no live tabs.
    await page.locator('[data-terminal-channel=ready]:visible').waitFor();
    await page.locator('[data-workspace-global-tabs] .tab-close').click();
    await expect.poll(() => page.locator('html').getAttribute('lang')).toBe('en');
    await expect.poll(() => page.locator('html').getAttribute('data-ax-theme')).toBe('dark');
    await openLevel3Settings(page);
    await page
      .getByRole('checkbox', { name: 'Hide hosts and IP addresses', exact: true })
      .waitFor();
    expect(
      await page
        .getByRole('checkbox', { name: 'Hide hosts and IP addresses', exact: true })
        .isChecked(),
    ).toBe(true);
    expect(
      await page.evaluate(() => ({ local: { ...localStorage }, session: { ...sessionStorage } })),
    ).toEqual({ local: {}, session: {} });
    expect(await page.locator('[data-workspace-global-tabs]').getByRole('tab').count()).toBe(0);
    expect(browserErrors).toEqual([]);
    expect(diagnostics.join('')).not.toContain(token);
    expect(await page.locator('body').textContent()).not.toContain(token);
    await shell.close();
    shell = undefined;
    host.kill('SIGTERM');
    expect(await stopped).toBe(0);
  } catch (error) {
    const failedPage = shell?.windows()[0];
    if (failedPage) {
      await writeFile(
        'out/level3-migration/final-2026-11-09/presentation-failure.json',
        JSON.stringify(
          {
            console: (await failedPage.consoleMessages())
              .map((message) => message.text())
              .filter((text) => text.startsWith('SYNC_REPAIR')),
            body: (await failedPage.locator('body').innerText()).replaceAll(
              'UI_SYNC_PRIVATE_CANARY',
              '[redacted]',
            ),
            error: String(error),
          },
          null,
          2,
        ),
      );
      await failedPage.screenshot({
        path: 'out/level3-migration/final-2026-11-09/presentation-failure.png',
      });
    }
    throw error;
  } finally {
    syncServer.closeAllConnections();
    await new Promise<void>((done) => syncServer.close(() => done()));
    await shell?.close();
    if (host && host.exitCode === null) {
      host.kill('SIGKILL');
      await stopped;
    }
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
}, 45000);
