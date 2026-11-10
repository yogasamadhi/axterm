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
it('opens an actual PTY HTTP link through generated Desktop Remote and the owned native opener', async () => {
  const home = await mkdtemp(join(tmpdir(), 'axterm-terminal-links-')),
    errors: string[] = [];
  let application: ElectronApplication | undefined;
  try {
    await mkdir(join(home, 'desktop'));
    const entry = join(home, 'shell.mjs');
    await writeFile(
      entry,
      `import{app,protocol}from'electron';import{DesktopShell}from${JSON.stringify(pathToFileURL(resolve('apps/desktop/lib/shell/application.js')).href)};protocol.registerSchemesAsPrivileged([{scheme:'axterm-app',privileges:{standard:true,secure:true,supportFetchAPI:true,corsEnabled:true,stream:true}}]);app.setPath('userData',${JSON.stringify(join(home, 'desktop'))});app.whenReady().then(()=>{globalThis.openedLinks=[];globalThis.shell=new DesktopShell({home:${JSON.stringify(home)},webRoot:${JSON.stringify(resolve('apps/web/dist'))},hostEntry:${JSON.stringify(resolve('apps/desktop-host/lib/index.js'))},preload:${JSON.stringify(resolve('apps/desktop/lib/shell/preload.cjs'))},environment:{...process.env},visible:false,openExternal:async url=>{globalThis.openedLinks.push(url)},confirmQuit:async()=>true,recover:async()=> 'quit'});globalThis.shell.start();app.emit('second-instance',{},['-tp','local','--title','Native Primary'],${JSON.stringify(home)});});`,
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
    const root = page.locator('[data-axterm-product-workspace]');
    const first = page.getByRole('tab', { name: 'Native Primary', exact: true });
    await first.waitFor();
    await page.locator('[data-terminal-channel=ready]').waitFor();
    await browserExpect(root).toHaveAttribute('data-workspace-presentation', 'ready');
    const terminal = page.locator('[data-terminal-id]').first(),
      canvas = terminal.locator('.terminal-canvas');
    await browserExpect(terminal).toHaveAttribute('data-background-kind', 'none');
    const input = page.locator('.xterm-helper-textarea').first();
    await input.fill("printf '\\nhttps://example.invalid/axterm-link-probe\\n'");
    await input.press('Enter');
    const row = terminal
      .locator('.xterm-rows > div')
      .filter({ hasText: /^https:\/\/example\.invalid\/axterm-link-probe$/ })
      .last();
    await row.waitFor();
    const bounds = await row.boundingBox();
    if (!bounds) throw Error('Link output is not visible');
    await page.mouse.move(bounds.x + 35, bounds.y + bounds.height / 2);
    await browserExpect(terminal.locator('.xterm-screen')).toHaveClass(/xterm-cursor-pointer/);
    await page.mouse.click(bounds.x + 35, bounds.y + bounds.height / 2);
    await browserExpect
      .poll(() =>
        application!.evaluate(
          () => (globalThis as unknown as { openedLinks: string[] }).openedLinks,
        ),
      )
      .toEqual(['https://example.invalid/axterm-link-probe']);
    await input.fill("printf '\\114INK_FLOW_ALIVE\\n'");
    await input.press('Enter');
    await browserExpect(canvas).toContainText('LINK_FLOW_ALIVE');
    expect(errors).toEqual([]);
    await application.evaluate(async () => {
      await (globalThis as unknown as { shell: DesktopShell }).shell.stop();
    });
  } catch (error) {
    await writeFile(
      'out/level3-migration/sdk/links-ui-diagnostic.json',
      JSON.stringify(
        {
          errors,
          bodies: await Promise.all(
            application?.windows().map((page) =>
              page
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
    await rm(home, { recursive: true, force: true });
  }
}, 20000);
