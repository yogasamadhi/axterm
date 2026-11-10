import { openLevel3TabMenu } from '../support/level3-tab-actions.ts';
import { openLevel3Settings } from '../support/level3-workspace-actions.ts';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
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
it('streams an explicitly granted terminal log, presents local information and sends batch input through both live PTY views', async () => {
  const home = await mkdtemp(join(tmpdir(), 'axterm-terminal-tools-')),
    log = join(home, 'session.log'),
    errors: string[] = [];
  let application: ElectronApplication | undefined;
  try {
    await mkdir(join(home, 'desktop'));
    await writeFile(log, 'EXISTING_LOG\n');
    const entry = join(home, 'shell.mjs');
    await writeFile(
      entry,
      `import{app,protocol}from'electron';import{DesktopShell}from${JSON.stringify(pathToFileURL(resolve('apps/desktop/lib/shell/application.js')).href)};protocol.registerSchemesAsPrivileged([{scheme:'axterm-app',privileges:{standard:true,secure:true,supportFetchAPI:true,corsEnabled:true,stream:true}}]);app.setPath('userData',${JSON.stringify(join(home, 'desktop'))});app.whenReady().then(()=>{globalThis.shell=new DesktopShell({home:${JSON.stringify(home)},webRoot:${JSON.stringify(resolve('apps/web/dist'))},hostEntry:${JSON.stringify(resolve('apps/desktop-host/lib/index.js'))},preload:${JSON.stringify(resolve('apps/desktop/lib/shell/preload.cjs'))},environment:{...process.env},visible:true,fileChooser:()=>({async choose(kind,signal){signal.throwIfAborted();if(kind!=='save-file')throw Error('Unexpected chooser');return ${JSON.stringify(log)};},defaultDirectory(){return ${JSON.stringify(home)};},retire(){}}),confirmQuit:async()=>true,recover:async()=> 'quit'});globalThis.shell.start();app.emit('second-instance',{},['-tp','local','--title','Tools Primary'],${JSON.stringify(home)});});`,
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
    await page.locator('[data-terminal-channel=ready]').waitFor();
    await openLevel3Settings(page);
    await page.getByTestId('application-language').click();
    await page.getByRole('option', { name: 'English', exact: true }).click();
    await page.locator('[data-section-close=left]').click();
    const terminal = page.locator('[data-terminal-id]').first(),
      source = await terminal.getAttribute('data-terminal-id');
    if (!source) throw Error('Missing source');
    const input = terminal.locator('.xterm-helper-textarea');
    await input.fill("printf 'BEFORE_RECORDING\\n'");
    await input.press('Enter');
    await browserExpect(terminal.locator('.terminal-canvas')).toContainText('BEFORE_RECORDING');
    await openLevel3TabMenu(page, source);
    await page.locator('[data-recording-action=save]').click();
    await browserExpect(terminal).toHaveAttribute('data-recording', 'true');
    await input.fill("printf 'DURING_RECORDING\\n'");
    await input.press('Enter');
    await browserExpect.poll(() => readFile(log, 'utf8')).toContain('DURING_RECORDING');
    expect(await readFile(log, 'utf8')).toMatch(/^EXISTING_LOG\n/);
    expect(await readFile(log, 'utf8')).toContain('BEFORE_RECORDING');
    await terminal.locator('.terminal-recording-indicator').click();
    await browserExpect(terminal).toHaveAttribute('data-recording', 'false');
    const recorded = await readFile(log, 'utf8');
    await input.fill("printf 'AFTER_RECORDING\\n'");
    await input.press('Enter');
    await browserExpect(terminal.locator('.terminal-canvas')).toContainText('AFTER_RECORDING');
    expect(await readFile(log, 'utf8')).toBe(recorded);
    await page.locator('[data-terminal-information-toggle]').click();
    const panel = page.locator('.terminal-information-panel');
    await browserExpect(panel.locator('[data-information-group=sysinfo]')).toContainText(
      process.platform === 'darwin' ? 'darwin' : process.platform,
    );
    await page.getByRole('button', { name: 'Close terminal information', exact: true }).click();
    await openLevel3TabMenu(page, source);
    await page.locator('[data-session-action=duplicate]').click();
    await browserExpect(page.locator('[data-terminal-id]')).toHaveCount(2);
    await browserExpect(page.locator('[data-terminal-channel=ready]')).toHaveCount(2);
    await page.getByRole('button', { name: 'Batch input', exact: true }).click();
    const batch = page.locator('.batch-input-panel');
    await batch.getByRole('button', { name: 'Select all', exact: true }).click();
    await batch
      .getByRole('textbox', { name: 'Batch command', exact: true })
      .fill("printf '\\102\\101\\124\\103\\110\\137\\124\\127\\117\\n'");
    await batch.locator('footer button').click();
    for (const view of await page.locator('[data-terminal-id]').all()) {
      const id = await view.getAttribute('data-terminal-id');
      await page.locator(`[id="workspace-tab-global-${id}"]`).click();
      await browserExpect(view.locator('.terminal-canvas')).toContainText('BATCH_TWO');
    }
    await openLevel3Settings(page);
    await page.locator('[data-settings-category=terminal]').click();
    const preferences = page.locator('.terminal-recovery-settings-panel');
    const restore = preferences.getByRole('checkbox', {
      name: 'Restore screen and working directory when reloading SSH',
      exact: true,
    });
    await restore.click();
    await browserExpect(restore).toBeChecked();
    await page.locator('[data-section-close=left]').click();
    await page.reload();
    await page.locator('[data-terminal-channel=ready]').first().waitFor();
    await openLevel3Settings(page);
    await page.locator('[data-settings-category=terminal]').click();
    await browserExpect(
      page.locator('.terminal-recovery-settings-panel').getByRole('checkbox', {
        name: 'Restore screen and working directory when reloading SSH',
        exact: true,
      }),
    ).toBeChecked();
    await page.locator('[data-section-close=left]').click();
    expect(errors).toEqual([]);
    await application.evaluate(async () => {
      await (globalThis as unknown as { shell: DesktopShell }).shell.stop();
    });
  } catch (error) {
    await writeFile(
      'out/level3-migration/sdk/tools-ui-diagnostic.json',
      JSON.stringify(
        {
          errors,
          log: await readFile(log, 'utf8').catch(() => '<missing>'),
          body: await application
            ?.windows()[0]
            ?.locator('body')
            .innerText()
            .catch(() => '<unavailable>'),
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
