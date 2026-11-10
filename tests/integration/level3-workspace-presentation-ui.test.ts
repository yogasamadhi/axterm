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
it('restores live tab selection and explicit CLI titles on reload while keeping independent native-window presentation records', async () => {
  const home = await mkdtemp(join(tmpdir(), 'axterm-workspace-presentation-')),
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
    const primaryId = await first.getAttribute('aria-controls');
    await application.evaluate(
      ({ app }, home) =>
        app.emit(
          'second-instance',
          {} as Electron.Event,
          ['local://terminal?title=Native%20Secondary'],
          home,
        ),
      home,
    );
    const secondary = page.getByRole('tab', { name: 'Native Secondary', exact: true });
    await secondary.waitFor();
    const secondaryId = await secondary.getAttribute('aria-controls');
    await first.click();
    await browserExpect(first).toHaveAttribute('aria-selected', 'true');
    await browserExpect(root).toHaveAttribute('data-workspace-presentation', 'ready');
    await page.reload();
    await browserExpect(
      page.getByRole('tab', { name: 'Native Primary', exact: true }),
    ).toHaveAttribute('aria-selected', 'true');
    await browserExpect(
      page.getByRole('tab', { name: 'Native Primary', exact: true }),
    ).toHaveAttribute('aria-controls', primaryId!);
    await browserExpect(
      page.getByRole('tab', { name: 'Native Secondary', exact: true }),
    ).toHaveAttribute('aria-controls', secondaryId!);
    expect(await page.locator('[data-workspace-global-tabs]').getByRole('tab').count()).toBe(2);
    const opened = application.waitForEvent('window');
    await application.evaluate(
      ({ app }, home) =>
        app.emit(
          'second-instance',
          {} as Electron.Event,
          ['--new-window', 'local://terminal?title=Other%20Window'],
          home,
        ),
      home,
    );
    const other = await opened;
    other.setDefaultTimeout(7000);
    other.on('pageerror', (error) => errors.push(error.message));
    const otherTab = other.getByRole('tab', { name: 'Other Window', exact: true });
    await browserExpect(otherTab).toHaveAttribute('aria-selected', 'true');
    await browserExpect(other.locator('[data-axterm-product-workspace]')).toHaveAttribute(
      'data-workspace-presentation',
      'ready',
    );
    await browserExpect(
      page.getByRole('tab', { name: 'Native Primary', exact: true }),
    ).toHaveAttribute('aria-selected', 'true');
    await other.reload();
    await browserExpect(
      other.getByRole('tab', { name: 'Other Window', exact: true }),
    ).toHaveAttribute('aria-selected', 'true');
    await browserExpect(
      page.getByRole('tab', { name: 'Native Primary', exact: true }),
    ).toHaveAttribute('aria-selected', 'true');
    expect(await other.locator('[data-workspace-global-tabs]').getByRole('tab').count()).toBe(3);
    expect(errors).toEqual([]);
  } catch (error) {
    await writeFile(
      'out/level3-migration/sdk/presentation-ui-diagnostic.json',
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
