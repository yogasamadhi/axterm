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
it('retains one on-screen key bar, actual PTY bytes, application cursor keys and accepted preference refresh', async () => {
  const home = await mkdtemp(join(tmpdir(), 'axterm-terminal-keybar-')),
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
    const size = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
    await canvas.dispatchEvent('pointerdown', { pointerType: 'touch', pointerId: 1 });
    await page.setViewportSize({ width: size.width, height: size.height - 180 });
    const bar = page.getByRole('toolbar', { name: text['terminal.shortcutBar'], exact: true });
    await browserExpect(bar).toHaveCount(1);
    await browserExpect(bar).toBeVisible();
    const edit = bar.getByRole('button', { name: text['terminal.editShortcutBar'], exact: true });
    await edit.click();
    const dialog = page.getByRole('dialog', {
      name: text['terminal.shortcutEditorTitle'],
      exact: true,
    });
    await dialog
      .getByRole('combobox', { name: text['terminal.firstModifier'], exact: true })
      .selectOption('shift');
    await dialog
      .getByRole('combobox', { name: text['terminal.shortcutKey'], exact: true })
      .selectOption('key-a');
    await dialog.getByRole('button', { name: text['terminal.addShortcut'], exact: true }).click();
    await browserExpect(
      dialog.locator('.terminal-shortcut-active-item').filter({ hasText: 'Shift+A' }),
    ).toHaveCount(1);
    await dialog
      .getByRole('button', { name: text['terminal.closeShortcutEditor'], exact: true })
      .click();
    await browserExpect(edit).toBeFocused();
    await input.fill("printf '\\nKEYBAR_%s\\n' '");
    await bar.getByRole('button', { name: 'Shift+A', exact: true }).click();
    await browserExpect(bar).toHaveAttribute('data-last-send', 'accepted');
    await input.fill("'");
    await input.press('Enter');
    await browserExpect(canvas).toContainText('KEYBAR_A');
    await input.fill(
      "printf '\\033[?1h\\122EADY_KEYBAR_ARROW\\n'; read -rsn3 key; printf '\\nKEYBAR_ARROW:'; printf %s \"$key\" | od -An -tx1; printf '\\033[?1l'",
    );
    await input.press('Enter');
    await browserExpect(canvas).toContainText('READY_KEYBAR_ARROW');
    await bar.getByRole('button', { name: '↑', exact: true }).click();
    await browserExpect(canvas).toContainText('KEYBAR_ARROW: 1b 4f 41');
    await page.reload();
    await page.locator('[data-terminal-channel=ready]').waitFor();
    const refreshedSize = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
    await page
      .locator('.terminal-canvas')
      .first()
      .dispatchEvent('pointerdown', { pointerType: 'touch', pointerId: 2 });
    await page.setViewportSize({ width: refreshedSize.width, height: refreshedSize.height - 180 });
    await browserExpect(bar).toBeVisible();
    await browserExpect(bar.getByRole('button', { name: 'Shift+A', exact: true })).toHaveCount(1);
    expect(await page.locator('[data-terminal-channel=ready]').count()).toBe(1);
    expect(errors).toEqual([]);
    await application.evaluate(async () => {
      await (globalThis as unknown as { shell: DesktopShell }).shell.stop();
    });
  } catch (error) {
    await writeFile(
      'out/level3-migration/sdk/keybar-ui-diagnostic.json',
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
