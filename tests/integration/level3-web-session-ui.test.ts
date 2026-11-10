import { closeLevel3Tab } from '../support/level3-tab-actions.ts';
import { openLevel3Bookmark, openLevel3Settings } from '../support/level3-workspace-actions.ts';
import { createServer, type IncomingHttpHeaders } from 'node:http';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
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
it('opens a retained Web Session in a sandboxed native child, answers Basic authentication once, isolates Host auth, hides for overlays and destroys on close', async () => {
  const home = await mkdtemp(join(tmpdir(), 'axterm-web-session-ui-')),
    headers: IncomingHttpHeaders[] = [],
    errors: string[] = [];
  const server = createServer((request, response) => {
    headers.push({ ...request.headers });
    if (
      request.url === '/auth' &&
      request.headers.authorization !==
        'Basic ' + Buffer.from('operator:WEB_TRANSIENT_FIXTURE').toString('base64')
    ) {
      response.writeHead(401, { 'WWW-Authenticate': 'Basic realm="Web fixture"' });
      response.end();
      return;
    }
    response.writeHead(200, { 'content-type': 'text/html' });
    response.end(
      '<!doctype html><title>Native Web fixture</title><a href="/next">Next</a><button onclick="window.open(\'/popup\')">Popup</button><div id="proof">Web fixture body</div>',
    );
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const port = (server.address() as { port: number }).port;
  let application: ElectronApplication | undefined;
  try {
    await mkdir(join(home, 'desktop'));
    const entry = join(home, 'shell.mjs');
    await writeFile(
      entry,
      `import{app,protocol}from'electron';import{DesktopShell}from${JSON.stringify(pathToFileURL(resolve('apps/desktop/lib/shell/application.js')).href)};protocol.registerSchemesAsPrivileged([{scheme:'axterm-app',privileges:{standard:true,secure:true,supportFetchAPI:true,corsEnabled:true,stream:true}}]);app.setPath('userData',${JSON.stringify(join(home, 'desktop'))});app.whenReady().then(()=>{globalThis.shell=new DesktopShell({home:${JSON.stringify(home)},webRoot:${JSON.stringify(resolve('apps/web/dist'))},hostEntry:${JSON.stringify(resolve('apps/desktop-host/lib/index.js'))},preload:${JSON.stringify(resolve('apps/desktop/lib/shell/preload.cjs'))},environment:{...process.env},visible:true,confirmQuit:async()=>true,recover:async()=> 'quit'});globalThis.shell.start();});`,
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
    const page = await application.firstWindow();
    page.setDefaultTimeout(7000);
    page.on('pageerror', (error) => errors.push(error.message));
    await page.locator('[data-axterm-product-workspace]').waitFor();
    await openLevel3Settings(page);
    await page.getByTestId('application-language').click();
    await page.getByRole('option', { name: 'English', exact: true }).click();
    await page.locator('[data-section-close=left]').click();
    await openLevel3Bookmark(page);
    await page.locator('[data-bookmark-protocol="web"]').click();
    const form = page.locator('form[data-protocol="web"]');
    await form.locator('input[name="name"]').fill('Web UI fixture');
    await form.locator('input[name="url"]').fill(`http://127.0.0.1:${port}/auth`);
    await form.locator('input[name="userAgent"]').fill('Axterm-Web-UI-Fixture');
    await form.locator('button[value="connect"]').click();
    await form.waitFor({ state: 'hidden' });
    const view = page.locator('[data-web-session-state]');
    await browserExpect(view).toHaveAttribute('data-web-session-state', 'auth-required');
    await view.locator('input[name="username"]').fill('operator');
    await view.locator('input[name="password"]').fill('WEB_TRANSIENT_FIXTURE');
    await view.getByRole('button', { name: 'Sign in', exact: true }).click();
    await browserExpect(view).toHaveAttribute('data-web-session-state', 'ready');
    expect(await view.locator('input[name="password"]').count()).toBe(0);
    const guest = () =>
      application!.evaluate(({ webContents }) =>
        webContents
          .getAllWebContents()
          .filter((value) => value.getTitle() === 'Native Web fixture')
          .map((value) => ({ id: value.id, url: value.getURL() })),
      );
    await expect.poll(async () => (await guest()).length).toBe(1);
    const guestId = (await guest())[0]!.id;
    expect(
      await application.evaluate(
        ({ webContents }, id) =>
          webContents
            .fromId(id)!
            .executeJavaScript(
              '({node:typeof process,bridge:typeof window.axtermDesktopBoot,body:document.querySelector("#proof").textContent})',
            ),
        guestId,
      ),
    ).toEqual({ node: 'undefined', bridge: 'undefined', body: 'Web fixture body' });
    expect(headers.some((value) => value['user-agent'] === 'Axterm-Web-UI-Fixture')).toBe(true);
    expect(
      headers.every((value) => !value['x-axterm-desktop-authorization'] && !value.cookie),
    ).toBe(true);
    expect(
      headers
        .filter((value) => value.authorization)
        .every(
          (value) =>
            value.authorization ===
            'Basic ' + Buffer.from('operator:WEB_TRANSIENT_FIXTURE').toString('base64'),
        ),
    ).toBe(true);
    await application.evaluate(
      ({ webContents }, id) =>
        webContents.fromId(id)!.executeJavaScript('document.querySelector("button").click()'),
      guestId,
    );
    await view.getByText('The page requested a new window:', { exact: false }).waitFor();
    expect((await guest()).length).toBe(1);
    await view.getByRole('button', { name: 'Zoom in page', exact: true }).click();
    await browserExpect(view.locator('[title="Reset page zoom"]')).toHaveText('110%');
    await openLevel3Bookmark(page);
    await page.getByRole('dialog').waitFor();
    const nativeVisibility = () =>
      application!.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()[0]!.contentView.children.map((value) => value.getVisible()),
      );
    await expect.poll(async () => (await nativeVisibility()).every((value) => !value)).toBe(true);
    await page.getByRole('dialog').getByRole('button', { name: /close/i }).click();
    const tab = page.getByRole('tab', { name: 'Web UI fixture', exact: true }),
      target = await tab.getAttribute('aria-controls');
    await closeLevel3Tab(
      page,
      page.locator('[data-workspace-global-tabs]').locator(`[aria-controls="${target}"]`),
    );
    await expect.poll(async () => (await guest()).length).toBe(0);
    expect(errors).toEqual([]);
  } catch (error) {
    await writeFile(
      'out/level3-migration/sdk/web-session-ui-diagnostic.json',
      JSON.stringify(
        {
          errors,
          body: await application
            ?.windows()[0]
            ?.locator('body')
            .innerText()
            .catch(() => '<unavailable>'),
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
    await new Promise<void>((done) => server.close(() => done()));
    await rm(home, { recursive: true, force: true });
  }
});
