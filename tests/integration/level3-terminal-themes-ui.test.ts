import { openLevel3AiWorkspace, openLevel3Settings } from '../support/level3-workspace-actions.ts';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { AXTERM_TERMINAL_THEMES } from '../../packages/plugins/terminals/src/application/theme-presets.ts';
import { piSseStart, piSseText, piSseEnd } from '../fixtures/pi-sse.ts';
import { themeDictionaries } from '../../packages/plugins/terminals/src/client/themes/locales.ts';
import { PNG } from 'pngjs';
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
it('retains theme CRUD, scoped background application and actual native image streaming without remounting the PTY', async () => {
  const home = await mkdtemp(join(tmpdir(), 'axterm-terminal-themes-')),
    errors: string[] = [];
  let application: ElectronApplication | undefined,
    requests = 0;
  const generated = { ...AXTERM_TERMINAL_THEMES[0], name: 'Generated theme probe' };
  const server = createServer((request, response) => {
    requests++;
    request.resume();
    request.once('end', () => {
      if (request.headers.authorization !== 'Bearer THEME_ENGINE_CANARY') {
        response.writeHead(401);
        response.end();
        return;
      }
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end(
        piSseStart('openai-chat') +
          piSseText('openai-chat', JSON.stringify(generated)) +
          piSseEnd('openai-chat'),
      );
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw Error('Fixture not ready');
  try {
    await mkdir(join(home, 'desktop'));
    const imagePath = join(home, 'background.png'),
      png = new PNG({ width: 8, height: 8 });
    const image = PNG.sync.write(png);
    await writeFile(imagePath, image);
    const entry = join(home, 'shell.mjs');
    await writeFile(
      entry,
      `import{app,protocol}from'electron';import{DesktopShell}from${JSON.stringify(pathToFileURL(resolve('apps/desktop/lib/shell/application.js')).href)};protocol.registerSchemesAsPrivileged([{scheme:'axterm-app',privileges:{standard:true,secure:true,supportFetchAPI:true,corsEnabled:true,stream:true}}]);app.setPath('userData',${JSON.stringify(join(home, 'desktop'))});app.whenReady().then(()=>{globalThis.shell=new DesktopShell({home:${JSON.stringify(home)},webRoot:${JSON.stringify(resolve('apps/web/dist'))},hostEntry:${JSON.stringify(resolve('apps/desktop-host/lib/index.js'))},preload:${JSON.stringify(resolve('apps/desktop/lib/shell/preload.cjs'))},environment:{...process.env},visible:false,fileChooser:()=>({async choose(kind,signal){signal.throwIfAborted();if(kind!=='open-file')throw Error('Unexpected selection');return ${JSON.stringify(imagePath)};},defaultDirectory(){return ${JSON.stringify(home)};},retire(){}}),confirmQuit:async()=>true,recover:async()=> 'quit'});globalThis.shell.start();app.emit('second-instance',{},['-tp','local','--title','Native Primary'],${JSON.stringify(home)});});`,
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
    const input = page.locator('.xterm-helper-textarea').first(),
      original = await input.elementHandle();
    await input.fill("printf 'THEME_PTY_PROBE\\n'");
    await input.press('Enter');
    await browserExpect(canvas).toContainText('THEME_PTY_PROBE');
    const t = themeDictionaries.en;
    await openLevel3Settings(page);
    await page.getByTestId('application-language').click();
    await page.getByRole('option', { name: 'English', exact: true }).click();
    await browserExpect(page.locator('html')).toHaveAttribute('lang', 'en');
    await page.locator('[data-settings-tab="themes"]').click();
    const editor = page.locator('[data-terminal-themes]');
    await editor.waitFor();
    await editor.getByRole('button', { name: t['terminalThemes.clone'], exact: true }).click();
    const name = editor.getByLabel(t['terminalThemes.name'], { exact: true });
    await browserExpect(name).toBeEnabled();
    await name.fill('Native theme probe');
    await editor.getByRole('button', { name: t['common.save'], exact: true }).click();
    await browserExpect(editor.locator('.terminal-theme-list')).toContainText('Native theme probe');
    await editor
      .getByLabel(t['terminalThemes.backgroundType'], { exact: true })
      .selectOption('text');
    await editor
      .getByLabel(t['terminalThemes.backgroundText'], { exact: true })
      .fill('OWNED_THEME_TEXT');
    await editor.getByRole('button', { name: t['terminalThemes.apply'], exact: true }).click();
    await browserExpect(editor).toContainText(t['terminalThemes.appliedGlobal']);
    await page.keyboard.press('Escape');
    await browserExpect(editor).toHaveCount(0);
    await browserExpect(terminal.locator('.terminal-background-text')).toHaveText(
      'OWNED_THEME_TEXT',
    );
    expect(
      await original!.evaluate((node) => node === document.querySelector('.xterm-helper-textarea')),
    ).toBe(true);
    await openLevel3Settings(page);
    await page.locator('[data-settings-tab="themes"]').click();
    await editor.getByLabel(t['terminalThemes.scope'], { exact: true }).selectOption('session');
    await editor
      .getByRole('button', { name: t['terminalThemes.chooseImage'], exact: true })
      .click();
    await browserExpect(
      editor.getByLabel(t['terminalThemes.backgroundType'], { exact: true }),
    ).toHaveValue('image');
    await editor.getByRole('button', { name: t['terminalThemes.apply'], exact: true }).click();
    await browserExpect(editor).toContainText(t['terminalThemes.appliedSession']);
    await page.keyboard.press('Escape');
    const background = terminal.locator('.terminal-background-image');
    await browserExpect(background).toHaveAttribute('data-background-state', 'ready');
    const decoded = await background.evaluate(async (node) => {
      const css = getComputedStyle(node).backgroundImage,
        match = /^url\(["']?(.*?)["']?\)$/.exec(css);
      if (!match?.[1]) throw Error('No owned background descriptor');
      const image = new Image();
      image.src = match[1];
      await image.decode();
      const response = await fetch(match[1]);
      return {
        width: image.naturalWidth,
        height: image.naturalHeight,
        status: response.status,
        bytes: (await response.arrayBuffer()).byteLength,
      };
    });
    expect(decoded).toEqual({ width: 8, height: 8, status: 200, bytes: image.length });
    await browserExpect(root).toHaveAttribute('data-workspace-presentation', 'ready');
    await page.reload();
    await page.locator('[data-terminal-channel=ready]').waitFor();
    await browserExpect(page.locator('.terminal-background-image')).toHaveAttribute(
      'data-background-state',
      'ready',
    );
    expect(await page.locator('[data-terminal-id]').count()).toBe(1);
    await openLevel3AiWorkspace(page);
    const aiConfig = page.getByRole('dialog', { name: 'AI Config', exact: true });
    await aiConfig.locator('[name=name]').fill('Theme Pi fixture');
    await aiConfig.locator('[name=baseUrl]').fill(`http://127.0.0.1:${address.port}/v1`);
    await aiConfig.locator('[name=model]').fill('theme-fixture-model');
    await aiConfig.locator('[name=apiKey]').fill('THEME_ENGINE_CANARY');
    await aiConfig.getByRole('button', { name: 'Save configuration', exact: true }).click();
    await aiConfig.waitFor({ state: 'hidden' });
    expect(requests).toBe(0);
    await page.getByRole('tab', { name: 'Native Primary', exact: true }).click();
    await openLevel3Settings(page);
    await page.locator('[data-settings-tab="themes"]').click();
    await editor.getByRole('tab', { name: 'AI', exact: true }).click();
    await editor
      .getByLabel(t['terminalThemes.aiDescription'], { exact: true })
      .fill('A readable dark green terminal');
    await editor.getByRole('button', { name: t['terminalThemes.aiGenerate'], exact: true }).click();
    await browserExpect(editor).toContainText(t['terminalThemes.aiPreviewReady']);
    await browserExpect(name).toHaveValue(generated.name);
    expect(requests).toBe(1);
    await browserExpect(editor.locator('.terminal-theme-list')).not.toContainText(generated.name);
    await editor.getByRole('button', { name: t['common.save'], exact: true }).click();
    await browserExpect(editor.locator('.terminal-theme-list')).toContainText(generated.name);
    await editor.getByRole('button', { name: t['common.delete'], exact: true }).click();
    await browserExpect(editor).toContainText(t['terminalThemes.confirmDelete']);
    await editor
      .getByRole('button', { name: t['terminalThemes.confirmDeleteButton'], exact: true })
      .click();
    await browserExpect(editor.locator('.terminal-theme-list')).not.toContainText(generated.name);
    await page.keyboard.press('Escape');
    expect(errors).toEqual([]);
    await application.evaluate(async () => {
      await (globalThis as unknown as { shell: DesktopShell }).shell.stop();
    });
  } catch (error) {
    await writeFile(
      'out/level3-migration/sdk/themes-ui-diagnostic.json',
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
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(home, { recursive: true, force: true });
  }
}, 30000);
