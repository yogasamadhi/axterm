import { openLevel3TabMenu } from '../support/level3-tab-actions.ts';
import { interactionDictionaries } from '../../packages/plugins/terminals/src/client/interactions/locales.ts';
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
it('clones, actually disconnects/recreates and retains exited PTY output across Desktop refresh', async () => {
  const home = await mkdtemp(join(tmpdir(), 'axterm-terminal-session-')),
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
    const lang = await page.locator('html').getAttribute('lang'),
      text =
        interactionDictionaries[lang as keyof typeof interactionDictionaries] ??
        interactionDictionaries.en;
    const input = page.locator('.xterm-helper-textarea').first();
    const sourceId = await terminal.getAttribute('data-terminal-id');
    if (!sourceId) throw Error('Missing source session');
    await input.evaluate((element) => {
      element.dataset.sessionProbe = 'original-view';
    });
    await input.fill("printf '\\123ESSION_OLD_OUTPUT\\n'");
    await input.press('Enter');
    await browserExpect(canvas).toContainText('SESSION_OLD_OUTPUT');
    const menu = async (id: string) => {
      await openLevel3TabMenu(page, id);
    };
    await menu(sourceId);
    await page.locator('[data-session-action="clone-pane"]').click();
    await page.locator('.terminal-grid-c2').waitFor();
    await browserExpect(page.locator('[data-terminal-channel="ready"]')).toHaveCount(2);
    await browserExpect(input).toHaveAttribute('data-session-probe', 'original-view');
    const cloneId = await page
      .locator(`[data-terminal-id]:not([data-terminal-id="${sourceId}"])`)
      .getAttribute('data-terminal-id');
    if (!cloneId) throw Error('Missing clone session');
    await page.locator(`[id="workspace-tab-global-${sourceId}"]`).click();
    await menu(sourceId);
    await page.locator('[data-session-action="disconnect"]').click();
    await browserExpect(terminal).toHaveAttribute('data-terminal-channel', 'closed');
    await browserExpect(canvas).toContainText('SESSION_OLD_OUTPUT');
    await terminal
      .getByRole('button', { name: text['terminal.reconnectNow'], exact: true })
      .click();
    await browserExpect(page.locator(`[data-terminal-id="${sourceId}"]`)).toHaveCount(0);
    const replacement = page.locator(`[data-terminal-id]:not([data-terminal-id="${cloneId}"])`);
    await browserExpect(replacement).toHaveAttribute('data-terminal-channel', 'ready');
    const replacementId = await replacement.getAttribute('data-terminal-id');
    if (!replacementId) throw Error('Missing replacement session');
    const nextInput = replacement.locator('.xterm-helper-textarea');
    await nextInput.fill("printf '\\116EW_SESSION_OK\\n'");
    await nextInput.press('Enter');
    await browserExpect(replacement.locator('.terminal-canvas')).toContainText('NEW_SESSION_OK');
    await browserExpect(replacement.locator('.terminal-canvas')).not.toContainText(
      'SESSION_OLD_OUTPUT',
    );
    await nextInput.fill("printf '\\116ATURAL_EXIT_OUTPUT\\n'; exit 7");
    await nextInput.press('Enter');
    await browserExpect(replacement).toHaveAttribute('data-terminal-channel', 'closed');
    await browserExpect(replacement.locator('.terminal-canvas')).toContainText(
      'NATURAL_EXIT_OUTPUT',
    );
    await page.reload();
    await browserExpect(root).toHaveAttribute('data-workspace-presentation', 'ready');
    await page.locator(`[id="workspace-tab-global-${replacementId}"]`).click();
    const retained = page.locator(`[data-terminal-id="${replacementId}"]`);
    await browserExpect(retained).toHaveAttribute('data-terminal-channel', 'closed');
    await browserExpect(retained.locator('.terminal-canvas')).toContainText('NATURAL_EXIT_OUTPUT');
    expect(await page.locator('[data-terminal-channel=ready]').count()).toBe(1);
    expect(errors).toEqual([]);
    await application.evaluate(async () => {
      await (globalThis as unknown as { shell: DesktopShell }).shell.stop();
    });
  } catch (error) {
    await writeFile(
      'out/level3-migration/sdk/session-ui-diagnostic.json',
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
