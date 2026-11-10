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
it('protects imported layout from both live windows until pure-layout reload', async () => {
  const home = await mkdtemp(join(tmpdir(), 'axterm-import-autosave-ui-'));
  let application: ElectronApplication | undefined;
  const stage = 'preferences';
  const errors: string[] = [];
  try {
    await mkdir(join(home, 'desktop'));
    const entry = join(home, 'shell.mjs');
    const launch = async (native = false) => {
      await writeFile(
        entry,
        `import{app,protocol}from'electron';import{DesktopShell}from${JSON.stringify(pathToFileURL(resolve('apps/desktop/lib/shell/application.js')).href)};protocol.registerSchemesAsPrivileged([{scheme:'axterm-app',privileges:{standard:true,secure:true,supportFetchAPI:true,corsEnabled:true,stream:true}}]);app.setPath('userData',${JSON.stringify(join(home, 'desktop'))});app.whenReady().then(()=>{globalThis.shell=new DesktopShell({home:${JSON.stringify(home)},webRoot:${JSON.stringify(resolve('apps/web/dist'))},hostEntry:${JSON.stringify(resolve('apps/desktop-host/lib/index.js'))},preload:${JSON.stringify(resolve('apps/desktop/lib/shell/preload.cjs'))},environment:{...process.env,SHELL:'/bin/bash'},visible:false,fileChooser:()=>({async choose(kind,signal){signal.throwIfAborted();if(kind!=='open-file'&&kind!=='save-file')throw Error('Unexpected chooser');return ${JSON.stringify(join(home, 'settings.json'))};},defaultDirectory(){return ${JSON.stringify(home)};},retire(){}}),confirmQuit:async()=>true,recover:async()=> 'quit'});globalThis.shell.start();${native ? `app.emit('second-instance',{},['-tp','local','--title','Native takes priority'],${JSON.stringify(home)});` : ''}});`,
      );
      const app = await electron.launch({
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
      application = app;
      const page = await app.firstWindow({ timeout: 7000 });
      page.setDefaultTimeout(6000);
      page.on('pageerror', (error) => errors.push(error.message));
      return { app, page };
    };
    const stop = async () => {
      const app = application!;
      await app.evaluate(async () => {
        await (globalThis as unknown as { shell: DesktopShell }).shell.stop();
      });
      const child = app.process();
      await app.close();
      if (child.exitCode === null) child.kill('SIGKILL');
      application = undefined;
    };
    const { app, page } = await launch();
    await page.locator('[data-terminal-channel=ready]').waitFor();
    await openLevel3Settings(page);
    await page.getByTestId('application-language').click();
    await page.getByRole('option', { name: 'English', exact: true }).click();
    await browserExpect(page.getByTestId('application-language')).toContainText('English');
    await page.keyboard.press('Escape');
    await app.evaluate(async () => {
      (globalThis as unknown as { shell: DesktopShell }).shell.createWindow();
    });
    await browserExpect.poll(() => app.windows().length).toBe(2);
    const second = app.windows().find((value) => value !== page)!;
    second.setDefaultTimeout(6000);
    await second.locator('[data-workspace-presentation=ready]').waitFor();
    await second.getByRole('button', { name: 'Layout', exact: true }).click();
    await second.locator('[data-layout-choice=c3]').click();
    await second.locator('[data-workspace-presentation=ready]').waitFor();
    const configurationFile = join(home, 'settings.json');
    await openLevel3Settings(page);
    await page.getByRole('button', { name: 'General', exact: true }).click();
    const portable = page.locator('[data-configuration-portable]');
    await portable
      .getByRole('button', { name: 'Export Axterm configuration', exact: true })
      .click();
    await browserExpect(portable.locator('[role=status]')).toBeVisible();
    const document = JSON.parse(await readFile(configurationFile, 'utf8'));
    document.data.settings.workspace.restoreLayout = true;
    document.data.settings.workspace.layout = {
      section: 'hosts',
      sidebarOpen: true,
      split: true,
      tabs: [],
      activeTerminalId: null,
      secondaryTerminalId: null,
      layoutMode: 'c2',
      paneTerminalIds: [null, null],
      focusedPane: 0,
    };
    await writeFile(configurationFile, JSON.stringify(document));
    await portable
      .getByRole('checkbox', {
        name: /^Also save portable appearance, layout, terminal, file and shortcut settings/,
      })
      .click();
    // Native chooser returns the isolated fixture file; no OS-focus dependency.
    await portable
      .getByRole('button', { name: 'Import Axterm configuration', exact: true })
      .click();
    // Commit at the real Host, then lose only the transport acknowledgement.
    await app.evaluate(() => {
      const original = globalThis.fetch.bind(globalThis);
      const capture = { payloads: [] as unknown[] };
      (globalThis as typeof globalThis & { __axtermImportAck?: typeof capture }).__axtermImportAck =
        capture;
      globalThis.fetch = async (input, init) => {
        const url = new URL(input instanceof Request ? input.url : String(input));
        if (
          url.protocol !== 'http:' ||
          url.hostname !== '127.0.0.1' ||
          url.pathname !== '/api/configuration/importConfiguration'
        )
          return original(input, init);
        const request = new Request(input, init);
        capture.payloads.push(((await request.clone().json()) as { payload: unknown }).payload);
        const response = await original(request);
        if (capture.payloads.length === 1) {
          await response.arrayBuffer();
          return Response.json({ detail: 'controlled committed ACK loss' }, { status: 500 });
        }
        return response;
      };
    });
    await portable.getByRole('button', { name: /^Import \d+ items$/ }).click();
    await browserExpect(
      portable.getByRole('button', { name: 'Check last import result', exact: true }),
    ).toBeVisible();
    const attempts = () =>
      app.evaluate(
        () =>
          (globalThis as typeof globalThis & { __axtermImportAck: { payloads: unknown[] } })
            .__axtermImportAck.payloads,
      );
    expect(await attempts()).toHaveLength(1);
    await portable.getByRole('button', { name: 'Check last import result', exact: true }).click();
    await browserExpect.poll(async () => (await attempts()).length).toBe(2);
    const replayed = await attempts();
    expect(replayed[1]).toEqual(replayed[0]);
    await browserExpect(page.locator('[data-configuration-import-result]')).toContainText(
      'Axterm configuration imported',
    );
    await page.keyboard.press('Escape');
    await browserExpect(page.locator('[data-workspace-import-restart]')).toBeVisible();
    await browserExpect(second.locator('[data-workspace-import-restart]')).toBeVisible();
    await second.getByRole('button', { name: 'Layout', exact: true }).click();
    await second.locator('[data-layout-choice=r2]').click();
    await browserExpect(second.locator('[data-workspace-import-restart]')).toBeVisible();
    await second.reload();
    await second.locator('[data-workspace-presentation=ready]').waitFor();
    await browserExpect(second.locator('[data-workspace-grid]')).toHaveClass(/terminal-grid-c2/);
    await browserExpect(second.locator('[data-terminal-channel=ready]')).toHaveCount(0);
    expect(errors).toEqual([]);
    await stop();
  } catch (error) {
    await writeFile(
      'out/level3-migration/sdk/import-autosave-ui-diagnostic.json',
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
      const child = application.process();
      await application.close().catch(() => undefined);
      if (child.exitCode === null) child.kill('SIGKILL');
    }
    await rm(home, { recursive: true, force: true });
  }
}, 30_000);
