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
it('opens retained diagnostics lazily and exports a bounded report through the real native grant and Files writer', async () => {
  const home = await mkdtemp(join(tmpdir(), 'axterm-diagnostic-ui-')),
    errors: string[] = [];
  let application: ElectronApplication | undefined,
    stage = 'launch';
  try {
    await mkdir(join(home, 'desktop'));
    const entry = join(home, 'shell.mjs'),
      destination = join(home, 'diagnostics.json');
    await writeFile(
      entry,
      `import{app,protocol}from'electron';import{DesktopShell}from${JSON.stringify(pathToFileURL(resolve('apps/desktop/lib/shell/application.js')).href)};protocol.registerSchemesAsPrivileged([{scheme:'axterm-app',privileges:{standard:true,secure:true,supportFetchAPI:true,corsEnabled:true,stream:true}}]);app.setPath('userData',${JSON.stringify(join(home, 'desktop'))});app.whenReady().then(()=>{globalThis.choices=0;globalThis.shell=new DesktopShell({home:${JSON.stringify(home)},webRoot:${JSON.stringify(resolve('apps/web/dist'))},hostEntry:${JSON.stringify(resolve('apps/desktop-host/lib/index.js'))},preload:${JSON.stringify(resolve('apps/desktop/lib/shell/preload.cjs'))},environment:{...process.env,SHELL:'/bin/bash'},visible:false,confirmQuit:async()=>true,recover:async()=> 'quit',fileChooser:()=>({choose:async kind=>{if(kind!=='save-file')throw Error('UNEXPECTED_PICKER');globalThis.choices++;return ${JSON.stringify(destination)};},defaultDirectory:()=>${JSON.stringify(home)},retire:()=>{}})});globalThis.shell.start();});`,
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
    await openLevel3Settings(page);
    await page.getByTestId('application-language').click();
    await page.getByRole('option', { name: 'English', exact: true }).click();
    const panel = page.locator('details.settings-advanced-diagnostics');
    await browserExpect(panel.locator('summary')).toHaveText('Advanced diagnostics');
    expect(await panel.getAttribute('open')).toBeNull();
    expect(
      await panel.getByRole('button', { name: 'Export diagnostics', exact: true }).count(),
    ).toBe(0);
    stage = 'read diagnostics';
    await panel.locator('summary').click();
    await browserExpect(panel.locator('.metric strong').first()).toHaveText('ok');
    const before = await application.evaluate(() =>
      (globalThis as unknown as { shell: DesktopShell }).shell.snapshot(),
    );
    stage = 'grant and export';
    await panel.getByRole('button', { name: 'Export diagnostics', exact: true }).click();
    await browserExpect(panel.getByRole('status')).toContainText('Exported');
    const text = await readFile(destination, 'utf8'),
      payload = JSON.parse(text);
    expect(payload).toMatchObject({
      format: 'axterm-diagnostics-v1',
      runtime: { database: 'ok', generation: before.generation },
    });
    expect(payload.logs.lines.length).toBeLessThanOrEqual(1000);
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(1024 * 1024);
    expect(text).not.toContain(home);
    expect(
      await application.evaluate(() => (globalThis as unknown as { choices: number }).choices),
    ).toBe(1);
    stage = 'collapse and reopen';
    await panel.locator('summary').click();
    await browserExpect(
      panel.getByRole('button', { name: 'Export diagnostics', exact: true }),
    ).toHaveCount(0);
    await panel.locator('summary').click();
    await browserExpect(panel.locator('.metric strong').first()).toHaveText('ok');
    expect(errors).toEqual([]);
    await application.evaluate(async () => {
      await (globalThis as unknown as { shell: DesktopShell }).shell.stop();
    });
  } catch (error) {
    await writeFile(
      'out/level3-migration/sdk/diagnostics-ui-diagnostic.json',
      JSON.stringify(
        {
          stage,
          errors,
          bodies: await Promise.all(
            application?.windows().map((p) =>
              p
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
