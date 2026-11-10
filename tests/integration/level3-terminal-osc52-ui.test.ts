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
it('handles actual PTY OSC52 output with bounded policies and an injected browser clipboard', async () => {
  const home = await mkdtemp(join(tmpdir(), 'axterm-terminal-osc52-')),
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
    await page.evaluate(() => {
      const probe = { writes: [] as string[], reads: 0 };
      (globalThis as unknown as { osc52Probe: typeof probe }).osc52Probe = probe;
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: {
          async writeText(text: string) {
            probe.writes.push(text);
          },
          async readText() {
            probe.reads++;
            return 'must stay local';
          },
        },
      });
    });
    await input.fill("printf '\\033]52;c;T1NDNTJfREVTS1RPUA==\\a\\122EADY_OSC52\\n'");
    await input.press('Enter');
    await browserExpect(canvas).toContainText('READY_OSC52');
    await browserExpect
      .poll(() =>
        page.evaluate(
          () => (globalThis as unknown as { osc52Probe: { writes: string[] } }).osc52Probe.writes,
        ),
      )
      .toEqual(['OSC52_DESKTOP']);
    await browserExpect(page.getByRole('alert')).toContainText(
      text['terminal.osc52WriteSucceeded'],
    );
    await input.fill("printf '\\033]52;c;?\\a'");
    await input.press('Enter');
    await browserExpect(page.getByRole('alert')).toContainText(text['terminal.osc52ReadDenied']);
    await input.fill("printf '\\033]52;c;/w==\\a'");
    await input.press('Enter');
    await browserExpect(page.getByRole('alert')).toContainText(text['terminal.osc52InvalidUtf8']);
    expect(
      await page.evaluate(
        () =>
          (globalThis as unknown as { osc52Probe: { reads: number; writes: string[] } }).osc52Probe,
      ),
    ).toEqual({ writes: ['OSC52_DESKTOP'], reads: 0 });
    await input.fill("printf '\\117SC52_ALIVE\\n'");
    await input.press('Enter');
    await browserExpect(canvas).toContainText('OSC52_ALIVE');
    expect(await page.locator('[data-terminal-channel=ready]').count()).toBe(1);
    expect(errors).toEqual([]);
    await application.evaluate(async () => {
      await (globalThis as unknown as { shell: DesktopShell }).shell.stop();
    });
  } catch (error) {
    await writeFile(
      'out/level3-migration/sdk/osc52-ui-diagnostic.json',
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
