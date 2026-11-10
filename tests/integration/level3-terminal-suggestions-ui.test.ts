import { openLevel3AiWorkspace, openLevel3Settings } from '../support/level3-workspace-actions.ts';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { piSseStart, piSseText, piSseEnd } from '../fixtures/pi-sse.ts';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
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
it('derives owned history and explicit Pi suggestions and inserts without executing until human Enter', async () => {
  const home = await mkdtemp(join(tmpdir(), 'axterm-command-suggestions-')),
    errors: string[] = [];
  let application: ElectronApplication | undefined,
    stage = 'launch',
    requests = 0;
  const effects = join(home, 'effects.txt'),
    command = `printf HINT >> '${effects}'`,
    aiCommand = `printf AI_HINT >> '${effects}'`;
  const server = createServer((request, response) => {
    requests++;
    request.resume();
    request.once('end', () => {
      if (request.headers.authorization !== 'Bearer HINT_ENGINE_CANARY') {
        response.writeHead(401);
        response.end();
        return;
      }
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end(
        piSseStart('openai-chat') +
          piSseText('openai-chat', JSON.stringify([aiCommand])) +
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
    const entry = join(home, 'shell.mjs');
    await writeFile(
      entry,
      `import{app,protocol}from'electron';import{DesktopShell}from${JSON.stringify(pathToFileURL(resolve('apps/desktop/lib/shell/application.js')).href)};protocol.registerSchemesAsPrivileged([{scheme:'axterm-app',privileges:{standard:true,secure:true,supportFetchAPI:true,corsEnabled:true,stream:true}}]);app.setPath('userData',${JSON.stringify(join(home, 'desktop'))});app.whenReady().then(()=>{globalThis.shell=new DesktopShell({home:${JSON.stringify(home)},webRoot:${JSON.stringify(resolve('apps/web/dist'))},hostEntry:${JSON.stringify(resolve('apps/desktop-host/lib/index.js'))},preload:${JSON.stringify(resolve('apps/desktop/lib/shell/preload.cjs'))},environment:{...process.env,SHELL:'/bin/bash'},visible:false,confirmQuit:async()=>true,recover:async()=> 'quit'});globalThis.shell.start();app.emit('second-instance',{},['-tp','local','--title','Native Primary'],${JSON.stringify(home)});});`,
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
    const page = await application.firstWindow({ timeout: 7000 });
    page.setDefaultTimeout(7000);
    page.on('pageerror', (error) => errors.push(error.message));
    await page.getByRole('tab', { name: 'Native Primary', exact: true }).waitFor();
    await page.locator('.terminal-canvas[data-shell-integration=active]').waitFor();
    stage = 'enable';
    await openLevel3Settings(page);
    await page.getByTestId('application-language').click();
    await page.getByRole('option', { name: 'English', exact: true }).click();
    await browserExpect(page.locator('html')).toHaveAttribute('lang', 'en');
    await page.locator('[data-settings-category=terminal]').click();
    const toggle = page.getByRole('checkbox', {
      name: 'Show command suggestions while typing',
      exact: true,
    });
    if (!(await toggle.isChecked())) await toggle.click();
    await browserExpect(toggle).toBeChecked();
    await page.keyboard.press('Escape');
    await page.locator('.status-command-history').click();
    await page.getByRole('button', { name: 'Enable command history', exact: true }).click();
    await page.locator('.command-history-list').waitFor();
    await page.locator('.status-command-history').click();
    const input = page.locator('.xterm-helper-textarea').first(),
      popup = page.locator('.terminal-suggestions-wrap');
    stage = 'record-history';
    await input.fill(command);
    await input.press('Enter');
    await browserExpect.poll(() => readFile(effects, 'utf8').catch(() => '')).toBe('HINT');
    await page.locator('.status-command-history').click();
    await browserExpect(page.locator('.command-history-item-text')).toHaveText(command);
    await page.locator('.status-command-history').click();
    stage = 'history-insert';
    await input.fill('printf H');
    await browserExpect(popup.locator('.terminal-suggestion-command')).toHaveText(command);
    await input.press('ArrowDown');
    await input.press('Enter');
    await browserExpect(popup).toHaveCount(0);
    expect(await readFile(effects, 'utf8')).toBe('HINT');
    await input.press('Enter');
    await browserExpect.poll(() => readFile(effects, 'utf8').catch(() => '')).toBe('HINTHINT');
    stage = 'history-delete';
    await input.fill('printf H');
    await popup.waitFor();
    await popup.locator('.terminal-suggestion-item').hover();
    await popup.locator('.terminal-suggestion-delete').click();
    await browserExpect(popup.locator('.terminal-suggestion-command')).toHaveCount(0);
    await input.press('Control+u');
    stage = 'ai-config';
    await openLevel3AiWorkspace(page);
    const aiConfig = page.getByRole('dialog', { name: 'AI Config', exact: true });
    await aiConfig.locator('[name=name]').fill('Hints Pi fixture');
    await aiConfig.locator('[name=baseUrl]').fill(`http://127.0.0.1:${address.port}/v1`);
    await aiConfig.locator('[name=model]').fill('hints-fixture-model');
    await aiConfig.locator('[name=apiKey]').fill('HINT_ENGINE_CANARY');
    await aiConfig.getByRole('button', { name: 'Save configuration', exact: true }).click();
    await aiConfig.waitFor({ state: 'hidden' });
    await page.getByRole('tab', { name: 'Native Primary', exact: true }).click();
    stage = 'explicit-ai';
    await input.fill('printf AI_');
    await popup.waitFor();
    expect(requests).toBe(0);
    await popup.getByRole('button', { name: 'Get AI suggestions', exact: true }).click();
    await browserExpect(popup.locator('.terminal-suggestion-command')).toHaveText(aiCommand);
    expect(requests).toBe(1);
    expect(await readFile(effects, 'utf8')).toBe('HINTHINT');
    await popup.locator('.terminal-suggestion-command').click();
    await browserExpect(popup).toHaveCount(0);
    expect(await readFile(effects, 'utf8')).toBe('HINTHINT');
    await input.press('Enter');
    await browserExpect
      .poll(() => readFile(effects, 'utf8').catch(() => ''))
      .toBe('HINTHINTAI_HINT');
    expect(errors).toEqual([]);
    await application.evaluate(async () => {
      await (globalThis as unknown as { shell: DesktopShell }).shell.stop();
    });
  } catch (error) {
    await writeFile(
      'out/level3-migration/sdk/suggestions-ui-diagnostic.json',
      JSON.stringify(
        {
          stage,
          requests,
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
