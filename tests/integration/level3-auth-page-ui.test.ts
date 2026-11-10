import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  _electron as electron,
  expect as browserExpect,
  type ElectronApplication,
} from '@playwright/test';
import { expect, it } from 'vitest';
import { terminalProfileInputSchema } from '@axterm/plugin-api/terminals';
import { runProfile } from '../../apps/cli/src/profile-boot.ts';
import { PROFILE_TEMPLATES } from '../../apps/cli/src/profile-templates.ts';
import { withLevel3ProductSeed } from '../fixtures/level3-product-seed.ts';

it('renders built authentication styles at three sizes/200% and exchanges a credential without persistent browser secrets', async () => {
  const home = await mkdtemp(join(tmpdir(), 'axterm-auth-page-ui-'));
  let application: Awaited<ReturnType<typeof runProfile>> | undefined;
  let browser: ElectronApplication | undefined;
  let token = '';
  try {
    const authHtml = await readFile('apps/web/dist/auth.html', 'utf8');
    const stylesheets = [...authHtml.matchAll(/<link[^>]+rel="stylesheet"[^>]+href="([^"]+)"/gu)];
    expect(stylesheets.length).toBeGreaterThanOrEqual(2);
    await withLevel3ProductSeed(home, (ctx) => {
      const receipt = ctx.terminalFacts.createProfile(
        randomUUID(),
        terminalProfileInputSchema.parse({
          name: 'Isolated authentication shell',
          shell: '/bin/sh',
          cwd: home,
          loginShell: false,
          env: { HOME: home, ZDOTDIR: home, ENV: '/dev/null', PS1: '' },
        }),
      );
      const settings = ctx.configurationController.getSettings();
      ctx.configurationController.updateSettings(
        randomUUID(),
        { terminal: { defaultProfileId: receipt.ids[0]! } },
        `"v${settings.version}"`,
      );
    });
    await mkdir(join(home, 'profiles/web'), { recursive: true, mode: 0o700 });
    await writeFile(
      join(home, 'profiles/web/package.json'),
      JSON.stringify({
        private: true,
        axterm: { profile: { bundles: PROFILE_TEMPLATES.web!.bundles } },
      }),
    );
    application = await runProfile({
      profile: 'web',
      home,
      installAnchor: resolve('apps/cli/package.json'),
      templates: {},
      patchFiles: [],
      args: [],
      requiredServices: ['webStartup'],
      prepare(ctx) {
        ctx.provide('webAssets', {
          index: resolve('apps/web/dist/index.html'),
          authenticationPage: resolve('apps/web/dist/auth.html'),
        });
      },
    });
    const origin = new URL(application.ctx.webStartup.url).origin;
    const entry = join(home, 'browser.cjs');
    await writeFile(
      entry,
      `const{app,BrowserWindow}=require('electron');app.setPath('userData',${JSON.stringify(join(home, 'browser'))});app.whenReady().then(()=>{const w=new BrowserWindow({show:false,width:1280,height:800,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false,backgroundThrottling:false}});w.loadURL(process.env.AXTERM_AUTH_UI_URL);});app.on('window-all-closed',()=>app.quit());`,
    );
    browser = await electron.launch({
      executablePath: createRequire(resolve('apps/desktop/package.json'))('electron') as string,
      args: [entry],
      cwd: home,
      env: {
        ...process.env,
        HOME: home,
        ZDOTDIR: home,
        AXTERM_HOME: home,
        AXTERM_AUTH_UI_URL: origin + '/',
        HTTP_PROXY: '',
        HTTPS_PROXY: '',
        ALL_PROXY: '',
      },
    });
    const page = await browser.firstWindow();
    await page.getByRole('heading', { name: 'Connect to Axterm' }).waitFor();
    for (const [width, height] of [
      [1280, 800],
      [1440, 900],
      [1920, 1080],
    ]) {
      for (const zoom of [1, 2]) {
        await browser.evaluate(
          ({ BrowserWindow }, { width, height, zoom }) => {
            const window = BrowserWindow.getAllWindows()[0]!;
            window.setContentSize(width!, height!);
            window.webContents.setZoomFactor(zoom);
          },
          { width, height, zoom },
        );
        await browserExpect
          .poll(() => page.evaluate(() => [innerWidth, innerHeight]))
          .toEqual([width! / zoom, height! / zoom]);
        await browserExpect(page.locator('body')).toHaveCSS('background-color', 'rgb(30, 30, 30)');
        await browserExpect(page.locator('form')).toHaveCSS('display', 'grid');
        const geometry = await page.locator('main').evaluate((element) => {
          const box = element.getBoundingClientRect();
          return {
            x: box.x,
            right: box.right,
            width: box.width,
            viewport: innerWidth,
            overflow: document.documentElement.scrollWidth > innerWidth,
          };
        });
        expect(geometry.x).toBeGreaterThanOrEqual(0);
        expect(geometry.right).toBeLessThanOrEqual(geometry.viewport);
        expect(geometry.width).toBeLessThanOrEqual(360);
        expect(geometry.overflow).toBe(false);
      }
    }
    const input = page.getByLabel('Launch token', { exact: true });
    await browserExpect(input).toHaveAttribute('type', 'password');
    await input.fill('invalid-auth-ui-fixture');
    await page.getByRole('button', { name: 'Connect', exact: true }).click();
    await browserExpect(page.getByRole('status')).toHaveText(
      'Connection failed. Check the launch token and try again.',
    );
    await browserExpect(input).toHaveValue('');
    expect(new URL(page.url()).search).toBe('');
    token = (await readFile(application.ctx.webStartup.tokenFile!, 'utf8')).trim();
    await input.fill(token);
    await page.getByRole('button', { name: 'Connect', exact: true }).click();
    await browserExpect(page.getByTestId('runtime-state')).toHaveAttribute('data-state', 'ready');
    expect(new URL(page.url()).search).toBe('');
    expect(
      await page.evaluate(() => ({
        cookie: document.cookie,
        local: { ...localStorage },
        session: { ...sessionStorage },
      })),
    ).toEqual({ cookie: '', local: {}, session: {} });
    expect(await page.locator('body').innerText()).not.toContain(token);
  } catch (error) {
    // eslint-disable-next-line preserve-caught-error -- Retaining the unredacted cause would expose the launch credential in a failed fixture log.
    if (token) throw new Error(String(error).replaceAll(token, '[redacted]'));
    throw error;
  } finally {
    try {
      await browser?.close();
    } finally {
      try {
        await application?.shutdown.shutdown(0);
      } finally {
        await rm(home, { recursive: true, force: true });
      }
    }
  }
}, 25000);
