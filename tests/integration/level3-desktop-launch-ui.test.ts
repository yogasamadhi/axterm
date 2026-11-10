import { mkdtemp, mkdir, writeFile, rm, readFile, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import {
  _electron as electron,
  expect as browserExpect,
  type ElectronApplication,
} from '@playwright/test';
import { expect, it } from 'vitest';
import type { DesktopShell } from '../../apps/desktop/src/shell/application.ts';
interface Harness {
  shell: DesktopShell;
}
it('delivers cold CLI cwd/title, consumes once across reload, and targets second-instance new-window and open-url launches', async () => {
  const home = await mkdtemp(join(tmpdir(), 'axterm-native-launch-ui-')),
    directory = join(home, 'incoming');
  let app: ElectronApplication | undefined;
  const errors: string[] = [];
  try {
    await mkdir(directory);
    await mkdir(join(home, 'desktop'));
    const entry = join(home, 'shell.mjs');
    await writeFile(
      entry,
      `import{app,protocol}from'electron';import{DesktopShell}from${JSON.stringify(pathToFileURL(resolve('apps/desktop/lib/shell/application.js')).href)};protocol.registerSchemesAsPrivileged([{scheme:'axterm-app',privileges:{standard:true,secure:true,supportFetchAPI:true,corsEnabled:true,stream:true}}]);app.setPath('userData',${JSON.stringify(join(home, 'desktop'))});app.whenReady().then(()=>{globalThis.shell=new DesktopShell({home:${JSON.stringify(home)},webRoot:${JSON.stringify(resolve('apps/web/dist'))},hostEntry:${JSON.stringify(resolve('apps/desktop-host/lib/index.js'))},preload:${JSON.stringify(resolve('apps/desktop/lib/shell/preload.cjs'))},environment:{...process.env},visible:false,recover:async()=> 'quit'});globalThis.nativeLaunchCalls=0;globalThis.nativeLaunchErrors=[];const take=globalThis.shell.launches.next.bind(globalThis.shell.launches);globalThis.shell.launches.next=(...args)=>{globalThis.nativeLaunchCalls++;return take(...args).catch(error=>{globalThis.nativeLaunchErrors.push(error.code??error.name);throw error;});};globalThis.shell.start();globalThis.shell.receiveArguments(${JSON.stringify(['-tp', 'local', '-d', directory, '--title', 'Native CLI'])});});`,
    );
    app = await electron.launch({
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
    const page = await app.firstWindow();
    page.setDefaultTimeout(8000);
    page.on('pageerror', (error) => errors.push(error.message));
    await page.locator('[data-axterm-product-workspace]').waitFor();
    await page.getByRole('tab', { name: 'Native CLI', exact: true }).waitFor();
    await page.locator('[data-terminal-channel=ready]').waitFor();
    const terminal = page.locator('[data-terminal-id]');
    const marker = join(directory, 'native-cwd.txt');
    const quoted = "'" + marker.replaceAll("'", "'\\''") + "'";
    await terminal.locator('textarea').fill('pwd > ' + quoted);
    await terminal.locator('textarea').press('Enter');
    await expect
      .poll(() =>
        readFile(marker, 'utf8')
          .then((text) => text.trim())
          .catch(() => ''),
      )
      .toBe(await realpath(directory));
    expect(await page.locator('[data-workspace-global-tabs]').getByRole('tab').count()).toBe(1);
    await page.reload();
    await page.locator('[data-workspace-global-tabs]').getByRole('tab').first().click();
    await page.locator('[data-terminal-channel=ready]').waitFor();
    expect(await page.locator('[data-workspace-global-tabs]').getByRole('tab').count()).toBe(1);
    const activeBefore = await page
      .locator('[data-workspace-global-tabs]')
      .getByRole('tab', { selected: true })
      .getAttribute('aria-controls');
    const opened = app.waitForEvent('window');
    await app.evaluate(({ app }, cwd) => {
      app.emit(
        'second-instance',
        {} as Electron.Event,
        ['--new-window', 'local://terminal?title=Second%20window'],
        cwd,
      );
    }, home);
    const second = await opened;
    second.setDefaultTimeout(8000);
    second.on('pageerror', (error) => errors.push(error.message));
    await second.getByRole('tab', { name: 'Second window', exact: true }).waitFor();
    expect(await page.getByRole('tab', { name: 'Second window', exact: true }).count()).toBe(0);
    expect(
      await page
        .locator('[data-workspace-global-tabs]')
        .getByRole('tab', { selected: true })
        .getAttribute('aria-controls'),
    ).toBe(activeBefore);
    await second.locator('[data-terminal-channel=ready]:visible').waitFor();
    await app.evaluate(({ app }) => {
      app.emit(
        'open-url',
        { preventDefault() {} } as Electron.Event,
        'axterm://terminal?type=local&title=Native%20deep%20link',
      );
    });
    // Native delivery uses a bounded 1s long poll; use the same 8s UI admission deadline.
    await expect
      .poll(
        async () =>
          (await page.getByRole('tab', { name: 'Native deep link', exact: true }).count()) +
          (await second.getByRole('tab', { name: 'Native deep link', exact: true }).count()),
        { timeout: 8000 },
      )
      .toBe(1);
    await browserExpect(page.locator('body')).not.toContainText('Failed to load plugins');
    expect(errors).toEqual([]);
  } catch (error) {
    await writeFile(
      'out/level3-migration/sdk/desktop-launch-ui-diagnostic.json',
      JSON.stringify(
        {
          errors,
          native: await app
            ?.evaluate(() => {
              const state = globalThis as unknown as {
                shell: {
                  launches: { resourceCount(): number };
                  windowIdentities: Map<unknown, { id: string }>;
                };
                nativeLaunchCalls: number;
                nativeLaunchErrors: string[];
              };
              return {
                calls: state.nativeLaunchCalls,
                errors: state.nativeLaunchErrors,
                resources: state.shell.launches.resourceCount(),
                windows: state.shell.windowIdentities.size,
              };
            })
            .catch(() => undefined),
          pages: await Promise.all(
            (app?.windows() ?? []).map((page) =>
              page
                .locator('body')
                .innerText()
                .catch(() => '<closed>'),
            ),
          ),
        },
        null,
        2,
      ),
    );
    throw error;
  } finally {
    if (app) {
      await app
        .evaluate(async () => {
          await (globalThis as unknown as Harness).shell.stop();
        })
        .catch(() => {});
      await app.close();
    }
    await rm(home, { recursive: true, force: true });
  }
}, 35000);
