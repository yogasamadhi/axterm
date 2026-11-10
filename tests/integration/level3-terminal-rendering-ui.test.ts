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
it('loads actual renderer capabilities and retains IME, Backspace, Shift+Enter and timestamp selection', async () => {
  const home = await mkdtemp(join(tmpdir(), 'axterm-terminal-rendering-')),
    errors: string[] = [];
  let application: ElectronApplication | undefined;
  try {
    await mkdir(join(home, 'desktop'));
    const entry = join(home, 'shell.mjs');
    await writeFile(
      entry,
      `import{app,protocol}from'electron';import{DesktopShell}from${JSON.stringify(pathToFileURL(resolve('apps/desktop/lib/shell/application.js')).href)};protocol.registerSchemesAsPrivileged([{scheme:'axterm-app',privileges:{standard:true,secure:true,supportFetchAPI:true,corsEnabled:true,stream:true}}]);app.setPath('userData',${JSON.stringify(join(home, 'desktop'))});app.whenReady().then(()=>{globalThis.shell=new DesktopShell({home:${JSON.stringify(home)},webRoot:${JSON.stringify(resolve('apps/web/dist'))},hostEntry:${JSON.stringify(resolve('apps/desktop-host/lib/index.js'))},preload:${JSON.stringify(resolve('apps/desktop/lib/shell/preload.cjs'))},environment:{...process.env},visible:false,confirmQuit:async()=>true,recover:async()=> 'quit'});globalThis.shell.start();app.emit('second-instance',{},['-tp','local','--title','Native Primary'],${JSON.stringify(home)});});`,
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
    await browserExpect(page.locator('html')).toHaveAttribute('data-terminal-font-state', 'ready');
    expect(
      await page.evaluate(() =>
        Array.from(document.fonts).some(
          (face) =>
            face.family.replace(/["']/g, '') === 'Maple Mono' &&
            face.weight === '400' &&
            face.status === 'loaded',
        ),
      ),
    ).toBe(true);
    await browserExpect(terminal).toHaveAttribute('data-terminal-capabilities', 'ready');
    await browserExpect(terminal).toHaveAttribute('data-terminal-unicode', '11');
    await browserExpect(terminal).toHaveAttribute('data-terminal-ligatures', 'active');
    await browserExpect(terminal).toHaveAttribute('data-terminal-renderer', 'dom');
    await browserExpect(terminal).toHaveAttribute('data-terminal-images', 'disabled');
    await input.fill("printf '\\nRENDERER_%s\\n' '");
    const compositionPrefix = await input.inputValue();
    await input.dispatchEvent('compositionstart');
    await input.press('Enter');
    await input.press('Backspace');
    await browserExpect(canvas).not.toContainText('RENDERER_IME');
    await input.evaluate((element, prefix) => {
      const textarea = element as HTMLTextAreaElement;
      textarea.value = prefix + 'IME';
      textarea.dispatchEvent(
        new CompositionEvent('compositionupdate', { data: 'IME', bubbles: true }),
      );
      textarea.dispatchEvent(
        new CompositionEvent('compositionend', { data: 'IME', bubbles: true }),
      );
    }, compositionPrefix);
    await browserExpect(terminal.locator('.xterm-rows')).toContainText("'IME");
    await input.fill("'");
    await input.press('Enter');
    await browserExpect(canvas).toContainText('RENDERER_IME');
    await input.fill("printf '\\nBACKSPACE_%s\\n' 'AX");
    await input.press('Backspace');
    await input.fill("'");
    await input.press('Enter');
    await browserExpect(canvas).toContainText('BACKSPACE_A');
    await input.fill("printf '\\n\\123HIFT_ENTER_PROBE\\n'");
    await input.press('Shift+Enter');
    await browserExpect(canvas).toContainText('SHIFT_ENTER_PROBE');
    await input.fill("printf '\\n1704067200\\n'");
    await input.press('Enter');
    const row = terminal
      .locator('.xterm-rows > div')
      .filter({ hasText: /^1704067200$/ })
      .last();
    const bounds = await row.boundingBox();
    if (!bounds) throw Error('Timestamp output is not visible');
    await page.mouse.dblclick(bounds.x + 25, bounds.y + bounds.height / 2);
    const tooltip = page.getByRole('tooltip');
    const date = await page.evaluate(() => new Date(1704067200000).toLocaleString());
    await browserExpect(tooltip).toHaveText(date);
    await input.press('ArrowLeft');
    await browserExpect(tooltip).toHaveCount(0);
    expect(await page.locator('[data-terminal-channel=ready]').count()).toBe(1);
    expect(errors).toEqual([]);
    await application.evaluate(async () => {
      await (globalThis as unknown as { shell: DesktopShell }).shell.stop();
    });
  } catch (error) {
    await writeFile(
      'out/level3-migration/sdk/rendering-ui-diagnostic.json',
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
