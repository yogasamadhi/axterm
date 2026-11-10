import { openLevel3Settings } from '../support/level3-workspace-actions.ts';
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
it('composes retained Widgets through Slots, generated Remote, native grants and the existing rename owner', async () => {
  const home = await mkdtemp(join(tmpdir(), 'axterm-widgets-ui-')),
    errors: string[] = [];
  let application: ElectronApplication | undefined,
    stage = 'launch';
  try {
    await mkdir(join(home, 'desktop'));
    await mkdir(join(home, 'shared'));
    await writeFile(join(home, 'shared', 'hello.txt'), 'WIDGET_UI_HTTP');
    const entry = join(home, 'shell.mjs');
    await writeFile(
      entry,
      `import{app,protocol}from'electron';import{DesktopShell}from${JSON.stringify(pathToFileURL(resolve('apps/desktop/lib/shell/application.js')).href)};protocol.registerSchemesAsPrivileged([{scheme:'axterm-app',privileges:{standard:true,secure:true,supportFetchAPI:true,corsEnabled:true,stream:true}}]);app.setPath('userData',${JSON.stringify(join(home, 'desktop'))});app.whenReady().then(()=>{globalThis.shell=new DesktopShell({home:${JSON.stringify(home)},webRoot:${JSON.stringify(resolve('apps/web/dist'))},hostEntry:${JSON.stringify(resolve('apps/desktop-host/lib/index.js'))},preload:${JSON.stringify(resolve('apps/desktop/lib/shell/preload.cjs'))},environment:{...process.env,SHELL:'/bin/bash'},visible:false,fileChooser:()=>({async choose(kind,signal){signal.throwIfAborted();if(kind!=='open-directory')throw Error('Unexpected chooser');return ${JSON.stringify(join(home, 'shared'))};},defaultDirectory(){return ${JSON.stringify(home)};},retire(){}}),confirmQuit:async()=>true,recover:async()=> 'quit'});globalThis.shell.start();app.emit('second-instance',{},['-tp','local','--title','Widgets Primary'],${JSON.stringify(home)});});`,
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
    const tab = page.getByRole('tab', { name: 'Widgets Primary', exact: true });
    await tab.waitFor();
    await page.locator('[data-terminal-channel=ready]').waitFor();
    stage = 'Widgets settings';
    await openLevel3Settings(page);
    await page.getByTestId('application-language').click();
    await page.getByRole('option', { name: 'English', exact: true }).click();
    await browserExpect(page.getByTestId('application-language')).toContainText('English');
    await page.locator('[data-settings-tab=widgets]').click();
    const panel = page.locator('.widget-workspace');
    await browserExpect(panel).toBeVisible();
    stage = 'HTTP start';
    await panel.getByRole('button', { name: 'Choose directory', exact: false }).click();
    await browserExpect(panel.locator('input[readonly]')).toHaveValue('shared');
    await panel.locator('input[name=port]').fill('0');
    await panel.getByRole('button', { name: 'Start widget', exact: true }).click();
    const instance = panel.locator('.widget-instance-list article').first();
    await browserExpect(instance).toBeVisible();
    await browserExpect(instance.locator('.widget-instance-title small')).toHaveText(
      /^http:\/\/127\.0\.0\.1:\d+\/?$/,
    );
    const url = await instance.locator('.widget-instance-title small').innerText();
    expect(await (await fetch(url + '/hello.txt')).text()).toBe('WIDGET_UI_HTTP');
    stage = 'HTTP stop';
    await instance.getByRole('button', { name: 'Stop', exact: true }).click();
    await instance
      .getByRole('button', { name: /confirm|stop/i })
      .last()
      .click();
    await browserExpect(panel.locator('.widget-empty-instances')).toBeVisible();
    stage = 'File Renamer';
    await panel.getByRole('tab', { name: 'Widgets', exact: true }).click();
    await panel.getByRole('button', { name: /File Renamer/ }).click();
    await panel.getByRole('button', { name: 'Choose directory', exact: false }).click();
    await panel.locator('input[name=template]').fill('renamed_{name}.{ext}');
    await panel.getByRole('button', { name: 'Preview rename', exact: true }).click();
    await browserExpect(panel.locator('.file-rename-preview')).toBeVisible();
    await panel
      .getByRole('button', { name: /Confirm.*rename|Rename.*file/i })
      .last()
      .click();
    await expect
      .poll(async () => {
        try {
          return await (
            await import('node:fs/promises')
          ).readFile(join(home, 'shared', 'renamed_hello.txt'), 'utf8');
        } catch {
          return '';
        }
      })
      .toBe('WIDGET_UI_HTTP');
    stage = 'MCP credential and source lifecycle';
    await panel.getByRole('button', { name: /MCP Server/ }).click();
    await panel.locator('input[name=port]').fill('0');
    await panel.locator('input[name=apiKey]').fill('MCP_NATIVE_FIXTURE_SECRET');
    await panel.getByRole('button', { name: 'Start widget', exact: true }).click();
    const mcp = panel.locator('.widget-instance-list article').first();
    await browserExpect(mcp).toBeVisible();
    await browserExpect(mcp.locator('.widget-instance-title small')).toHaveText(
      /^http:\/\/127\.0\.0\.1:\d+\/mcp(?: · .+)?$/,
    );
    const mcpUrl = (await mcp.locator('.widget-instance-title small').innerText()).split(' · ')[0]!;
    const initialized = await fetch(mcpUrl, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer MCP_NATIVE_FIXTURE_SECRET',
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'native-fixture', version: '1' },
        },
      }),
    });
    expect(initialized.status).toBe(200);
    await initialized.text();
    await mcp.getByRole('button', { name: 'Stop', exact: true }).click();
    await mcp.getByRole('button', { name: 'Click again to confirm stop', exact: true }).click();
    await browserExpect(panel.locator('.widget-empty-instances')).toBeVisible();
    expect(JSON.parse(await readFile(join(home, 'vault-v2', 'metadata.json'), 'utf8'))).toEqual([]);
    expect(errors).toEqual([]);
    await application.evaluate(async () => {
      await (globalThis as unknown as { shell: DesktopShell }).shell.stop();
    });
  } catch (error) {
    await writeFile(
      'out/level3-migration/sdk/widgets-ui-diagnostic.json',
      JSON.stringify(
        {
          stage,
          errors,
          console: await application
            ?.windows()[0]
            ?.consoleMessages()
            .then((messages) =>
              messages.map((message) => ({ type: message.type(), text: message.text() })),
            ),
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
}, 30000);
