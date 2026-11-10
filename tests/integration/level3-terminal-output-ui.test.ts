import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import {
  _electron as electron,
  expect as browserExpect,
  type ElectronApplication,
} from '@playwright/test';
import { expect, it } from 'vitest';
import { runProfile } from '../../apps/cli/src/profile-boot.ts';
import { PROFILE_TEMPLATES } from '../../apps/cli/src/profile-templates.ts';
import type TerminalController from '../../packages/plugins/terminals/src/index.ts';
import { createTerminalSchema } from '@axterm/plugin-api/terminals';
import type {} from '../../packages/infra/web-startup/src/index.ts';
it('renders actual GBK PTY bytes and raw ESC markers from the accepted terminal Profile', async () => {
  const home = await mkdtemp(join(tmpdir(), 'axterm-output-profile-'));
  let host: Awaited<ReturnType<typeof runProfile>> | undefined,
    browser: ElectronApplication | undefined;
  const errors: string[] = [];
  const previous = {
    HOME: process.env.HOME,
    ZDOTDIR: process.env.ZDOTDIR,
    SHELL: process.env.SHELL,
  };
  process.env.HOME = home;
  process.env.ZDOTDIR = home;
  process.env.SHELL = '/bin/bash';
  try {
    host = await runProfile({
      profile: 'web',
      home,
      installAnchor: resolve('apps/cli/package.json'),
      templates: PROFILE_TEMPLATES,
      patchFiles: [],
      args: [],
      requiredServices: ['terminalController', 'terminalFacts', 'webStartup', 'clientModules'],
      prepare(ctx) {
        ctx.provide('webAssets', {
          index: resolve('apps/web/dist/index.html'),
          authenticationPage: resolve('apps/web/dist/auth.html'),
        });
      },
    });
    const controller = host.ctx.get('terminalController') as TerminalController;
    const profile = controller.createTerminalProfile(randomUUID(), {
      name: 'GBK raw probe',
      encoding: 'gbk',
      displayRaw: true,
    });
    const session = await controller.createTerminal(
      host.ctx.runtimeIdentity.generation,
      randomUUID(),
      createTerminalSchema.parse({ kind: 'local', profileId: profile.ids[0]!, cols: 80, rows: 24 }),
      new AbortController().signal,
    );
    const token = (await readFile(host.ctx.webStartup.tokenFile!, 'utf8')).trim();
    await mkdir(join(home, 'browser'));
    const entry = join(home, 'browser.cjs');
    await writeFile(
      entry,
      `const {app,BrowserWindow}=require('electron');app.setPath('userData',${JSON.stringify(join(home, 'browser'))});app.whenReady().then(()=>{new BrowserWindow({show:false,width:1280,height:900,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false}}).loadURL(${JSON.stringify(host.ctx.webStartup.url)});});app.on('window-all-closed',()=>app.quit());`,
    );
    browser = await electron.launch({
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
    const page = await browser.firstWindow();
    page.setDefaultTimeout(7000);
    page.on('pageerror', (error) => errors.push(error.message.replaceAll(token, '[redacted]')));
    await page.locator('#credential').fill(token);
    await page.getByRole('button', { name: 'Connect', exact: true }).click();
    await page
      .locator('[data-workspace-global-tabs]')
      .getByRole('tab', { name: session.title, exact: true })
      .click();
    const terminal = page.locator(`[data-terminal-id="${session.id}"]`);
    await browserExpect(terminal).toHaveAttribute('data-terminal-channel', 'ready');
    await browserExpect(terminal).toHaveAttribute('data-encoding', 'gbk');
    await browserExpect(terminal).toHaveAttribute('data-display-raw', 'true');
    await browserExpect(page.getByTestId('runtime-state')).toHaveAttribute('data-state', 'ready');
    await page.locator('[data-runtime-details-trigger]').first().click();
    await browserExpect(page.getByTestId('runtime-generation')).toHaveText(
      host.ctx.runtimeIdentity.generation,
    );
    await page.keyboard.press('Escape');
    const carrier = await terminal.getAttribute('data-terminal-carrier');
    await page.locator('[data-runtime-reconnect]').click();
    await browserExpect(terminal).not.toHaveAttribute('data-terminal-carrier', carrier!);
    await browserExpect(terminal).toHaveAttribute('data-terminal-channel', 'ready');
    await browserExpect(page.getByTestId('runtime-state')).toHaveAttribute('data-state', 'ready');
    const input = terminal.locator('.xterm-helper-textarea');
    await input.fill(
      "printf '\\n\\326'; sleep 0.03; printf '\\320\\316\\304\\033[31mRAW\\033[0m\\n'",
    );
    await input.press('Enter');
    await browserExpect(
      terminal.locator('.xterm-rows > div').filter({ hasText: /^中文/ }),
    ).toHaveText('中文\\033[31mRAW\\033[0m');
    const canvas = terminal.locator('.terminal-canvas');
    const received = Number(await canvas.getAttribute('data-output-received-bytes'));
    await page.locator('select[aria-label="当前终端输出编码"]').selectOption('utf-8');
    await browserExpect(terminal).toHaveAttribute('data-encoding', 'utf-8');
    await input.fill("printf '\\nUTF_OVERRIDE_\\344\\270\\255\\346\\226\\207\\n'");
    await input.press('Enter');
    await browserExpect(terminal.locator('.xterm-rows')).toContainText('UTF_OVERRIDE_中文');
    expect(Number(await canvas.getAttribute('data-output-received-bytes'))).toBeGreaterThan(
      received,
    );
    await expect
      .poll(async () => Number(await canvas.getAttribute('data-output-pending-bytes')))
      .toBe(0);
    expect(await canvas.getAttribute('data-output-consumed-bytes')).toBe(
      await canvas.getAttribute('data-output-received-bytes'),
    );
    expect(controller.getTerminalSession(session.id).behavior.encoding).toBe('gbk');
    await page.reload();
    await browserExpect(terminal).toHaveAttribute('data-terminal-channel', 'ready');
    await browserExpect(terminal).toHaveAttribute('data-encoding', 'gbk');
    await browserExpect(
      terminal.locator('.xterm-rows > div').filter({ hasText: /^中文/ }),
    ).toHaveText('中文\\033[31mRAW\\033[0m');
    expect(errors).toEqual([]);
    await host.shutdown.shutdown(0);
    host = undefined;
    await browserExpect(page.getByTestId('runtime-state')).toHaveAttribute(
      'data-state',
      'degraded',
    );
    await browser.close();
    browser = undefined;
  } catch (error) {
    const page = browser?.windows()[0];
    await writeFile(
      'out/level3-migration/sdk/runtime-encoding-diagnostic.json',
      JSON.stringify(
        {
          errors,
          body: await page
            ?.locator('body')
            .innerText()
            .catch(() => '<unavailable>'),
          console: await page
            ?.consoleMessages()
            .then((messages) =>
              messages.map((message) => ({ type: message.type(), text: message.text() })),
            ),
        },
        null,
        2,
      ),
    );
    throw error;
  } finally {
    await browser?.close().catch(() => {});
    await host?.shutdown.shutdown(0);
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(home, { recursive: true, force: true });
  }
}, 15000);
