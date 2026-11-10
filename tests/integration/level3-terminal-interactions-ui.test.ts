import { pressLevel3NativeShortcut } from '../support/level3-native-shortcut.ts';
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
it('retains actual PTY search, bounded regex feedback, selection and clear through the owned context menu', async () => {
  const home = await mkdtemp(join(tmpdir(), 'axterm-terminal-interactions-')),
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
    await input.fill("printf '\\nAXTERM_SEARCH_PROBE one\\nAXTERM_SEARCH_PROBE two\\n'");
    await input.press('Enter');
    await browserExpect(canvas).toContainText('AXTERM_SEARCH_PROBE two');
    await terminal.click({ button: 'right' });
    await page.getByRole('menuitem', { name: text['interaction.search'], exact: true }).click();
    const search = page.locator('.terminal-search'),
      query = search.locator('input');
    await browserExpect(query).toBeFocused();
    await search.getByRole('button', { name: text['terminal.searchRegex'], exact: true }).click();
    await query.fill('^AXTERM_SEARCH_PROBE (one|two)$');
    await browserExpect(search.locator('.terminal-search-count')).toHaveText(/[12]\/2/);
    await query.press('Enter');
    await browserExpect(search.locator('.terminal-search-count')).toHaveText(/[12]\/2/);
    await query.fill('(');
    await browserExpect(query).toHaveAttribute('aria-invalid', 'true');
    await browserExpect(search.locator('.terminal-search-result')).toHaveText(
      text['terminal.searchInvalidRegex'],
    );
    await query.press('Escape');
    await browserExpect(search).toHaveCount(0);
    await browserExpect(input).toBeFocused();
    await terminal.click({ button: 'right' });
    await page.getByRole('menuitem', { name: text['interaction.selectAll'], exact: true }).click();
    await terminal.click({ button: 'right' });
    await browserExpect(
      page.getByRole('menuitem', { name: text['interaction.copy'], exact: true }),
    ).toBeEnabled();
    await page.keyboard.press('Escape');
    const gate = join(home, 'normal-buffer-continue');
    await input.fill(
      `printf '\\nNORMAL_BUFFER_BEFORE\\n'; while [ ! -f '${gate}' ]; do sleep 0.05; done; printf '\\101FTER_NORMAL_BUFFER\\n'`,
    );
    await input.press('Enter');
    await terminal.click({ button: 'right' });
    await page.getByRole('menuitem', { name: text['terminal.normalBuffer'], exact: true }).click();
    const normal = terminal.locator('.terminal-normal-buffer'),
      snapshot = normal.locator('pre');
    await browserExpect(snapshot).toContainText('NORMAL_BUFFER_BEFORE');
    await browserExpect(snapshot).not.toContainText('AFTER_NORMAL_BUFFER');
    await browserExpect(
      normal.getByRole('button', { name: text['terminal.closeNormalBuffer'], exact: true }),
    ).toBeFocused();
    const originalSnapshot = await snapshot.textContent();
    await writeFile(gate, 'continue');
    await browserExpect(canvas).toContainText('AFTER_NORMAL_BUFFER');
    expect(await snapshot.textContent()).toBe(originalSnapshot);
    await browserExpect(
      normal.getByRole('button', { name: text['terminal.closeNormalBuffer'], exact: true }),
    ).toBeFocused();
    await page.keyboard.press('Escape');
    await browserExpect(normal).toHaveCount(0);
    await browserExpect(input).toBeFocused();
    await terminal.click({ button: 'right' });
    await page.getByRole('menuitem', { name: text['terminal.normalBuffer'], exact: true }).click();
    await browserExpect(snapshot).toContainText('AFTER_NORMAL_BUFFER');
    await normal
      .getByRole('button', { name: text['terminal.closeNormalBuffer'], exact: true })
      .click();
    await browserExpect(normal).toHaveCount(0);
    await browserExpect(input).toBeFocused();
    await terminal.click({ button: 'right' });
    await page.getByRole('menuitem', { name: text['interaction.clear'], exact: true }).click();
    await browserExpect(canvas).not.toContainText('AXTERM_SEARCH_PROBE');
    await pressLevel3NativeShortcut(application, page, 'F', [
      process.platform === 'darwin' ? 'meta' : 'control',
    ]);
    await browserExpect(query).toBeFocused();
    await query.press('Escape');
    expect(await page.locator('[data-terminal-channel=ready]').count()).toBe(1);
    expect(errors).toEqual([]);
  } catch (error) {
    await writeFile(
      'out/level3-migration/sdk/interactions-ui-diagnostic.json',
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
