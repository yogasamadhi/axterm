import {
  openSettingsSync,
  openWidgets,
  openNewBookmark,
  openTunnelsWorkspace,
  openFilesWorkspace,
  openTerminalThemes,
  openQuickCommandsWorkspace,
} from './settings-workspace-navigation';
import { createHash, generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { _electron as electron, expect, test, type Locator, type Page } from '@playwright/test';
import {
  DEFAULT_TERMINAL_BACKGROUND,
  connectionProfileInputSchema,
  terminalProfileInputSchema,
  triggerRuleInputSchema,
  tunnelProfileInputSchema,
} from '../../packages/contracts/src';
import type * as Ssh2Module from 'ssh2';
import type { Connection as SshServerConnection } from 'ssh2';
import { ConnectionHistoryRepository } from '../../packages/runtime/src/adapters/sqlite/connection-history-repository';
import { ProductDatabase } from '../../packages/runtime/src/adapters/sqlite/database';
import {
  ProductRepository,
  etagFor,
  stableHash,
} from '../../packages/runtime/src/adapters/sqlite/product-repository';
import { ConnectionProfileRepository } from '../../packages/runtime/src/adapters/sqlite/connection-profile-repository';
import { BookmarkRepository } from '../../packages/runtime/src/adapters/sqlite/bookmark-repository';
import { QuickCommandRepository } from '../../packages/runtime/src/adapters/sqlite/quick-command-repository';
import { TerminalThemeRepository } from '../../packages/runtime/src/adapters/sqlite/terminal-theme-repository';
import { BatchOperationRepository } from '../../packages/runtime/src/adapters/sqlite/batch-operation-repository';
import { TriggerRepository } from '../../packages/runtime/src/adapters/sqlite/trigger-repository';
import { AXTERM_TERMINAL_THEMES } from '../../packages/shared/src/terminal-theme-presets';
import { launchLocalOptimizationApp } from '../fixtures/local-optimization-launch';
import { selectAiSkill } from './ai-skill-picker';
import { DEFAULT_DESKTOP_WINDOW_PREFERENCES } from '../../apps/desktop/src/main/host-capabilities/window-preferences';
import { canonicalManifestRecord } from '../../apps/desktop/src/main/host-capabilities/signed-release-updater';

async function readDirectoryFiles(directory: string): Promise<Buffer[]> {
  const contents: Buffer[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) contents.push(...(await readDirectoryFiles(path)));
    else if (entry.isFile()) contents.push(await readFile(path));
  }
  return contents;
}

const require = createRequire(resolve('apps/desktop/package.json'));
const runtimeRequire = createRequire(resolve('packages/runtime/package.json'));
const { Client: SshClient, Server: SshServer, utils } = runtimeRequire('ssh2') as typeof Ssh2Module;
interface TestFtpClient {
  access(input: { host: string; port: number; user: string; password: string }): Promise<unknown>;
  list(): Promise<Array<{ name: string }>>;
  close(): void;
}
const { Client: FtpClient } = runtimeRequire('basic-ftp') as {
  Client: new (timeout?: number) => TestFtpClient;
};
const executablePath = require('electron') as string;
const sshFixturePort = Number(process.env.AXTERM_SSH_FIXTURE_PORT ?? 0);

test('refreshing an opening workspace cancels navigation without a startup error', async () => {
  const userData = await mkdtemp(resolve(tmpdir(), 'axterm-workspace-refresh-'));
  const app = await launchLocalOptimizationApp({
    executablePath,
    args: [resolve('apps/desktop'), `--user-data-dir=${userData}`],
    env: { ...process.env, ELECTRON_RENDERER_URL: '' },
  });
  try {
    const originalPage = await app.firstWindow();
    await expect(originalPage.getByTestId('runtime-state')).toHaveAttribute('data-state', 'ready');
    const nextWindow = app.waitForEvent('window');
    await app.evaluate(({ app, dialog, session }) => {
      const probe = { dialogs: [] as string[], failures: [] as number[], reloadFailed: false };
      (
        globalThis as typeof globalThis & { workspaceRefreshProbe: typeof probe }
      ).workspaceRefreshProbe = probe;
      // Capture native errors so a regression fails the assertion instead of
      // blocking the test and the user's desktop with a modal dialog.
      dialog.showErrorBox = (title) => {
        probe.dialogs.push(title);
      };
      app.once('browser-window-created', (_event, window) => {
        const load = window.loadURL.bind(window);
        window.loadURL = (url, options) =>
          load(url, options).catch((error: { errno: number }) => {
            probe.failures.push(error.errno);
            throw error;
          });
        let heldRequest: ((response: { cancel: boolean }) => void) | undefined;
        let intercepted = false;
        session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
          if (
            details.webContentsId === window.webContents.id &&
            details.resourceType === 'mainFrame'
          ) {
            if (!intercepted) {
              intercepted = true;
              heldRequest = callback;
              // Delay the first request so Chromium must replace an unfinished
              // load, regardless of how quickly the local Runtime serves HTML.
              setImmediate(() => {
                void window.webContents.loadURL(details.url).catch(() => {
                  probe.reloadFailed = true;
                });
              });
              return;
            }
            heldRequest?.({ cancel: false });
            heldRequest = undefined;
          }
          callback({ cancel: false });
        });
      });
      app.emit('second-instance', {} as never, ['--new-window'], process.cwd(), {} as never);
    });
    const page = await nextWindow;
    await app.evaluate(({ session }) => session.defaultSession.webRequest.onBeforeRequest(null));
    await expect(page.getByTestId('runtime-state')).toHaveAttribute('data-state', 'ready');
    await expect(page.locator('.terminal-host')).toHaveAttribute(
      'data-connection-state',
      'connected',
    );
    const probe = await app.evaluate(
      () =>
        (
          globalThis as typeof globalThis & {
            workspaceRefreshProbe: { dialogs: string[]; failures: number[]; reloadFailed: boolean };
          }
        ).workspaceRefreshProbe,
    );
    expect(probe.failures).toContain(-3);
    expect(probe.dialogs).toEqual([]);
    expect(probe.reloadFailed).toBe(false);
    await expect(originalPage.getByTestId('runtime-state')).toHaveAttribute('data-state', 'ready');
  } finally {
    await app.close();
    await rm(userData, { recursive: true, force: true });
  }
});

test('OP02 command palette executes a keyboard selection and reaches sessions, files, transfers and saved workspaces', async () => {
  const userData = await mkdtemp(resolve(tmpdir(), 'axterm-palette-keyboard-'));
  const app = await launchLocalOptimizationApp({
    executablePath,
    args: [resolve('apps/desktop'), `--user-data-dir=${userData}`],
    env: { ...process.env, ELECTRON_RENDERER_URL: '' },
  });
  try {
    const page = await app.firstWindow();
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await expect(page.getByTestId('runtime-state')).toHaveAttribute('data-state', 'ready');
    const tabs = page.locator('.pane-tabbar .terminal-tab');
    const terminalInput = page.locator(
      '.terminal-session-layer:not([hidden]) .xterm-helper-textarea',
    );
    await expect(
      page.locator('.terminal-session-layer:not([hidden]) .terminal-host'),
    ).toHaveAttribute('data-connection-state', 'connected');
    const originalId = await tabs.first().getAttribute('data-terminal-id');
    let created = 0;
    page.on('request', (request) => {
      if (request.method() === 'POST' && new URL(request.url()).pathname.endsWith('/terminals'))
        created += 1;
    });
    const open = process.platform === 'darwin' ? 'Meta+k' : 'Control+k';
    await terminalInput.focus();
    await page.keyboard.press(open);
    const palette = page.getByRole('dialog', { name: '命令面板', exact: true });
    const search = palette.getByRole('combobox');
    await expect(search).toBeFocused();
    await expect(palette.getByRole('option').first()).toHaveAttribute(
      'data-palette-id',
      'shortcut:app_closeCurrentTab',
    );
    for (let index = 0; index < 6; index += 1) await search.press('ArrowDown');
    await search.press('ArrowUp');
    await expect(palette.getByRole('option', { selected: true })).toHaveAttribute(
      'data-palette-id',
      'shortcut:app_newBookmark',
    );
    await search.press('ArrowDown');
    await expect(palette.getByRole('option', { selected: true })).toHaveAttribute(
      'data-palette-id',
      'shortcut:app_newTab',
    );
    await search.press('Enter');
    await expect(palette).toBeHidden();
    await expect(tabs).toHaveCount(2);
    await expect(page.locator(`.terminal-tab[data-terminal-id="${originalId}"]`)).toBeVisible();
    expect(created).toBe(1);
    await expect(
      page.locator('.terminal-session-layer:not([hidden]) .terminal-host'),
    ).toHaveAttribute('data-connection-state', 'connected');
    await terminalInput.focus();
    await page.keyboard.press(open);
    await expect(palette.getByRole('option').first()).toHaveAttribute(
      'data-palette-id',
      'shortcut:app_newTab',
    );
    await search.fill('新建本地终端');
    await expect(palette.getByRole('option')).toHaveCount(1);
    await expect(palette.getByRole('option').locator('kbd')).toContainText('Q');
    for (const key of ['Enter', 'Escape']) {
      await search.evaluate(
        (element, value) =>
          element.dispatchEvent(
            new KeyboardEvent('keydown', { key: value, bubbles: true, isComposing: true }),
          ),
        key,
      );
      await expect(palette).toBeVisible();
      expect(created).toBe(1);
    }
    await search.press('Alt+Q');
    expect(created).toBe(1);
    await search.press('Escape');
    await expect(terminalInput).toBeFocused();
    await page.keyboard.press('Alt+Q');
    await expect(tabs).toHaveCount(3);
    expect(created).toBe(2);
    await page.keyboard.press(open);
    await search.fill('切换会话');
    await palette.locator(`[data-palette-id="session:${originalId}"]`).click();
    await expect(page.locator('.terminal-tab.active')).toHaveAttribute(
      'data-terminal-id',
      originalId!,
    );

    await page.getByTitle('布局与工作区').click();
    await page.locator('.layout-menu').getByRole('button', { name: '工作区', exact: true }).click();
    await page.getByPlaceholder('工作区名称').fill('OP02 workspace');
    await page
      .locator('.workspace-menu form')
      .getByRole('button', { name: '保存', exact: true })
      .click();
    await expect(page.locator('.workspace-list-menu').getByText('OP02 workspace')).toBeVisible();
    await page.keyboard.press('Escape');
    await page.keyboard.press('Alt+Q');
    await expect(tabs).toHaveCount(4);
    await page.keyboard.press(open);
    await search.fill('OP02 workspace');
    await palette.getByRole('option', { name: '切换工作区：OP02 workspace', exact: true }).click();
    await expect(tabs).toHaveCount(3);
    await page.keyboard.press(open);
    await search.fill('传输中心');
    await palette.locator('[data-palette-id="transfer-center"]').click();
    await expect(page.getByRole('complementary', { name: '传输中心', exact: true })).toBeVisible();
    await page.keyboard.press('Escape');
    await page.keyboard.press(open);
    await search.fill('File transfer');
    await palette.locator('[data-palette-id="section:files"]').click();
    await expect(page.getByRole('region', { name: '本地文件', exact: true })).toBeVisible();
    await expect(page.getByRole('tab', { name: '文件管理', exact: true })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await page.keyboard.press(open);
    await search.fill('zz-no-matching-command');
    await expect(palette.getByRole('option')).toHaveCount(0);
    await expect(palette.getByRole('status')).toContainText('没有匹配的命令');
    await search.press('Enter');
    await expect(palette).toBeVisible();
    await search.press('Escape');
    while (await tabs.count()) {
      const count = await tabs.count();
      await page.locator('.terminal-pane.active .tab-close-active').click();
      await expect(tabs).toHaveCount(count - 1);
    }
    await page.keyboard.press(open);
    await search.fill('Close current tab');
    const unavailable = palette.locator('[data-palette-id="shortcut:app_closeCurrentTab"]');
    await expect(unavailable).toHaveAttribute('aria-disabled', 'true');
    await expect(palette).toContainText('需要可用的终端会话');
    const before = created;
    await search.press('Enter');
    await expect(palette).toBeVisible();
    expect(created).toBe(before);
    await search.press('Tab');
    await expect(palette.getByRole('button', { name: '关闭', exact: true })).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(search).toBeFocused();
    await search.press('Escape');
    expect(errors).toEqual([]);
  } finally {
    await app.close().catch(() => {});
    await rm(userData, { recursive: true, force: true });
  }
});

test('OP02 command palette searches four languages and remains bounded at three viewports and 200% zoom', async () => {
  test.setTimeout(90_000);
  const userData = await mkdtemp(resolve(tmpdir(), 'axterm-palette-languages-'));
  const app = await launchLocalOptimizationApp({
    executablePath,
    args: [resolve('apps/desktop'), `--user-data-dir=${userData}`],
    env: { ...process.env, ELECTRON_RENDERER_URL: '' },
  });
  try {
    await app.context().addInitScript({ path: require.resolve('axe-core/axe.min.js') });
    const page = await app.firstWindow();
    await expect(page.getByTestId('runtime-state')).toHaveAttribute('data-state', 'ready');
    await page.locator('[data-activity-item="setting"]').click();
    await page.locator('[data-settings-category="common"]').click();
    const language = page.getByTestId('application-language');
    const cases = [
      { id: 'en', title: 'Command palette', query: 'New local terminal' },
      { id: 'zh-CN', title: '命令面板', query: '新建本地终端' },
      { id: 'zh-TW', title: '命令面板', query: '新增本機終端機' },
      { id: 'ja', title: 'コマンドパレット', query: '新しいローカルターミナル' },
    ];
    for (const locale of cases) {
      await language.selectOption(locale.id);
      await expect(page.locator('html')).toHaveAttribute('lang', locale.id);
      for (const viewport of [
        { width: 1280, height: 800 },
        { width: 1440, height: 900 },
        { width: 1920, height: 1080 },
      ]) {
        await page.setViewportSize(viewport);
        for (const zoom of [1, 2]) {
          await app.evaluate(
            ({ BrowserWindow }, value) =>
              BrowserWindow.getAllWindows()[0]?.webContents.setZoomFactor(value),
            zoom,
          );
          await language.focus();
          await page.keyboard.press(process.platform === 'darwin' ? 'Meta+k' : 'Control+k');
          const palette = page.getByRole('dialog', { name: locale.title, exact: true });
          const search = palette.getByRole('combobox');
          await expect(search).toBeFocused();
          expect(
            await palette.evaluate((element) => {
              const bounds = element.getBoundingClientRect();
              return (
                bounds.left >= 0 &&
                bounds.top >= 0 &&
                bounds.right <= innerWidth &&
                bounds.bottom <= innerHeight
              );
            }),
          ).toBe(true);
          if (viewport.width === 1280) {
            await page.screenshot({
              path: test.info().outputPath(`palette-all-${locale.id}-zoom${zoom}.png`),
            });
          }
          if (viewport.width === 1280 && zoom === 1) {
            const violations = await palette.evaluate(async (element) => {
              const axe = (
                globalThis as typeof globalThis & {
                  axe: {
                    run(
                      context: Element,
                      options: unknown,
                    ): Promise<{
                      violations: Array<{ id: string; nodes: Array<{ target: string[] }> }>;
                    }>;
                  };
                }
              ).axe;
              const result = await axe.run(element, {
                runOnly: {
                  type: 'tag',
                  values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'],
                },
              });
              return result.violations.map(({ id, nodes }) => ({
                id,
                targets: nodes.map(({ target }) => target),
              }));
            });
            expect(violations).toEqual([]);
          }
          await search.fill(locale.query);
          await expect(palette.getByRole('option')).toHaveCount(1);
          await expect(palette.getByRole('option')).toHaveText(/Q/);
          expect(
            await palette.evaluate((element) => {
              const bounds = element.getBoundingClientRect();
              const close = element.querySelector('.palette-close')!.getBoundingClientRect();
              return (
                bounds.left >= 0 &&
                bounds.top >= 0 &&
                bounds.right <= innerWidth &&
                bounds.bottom <= innerHeight &&
                close.left >= bounds.left &&
                close.right <= bounds.right
              );
            }),
          ).toBe(true);
          await page.screenshot({
            path: test.info().outputPath(`palette-${locale.id}-${viewport.width}-zoom${zoom}.png`),
          });
          await search.press('Escape');
          await expect(language).toBeFocused();
        }
      }
      await app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()[0]?.webContents.setZoomFactor(1),
      );
    }
  } finally {
    await app.close().catch(() => {});
    await rm(userData, { recursive: true, force: true });
  }
});

test('OP02 command palette connects a real SSH host and preserves unknown and changed Host Key confirmation', async () => {
  test.setTimeout(90_000);
  const firstKey = utils.generateKeyPairSync('ecdsa', { bits: 256 }).private;
  const replacementKey = utils.generateKeyPairSync('ecdsa', { bits: 256 }).private;
  let fixture = await startReconnectSshFixture(firstKey);
  const port = fixture.port;
  const userData = await mkdtemp(resolve(tmpdir(), 'axterm-palette-ssh-'));
  let app: Awaited<ReturnType<typeof electron.launch>> | undefined;
  try {
    const database = await ProductDatabase.open(resolve(userData, 'data-v2', 'axterm.sqlite'));
    try {
      new ProductRepository(database).createHost({
        name: 'Palette actual SSH',
        hostname: '127.0.0.1',
        port,
        username: 'operator',
        authType: 'agent',
        sshAgent: { enabled: false, path: null },
      });
    } finally {
      database.close();
    }
    app = await launchLocalOptimizationApp({
      executablePath,
      args: [resolve('apps/desktop'), `--user-data-dir=${userData}`],
      env: { ...process.env, ELECTRON_RENDERER_URL: '' },
    });
    const page = await app.firstWindow();
    await expect(page.getByTestId('runtime-state')).toHaveAttribute('data-state', 'ready');
    const connect = async () => {
      await page.keyboard.press(process.platform === 'darwin' ? 'Meta+k' : 'Control+k');
      const palette = page.getByRole('dialog', { name: '命令面板', exact: true });
      await palette.getByRole('combobox').fill('Palette actual SSH');
      await palette.getByRole('option', { name: /连接：Palette actual SSH/ }).click();
      await expect(palette).toBeHidden();
    };
    await connect();
    const unknown = page.getByRole('dialog', { name: '首次连接此主机', exact: true });
    await expect(unknown.locator('[data-interaction-kind="unknownHostKey"]')).toBeVisible();
    await expect(
      page.locator('.terminal-session-layer:not([hidden]) .xterm-rows'),
    ).not.toContainText('D04_NETWORK_FIXTURE_READY');
    await unknown.getByRole('button', { name: '信任并连接', exact: true }).click();
    const activeTab = page.locator('.pane-tabbar .terminal-tab.active');
    await expect(activeTab).toHaveAttribute('data-terminal-id', /.+/);
    const firstTerminalId = await activeTab.getAttribute('data-terminal-id');
    const rows = page.locator('.terminal-session-layer:not([hidden]) .xterm-rows');
    await expect.poll(() => rows.textContent()).toContain('D04_NETWORK_FIXTURE_READY');
    const input = page.locator('.terminal-session-layer:not([hidden]) .xterm-helper-textarea');
    await input.pressSequentially('OP02_NETWORK_INPUT');
    await input.press('Enter');
    await expect.poll(() => fixture.receivedText()).toContain('OP02_NETWORK_INPUT');
    await fixture.stop();
    await expect(
      page.locator('.terminal-session-layer:not([hidden]) .terminal-reconnect-overlay'),
    ).toBeVisible();
    expect(fixture.connectionCount()).toBe(0);
    fixture = await startReconnectSshFixture(replacementKey, port);
    await connect();
    const changed = page.locator('.host-key-interaction-modal.changed');
    await expect(changed.locator('[data-interaction-kind="changedHostKey"]')).toBeVisible();
    await expect(changed.locator('[role="alert"]')).toBeVisible();
    const confirmation = changed.locator('input[name="remember"]');
    await expect(confirmation).not.toBeChecked();
    const replace = changed.getByRole('button', { name: '替换密钥并连接', exact: true });
    await replace.click();
    await expect(changed).toBeVisible();
    await expect(confirmation).toHaveAttribute('aria-invalid', 'true');
    await confirmation.check();
    await replace.click();
    await expect(changed).toBeHidden();
    // The disconnected terminal retains its output. Wait for the newly opened session
    // before treating the fixture's identical ready marker as new connection evidence.
    await expect(activeTab).not.toHaveAttribute('data-terminal-id', firstTerminalId!);
    await expect(
      page.locator('.terminal-session-layer:not([hidden]) .terminal-host'),
    ).toHaveAttribute('data-connection-state', 'connected');
    await expect.poll(() => rows.textContent()).toContain('D04_NETWORK_FIXTURE_READY');
    await input.pressSequentially('OP02_CHANGED_KEY_INPUT');
    await input.press('Enter');
    await expect.poll(() => fixture.receivedText()).toContain('OP02_CHANGED_KEY_INPUT');
    await app.close();
    app = undefined;
    const parsed = utils.parseKey(replacementKey);
    if (parsed instanceof Error || Array.isArray(parsed))
      throw new Error('Invalid palette fixture key');
    const fingerprint = `SHA256:${createHash('sha256').update(parsed.getPublicSSH()).digest('base64').replace(/=+$/u, '')}`;
    const saved = await ProductDatabase.open(resolve(userData, 'data-v2', 'axterm.sqlite'));
    try {
      expect(new ProductRepository(saved).getKnownHostKey('127.0.0.1', port)?.fingerprint).toBe(
        fingerprint,
      );
    } finally {
      saved.close();
    }
  } finally {
    await app?.close().catch(() => {});
    await fixture.stop();
    await rm(userData, { recursive: true, force: true });
  }
});

test('Windows Ctrl+C copies a selection, interrupts without one, and double press interrupts', async () => {
  test.skip(process.platform !== 'win32', 'The Windows terminal keyboard behavior is under test.');
  const userData = await mkdtemp(resolve(tmpdir(), 'axterm-ctrl-c-e2e-'));
  const app = await electron.launch({
    executablePath,
    args: [resolve('apps/desktop'), `--user-data-dir=${userData}`],
    env: { ...process.env, ELECTRON_RENDERER_URL: '' },
  });
  try {
    const page = await app.firstWindow();
    await expect(page.getByTestId('runtime-state')).toHaveAttribute('data-state', 'ready');
    const layer = page.locator('.terminal-session-layer:not([hidden])');
    await expect(layer.locator('.terminal-host')).toHaveAttribute(
      'data-connection-state',
      'connected',
    );
    const input = layer.locator('.xterm-helper-textarea');
    const rows = layer.locator('.xterm-rows');
    await input.pressSequentially("Write-Output 'AXTERM_CTRL_C_COPY_MARKER'");
    await input.press('Enter');
    await expect.poll(() => rows.textContent()).toContain('AXTERM_CTRL_C_COPY_MARKER');
    await layer.locator('.terminal-host').click({ button: 'right', position: { x: 100, y: 100 } });
    await page
      .getByRole('menu', { name: '终端菜单' })
      .getByRole('menuitem', { name: '全选' })
      .click();
    await page.keyboard.press('Control+c');
    await expect
      .poll(() => app.evaluate(({ clipboard }) => clipboard.readText()))
      .toContain('AXTERM_CTRL_C_COPY_MARKER');
    await app.evaluate(({ clipboard }) => clipboard.writeText('COPY_ALIAS_SENTINEL'));
    await page.keyboard.press('Control+Shift+c');
    await expect
      .poll(() => app.evaluate(({ clipboard }) => clipboard.readText()))
      .toContain('AXTERM_CTRL_C_COPY_MARKER');

    const started = resolve(userData, 'sleep-started.txt');
    const afterInterrupt = resolve(userData, 'after-interrupt.txt');
    await input.pressSequentially(
      `Set-Content -LiteralPath '${started}' -Value 'started'; Start-Sleep -Seconds 20`,
    );
    await input.press('Enter');
    await expect.poll(() => readFile(started, 'utf8').catch(() => '')).toContain('started');
    await app.evaluate(({ clipboard }) => clipboard.writeText('NO_SELECTION_SENTINEL'));
    await input.press('Control+c');
    expect(await app.evaluate(({ clipboard }) => clipboard.readText())).toBe(
      'NO_SELECTION_SENTINEL',
    );
    // PowerShell/PSReadLine can discard the first keystroke while redrawing after ^C.
    await page.waitForTimeout(300);
    await input.pressSequentially(`Set-Content -LiteralPath '${afterInterrupt}' -Value 'resumed'`);
    await input.press('Enter');
    await expect.poll(() => readFile(afterInterrupt, 'utf8').catch(() => '')).toContain('resumed');

    const doubleStarted = resolve(userData, 'double-started.txt');
    const afterDouble = resolve(userData, 'after-double.txt');
    await input.pressSequentially(
      `Set-Content -LiteralPath '${doubleStarted}' -Value 'started'; Start-Sleep -Seconds 20`,
    );
    await input.press('Enter');
    await expect.poll(() => readFile(doubleStarted, 'utf8').catch(() => '')).toContain('started');
    await layer.locator('.terminal-host').click({ button: 'right', position: { x: 100, y: 100 } });
    await page
      .getByRole('menu', { name: '终端菜单' })
      .getByRole('menuitem', { name: '全选' })
      .click();
    await app.evaluate(({ clipboard }) => clipboard.writeText('DOUBLE_PRESS_SENTINEL'));
    await page.keyboard.down('Control');
    await page.keyboard.press('c');
    await page.keyboard.press('c');
    await page.keyboard.up('Control');
    await expect
      .poll(() => app.evaluate(({ clipboard }) => clipboard.readText()))
      .toContain('Start-Sleep -Seconds 20');
    await page.waitForTimeout(300);
    await input.pressSequentially(`Set-Content -LiteralPath '${afterDouble}' -Value 'resumed'`);
    await input.press('Enter');
    await expect.poll(() => readFile(afterDouble, 'utf8').catch(() => '')).toContain('resumed');
  } finally {
    await app.close().catch(() => {});
    await rm(userData, { recursive: true, force: true });
  }
});

test('Windows terminal pastes with Ctrl+V and keeps Ctrl+Shift+V working', async () => {
  test.skip(process.platform !== 'win32', 'The Windows terminal keyboard behavior is under test.');
  const userData = await mkdtemp(resolve(tmpdir(), 'axterm-ctrl-v-e2e-'));
  const app = await electron.launch({
    executablePath,
    args: [resolve('apps/desktop'), `--user-data-dir=${userData}`],
    env: { ...process.env, ELECTRON_RENDERER_URL: '' },
  });
  try {
    const page = await app.firstWindow();
    await expect(page.getByTestId('runtime-state')).toHaveAttribute('data-state', 'ready');
    const layer = page.locator('.terminal-session-layer:not([hidden])');
    await expect(layer.locator('.terminal-host')).toHaveAttribute(
      'data-connection-state',
      'connected',
    );
    const input = layer.locator('.xterm-helper-textarea');
    for (const [chord, filename] of [
      ['Control+v', 'ctrl-v.txt'],
      ['Control+Shift+v', 'ctrl-shift-v.txt'],
    ] as const) {
      const output = resolve(userData, filename);
      await app.evaluate(
        ({ clipboard }, command) => clipboard.writeText(command),
        `Set-Content -LiteralPath '${output}' -Value '${filename}'`,
      );
      await input.press(chord);
      await expect.poll(() => layer.locator('.xterm-rows').textContent()).toContain(filename);
      await input.press('Enter');
      await expect.poll(() => readFile(output, 'utf8').catch(() => '')).toContain(filename);
    }
  } finally {
    await app.close().catch(() => {});
    await rm(userData, { recursive: true, force: true });
  }
});

test('Windows paste confirmation focuses Confirm so Enter pastes and Escape still cancels', async () => {
  test.skip(process.platform !== 'win32', 'The Windows paste dialog behavior is under test.');
  const userData = await mkdtemp(resolve(tmpdir(), 'axterm-paste-confirm-focus-e2e-'));
  const app = await electron.launch({
    executablePath,
    args: [resolve('apps/desktop'), `--user-data-dir=${userData}`],
    env: { ...process.env, ELECTRON_RENDERER_URL: '' },
  });
  try {
    const page = await app.firstWindow();
    await expect(page.getByTestId('runtime-state')).toHaveAttribute('data-state', 'ready');
    const layer = page.locator('.terminal-session-layer:not([hidden])');
    await expect(layer.locator('.terminal-host')).toHaveAttribute(
      'data-connection-state',
      'connected',
    );
    await app.evaluate(({ clipboard }) =>
      clipboard.writeText("Write-Output 'AXTERM_PASTE_ONE'\nWrite-Output 'AXTERM_PASTE_TWO'"),
    );
    const input = layer.locator('.xterm-helper-textarea');
    const dialog = page.getByRole('dialog', { name: '确认粘贴到终端' });
    const confirm = dialog.getByRole('button', { name: '确认粘贴' });

    await input.press('Control+v');
    await expect(confirm).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(layer.locator('.terminal-action-feedback')).toHaveText('已取消粘贴。');

    await input.press('Control+v');
    await expect(confirm).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(dialog).toHaveCount(0);
    await expect(layer.locator('.terminal-action-feedback')).toHaveText('剪贴板内容已发送到终端。');
  } finally {
    await app.close().catch(() => {});
    await rm(userData, { recursive: true, force: true });
  }
});

test('first and later multiline pastes in a new PowerShell tab wait for Enter', async () => {
  test.skip(process.platform !== 'win32', 'The Windows PowerShell startup behavior is under test.');
  const userData = await mkdtemp(resolve(tmpdir(), 'axterm-first-multiline-paste-e2e-'));
  const app = await electron.launch({
    executablePath,
    args: [resolve('apps/desktop'), `--user-data-dir=${userData}`],
    env: { ...process.env, ELECTRON_RENDERER_URL: '' },
  });
  try {
    const page = await app.firstWindow();
    await expect(page.getByTestId('runtime-state')).toHaveAttribute('data-state', 'ready');
    const first = resolve(userData, 'first-paste-line.txt');
    const second = resolve(userData, 'second-paste-line.txt');
    await app.evaluate(
      ({ clipboard }, value) => clipboard.writeText(value),
      `Set-Content -LiteralPath '${first}' -Value 'first'\r\nSet-Content -LiteralPath '${second}' -Value 'second'`,
    );
    const previousTerminalId = await page
      .locator('.terminal-session-layer:not([hidden])')
      .getAttribute('data-terminal-session');
    await page.locator('.terminal-pane.active .tab-add').click();
    await expect(page.locator('.terminal-pane.active .terminal-tab')).toHaveCount(2);
    const layer = page.locator('.terminal-session-layer:not([hidden])');
    await expect(layer).not.toHaveAttribute('data-terminal-session', previousTerminalId!);
    const input = layer.locator('.xterm-helper-textarea');
    await input.press('Control+v');
    const dialog = page.getByRole('dialog', { name: '确认粘贴到终端' });
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: '确认粘贴' }).click();
    await expect(layer.locator('.terminal-action-feedback')).toHaveText('剪贴板内容已发送到终端。');
    await page.waitForTimeout(5_000);
    expect(await readFile(first, 'utf8').catch(() => undefined)).toBeUndefined();
    expect(await readFile(second, 'utf8').catch(() => undefined)).toBeUndefined();
    await input.press('Enter');
    await expect.poll(() => readFile(first, 'utf8').catch(() => '')).toContain('first');
    await expect.poll(() => readFile(second, 'utf8').catch(() => '')).toContain('second');

    const later = resolve(userData, 'later-paste-line.txt');
    await app.evaluate(
      ({ clipboard }, value) => clipboard.writeText(value),
      `Set-Content -LiteralPath '${later}' -Value 'later'\r\nWrite-Output 'SECOND_PASTE_READY'`,
    );
    await input.press('Control+v');
    await dialog.getByRole('button', { name: '确认粘贴' }).click();
    await expect(layer.locator('.terminal-action-feedback')).toHaveText('剪贴板内容已发送到终端。');
    expect(await readFile(later, 'utf8').catch(() => undefined)).toBeUndefined();
    await input.press('Enter');
    await expect.poll(() => readFile(later, 'utf8').catch(() => '')).toContain('later');
  } finally {
    await app.close().catch(() => {});
    await rm(userData, { recursive: true, force: true });
  }
});

test('Windows CMD profile still accepts multiline paste without bracketed-paste support', async () => {
  test.skip(process.platform !== 'win32', 'The Windows CMD fallback is under test.');
  const userData = await mkdtemp(resolve(tmpdir(), 'axterm-cmd-multiline-paste-e2e-'));
  const app = await electron.launch({
    executablePath,
    args: [resolve('apps/desktop'), `--user-data-dir=${userData}`],
    env: { ...process.env, ELECTRON_RENDERER_URL: '' },
  });
  try {
    const page = await app.firstWindow();
    await expect(page.getByTestId('runtime-state')).toHaveAttribute('data-state', 'ready');
    await expect(
      page.locator('.terminal-session-layer:not([hidden]) .terminal-host'),
    ).toHaveAttribute('data-connection-state', 'connected');
    await page.locator('[data-activity-item="setting"]').click();
    await page.locator('[data-settings-category="terminal"]').click();
    const profileForm = page
      .locator('form')
      .filter({ has: page.getByRole('heading', { name: '终端配置' }) });
    await profileForm.getByLabel('名称').fill('CMD paste test');
    await profileForm.getByLabel('Shell', { exact: true }).fill('cmd.exe');
    await profileForm.getByRole('button', { name: '保存终端配置' }).click();
    await page.getByLabel('全局默认终端配置').selectOption({ label: 'CMD paste test' });
    await page.getByRole('button', { name: '关闭设置并返回工作区' }).click();

    const previousId = await page
      .locator('.terminal-session-layer:not([hidden])')
      .getAttribute('data-terminal-session');
    await page.getByTitle('新建会话菜单', { exact: true }).click();
    await page
      .locator('.session-menu')
      .getByRole('button', { name: /本地终端/ })
      .click();
    await expect(page.locator('.workspace-tab.terminal-tab')).toHaveCount(2);
    const layer = page.locator('.terminal-session-layer:not([hidden])');
    await expect(layer).not.toHaveAttribute('data-terminal-session', previousId!);
    const first = resolve(userData, 'cmd-first.txt');
    const second = resolve(userData, 'cmd-second.txt');
    await app.evaluate(
      ({ clipboard }, value) => clipboard.writeText(value),
      `echo first > "${first}"\r\necho second > "${second}"`,
    );
    const input = layer.locator('.xterm-helper-textarea');
    await input.press('Control+v');
    await page
      .getByRole('dialog', { name: '确认粘贴到终端' })
      .getByRole('button', { name: '确认粘贴' })
      .click();
    await expect(layer.locator('.terminal-action-feedback')).toHaveText(
      '剪贴板内容已发送到终端。',
      { timeout: 5_000 },
    );
    await expect.poll(() => readFile(first, 'utf8').catch(() => '')).toContain('first');
    await input.press('Enter');
    await expect.poll(() => readFile(second, 'utf8').catch(() => '')).toContain('second');
  } finally {
    await app.close().catch(() => {});
    await rm(userData, { recursive: true, force: true });
  }
});

test('SSH first multiline paste uses a hidden startup bracket mode and older shells still receive paste', async () => {
  test.skip(process.platform !== 'win32', 'The Windows SSH paste regression is under test.');
  test.setTimeout(60_000);
  const userData = await mkdtemp(resolve(tmpdir(), 'axterm-ssh-paste-fallback-e2e-'));
  const hostKey = utils.generateKeyPairSync('ed25519').private;
  const parsedHostKey = utils.parseKey(hostKey);
  if (parsedHostKey instanceof Error || Array.isArray(parsedHostKey))
    throw new Error('SSH paste fixture generated an invalid host key');
  const publicKey = parsedHostKey.getPublicSSH();
  const fingerprint = `SHA256:${createHash('sha256')
    .update(publicKey)
    .digest('base64')
    .replace(/=+$/u, '')}`;
  const fixture = await startReconnectSshFixture(hostKey);
  const bracketedFixture = await startReconnectSshFixture(hostKey, 0, true);
  await mkdir(resolve(userData, 'data-v2'), { recursive: true });
  const database = await ProductDatabase.open(resolve(userData, 'data-v2', 'axterm.sqlite'));
  try {
    const products = new ProductRepository(database);
    const bookmarks = new BookmarkRepository(database);
    for (const [name, server] of [
      ['SSH paste startup', bracketedFixture],
      ['SSH paste fallback', fixture],
    ] as const) {
      const host = products.createHost({
        name,
        hostname: '127.0.0.1',
        port: server.port,
        username: 'operator',
        authType: 'agent',
        sshAgent: { enabled: false, path: null },
      });
      products.saveKnownHostKey({
        host: host.hostname,
        port: host.port,
        algorithm: parsedHostKey.type,
        fingerprint,
        publicKey: publicKey.toString('base64'),
      });
      bookmarks.createBookmark(
        {
          groupId: null,
          protocol: 'ssh',
          hostId: host.id,
          title: host.name,
          color: null,
          description: 'SSH paste startup fixture',
          profileId: null,
          connectionProfileId: null,
          quickCommands: [],
          triggers: [],
          ftp: null,
          telnet: null,
          serial: null,
          rdp: null,
          vnc: null,
          spice: null,
          web: null,
        },
        bookmarks.snapshot().etag,
      );
    }
  } finally {
    database.close();
  }

  const packaged = process.env.AXTERM_SSH_PASTE_PACKAGED === '1';
  const app = await electron.launch({
    executablePath: packaged ? resolve('release/win-unpacked/Axterm.exe') : executablePath,
    args: packaged
      ? [`--user-data-dir=${userData}`]
      : [resolve('apps/desktop'), `--user-data-dir=${userData}`],
    env: { ...process.env, ELECTRON_RENDERER_URL: '' },
  });
  try {
    const page = await app.firstWindow();
    await expect(page.getByTestId('runtime-state')).toHaveAttribute('data-state', 'ready');
    await page.locator('[data-activity-item="bookmarks"]').click();
    await page.locator('[data-bookmark-title="SSH paste startup"] .bookmark-row-main').click();
    await expect(page.locator('.terminal-pane.active .terminal-tab.active .tab-title')).toHaveText(
      'SSH paste startup',
    );
    let layer = page.locator('.terminal-session-layer:not([hidden])');
    await expect(layer.locator('.terminal-host')).toHaveAttribute(
      'data-connection-state',
      'connected',
    );
    await app.evaluate(({ clipboard }) =>
      clipboard.writeText('echo SSH_FIRST_BLOCK\necho SSH_SECOND_BLOCK'),
    );
    await layer.locator('.xterm-helper-textarea').press('Control+v');
    await page
      .getByRole('dialog', { name: '确认粘贴到终端' })
      .getByRole('button', { name: '确认粘贴' })
      .click();
    await expect.poll(() => bracketedFixture.receivedText()).toContain('AXTERM_SHELL_INTEGRATION');
    bracketedFixture.releaseIntegration();
    await expect
      .poll(() => bracketedFixture.receivedText(), { timeout: 15_000 })
      .toContain('SSH_SECOND_BLOCK');
    await expect(layer.locator('.terminal-surface')).toHaveAttribute(
      'data-command-tracking',
      'active',
    );
    expect(bracketedFixture.receivedText()).toContain('\u001b[200~echo SSH_FIRST_BLOCK');
    expect(bracketedFixture.receivedText()).toContain('SSH_SECOND_BLOCK\u001b[201~');

    await page.locator('[data-bookmark-title="SSH paste fallback"] .bookmark-row-main').click();
    await expect(page.locator('.terminal-pane.active .terminal-tab.active .tab-title')).toHaveText(
      'SSH paste fallback',
    );
    layer = page.locator('.terminal-session-layer:not([hidden])');
    await expect(layer.locator('.terminal-host')).toHaveAttribute(
      'data-connection-state',
      'connected',
    );
    await expect(layer.locator('.xterm-rows')).toContainText('D04_NETWORK_FIXTURE_READY');
    await app.evaluate(({ clipboard }) =>
      clipboard.writeText('echo SSH_PASTE_FIRST\necho SSH_PASTE_SECOND'),
    );
    await layer.locator('.xterm-helper-textarea').press('Control+v');
    await page
      .getByRole('dialog', { name: '确认粘贴到终端' })
      .getByRole('button', { name: '确认粘贴' })
      .click();
    await expect(layer.locator('.terminal-action-feedback')).toHaveText(
      '剪贴板内容已发送到终端。',
      { timeout: 8_000 },
    );
    await expect.poll(() => fixture.receivedText()).toContain('SSH_PASTE_FIRST');
    await expect.poll(() => fixture.receivedText()).toContain('SSH_PASTE_SECOND');
  } finally {
    await app.close().catch(() => {});
    await fixture.stop().catch(() => {});
    await bracketedFixture.stop().catch(() => {});
    await rm(userData, { recursive: true, force: true });
  }
});

test('active terminal tab has a distinct background and accent that follow the selection', async () => {
  const userData = await mkdtemp(resolve(tmpdir(), 'axterm-active-tab-color-e2e-'));
  const app = await electron.launch({
    executablePath,
    args: [resolve('apps/desktop'), `--user-data-dir=${userData}`],
    env: { ...process.env, ELECTRON_RENDERER_URL: '' },
  });
  try {
    const page = await app.firstWindow();
    await expect(page.getByTestId('runtime-state')).toHaveAttribute('data-state', 'ready');
    await page.locator('.terminal-pane.active .tab-add').click();
    const tabs = page.locator('.terminal-pane.active .terminal-tab');
    await expect(tabs).toHaveCount(2);

    const tabAppearance = () =>
      tabs.evaluateAll((elements) =>
        elements.map((element) => {
          const style = getComputedStyle(element);
          const canvas = document.createElement('canvas');
          canvas.width = canvas.height = 1;
          const context = canvas.getContext('2d')!;
          context.fillStyle = style.backgroundColor;
          context.fillRect(0, 0, 1, 1);
          const [red, green, blue] = context.getImageData(0, 0, 1, 1).data;
          const accentChannels = style.boxShadow.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
          return {
            brightness: red! * 0.2126 + green! * 0.7152 + blue! * 0.0722,
            colorSpread: Math.max(red!, green!, blue!) - Math.min(red!, green!, blue!),
            accent: style.boxShadow,
            accentSpread: accentChannels
              ? Math.max(...accentChannels.slice(1, 4).map(Number)) -
                Math.min(...accentChannels.slice(1, 4).map(Number))
              : null,
          };
        }),
      );

    await expect(tabs.nth(1)).toHaveClass(/active/);
    let appearance = await tabAppearance();
    expect(appearance[1]!.brightness - appearance[0]!.brightness).toBeGreaterThan(55);
    expect(appearance[1]!.colorSpread).toBeLessThanOrEqual(3);
    expect(appearance[1]!.accent).toContain('inset');
    expect(appearance[1]!.accentSpread).toBeLessThanOrEqual(3);
    expect(appearance[0]!.accent).toBe('none');

    await tabs.first().click();
    await expect(tabs.first()).toHaveClass(/active/);
    appearance = await tabAppearance();
    expect(appearance[0]!.brightness - appearance[1]!.brightness).toBeGreaterThan(55);
    expect(appearance[0]!.colorSpread).toBeLessThanOrEqual(3);
    expect(appearance[0]!.accent).toContain('inset');
    expect(appearance[0]!.accentSpread).toBeLessThanOrEqual(3);
    expect(appearance[1]!.accent).toBe('none');
  } finally {
    await app.close().catch(() => {});
    await rm(userData, { recursive: true, force: true });
  }
});

test('embedded file browser fills the pane and renders more rows when the window grows', async () => {
  const userData = await mkdtemp(resolve(tmpdir(), 'axterm-file-pane-height-e2e-'));
  const browseDirectory = resolve(userData, 'many-files');
  await mkdir(browseDirectory);
  await Promise.all(
    Array.from({ length: 80 }, (_, index) =>
      writeFile(resolve(browseDirectory, `file-${String(index).padStart(3, '0')}.txt`), ''),
    ),
  );
  const app = await electron.launch({
    executablePath,
    args: [resolve('apps/desktop'), `--user-data-dir=${userData}`],
    env: { ...process.env, ELECTRON_RENDERER_URL: '' },
  });
  try {
    await app.evaluate(({ dialog }, directory) => {
      Object.defineProperty(dialog, 'showOpenDialog', {
        configurable: true,
        value: async () => ({ canceled: false, filePaths: [directory] }),
      });
    }, browseDirectory);
    const page = await app.firstWindow();
    await expect(page.getByTestId('runtime-state')).toHaveAttribute('data-state', 'ready');
    await page
      .getByRole('tablist', { name: '会话工具' })
      .getByRole('tab', { name: '文件管理' })
      .click();
    const pane = page.locator('.terminal-file-session-layer:not([hidden]) .file-pane-local');
    await expect(pane).toBeVisible();
    await pane.getByRole('button', { name: '更换目录' }).click();
    await expect(pane.getByLabel('本地绝对路径')).toHaveValue(browseDirectory);
    const scroll = pane.locator('.file-table-scroll');
    const visibleRows = () => pane.locator('.file-data-row').count();

    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(1200, 700));
    const compactHeight = await scroll.evaluate((element) => element.clientHeight);
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(1200, 900));
    await expect
      .poll(() => scroll.evaluate((element) => element.clientHeight))
      .toBeGreaterThan(compactHeight + 150);
    const expandedHeight = await scroll.evaluate((element) => element.clientHeight);
    expect(expandedHeight).toBeGreaterThan(400);
    await expect.poll(visibleRows).toBeGreaterThan(20);
    const bottomGap = await pane.evaluate((element) => {
      const scrollRect = element.querySelector('.file-table-scroll')!.getBoundingClientRect();
      return element.getBoundingClientRect().bottom - scrollRect.bottom;
    });
    expect(bottomGap).toBeLessThan(50);
  } finally {
    await app.close().catch(() => {});
    await rm(userData, { recursive: true, force: true });
  }
});

test('empty space after terminal tabs is a safe window drag region', async () => {
  test.skip(process.platform !== 'win32', 'The Windows custom title bar is under test.');
  const userData = await mkdtemp(resolve(tmpdir(), 'axterm-window-drag-space-e2e-'));
  const app = await electron.launch({
    executablePath,
    args: [resolve('apps/desktop'), `--user-data-dir=${userData}`],
    env: { ...process.env, ELECTRON_RENDERER_URL: '' },
  });
  try {
    const page = await app.firstWindow();
    await expect(page.getByTestId('runtime-state')).toHaveAttribute('data-state', 'ready');
    await app.evaluate(({ BrowserWindow, screen }) => {
      const workArea = screen.getPrimaryDisplay().workArea;
      BrowserWindow.getAllWindows()[0]!.setBounds({
        x: workArea.x + 100,
        y: workArea.y + 100,
        width: Math.min(1_300, workArea.width - 200),
        height: Math.min(800, workArea.height - 200),
      });
    });
    await expect(page.locator('.terminal-pane.active .terminal-tab')).toHaveCount(1);
    const dragSpace = page.locator('.terminal-pane.active .pane-tabbar-drag-space');
    await expect(dragSpace).toBeVisible({ timeout: 2_000 });
    await expect(dragSpace).toHaveCSS('-webkit-app-region', 'drag');
    const regions = await page.evaluate(() => {
      const space = document.querySelector('.terminal-pane.active .pane-tabbar-drag-space');
      const controls = document.querySelector('.terminal-workspace > .tabbar');
      const close = document.querySelector('[data-window-action="close"]');
      if (!space || !controls || !close) throw new Error('Missing title-bar region');
      const blank = space.getBoundingClientRect();
      const actions = controls.getBoundingClientRect();
      const closeButton = close.getBoundingClientRect();
      const x = blank.left + blank.width / 2;
      const y = blank.top + blank.height / 2;
      return {
        blankWidth: blank.width,
        blankRight: blank.right,
        controlsLeft: actions.left,
        hitIsBlank: document.elementFromPoint(x, y) === space,
        closeRegion: getComputedStyle(close).getPropertyValue('-webkit-app-region'),
        closeHitsButton: close.contains(
          document.elementFromPoint(
            closeButton.left + closeButton.width / 2,
            closeButton.top + closeButton.height / 2,
          ),
        ),
      };
    });
    expect(regions.blankWidth).toBeGreaterThan(100);
    expect(regions.blankRight).toBeLessThanOrEqual(regions.controlsLeft + 1);
    expect(regions.hitIsBlank).toBe(true);
    expect(regions.closeRegion).toBe('no-drag');
    expect(regions.closeHitsButton).toBe(true);

    await app.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0]!;
      window.setBounds({ ...window.getBounds(), width: 800 });
    });
    for (let index = 0; index < 4; index++)
      await page.locator('.terminal-pane.active .tab-add').click();
    await expect(page.locator('.terminal-pane.active .terminal-tab')).toHaveCount(5);
    const overflow = page.getByTestId('pane-1-tab-overflow');
    await expect(overflow).toBeVisible();
    const scroll = page.locator('.terminal-pane.active .pane-tabbar-scroll');
    const stripRight = await scroll.evaluate((element) => element.getBoundingClientRect().right);
    const controlsLeft = await page
      .locator('.terminal-workspace > .tabbar')
      .evaluate((element) => element.getBoundingClientRect().left);
    expect(stripRight).toBeLessThanOrEqual(controlsLeft + 1);
    const beforeScroll = await scroll.evaluate((element) => element.scrollLeft);
    await overflow.getByTitle('窗格 1 向右滚动标签').click();
    await expect
      .poll(() => scroll.evaluate((element) => element.scrollLeft))
      .toBeGreaterThan(beforeScroll);
  } finally {
    await app.close().catch(() => {});
    await rm(userData, { recursive: true, force: true });
  }
});

test('Linux close control remains clickable beside terminal tabs', async () => {
  test.skip(process.platform !== 'linux', 'The Linux custom title bar is under test.');
  const userData = await mkdtemp(resolve(tmpdir(), 'axterm-linux-window-close-e2e-'));
  const app = await electron.launch({
    executablePath,
    args: [resolve('apps/desktop'), `--user-data-dir=${userData}`],
    env: { ...process.env, ELECTRON_RENDERER_URL: '' },
  });
  try {
    const page = await app.firstWindow();
    await expect(page.getByTestId('runtime-state')).toHaveAttribute('data-state', 'ready');
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]!.setBounds({ x: 100, y: 100, width: 800, height: 700 }),
    );
    for (let index = 0; index < 4; index++) {
      await page
        .locator('.terminal-pane.active .tab-add')
        .evaluate((button: HTMLButtonElement) => button.click());
      await expect(page.locator('.terminal-pane.active .terminal-tab')).toHaveCount(index + 2);
    }
    await expect(page.locator('.terminal-pane.active .terminal-tab')).toHaveCount(5);

    const controls = page.locator('.terminal-workspace > .tabbar');
    const scroll = page.locator('.terminal-pane.active .pane-tabbar-scroll');
    const close = page.locator('[data-window-action="close"]');
    const geometry = await page.evaluate(() => {
      const controls = document.querySelector('.terminal-workspace > .tabbar');
      const scroll = document.querySelector('.terminal-pane.active .pane-tabbar-scroll');
      const close = document.querySelector('[data-window-action="close"]');
      if (!controls || !scroll || !close) throw new Error('Missing Linux title-bar control');
      const rect = close.getBoundingClientRect();
      return {
        controlsLeft: controls.getBoundingClientRect().left,
        scrollRight: scroll.getBoundingClientRect().right,
        closeHit: close.contains(
          document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2),
        ),
      };
    });
    expect(geometry.scrollRight).toBeLessThanOrEqual(geometry.controlsLeft + 1);
    expect(geometry.closeHit).toBe(true);
    await expect(controls).toHaveCSS('-webkit-app-region', 'no-drag');
    await expect(scroll).toHaveCSS('-webkit-app-region', 'drag');
    const restingBackground = await close.evaluate(
      (button) => getComputedStyle(button).backgroundColor,
    );
    await close.hover();
    await expect
      .poll(() => close.evaluate((button) => getComputedStyle(button).backgroundColor))
      .not.toBe(restingBackground);
    await close.click();
    const confirmation = page.getByRole('alertdialog');
    await expect(confirmation).toBeVisible();
    await confirmation.getByRole('button', { name: '取消' }).click();
    expect(page.isClosed()).toBe(false);
  } finally {
    await app.close().catch(() => {});
    await rm(userData, { recursive: true, force: true });
  }
});

test('window close button closes one terminal without a prompt', async () => {
  test.skip(process.platform === 'darwin', 'macOS uses native title-bar close controls.');
  const userData = await mkdtemp(resolve(tmpdir(), 'axterm-window-close-one-e2e-'));
  await mkdir(resolve(userData, 'desktop'));
  await writeFile(
    resolve(userData, 'desktop', 'window-preferences.json'),
    JSON.stringify({
      version: 1,
      preferences: { ...DEFAULT_DESKTOP_WINDOW_PREFERENCES, confirmBeforeExit: true },
    }),
  );
  const app = await electron.launch({
    executablePath,
    args: [resolve('apps/desktop'), `--user-data-dir=${userData}`],
    env: { ...process.env, ELECTRON_RENDERER_URL: '' },
  });
  try {
    const page = await app.firstWindow();
    await expect(page.getByTestId('runtime-state')).toHaveAttribute('data-state', 'ready');
    await expect(page.locator('.terminal-pane.active .terminal-tab')).toHaveCount(1);
    const closeButton = page.locator('[data-window-action="close"]');
    await expect(closeButton).toBeVisible();
    await closeButton.click();
    await expect.poll(() => page.isClosed()).toBe(true);
  } finally {
    await app.close().catch(() => {});
    await rm(userData, { recursive: true, force: true });
  }
});

test('window close button confirms before closing multiple terminals', async () => {
  test.skip(process.platform === 'darwin', 'macOS uses native title-bar close controls.');
  const userData = await mkdtemp(resolve(tmpdir(), 'axterm-window-close-many-e2e-'));
  const app = await electron.launch({
    executablePath,
    args: [resolve('apps/desktop'), `--user-data-dir=${userData}`],
    env: { ...process.env, ELECTRON_RENDERER_URL: '' },
  });
  try {
    const page = await app.firstWindow();
    await expect(page.getByTestId('runtime-state')).toHaveAttribute('data-state', 'ready');
    await expect(page.locator('.terminal-pane.active .terminal-tab')).toHaveCount(1);
    await page.locator('.terminal-pane.active .tab-add').click();
    await expect(page.locator('.terminal-pane.active .terminal-tab')).toHaveCount(2);
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.maximize());
    await expect
      .poll(() =>
        app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.isMaximized()),
      )
      .toBe(true);

    const closeButton = page.locator('[data-window-action="close"]');
    await expect(page.locator('.activity-brand')).toHaveCSS('-webkit-app-region', 'drag');
    await expect(page.locator('.terminal-workspace > .tabbar')).toHaveCSS(
      '-webkit-app-region',
      'no-drag',
    );
    const dragStrip = page.locator('.terminal-pane.active > .pane-tabbar .pane-tabbar-scroll');
    await expect(dragStrip).toHaveCSS('-webkit-app-region', 'drag');
    const stripRight = await dragStrip.evaluate((element) => element.getBoundingClientRect().right);
    const controlsLeft = await page
      .locator('.terminal-workspace > .tabbar')
      .evaluate((element) => element.getBoundingClientRect().left);
    expect(stripRight).toBeLessThanOrEqual(controlsLeft + 1);
    await expect(closeButton).toHaveCSS('-webkit-app-region', 'no-drag');
    const closeTarget = await closeButton.evaluate((button) => {
      const bounds = button.getBoundingClientRect();
      const x = bounds.left + bounds.width / 2;
      const y = bounds.top + bounds.height / 2;
      return {
        x,
        y,
        hitsCloseButton: button.contains(document.elementFromPoint(x, y)),
        regionsAtPoint: document
          .elementsFromPoint(x, y)
          .map((element) => getComputedStyle(element).getPropertyValue('-webkit-app-region')),
      };
    });
    expect(closeTarget.hitsCloseButton).toBe(true);
    expect(closeTarget.regionsAtPoint).not.toContain('drag');
    await page.mouse.click(closeTarget.x, closeTarget.y);
    const confirmation = page.getByRole('alertdialog', { name: '关闭 2 个标签？' });
    await expect(confirmation).toBeVisible();
    await confirmation.getByRole('button', { name: '取消' }).click();
    await expect(confirmation).toHaveCount(0);
    expect(page.isClosed()).toBe(false);

    await page.mouse.click(closeTarget.x, closeTarget.y);
    await confirmation.getByRole('button', { name: '关闭窗口' }).click();
    await expect.poll(() => page.isClosed()).toBe(true);
  } finally {
    await app.close().catch(() => {});
    await rm(userData, { recursive: true, force: true });
  }
});

test('H12 signed updater exposes check, progress, cancellation and installer handoff', async () => {
  const userData = await mkdtemp(resolve(tmpdir(), 'axterm-updater-e2e-'));
  const artifact = Buffer.alloc(1024 * 1024, 0x5a);
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const fixtureState: { manifest?: Record<string, unknown> } = {};
  const fixture = createServer((request, response) => {
    if (request.url === '/manifest.json') {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify(fixtureState.manifest));
      return;
    }
    if (request.url === '/axterm-0.11.0.zip') {
      response.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'Content-Length': artifact.byteLength,
      });
      let offset = 0;
      const timer = setInterval(() => {
        if (response.destroyed) {
          clearInterval(timer);
          return;
        }
        const end = Math.min(artifact.byteLength, offset + 32 * 1024);
        response.write(artifact.subarray(offset, end));
        offset = end;
        if (offset >= artifact.byteLength) {
          clearInterval(timer);
          response.end();
        }
      }, 20);
      response.once('close', () => clearInterval(timer));
      return;
    }
    response.writeHead(404).end();
  });
  fixture.listen(0, '127.0.0.1');
  await once(fixture, 'listening');
  const address = fixture.address();
  if (!address || typeof address === 'string') throw new Error('Updater fixture did not bind');
  const origin = `http://127.0.0.1:${address.port}`;
  const unsigned = {
    version: '0.11.0',
    publishedAt: '2026-09-14T00:00:00.000Z',
    notes: 'Production Electron signed update fixture',
    artifact: {
      url: `${origin}/axterm-0.11.0.zip`,
      fileName: 'axterm-0.11.0.zip',
      size: artifact.byteLength,
      sha256: createHash('sha256').update(artifact).digest('hex'),
      signature: Buffer.alloc(64).toString('base64'),
    },
  };
  fixtureState.manifest = {
    ...unsigned,
    artifact: {
      ...unsigned.artifact,
      signature: sign(null, Buffer.from(canonicalManifestRecord(unsigned)), privateKey).toString(
        'base64',
      ),
    },
  };
  const canonicalUserData = await realpath(userData);
  const app = await electron.launch({
    executablePath,
    args: [resolve('apps/desktop'), `--user-data-dir=${userData}`],
    env: {
      ...process.env,
      ELECTRON_RENDERER_URL: '',
      AXTERM_UPDATE_MANIFEST_URL: `${origin}/manifest.json`,
      AXTERM_UPDATE_PUBLIC_KEY_BASE64: publicKey
        .export({ format: 'der', type: 'spki' })
        .toString('base64'),
    },
  });
  try {
    await app.evaluate(({ shell }) => {
      (globalThis as unknown as { openedInstallers: string[] }).openedInstallers = [];
      shell.openPath = (async (path: string) => {
        (globalThis as unknown as { openedInstallers: string[] }).openedInstallers.push(path);
        return '';
      }) as typeof shell.openPath;
    });
    const page = await app.firstWindow();
    await expect(page.getByTestId('runtime-state')).toHaveAttribute('data-state', 'ready');
    await page.locator('[data-activity-item="setting"]').click();
    await page.locator('[data-settings-category="common"]').click();
    const updater = page.locator('.updater-panel');
    await expect(updater).toBeVisible();
    await expect(updater).toContainText(/Up to date|已是最新版本/);

    await updater.getByRole('button', { name: /Check for updates|检查更新/ }).click();
    await expect(updater).toContainText(/Update available|发现新版本/);
    await expect(updater).toContainText('0.11.0');

    await updater.getByRole('button', { name: /Download|下载/ }).click();
    await expect(updater).toContainText(/Downloading update|正在下载更新/);
    await updater.getByRole('button', { name: /Cancel|取消/ }).click();
    await expect(updater).toContainText(/Update available|发现新版本/);
    await expect(
      readFile(resolve(userData, 'updates', 'axterm-0.11.0.zip.part')),
    ).rejects.toThrow();

    await updater.getByRole('button', { name: /Download|下载/ }).click();
    await expect(updater).toContainText(/Ready to install|可以安装/, { timeout: 15_000 });
    await expect(updater.locator('progress')).toHaveCount(0);
    expect(await page.locator('body').innerText()).not.toContain(resolve(userData, 'updates'));
    await page.screenshot({ path: resolve('test-results/phase21-h12-updater-ready.png') });
    await updater.getByRole('button', { name: /Open installer|打开安装包/ }).click();
    await expect
      .poll(() =>
        app.evaluate(
          () => (globalThis as unknown as { openedInstallers: string[] }).openedInstallers,
        ),
      )
      .toEqual([resolve(canonicalUserData, 'updates', 'axterm-0.11.0.zip')]);
  } finally {
    await app.close().catch(() => {});
    fixture.closeAllConnections();
    fixture.close();
    await once(fixture, 'close');
    await rm(userData, { recursive: true, force: true });
  }
});

test('G09/G10 Widgets manage scoped server and reviewed file renamer lifecycles', async () => {
  const userData = await mkdtemp(resolve(tmpdir(), 'axterm-widget-e2e-'));
  const fixtureDirectory = await mkdtemp(resolve(tmpdir(), 'axterm-widget-files-'));
  await writeFile(resolve(fixtureDirectory, 'index.html'), 'AXTERM_WIDGET_INDEX');
  await writeFile(resolve(fixtureDirectory, 'alpha.txt'), 'alpha');
  await writeFile(resolve(fixtureDirectory, 'beta.txt'), 'beta');
  const app = await electron.launch({
    executablePath,
    args: [resolve('apps/desktop'), `--user-data-dir=${userData}`],
    env: { ...process.env, ELECTRON_RENDERER_URL: '' },
  });
  let widgetUrl = '';
  try {
    await app.evaluate(
      ({ dialog }, paths) => {
        const queue = [...paths];
        dialog.showOpenDialog = (() =>
          Promise.resolve({
            canceled: false,
            filePaths: [queue.shift()!],
          })) as typeof dialog.showOpenDialog;
      },
      [fixtureDirectory, fixtureDirectory],
    );
    const page = await app.firstWindow();
    await expect(page.getByTestId('runtime-state')).toHaveAttribute('data-state', 'ready');
    await openWidgets(page);

    const workspace = page.locator('.widget-workspace');
    await expect(workspace).toBeVisible();
    await expect(
      workspace.getByRole('button', { name: /Static File Server|静态文件服务器/ }),
    ).toBeVisible();
    const serverForm = workspace
      .locator('.widget-form')
      .filter({ hasText: /Static File Server|静态文件服务器/ });
    await serverForm.getByRole('button', { name: '选择目录' }).click();
    await expect(serverForm.locator('input[readonly]')).toHaveValue(/axterm-widget-files-/);
    await serverForm.locator('input[name="port"]').fill('0');
    await serverForm.locator('input[name="title"]').fill('Release preview');
    await serverForm.getByRole('button', { name: /Start widget|启动 Widget/ }).click();

    await expect(
      workspace.getByRole('tab', { name: /Running instances \(1\)|运行中的实例（1）/ }),
    ).toHaveAttribute('aria-selected', 'true');
    const instance = workspace.locator('.widget-instance-list article');
    await expect(instance).toContainText('Release preview');
    widgetUrl = (await instance.locator('.widget-instance-title small').textContent()) ?? '';
    expect(widgetUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(await (await fetch(widgetUrl)).text()).toBe('AXTERM_WIDGET_INDEX');

    await instance.getByTitle('重命名').click();
    await instance.locator('input[name="title"]').fill('Renamed release preview');
    await instance.getByTitle('保存名称').click();
    await expect(instance).toContainText('Renamed release preview');
    await instance.getByTitle('停止').click();
    await instance.getByTitle('再次点击确认停止').click();
    await expect(workspace.getByText(/No running instances|没有运行中的实例/)).toBeVisible();
    await expect(fetch(widgetUrl)).rejects.toThrow();

    await workspace.getByRole('tab', { name: 'Widgets' }).click();
    await workspace.getByRole('button', { name: /File Renamer|文件重命名器/ }).click();
    const renameForm = workspace.locator('.file-renamer-form');
    await renameForm.getByRole('button', { name: '选择目录' }).click();
    await renameForm.locator('input[name="template"]').fill('renamed-{n}.{ext}');
    await renameForm.locator('input[name="fileTypes"]').fill('txt');
    await renameForm.getByRole('button', { name: /Preview rename|预览重命名/ }).click();
    const preview = renameForm.getByLabel('重命名预览');
    await expect(preview).toContainText(
      /2 ready · 0 conflicts · 2 total|2 个待处理 · 0 个冲突 · 共 2 个/,
    );
    await expect(preview).toContainText('alpha.txt');
    await preview
      .getByRole('button', { name: /Confirm and rename 2 files|确认并重命名 2 个文件/ })
      .click();
    await expect(workspace.getByText('File Renamer 已完成')).toBeVisible();
    expect(await readFile(resolve(fixtureDirectory, 'renamed-1.txt'), 'utf8')).toBe('alpha');
    expect(await readFile(resolve(fixtureDirectory, 'renamed-2.txt'), 'utf8')).toBe('beta');
  } finally {
    await app.close().catch(() => {});
    if (widgetUrl) await expect(fetch(widgetUrl)).rejects.toThrow();
    await Promise.all([
      rm(userData, { recursive: true, force: true }),
      rm(fixtureDirectory, { recursive: true, force: true }),
    ]);
  }
});

test('G11 Widgets run bounded authenticated FTP and SSH/SFTP servers', async () => {
  test.setTimeout(90_000);
  const userData = await mkdtemp(resolve(tmpdir(), 'axterm-server-widget-e2e-'));
  const fixtureDirectory = await mkdtemp(resolve(tmpdir(), 'axterm-server-widget-files-'));
  const transferDirectory = resolve(userData, 'sftp-transfer');
  await mkdir(transferDirectory);
  await writeFile(resolve(fixtureDirectory, 'shared.txt'), 'SERVER_WIDGET_SHARED');
  const binaryPayload = Buffer.from(Array.from({ length: 192 * 1024 }, (_, index) => index % 256));
  await writeFile(resolve(transferDirectory, 'upload.bin'), binaryPayload);
  await mkdir(resolve(transferDirectory, 'local-tree'));
  await writeFile(resolve(transferDirectory, 'local-tree', 'nested.bin'), binaryPayload);
  await mkdir(resolve(fixtureDirectory, 'remote-tree'));
  await writeFile(resolve(fixtureDirectory, 'remote-tree', 'nested.bin'), binaryPayload);
  const app = await launchLocalOptimizationApp({
    executablePath,
    args: [resolve('apps/desktop'), `--user-data-dir=${userData}`],
    env: { ...process.env, ELECTRON_RENDERER_URL: '' },
  });
  try {
    await app.evaluate(
      ({ dialog }, paths) => {
        const queue = [...paths];
        dialog.showOpenDialog = (() =>
          Promise.resolve({
            canceled: false,
            filePaths: [queue.shift()!],
          })) as typeof dialog.showOpenDialog;
      },
      [fixtureDirectory, fixtureDirectory, transferDirectory],
    );
    const page = await app.firstWindow();
    const pageErrors: string[] = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));
    await expect(page.getByTestId('runtime-state')).toHaveAttribute('data-state', 'ready');
    await openWidgets(page);
    const workspace = page.locator('.widget-workspace');

    await workspace.getByRole('button', { name: /Local FTP Server|本地 FTP 服务器/ }).click();
    const ftpForm = workspace.locator('.local-ftp-widget-form');
    expect(
      await ftpForm
        .locator('select[name="host"] option')
        .evaluateAll((options) => options.map((option) => (option as HTMLOptionElement).value)),
    ).toEqual(['127.0.0.1', '::1']);
    await ftpForm.getByRole('button', { name: '选择目录' }).click();
    await ftpForm.locator('input[name="port"]').fill('0');
    await ftpForm.locator('input[name="password"]').fill('ftp-e2e-session-only');
    await ftpForm.locator('input[name="passivePortStart"]').fill('50400');
    await ftpForm.locator('input[name="passivePortEnd"]').fill('50407');
    await ftpForm.getByRole('button', { name: /Start widget|启动 Widget/ }).click();
    let instance = workspace.locator('.widget-instance-list article').filter({
      hasText: /Local FTP Server|本地 FTP 服务器/,
    });
    await expect(instance).toBeVisible();
    const ftpText = (await instance.locator('.widget-instance-title small').textContent()) ?? '';
    const ftpUrl = ftpText.match(/ftp:\/\/[^\s·]+/)?.[0];
    expect(ftpUrl).toBeTruthy();
    const ftpAddress = new URL(ftpUrl!);
    const ftp = new FtpClient(5_000);
    await ftp.access({
      host: ftpAddress.hostname,
      port: Number(ftpAddress.port),
      user: 'ftpuser',
      password: 'ftp-e2e-session-only',
    });
    expect((await ftp.list()).map(({ name }) => name)).toContain('shared.txt');
    ftp.close();
    await instance.getByTitle('停止').click();
    await instance.getByTitle('再次点击确认停止').click();
    await expect(workspace.getByText(/No running instances|没有运行中的实例/)).toBeVisible();

    await workspace.getByRole('tab', { name: 'Widgets' }).click();
    await workspace.getByRole('button', { name: /SSH Server|SSH 服务器/ }).click();
    const sshForm = workspace.locator('.local-ssh-widget-form');
    await sshForm.getByRole('button', { name: '选择目录' }).click();
    await sshForm.locator('input[name="port"]').fill('0');
    await sshForm.locator('input[name="password"]').fill('ssh-e2e-session-only');
    await sshForm.getByRole('button', { name: /Start widget|启动 Widget/ }).click();
    instance = workspace
      .locator('.widget-instance-list article')
      .filter({ hasText: /SSH Server|SSH 服务器/ });
    await expect(instance).toBeVisible();
    const sshText = (await instance.locator('.widget-instance-title small').textContent()) ?? '';
    const sshUrl = sshText.match(/ssh:\/\/[^\s·]+/)?.[0];
    expect(sshUrl).toBeTruthy();
    const sshAddress = new URL(sshUrl!);
    const ssh = await connectWidgetSsh(Number(sshAddress.port), 'test', 'ssh-e2e-session-only');
    expect((await execWidgetSsh(ssh, 'cat shared.txt')).trim()).toBe('SERVER_WIDGET_SHARED');
    ssh.end();
    await page.locator('[data-activity-item="bookmarks"]').click();
    await page.locator('.workspace-sidebar').getByRole('button', { name: '管理' }).click();
    await page.getByRole('button', { name: '添加主机' }).click();
    const hostForm = page.getByRole('dialog', { name: '添加 SSH 主机' });
    await hostForm.getByLabel('显示名称').fill('Widget SFTP');
    await hostForm.getByLabel('主机地址').fill('127.0.0.1');
    await hostForm.getByLabel('端口').fill(String(sshAddress.port));
    await hostForm.getByLabel('用户名').fill('test');
    await hostForm.getByLabel('认证方式').selectOption('password');
    await hostForm.getByLabel('密码', { exact: true }).fill('ssh-e2e-session-only');
    await hostForm.getByRole('button', { name: '保存并连接' }).click();
    const hostKeyDialog = page.getByRole('dialog', { name: /首次连接此主机/ });
    await hostKeyDialog.getByRole('button', { name: '信任并连接', exact: true }).click();
    await page
      .locator('.terminal-pane.active .session-mode-tabs')
      .getByRole('tab', { name: 'SFTP', exact: true })
      .click();
    await openFilesWorkspace(page);
    const localPane = page.getByRole('region', { name: '本地文件' });
    const remotePane = page.getByRole('region', { name: '远端文件' });
    await expect(remotePane.getByRole('button', { name: 'shared.txt', exact: true })).toBeVisible();
    await expect(remotePane.getByRole('textbox', { name: '远端路径', exact: true })).toHaveValue(
      '/',
    );
    await localPane.getByRole('button', { name: '更换目录' }).click();
    await expect(localPane.getByRole('button', { name: 'upload.bin', exact: true })).toBeVisible();
    const localBinary = localPane.getByRole('button', { name: 'upload.bin', exact: true });
    await localBinary.click();
    await localPane
      .getByRole('button', { name: 'local-tree', exact: true })
      .click({ modifiers: [process.platform === 'darwin' ? 'Meta' : 'Control'] });
    await localBinary.click({ button: 'right' });
    await page.getByRole('menuitem', { name: '上传到远端' }).click();
    await page
      .getByRole('dialog', { name: '确认上传' })
      .getByRole('button', { name: '上传', exact: true })
      .click();
    await expect
      .poll(async () =>
        readFile(resolve(fixtureDirectory, 'upload.bin'))
          .then((bytes) => bytes.equals(binaryPayload))
          .catch(() => false),
      )
      .toBe(true);
    await expect
      .poll(async () =>
        readFile(resolve(fixtureDirectory, 'local-tree', 'nested.bin'))
          .then((bytes) => bytes.equals(binaryPayload))
          .catch(() => false),
      )
      .toBe(true);
    await expect(remotePane.getByRole('button', { name: 'upload.bin', exact: true })).toBeVisible();
    const remoteFile = remotePane.getByRole('button', { name: 'shared.txt', exact: true });
    await remoteFile.click();
    await remotePane
      .getByRole('button', { name: 'remote-tree', exact: true })
      .click({ modifiers: [process.platform === 'darwin' ? 'Meta' : 'Control'] });
    await remoteFile.click({ button: 'right' });
    await page.getByRole('menuitem', { name: '下载到本地' }).click();
    const download = page.getByRole('dialog', { name: '确认下载' });
    await expect(download).toContainText('选中的 2 项');
    await download.getByRole('button', { name: '下载', exact: true }).click();
    await expect
      .poll(async () => readFile(resolve(transferDirectory, 'shared.txt'), 'utf8').catch(() => ''))
      .toBe('SERVER_WIDGET_SHARED');
    await expect
      .poll(async () =>
        readFile(resolve(transferDirectory, 'remote-tree', 'nested.bin'))
          .then((bytes) => bytes.equals(binaryPayload))
          .catch(() => false),
      )
      .toBe(true);
    await expect(localPane.getByRole('button', { name: 'remote-tree', exact: true })).toBeVisible();
    // The local server has no atomic-replace extension: preserve the original,
    // expose the failure, and never silently downgrade to deleting the target.
    await writeFile(resolve(transferDirectory, 'upload.bin'), Buffer.from('replacement bytes'));
    await localBinary.click();
    await localPane
      .getByRole('button', { name: 'upload.bin', exact: true })
      .click({ button: 'right' });
    await page.getByRole('menuitem', { name: '上传到远端' }).click();
    await page
      .getByRole('dialog', { name: '确认上传' })
      .getByRole('button', { name: '上传', exact: true })
      .click();
    const conflict = page.getByRole('dialog', { name: '处理传输冲突' });
    await expect(conflict).toContainText('/upload.bin');
    expect((await readFile(resolve(fixtureDirectory, 'upload.bin'))).equals(binaryPayload)).toBe(
      true,
    );
    await conflict.getByRole('button', { name: '关闭', exact: true }).click();
    await page.locator('footer').getByRole('button', { name: /^传输/ }).click();
    const center = page.getByRole('complementary', { name: '传输中心', exact: true });
    const retry = center.locator('article').getByRole('button', { name: '重试', exact: true });
    await expect(retry).toHaveCount(1);
    // This injection verifies UI error recovery only; the file proofs use SSH.
    await page.route('**/transfers/*/retry', (route) =>
      route.fulfill({ status: 503, contentType: 'application/json', body: '{}' }),
    );
    await retry.click();
    await expect(center.getByRole('alert')).toContainText('传输操作失败');
    await page.unroute('**/transfers/*/retry');
    await retry.click();
    await expect(conflict).toBeVisible();
    await conflict.getByRole('button', { name: '覆盖', exact: true }).click();
    await expect(center).toContainText('服务器无法安全覆盖此文件');
    expect((await readFile(resolve(fixtureDirectory, 'upload.bin'))).equals(binaryPayload)).toBe(
      true,
    );
    expect((await readdir(fixtureDirectory)).filter((name) => name.endsWith('.part'))).toEqual([]);
    await center.getByRole('button', { name: '关闭传输中心' }).click();
    expect(
      await page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage })),
    ).not.toMatch(/ftp-e2e-session-only|ssh-e2e-session-only/);
    await openWidgets(page);
    await workspace.getByRole('tab', { name: /运行中的实例/u }).click();
    await instance.getByTitle('停止').click();
    await instance.getByTitle('再次点击确认停止').click();
    await expect(workspace.getByText(/No running instances|没有运行中的实例/)).toBeVisible();
    expect(pageErrors).toEqual([]);
    await page.screenshot({ path: test.info().outputPath('disconnected-widget.png') });
    await openFilesWorkspace(page);
    await page.locator('.app-statusbar').getByRole('button', { name: /^传输/ }).click();
    await expect(center).toContainText('请在文件工作区重新连接');
    await expect(
      center.locator('article').getByRole('button', { name: '重试', exact: true }),
    ).toHaveCount(0);
    await center.getByRole('button', { name: '关闭传输中心' }).click();
    const generation = await page.getByTestId('runtime-generation').innerText();
    const runtimePid = Number(
      await page
        .locator('dl div')
        .filter({ has: page.getByText('进程 ID', { exact: true }) })
        .locator('dd')
        .innerText(),
    );
    expect(runtimePid).toBeGreaterThan(0);
    process.kill(runtimePid, 'SIGKILL');
    await expect(page.getByTestId('runtime-generation')).not.toHaveText(generation);
    await expect(page.getByTestId('runtime-state')).toHaveAttribute('data-state', 'ready');
    await page.locator('footer').getByRole('button', { name: /^传输/ }).click();
    await expect(center).toContainText('请重新选择文件并授权本地目录');
    await expect(center.getByRole('button', { name: '重试', exact: true })).toHaveCount(0);
    await center.getByRole('button', { name: '重新选择文件' }).first().click();
    await expect(center).toHaveCount(0);
    await expect(localPane.getByRole('textbox', { name: '本地绝对路径' })).not.toHaveValue(
      transferDirectory,
    );
    await expect(localPane.getByRole('button', { name: 'upload.bin', exact: true })).toHaveCount(0);
  } finally {
    await app.close().catch(() => {});
    await Promise.all([
      rm(userData, { recursive: true, force: true }),
      rm(fixtureDirectory, { recursive: true, force: true }),
    ]);
  }
});

test('I10 runs an authenticated MCP Widget and routes mutations through Agent approval', async () => {
  const userData = await mkdtemp(resolve(tmpdir(), 'axterm-mcp-widget-e2e-'));
  const approvedPath = resolve(userData, 'i10-mcp-approved');
  const apiKey = 'i10-local-mcp-api-key-1234567890';
  const app = await electron.launch({
    executablePath,
    args: [resolve('apps/desktop'), `--user-data-dir=${userData}`],
    env: { ...process.env, ELECTRON_RENDERER_URL: '', SHELL: '/bin/sh' },
  });
  let mcpUrl = '';
  try {
    const page = await app.firstWindow();
    await expect(page.getByTestId('runtime-state')).toHaveAttribute('data-state', 'ready');
    const terminalLayer = page.locator('.terminal-session-layer:not([hidden])');
    await expect(terminalLayer.locator('.terminal-host')).toHaveAttribute(
      'data-connection-state',
      'connected',
    );
    const terminalId = await terminalLayer.getAttribute('data-terminal-session');
    expect(terminalId).toBeTruthy();

    await openWidgets(page);
    const workspace = page.locator('.widget-workspace');
    await workspace.getByRole('option', { name: /MCP/ }).click();
    const form = workspace.locator('.mcp-widget-form');
    await expect(form.getByRole('heading', { name: /MCP Server|MCP 服务器/ })).toBeVisible();
    await expect(form).toContainText(/Authenticated local endpoint|经过认证的本地端点/);
    await expect(form).toContainText('terminal.exec');
    await form.locator('input[name="port"]').fill('0');
    await form.locator('input[name="apiKey"]').fill(apiKey);
    await form.locator('input[name="enabledTools"]').evaluateAll((inputs) =>
      inputs.forEach((input) => {
        const checkbox = input as HTMLInputElement;
        checkbox.checked = ['system.inspectMemory', 'terminal.exec'].includes(checkbox.value);
        checkbox.dispatchEvent(new Event('change', { bubbles: true }));
      }),
    );
    await page.screenshot({ path: 'test-results/phase20-mcp-server-widget.png' });
    await form.getByRole('button', { name: /Start widget|启动 Widget/ }).click();

    const instance = workspace.locator('.widget-instance-list article').filter({ hasText: /MCP/ });
    await expect(instance).toBeVisible();
    const instanceText =
      (await instance.locator('.widget-instance-title small').textContent()) ?? '';
    mcpUrl = instanceText.match(/http:\/\/127\.0\.0\.1:\d+\/mcp/u)?.[0] ?? '';
    expect(mcpUrl).toBeTruthy();
    expect(
      (
        await fetch(mcpUrl, {
          method: 'POST',
          headers: {
            Authorization: 'Bearer wrong-key',
            Accept: 'application/json, text/event-stream',
            'Content-Type': 'application/json',
          },
          body: mcpRequestE2e(1, 'initialize', { protocolVersion: '2025-06-18' }),
        })
      ).status,
    ).toBe(401);
    const initialized = await fetch(mcpUrl, {
      method: 'POST',
      headers: mcpHeadersE2e(apiKey),
      body: mcpRequestE2e(1, 'initialize', { protocolVersion: '2025-06-18' }),
    });
    const sessionId = initialized.headers.get('mcp-session-id')!;
    expect(sessionId).toBeTruthy();
    const headers = {
      ...mcpHeadersE2e(apiKey),
      'Mcp-Session-Id': sessionId,
      'MCP-Protocol-Version': '2025-06-18',
    };
    expect(
      (
        await fetch(mcpUrl, {
          method: 'POST',
          headers,
          body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
        })
      ).status,
    ).toBe(202);
    const listed = await mcpPostE2e(mcpUrl, headers, 2, 'tools/list');
    expect(listed.result.tools.map((tool: { name: string }) => tool.name)).toEqual([
      'system.inspectMemory',
      'terminal.exec',
    ]);
    const memory = await mcpPostE2e(mcpUrl, headers, 3, 'tools/call', {
      name: 'system.inspectMemory',
      arguments: {},
    });
    expect(memory.result).toMatchObject({
      isError: false,
      structuredContent: { state: 'succeeded' },
    });
    await expect(instance.locator('.widget-instance-title small')).toContainText(
      /2 tools · 1 sessions|2 个工具 · 1 个会话/,
      { timeout: 5_000 },
    );

    const command = `printf I10_MCP_APPROVED > '${approvedPath}'`;
    const mutation = await mcpPostE2e(mcpUrl, headers, 4, 'tools/call', {
      name: 'terminal.exec',
      arguments: { terminalId, command },
    });
    expect(mutation.result.structuredContent.state).toBe('waiting_approval');
    await expect(readFile(approvedPath)).rejects.toThrow();

    await openAiWorkspace(page, false);
    await expect(page.getByRole('dialog', { name: 'AI 配置' })).toBeHidden();
    const card = page
      .getByRole('region', { name: 'Agent 工具活动' })
      .locator('.agent-tool-card')
      .filter({ hasText: 'I10_MCP_APPROVED' });
    await expect(card).toContainText('等待审批');
    await expect(card).toContainText('精确参数哈希');
    await card.getByRole('button', { name: '仅运行一次' }).click();
    await expect(card).toContainText('已完成');
    await expect
      .poll(async () => readFile(approvedPath, 'utf8').catch(() => ''))
      .toBe('I10_MCP_APPROVED');
    expect(
      await page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage })),
    ).not.toContain(apiKey);

    await openWidgets(page);
    await workspace.getByRole('tab', { name: /Running instances|运行中的实例/ }).click();
    const running = workspace.locator('.widget-instance-list article').filter({ hasText: /MCP/ });
    await running.getByTitle('停止').click();
    await running.getByTitle('再次点击确认停止').click();
    await expect(fetch(mcpUrl)).rejects.toThrow();
  } finally {
    await app.close().catch(() => undefined);
    if (mcpUrl) await expect(fetch(mcpUrl)).rejects.toThrow();
    await rm(userData, { recursive: true, force: true });
  }
});

function connectWidgetSsh(port: number, username: string, password: string) {
  return new Promise<InstanceType<typeof SshClient>>((resolveConnection, rejectConnection) => {
    const client = new SshClient();
    client.once('ready', () => resolveConnection(client));
    client.once('error', rejectConnection);
    client.connect({
      host: '127.0.0.1',
      port,
      username,
      password,
      hostVerifier: () => true,
      readyTimeout: 5_000,
    });
  });
}

function mcpHeadersE2e(apiKey: string) {
  return {
    Authorization: `Bearer ${apiKey}`,
    Accept: 'application/json, text/event-stream',
    'Content-Type': 'application/json',
  };
}

function mcpRequestE2e(id: number, method: string, params?: Record<string, unknown>): string {
  return JSON.stringify({ jsonrpc: '2.0', id, method, ...(params ? { params } : {}) });
}

async function mcpPostE2e(
  url: string,
  headers: Record<string, string>,
  id: number,
  method: string,
  params?: Record<string, unknown>,
) {
  const response = await fetch(url, {
    method: 'POST',
    headers,
    body: mcpRequestE2e(id, method, params),
  });
  expect(response.status).toBe(200);
  return response.json() as Promise<TestMcpResponse>;
}

interface TestMcpResponse {
  result: {
    tools: Array<{ name: string }>;
    isError: boolean;
    structuredContent: {
      state: string;
      approvalId?: string;
      argsHash?: string;
    };
  };
}

function execWidgetSsh(client: InstanceType<typeof SshClient>, command: string) {
  return new Promise<string>((resolveOutput, rejectOutput) => {
    client.exec(command, (error, stream) => {
      if (error) return rejectOutput(error);
      const output: Buffer[] = [];
      stream.on('data', (chunk: Buffer) => output.push(chunk));
      stream.once('error', rejectOutput);
      stream.once('close', () => resolveOutput(Buffer.concat(output).toString('utf8')));
    });
  });
}

async function dragFileTo(source: Locator, target: Locator, page: Page) {
  const transfer = await page.evaluateHandle(() => new DataTransfer());
  try {
    await source.dispatchEvent('dragstart', { dataTransfer: transfer });
    await target.dispatchEvent('dragenter', { dataTransfer: transfer });
    await target.dispatchEvent('dragover', { dataTransfer: transfer });
    await target.dispatchEvent('drop', { dataTransfer: transfer });
    await source.dispatchEvent('dragend', { dataTransfer: transfer });
  } finally {
    await transfer.dispose();
  }
}

async function startReconnectSshFixture(
  hostKey: string | Buffer,
  requestedPort = 0,
  hiddenBracketedPaste = false,
) {
  const connections = new Set<SshServerConnection>();
  let receivedText = '';
  let integrationReleaseRequested = false;
  let pendingIntegrationReply: (() => void) | undefined;
  const server = new SshServer({ hostKeys: [hostKey] }, (connection) => {
    connections.add(connection);
    // Rejecting an unknown/changed host key intentionally closes the client
    // during key exchange. ssh2 reports that expected peer abort as an error
    // event on the server-side connection.
    connection.on('error', (error) => {
      if (error.message !== 'KEY_EXCHANGE_FAILED') throw error;
    });
    connection.once('close', () => connections.delete(connection));
    connection.on('authentication', (context) => {
      if (context.method === 'none') context.accept();
      else context.reject(['none']);
    });
    connection.on('ready', () => {
      connection.on('session', (accept) => {
        const session = accept();
        session.on('exec', (acceptCommand) => {
          const stream = acceptCommand();
          stream.write(hiddenBracketedPaste ? '/bin/bash\n' : '/bin/sh\n');
          stream.exit(0);
          stream.end();
        });
        session.on('pty', (acceptPty) => acceptPty?.());
        session.on('shell', (acceptShell) => {
          const stream = acceptShell();
          stream.write(
            hiddenBracketedPaste
              ? '\r\nD04_NETWORK_FIXTURE_READY\r\n\u001b[?25l\u001b[?2004h\r\nold$ '
              : '\r\nD04_NETWORK_FIXTURE_READY\r\n$ ',
          );
          let integrationReplied = false;
          stream.on('data', (chunk: Buffer) => {
            receivedText = `${receivedText}${chunk.toString('utf8')}`.slice(-64 * 1024);
            if (
              hiddenBracketedPaste &&
              !integrationReplied &&
              receivedText.includes('AXTERM_SHELL_INTEGRATION')
            ) {
              integrationReplied = true;
              const reply = () => stream.write('echoed bootstrap\r\n\u001b]633;A\u0007new$ ');
              if (integrationReleaseRequested) reply();
              else pendingIntegrationReply = reply;
              return;
            }
            stream.write(chunk);
          });
        });
      });
    });
  });
  server.listen(requestedPort, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('D04 SSH fixture did not bind');
  return {
    port: address.port,
    connectionCount: () => connections.size,
    receivedText: () => receivedText,
    releaseIntegration() {
      integrationReleaseRequested = true;
      pendingIntegrationReply?.();
      pendingIntegrationReply = undefined;
    },
    async stop() {
      const closed = new Promise<void>((resolveClose) => server.close(() => resolveClose()));
      for (const connection of connections) connection.end();
      await closed;
    },
  };
}

test('P-04/P-07 localizes real SSH Host Key verification and requires changed-key confirmation', async () => {
  test.setTimeout(90_000);
  const hostKey = utils.generateKeyPairSync('ed25519').private;
  const parsedHostKey = utils.parseKey(hostKey);
  if (parsedHostKey instanceof Error || Array.isArray(parsedHostKey))
    throw new Error('Host Key localization fixture generated an invalid host key');
  const publicKey = parsedHostKey.getPublicSSH();
  const fingerprint = `SHA256:${createHash('sha256')
    .update(publicKey)
    .digest('base64')
    .replace(/=+$/u, '')}`;
  const fixture = await startReconnectSshFixture(hostKey);
  const cases = [
    {
      id: 'en',
      title: 'First connection to this host',
      summary: 'No identity is saved for this SSH host.',
      target: 'Target',
      algorithm: 'Algorithm',
      fingerprint: 'SHA256 fingerprint',
      remember: 'Save and remember this host key',
      reject: 'Reject',
    },
    {
      id: 'ja',
      title: 'このホストへの初回接続',
      summary: 'この SSH ホストの識別情報は保存されていません。',
      target: '接続先',
      algorithm: 'アルゴリズム',
      fingerprint: 'SHA256 フィンガープリント',
      remember: 'このホスト鍵を保存して記憶',
      reject: '拒否',
    },
    {
      id: 'zh-CN',
      title: '首次连接此主机',
      summary: '尚未保存此 SSH 主机的身份。',
      target: '目标',
      algorithm: '算法',
      fingerprint: 'SHA256 指纹',
      remember: '保存并记住此主机密钥',
      reject: '拒绝',
    },
    {
      id: 'zh-TW',
      title: '首次連線至此主機',
      summary: '尚未儲存此 SSH 主機的身分。',
      target: '目標',
      algorithm: '演算法',
      fingerprint: 'SHA256 指紋',
      remember: '儲存並記住此主機金鑰',
      reject: '拒絕',
    },
  ] as const;

  try {
    for (const locale of cases) {
      const userData = await mkdtemp(resolve(tmpdir(), `axterm-host-key-${locale.id}-`));
      await mkdir(resolve(userData, 'data-v2'), { recursive: true });
      const database = await ProductDatabase.open(resolve(userData, 'data-v2', 'axterm.sqlite'));
      try {
        const products = new ProductRepository(database);
        const host = products.createHost({
          name: 'Localized Host Key',
          hostname: '127.0.0.1',
          port: fixture.port,
          username: 'operator',
          authType: 'agent',
          sshAgent: { enabled: false, path: null },
        });
        const bookmarks = new BookmarkRepository(database);
        bookmarks.createBookmark(
          {
            groupId: null,
            protocol: 'ssh',
            hostId: host.id,
            title: 'Localized Host Key',
            color: null,
            description: 'Localized Host Key verification fixture',
            profileId: null,
            connectionProfileId: null,
            quickCommands: [],
            triggers: [],
            ftp: null,
            telnet: null,
            serial: null,
            rdp: null,
            vnc: null,
            spice: null,
            web: null,
          },
          bookmarks.snapshot().etag,
        );
      } finally {
        database.close();
      }

      const app = await electron.launch({
        executablePath,
        args: [resolve('apps/desktop'), `--user-data-dir=${userData}`],
        env: { ...process.env, ELECTRON_RENDERER_URL: '' },
      });
      try {
        const page = await app.firstWindow();
        await expect(page.getByTestId('runtime-state')).toHaveAttribute('data-state', 'ready');
        await page.locator('[data-activity-item="setting"]').click();
        await page.locator('[data-settings-category="common"]').click();
        await page.getByTestId('application-language').selectOption(locale.id);
        await expect(page.locator('html')).toHaveAttribute('lang', locale.id);
        await page.locator('[data-activity-item="bookmarks"]').click();
        await page.locator('[data-bookmark-title="Localized Host Key"] .bookmark-row-main').click();

        const dialog = page.getByRole('dialog', { name: locale.title });
        await expect(dialog).toBeVisible();
        await expect(dialog.locator('form[data-interaction-kind="unknownHostKey"]')).toBeVisible();
        await expect(dialog.getByText(locale.summary, { exact: true })).toBeVisible();
        await expect(dialog.getByText(locale.target, { exact: true })).toBeVisible();
        await expect(dialog.getByText(locale.algorithm, { exact: true })).toBeVisible();
        await expect(dialog.getByText(locale.fingerprint, { exact: true })).toBeVisible();
        await expect(dialog.getByText(`operator@127.0.0.1:${fixture.port}`)).toBeVisible();
        await expect(dialog.getByText(fingerprint, { exact: true })).toBeVisible();
        await expect(dialog.getByLabel(locale.remember)).toBeChecked();
        const reject = dialog.getByRole('button', { name: locale.reject, exact: true });
        await expect(reject).toBeFocused();
        await expect(dialog.getByText('SSH host key verification', { exact: true })).toHaveCount(0);
        await reject.click();
        await expect(dialog).toBeHidden();
      } finally {
        await app.close().catch(() => {});
        await rm(userData, { recursive: true, force: true });
      }
    }

    const userData = await mkdtemp(resolve(tmpdir(), 'axterm-changed-host-key-'));
    await mkdir(resolve(userData, 'data-v2'), { recursive: true });
    let database = await ProductDatabase.open(resolve(userData, 'data-v2', 'axterm.sqlite'));
    try {
      const products = new ProductRepository(database);
      const host = products.createHost({
        name: 'Changed Host Key',
        hostname: '127.0.0.1',
        port: fixture.port,
        username: 'operator',
        authType: 'agent',
        sshAgent: { enabled: false, path: null },
      });
      products.saveKnownHostKey({
        host: host.hostname,
        port: host.port,
        algorithm: 'ssh-ed25519',
        fingerprint: 'SHA256:previous-host-key',
        publicKey: Buffer.from('previous-host-key').toString('base64'),
      });
      const bookmarks = new BookmarkRepository(database);
      bookmarks.createBookmark(
        {
          groupId: null,
          protocol: 'ssh',
          hostId: host.id,
          title: 'Changed Host Key',
          color: null,
          description: 'Changed Host Key verification fixture',
          profileId: null,
          connectionProfileId: null,
          quickCommands: [],
          triggers: [],
          ftp: null,
          telnet: null,
          serial: null,
          rdp: null,
          vnc: null,
          spice: null,
          web: null,
        },
        bookmarks.snapshot().etag,
      );
    } finally {
      database.close();
    }

    const app = await electron.launch({
      executablePath,
      args: [resolve('apps/desktop'), `--user-data-dir=${userData}`],
      env: { ...process.env, ELECTRON_RENDERER_URL: '' },
    });
    try {
      const page = await app.firstWindow();
      await expect(page.getByTestId('runtime-state')).toHaveAttribute('data-state', 'ready');
      await page.locator('[data-activity-item="setting"]').click();
      await page.locator('[data-settings-category="common"]').click();
      await page.getByTestId('application-language').selectOption('en');
      await page.locator('[data-activity-item="bookmarks"]').click();
      await page.locator('[data-bookmark-title="Changed Host Key"] .bookmark-row-main').click();

      const dialog = page.getByRole('dialog', { name: 'Remote host key changed' });
      await expect(dialog).toBeVisible();
      await expect(dialog.locator('form[data-interaction-kind="changedHostKey"]')).toBeVisible();
      await expect(
        dialog.getByText('The remote identity does not match the saved host key.', { exact: true }),
      ).toBeVisible();
      await expect(dialog.getByText('High risk', { exact: true })).toBeVisible();
      await expect(dialog.getByText('SHA256:previous-host-key', { exact: true })).toBeVisible();
      await expect(dialog.getByText(fingerprint, { exact: true })).toBeVisible();
      const confirm = dialog.getByLabel(
        'I verified the new fingerprint and want to replace the saved host key',
      );
      await expect(confirm).not.toBeChecked();
      const replace = dialog.getByRole('button', { name: 'Replace key and connect' });
      await replace.click();
      await expect(dialog).toBeVisible();
      await expect(
        dialog.getByText(
          'Verify the new fingerprint and select the confirmation checkbox before replacing the saved host key.',
          { exact: true },
        ),
      ).toBeVisible();
      await expect(confirm).toHaveAttribute('aria-invalid', 'true');
      expect(
        await dialog
          .locator('.host-key-interaction-summary')
          .evaluate((element) => getComputedStyle(element).color),
      ).toBe('rgb(240, 100, 115)');
      await dialog.getByRole('button', { name: 'Reject', exact: true }).click();
      await expect(dialog).toBeHidden();
    } finally {
      await app.close().catch(() => {});
    }

    database = await ProductDatabase.open(resolve(userData, 'data-v2', 'axterm.sqlite'));
    try {
      expect(
        new ProductRepository(database).getKnownHostKey('127.0.0.1', fixture.port),
      ).toMatchObject({ fingerprint: 'SHA256:previous-host-key' });
    } finally {
      database.close();
      await rm(userData, { recursive: true, force: true });
    }
  } finally {
    await fixture.stop().catch(() => {});
  }
});

test.describe('F-08 desktop deep links', () => {
  test('accepts Axterm deep links and rejects the removed Legacy Prototype URL scheme', async () => {
    const userData = await mkdtemp(resolve(tmpdir(), 'axterm-deep-link-e2e-'));
    const source =
      'axterm://operator:deep-link-session-only@telnet.example.test:2323?type=telnet&title=Deep%20Link';
    const app = await electron.launch({
      executablePath,
      args: [resolve('apps/desktop'), `--user-data-dir=${userData}`, source],
      env: { ...process.env, ELECTRON_RENDERER_URL: '' },
    });
    try {
      const page = await app.firstWindow();
      await expect(page.getByTestId('runtime-state')).toHaveAttribute('data-state', 'ready');
      const form = page.getByRole('dialog', { name: '添加 Telnet 书签' });
      await expect(form).toBeVisible();
      await expect(form.locator('input[name="name"]')).toHaveValue('Deep Link');
      await expect(form.locator('input[name="hostname"]')).toHaveValue('telnet.example.test');
      await expect(form.locator('input[name="port"]')).toHaveValue('2323');
      await expect(form.locator('input[name="username"]')).toHaveValue('operator');
      await expect(form.locator('input[name="password"]')).toHaveValue('deep-link-session-only');
      expect(
        await page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage })),
      ).not.toContain('deep-link-session-only');
      await form.getByRole('button', { name: '取消' }).click();
      await expect(form).toBeHidden();
      await expect(page.locator('[role="dialog"]')).toHaveCount(0);
      await page.waitForTimeout(100);

      await app.evaluate(({ app }, url) => {
        app.emit('open-url', { preventDefault() {} } as never, url);
      }, 'vnc://viewer:vnc-session-only@vnc.example.test:5901?title=VNC%20Deep');
      const vncForm = page.getByRole('dialog', { name: '添加 VNC 书签' });
      await expect(vncForm).toBeVisible();
      await expect(vncForm.locator('input[name="hostname"]')).toHaveValue('vnc.example.test');
      await expect(vncForm.locator('input[name="password"]')).toHaveValue('vnc-session-only');
      await vncForm.getByRole('button', { name: '取消' }).click();
      await expect(page.locator('[role="dialog"]')).toHaveCount(0);
      await page.waitForTimeout(100);

      const axtermFtpLink =
        'axterm://ftp-user:ftp-session-only@ftp.example.test:2121?type=ftp&title=FTP%20Deep';
      await app.evaluate(
        ({ app }, url) => {
          app.emit('second-instance', {} as never, [url], process.cwd(), {} as never);
        },
        axtermFtpLink.replace('axterm://', 'legacy-prototype://'),
      );
      const ftpForm = page.getByRole('dialog', { name: '添加 FTP/FTPS 书签' });
      await expect(ftpForm).toBeHidden();

      await app.evaluate(({ app }, url) => {
        app.emit('second-instance', {} as never, [url], process.cwd(), {} as never);
      }, axtermFtpLink);
      await expect(ftpForm).toBeVisible();
      await expect(ftpForm.locator('input[name="hostname"]')).toHaveValue('ftp.example.test');
      await expect(ftpForm.locator('input[name="port"]')).toHaveValue('2121');
      await expect(ftpForm.locator('input[name="username"]')).toHaveValue('ftp-user');
      await expect(ftpForm.locator('input[name="password"]')).toHaveValue('ftp-session-only');
      await ftpForm.getByRole('button', { name: '取消' }).click();
    } finally {
      await app.close();
      await rm(userData, { recursive: true, force: true });
    }
  });
});

test.describe('G-12 desktop command line', () => {
  test('opens a quoted local target and forwards second-instance options into a new window', async () => {
    const userData = await mkdtemp(resolve(tmpdir(), 'axterm-cli-e2e-'));
    const workingDirectory = await mkdtemp(resolve(tmpdir(), 'axterm-cli-cwd-'));
    const cwdEvidence = resolve(userData, 'cli-cwd.txt');
    const batchFile = resolve(userData, 'quoted batch operation.json');
    await mkdir(resolve(userData, 'data-v2'), { recursive: true });
    const seed = await ProductDatabase.open(resolve(userData, 'data-v2', 'axterm.sqlite'));
    let batchBookmarkId: string;
    try {
      const products = new ProductRepository(seed);
      const host = products.createHost({
        name: 'CLI batch target',
        hostname: '127.0.0.1',
        port: 1,
        username: 'operator',
        authType: 'agent',
        sshAgent: { enabled: false, path: null },
      });
      const bookmarks = new BookmarkRepository(seed);
      batchBookmarkId = bookmarks.createBookmark(
        {
          groupId: null,
          protocol: 'ssh',
          hostId: host.id,
          title: host.name,
          color: null,
          description: 'G12 command-line batch target',
          profileId: null,
          connectionProfileId: null,
          quickCommands: [],
          triggers: [],
          ftp: null,
          telnet: null,
          serial: null,
          rdp: null,
          vnc: null,
          spice: null,
          web: null,
        },
        bookmarks.snapshot().etag,
      ).bookmarks[0]!.id;
    } finally {
      seed.close();
    }
    await writeFile(
      batchFile,
      JSON.stringify({
        name: 'CLI batch action',
        bookmarkIds: [batchBookmarkId],
        steps: [
          {
            id: '00000000-0000-4000-8000-000000000012',
            name: 'Requested command',
            command: 'printf G12_BATCH',
            delayMs: 0,
            continueOnError: false,
          },
        ],
        concurrency: 1,
        connectionTimeoutMs: 1_000,
      }),
    );
    const app = await electron.launch({
      executablePath,
      args: [
        resolve('apps/desktop'),
        `--user-data-dir=${userData}`,
        '-tp',
        'local',
        '-d',
        workingDirectory,
        '-t',
        'CLI Local Workspace',
      ],
      env: { ...process.env, ELECTRON_RENDERER_URL: '' },
    });
    try {
      const first = await app.firstWindow();
      await expect(first.getByTestId('runtime-state')).toHaveAttribute('data-state', 'ready');
      await expect(
        first.locator('.workspace-tab.terminal-tab').filter({ hasText: 'CLI Local Workspace' }),
      ).toBeVisible();
      const input = first.locator('.terminal-session-layer:not([hidden]) .xterm-helper-textarea');
      await input.pressSequentially(`pwd > '${cwdEvidence}'`);
      await input.press('Enter');
      await expect
        .poll(async () => (await readFile(cwdEvidence, 'utf8').catch(() => '')).trim())
        .toBe(await realpath(workingDirectory));

      await app.evaluate(
        ({ app }, payload) => {
          app.emit('second-instance', {} as never, payload.argv, payload.cwd, {} as never);
        },
        {
          cwd: workingDirectory,
          argv: [
            '/Applications/Axterm.app',
            `--user-data-dir=${userData}`,
            '--new-window',
            '-tp',
            'telnet',
            '-opts',
            '{"host":"telnet.cli.test","port":2323,"username":"operator"}',
            '-pw',
            'cli-session-only',
            '-t',
            'CLI Telnet',
          ],
        },
      );
      await expect.poll(async () => (await app.windows()).length).toBe(2);
      const pages = await app.windows();
      const forms = pages.map((page) => page.getByRole('dialog', { name: '添加 Telnet 书签' }));
      await expect
        .poll(async () => Promise.all(forms.map((form) => form.isVisible())))
        .toContain(true);
      const form = forms[(await Promise.all(forms.map((item) => item.isVisible()))).indexOf(true)]!;
      await expect(form.locator('input[name="name"]')).toHaveValue('CLI Telnet');
      await expect(form.locator('input[name="hostname"]')).toHaveValue('telnet.cli.test');
      await expect(form.locator('input[name="port"]')).toHaveValue('2323');
      await expect(form.locator('input[name="username"]')).toHaveValue('operator');
      await expect(form.locator('input[name="password"]')).toHaveValue('cli-session-only');
      for (const page of pages)
        expect(
          await page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage })),
        ).not.toContain('cli-session-only');
      await form.getByRole('button', { name: '取消' }).click();

      await app.evaluate(
        ({ app }, payload) => {
          app.emit('second-instance', {} as never, payload.argv, payload.cwd, {} as never);
        },
        {
          cwd: workingDirectory,
          argv: ['/Applications/Axterm.app', '-bo', batchFile],
        },
      );
      await expect
        .poll(async () => {
          const database = await ProductDatabase.open(
            resolve(userData, 'data-v2', 'axterm.sqlite'),
          );
          try {
            return new BatchOperationRepository(database).list().map(({ name }) => name);
          } finally {
            database.close();
          }
        })
        .toContain('CLI batch action');
    } finally {
      await app.close().catch(() => {});
      await Promise.all([
        rm(userData, { recursive: true, force: true }),
        rm(workingDirectory, { recursive: true, force: true }),
      ]);
    }
  });
});

test.describe('H-01 settings navigation', () => {
  test('searches all settings categories and exposes keyboard and local-Vault metadata states', async () => {
    const userData = await mkdtemp(resolve(tmpdir(), 'axterm-settings-navigation-e2e-'));
    await mkdir(resolve(userData, 'data-v2'), { recursive: true });
    const seed = await ProductDatabase.open(resolve(userData, 'data-v2', 'axterm.sqlite'));
    try {
      new ProductRepository(seed).createHost({
        name: 'Private address host',
        hostname: '192.168.100.25',
        port: 22,
        username: 'operator',
        authType: 'agent',
        sshAgent: { enabled: false, path: null },
      });
    } finally {
      seed.close();
    }
    const app = await electron.launch({
      executablePath,
      args: [resolve('apps/desktop'), `--user-data-dir=${userData}`],
      env: { ...process.env, ELECTRON_RENDERER_URL: '' },
    });
    try {
      const page = await app.firstWindow();
      await expect(page.getByTestId('runtime-state')).toHaveAttribute('data-state', 'ready');
      await page.locator('[data-activity-item="setting"]').click();
      const categories = page.getByRole('complementary', { name: '设置项目' });
      for (const name of [
        '常规',
        '终端',
        '键盘快捷键',
        '同步设置',
        'AI 服务配置',
        '凭据',
        '关于 Axterm',
      ])
        await expect(categories.getByRole('button', { name, exact: true })).toBeVisible();

      await categories.locator('[data-settings-category="common"]').click();
      const privacy = page.locator('.settings-privacy-panel');
      await privacy.getByRole('checkbox', { name: '隐藏主机与 IP 地址' }).click();
      await expect(page.getByText('主机与 IP 地址已隐藏。')).toBeVisible();
      const behavior = page.locator('.behavior-settings');
      await expect(behavior.getByRole('heading', { name: '启动、文件与无障碍' })).toBeVisible();
      const refreshOnFocus = behavior.getByRole('checkbox', {
        name: '打开 SFTP 时刷新本地与远端文件',
      });
      await refreshOnFocus.click();
      await expect(refreshOnFocus).toBeChecked();
      const followTerminalCwd = behavior.getByRole('checkbox', {
        name: '保持 SFTP 路径与 SSH 终端目录同步',
      });
      await followTerminalCwd.click();
      await expect(followTerminalCwd).toBeChecked();
      const splitSftp = behavior.getByRole('checkbox', {
        name: '以分栏视图打开 SSH 文件管理',
      });
      await splitSftp.click();
      await expect(splitSftp).toBeChecked();
      const screenReader = behavior.getByRole('checkbox', {
        name: '启用终端屏幕阅读器支持',
      });
      await screenReader.click();
      await expect(screenReader).toBeChecked();
      await behavior.getByLabel('外部编辑器可执行文件').fill('/usr/bin/vi');
      await behavior.getByRole('button', { name: '保存编辑器' }).click();
      await expect(behavior.getByRole('status')).toHaveText('设置已保存。');
      await page.locator('[data-activity-item="bookmarks"]').click();
      await page.getByTitle('新建会话菜单', { exact: true }).click();
      const sessionMenu = page.locator('.session-menu');
      await expect(sessionMenu).toContainText('operator@192.168.*.*:22');
      await expect(sessionMenu).not.toContainText('192.168.100.25');
      await page.keyboard.press('Escape');
      await page.locator('[data-activity-item="setting"]').click();

      const terminal = categories.locator('[data-settings-category="terminal"]');
      await terminal.focus();
      await terminal.press('End');
      await expect(categories.locator('[data-settings-category="legal"]')).toBeFocused();
      await categories.locator('[data-settings-category="legal"]').press('ArrowUp');
      await expect(categories.locator('[data-settings-category="password"]')).toBeFocused();
      const credentialList = page.getByRole('region', { name: /本地凭据|保存的凭据/ });
      await expect(credentialList).toContainText('尚未保存凭据');
      await expect(credentialList).toContainText('凭据原文不会回显');

      const search = categories.getByLabel('搜索设置');
      await search.fill('webdav');
      await expect(categories.locator('[data-settings-category="sync"]')).toBeVisible();
      await expect(categories.locator('[data-settings-category="terminal"]')).toHaveCount(0);
      await categories.locator('[data-settings-category="sync"]').click();
      await expect(page.getByRole('heading', { name: '设置同步', level: 1 })).toBeVisible();
      await search.fill('missing category');
      await expect(categories).toContainText('没有匹配的设置分类');
    } finally {
      await app.close().catch(() => {});
      await rm(userData, { recursive: true, force: true });
    }
  });

  test('opens the configured local bookmark set at startup and keeps bookmark titles', async () => {
    const userData = await mkdtemp(resolve(tmpdir(), 'axterm-startup-sessions-e2e-'));
    await mkdir(resolve(userData, 'data-v2'), { recursive: true });
    const database = await ProductDatabase.open(resolve(userData, 'data-v2', 'axterm.sqlite'));
    try {
      const products = new ProductRepository(database);
      const bookmarks = new BookmarkRepository(database);
      const ids: string[] = [];
      for (const title of ['Startup Alpha', 'Startup Beta']) {
        const before = new Set(bookmarks.snapshot().bookmarks.map(({ id }) => id));
        const tree = bookmarks.createBookmark(
          {
            groupId: null,
            protocol: 'local',
            hostId: null,
            title,
            color: null,
            description: 'Startup session E2E fixture',
            profileId: null,
            connectionProfileId: null,
            quickCommands: [],
            triggers: [],
            ftp: null,
            telnet: null,
            serial: null,
            rdp: null,
            vnc: null,
            spice: null,
            web: null,
          },
          bookmarks.snapshot().etag,
        );
        ids.push(tree.bookmarks.find(({ id }) => !before.has(id))!.id);
      }
      products.updateSettings(
        { workspace: { restoreLayout: false, startupSessions: ids } },
        etagFor(products.getSettings().version),
      );
    } finally {
      database.close();
    }

    const app = await electron.launch({
      executablePath,
      args: [resolve('apps/desktop'), `--user-data-dir=${userData}`],
      env: { ...process.env, ELECTRON_RENDERER_URL: '' },
    });
    try {
      const page = await app.firstWindow();
      await expect(page.getByTestId('runtime-state')).toHaveAttribute('data-state', 'ready');
      const tabs = page.locator('.workspace-tab.terminal-tab');
      await expect(tabs).toHaveCount(2);
      await expect(tabs.filter({ hasText: 'Startup Alpha' })).toHaveCount(1);
      await expect(tabs.filter({ hasText: 'Startup Beta' })).toHaveCount(1);
    } finally {
      await app.close().catch(() => {});
      await rm(userData, { recursive: true, force: true });
    }
  });

  test('recreates stale sessions from the configured startup workspace', async () => {
    const userData = await mkdtemp(resolve(tmpdir(), 'axterm-startup-workspace-e2e-'));
    await mkdir(resolve(userData, 'data-v2'), { recursive: true });
    const database = await ProductDatabase.open(resolve(userData, 'data-v2', 'axterm.sqlite'));
    try {
      const products = new ProductRepository(database);
      const bookmarks = new BookmarkRepository(database);
      const tree = bookmarks.createBookmark(
        {
          groupId: null,
          protocol: 'local',
          hostId: null,
          title: 'Workspace Shell',
          color: null,
          description: 'Startup workspace E2E fixture',
          profileId: null,
          connectionProfileId: null,
          quickCommands: [],
          triggers: [],
          ftp: null,
          telnet: null,
          serial: null,
          rdp: null,
          vnc: null,
          spice: null,
          web: null,
        },
        bookmarks.snapshot().etag,
      );
      const bookmarkId = tree.bookmarks[0]!.id;
      const workspaceId = 'ac35f11f-2654-4b09-915f-f41c1d6f7129';
      const staleTerminalId = '7cef64b6-6a80-47ee-b052-52988602806a';
      const now = new Date().toISOString();
      products.updateSettings(
        {
          workspace: {
            restoreLayout: true,
            startupSessions: workspaceId,
            namedWorkspaces: [
              {
                id: workspaceId,
                name: 'Startup Operations',
                createdAt: now,
                updatedAt: now,
                layout: {
                  section: 'hosts',
                  sidebarOpen: true,
                  split: false,
                  tabs: [
                    {
                      id: staleTerminalId,
                      title: 'Workspace Shell',
                      kind: 'local',
                      bookmarkId,
                      pinned: false,
                      paneIndex: 0,
                    },
                  ],
                  activeTerminalId: staleTerminalId,
                  secondaryTerminalId: null,
                  layoutMode: 'c1',
                  paneTerminalIds: [staleTerminalId],
                  focusedPane: 0,
                },
              },
            ],
          },
        },
        etagFor(products.getSettings().version),
      );
    } finally {
      database.close();
    }

    const app = await electron.launch({
      executablePath,
      args: [resolve('apps/desktop'), `--user-data-dir=${userData}`],
      env: { ...process.env, ELECTRON_RENDERER_URL: '' },
    });
    try {
      const page = await app.firstWindow();
      await expect(page.getByTestId('runtime-state')).toHaveAttribute('data-state', 'ready');
      await expect(page.locator('.workspace-tab.terminal-tab')).toHaveCount(1);
      await expect(page.locator('.workspace-tab.terminal-tab')).toContainText('Workspace Shell');
      await expect(page.locator('.terminal-host')).toHaveAttribute(
        'data-connection-state',
        'connected',
      );
    } finally {
      await app.close().catch(() => {});
      await rm(userData, { recursive: true, force: true });
    }
  });
});

test.describe('H-11 localization', () => {
  test('switches each retained language immediately and persists the selection', async () => {
    const userData = await mkdtemp(resolve(tmpdir(), 'axterm-localization-e2e-'));
    let app = await electron.launch({
      executablePath,
      args: [resolve('apps/desktop'), `--user-data-dir=${userData}`],
      env: { ...process.env, ELECTRON_RENDERER_URL: '' },
    });
    try {
      let page = await app.firstWindow();
      await expect(page.getByTestId('runtime-state')).toHaveAttribute('data-state', 'ready');
      await expect(page.locator('html')).toHaveAttribute('lang', 'zh-CN');
      await page.locator('[data-activity-item="setting"]').click();
      await page.locator('[data-settings-category="common"]').click();
      const language = page.getByTestId('application-language');
      await expect(language.locator('option')).toHaveCount(4);
      await expect(
        page.getByText('导航标签支持全部 4 种语言；其他文案在缺少翻译时回退到英文。'),
      ).toBeVisible();
      await language.selectOption('en');
      await expect(page.locator('html')).toHaveAttribute('lang', 'en');
      await expect(page.locator('html')).toHaveAttribute('dir', 'ltr');
      await expect(page.locator('[data-activity-item="setting"]')).toBeVisible();
      await expect(page.locator('[data-settings-category="common"]')).toHaveText('General');
      await expect(page.getByRole('heading', { name: 'Runtime status' })).toBeVisible();
      await expect(
        page.getByText(
          'Navigation labels are available in all four supported languages. Other text falls back to English when a translation is unavailable.',
        ),
      ).toBeVisible();
      await page.getByRole('button', { name: 'Close settings and return to workspace' }).click();
      await page.locator('.tab-add-menu:visible').first().click();
      await expect(page.locator('.session-menu')).toContainText('Local terminal');
      await expect(page.locator('.session-menu')).toContainText('Use the platform default shell');
      await page.keyboard.press('Escape');

      await app.close();
      app = await electron.launch({
        executablePath,
        args: [resolve('apps/desktop'), `--user-data-dir=${userData}`],
        env: { ...process.env, ELECTRON_RENDERER_URL: '' },
      });
      page = await app.firstWindow();
      await expect(page.getByTestId('runtime-state')).toHaveAttribute('data-state', 'ready');
      await expect(page.locator('html')).toHaveAttribute('lang', 'en');
      const settingsButton = page.locator('[data-activity-item="setting"]');
      await expect(settingsButton).toBeVisible();
      await settingsButton.click();
      await page.locator('[data-settings-category="common"]').click();
      await page.getByTestId('application-language').selectOption('ja');
      await expect(page.locator('html')).toHaveAttribute('lang', 'ja');
      await expect(page.locator('html')).toHaveAttribute('dir', 'ltr');
      await expect(page.locator('[data-settings-category="common"]')).toHaveText('全般');
      await expect(page.getByRole('heading', { name: 'ランタイムの状態' })).toBeVisible();
      await expect(
        page.getByText(
          'アプリケーションの表示言語を選択します。変更はすぐに反映され、保存されます。',
        ),
      ).toBeVisible();
      await expect(
        page.getByText(
          'ナビゲーションのラベルは、対応する4言語すべてで利用できます。翻訳がないその他のテキストは英語で表示されます。',
        ),
      ).toBeVisible();
      await page.locator('[data-settings-category="shortcuts"]').click();
      await expect(
        page.getByRole('heading', { name: 'ショートカット', exact: true }),
      ).toBeVisible();
      await expect(page.getByText('物理キーの組み合わせを入力します。')).toBeVisible();
      await expect(
        page.getByRole('table', { name: 'ショートカット アクション レジストリ' }),
      ).toBeVisible();
      await page.locator('[data-settings-category="common"]').click();
      await page.locator('[data-settings-category="terminal"]').click();
      await expect(
        page.getByPlaceholder('空欄のままにするとプラットフォームの既定シェルを使用します'),
      ).toBeVisible();
      const japaneseRecovery = page.locator('.terminal-recovery-settings-panel');
      await expect(
        japaneseRecovery.getByRole('heading', { name: 'ターミナルの操作と復旧', exact: true }),
      ).toBeVisible();
      await expect(japaneseRecovery).toContainText(
        '自動再接続は、確立済みの SSH セッションが予期せず切断された後にのみ行われます。',
      );
      await page.locator('[data-settings-category="common"]').click();
      await expect(page.getByTestId('data-migration-deprecation')).toContainText(
        '移行に関するお知らせ',
      );
      await expect(page.getByRole('region', { name: 'Axterm 設定スナップショット' })).toBeVisible();
      await expect(
        page.getByText(
          '接続、すべてのブックマークプロトコル、プロファイル、コマンド、カスタムテーマ、トリガー、設定を Axterm 独自形式でエクスポートします。',
        ),
      ).toBeVisible();
      await expect(
        page.getByRole('heading', { name: '起動、ファイル、アクセシビリティ' }),
      ).toBeVisible();
      await expect(
        page.getByPlaceholder('空欄のままにするとシステムの既定値を使用します'),
      ).toBeVisible();
      await page.getByRole('button', { name: 'ターミナルプロファイル' }).click();
      await expect(page.getByRole('region', { name: '接続プロファイル' })).toBeVisible();
      await expect(page.getByPlaceholder('検索')).toBeVisible();
      await expect(page.getByRole('region', { name: '接続プロファイル' })).toContainText(
        'プロトコル間でユーザー名と認証情報を再利用します。ブックマークではターミナルプロファイルと接続プロファイルを個別に選択できます。',
      );
      await page.locator('[data-activity-item="bookmarks"]').click();
      await expect(page.getByRole('heading', { name: 'ホストと接続' })).toBeVisible();
      const japaneseBookmarkTree = page.getByRole('region', { name: 'ブックマークツリー' });
      await expect(japaneseBookmarkTree).toBeVisible();
      await expect(
        japaneseBookmarkTree.getByRole('textbox', { name: 'ブックマークを検索' }),
      ).toBeVisible();
      await expect(page.getByPlaceholder('名前、アドレス、またはユーザーで検索')).toBeVisible();
      await expect(
        page.getByText('最初の SSH ホストを追加するか、SSH 設定をインポートしてください。'),
      ).toBeVisible();
      await page.getByRole('button', { name: 'ホストを追加' }).click();
      const japaneseHostDialog = page.getByRole('dialog', { name: 'SSH ホストを追加' });
      await expect(japaneseHostDialog).toBeVisible();
      await japaneseHostDialog.getByRole('tab', { name: '認証' }).click();
      await expect(
        japaneseHostDialog.getByText(
          'SSH の接続先と認証を設定します。保存した認証情報は Axterm のアプリケーションローカル Vault に保存されます。',
        ),
      ).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(japaneseHostDialog).toBeHidden();
      await page.getByRole('button', { name: 'FTP を追加' }).click();
      const japaneseFtpDialog = page.getByRole('dialog', { name: 'FTP/FTPS ブックマークを追加' });
      await expect(japaneseFtpDialog).toBeVisible();
      await expect(
        japaneseFtpDialog.getByText(
          'パスワードは Axterm のアプリケーションローカル認証情報ストアにのみ保存されます。ブックマークデータベースには参照だけが保存されます。',
        ),
      ).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(japaneseFtpDialog).toBeHidden();
      await openSettingsSync(page);
      await expect(page.getByTestId('legacy-sync-deprecation')).toContainText(
        'Axterm がこれを黙って削除することはありません。',
      );
      await expect(page.getByRole('tablist', { name: '同期サービス' })).toBeVisible();
      await page.getByRole('tab', { name: 'Gitee Gist' }).click();
      await expect(
        page.getByText(
          'Gitee API のレート制限と ETag サポートは GitHub より弱いため、アップロード前にコンテンツバージョンを再比較します。',
        ),
      ).toBeVisible();
      await page.locator('.settings-workspace-close.right').click();
      await page.locator('.batch-input-trigger').click();
      const japaneseBatchInput = page.getByRole('region', { name: '一括入力パネル' });
      await expect(japaneseBatchInput).toContainText(
        '選択したターミナルへ一度に送信します。フォーカスは現在のターミナルに残ります。',
      );
      await expect(
        japaneseBatchInput.getByRole('textbox', { name: '一括コマンド' }),
      ).toHaveAttribute(
        'placeholder',
        'コマンドを入力してください。Enter で送信し、Shift+Enter で改行します',
      );
      await japaneseBatchInput.getByRole('button', { name: '一括入力を閉じる' }).click();
      await page.locator('.workspace-tab.terminal-tab.active:visible').click();
      const japaneseTerminal = page.locator('.terminal-session-layer:not([hidden])');
      await japaneseTerminal
        .locator('.xterm-helper-textarea')
        .press(process.platform === 'darwin' ? 'Meta+f' : 'Control+f');
      await expect(japaneseTerminal.getByPlaceholder('ターミナル出力を検索')).toBeVisible();
      await japaneseTerminal.getByRole('button', { name: '検索を閉じる' }).click();
      await japaneseTerminal.locator('.xterm-screen').click({ button: 'right' });
      const japaneseTerminalMenu = page.getByRole('menu', { name: 'ターミナルメニュー' });
      await expect(japaneseTerminalMenu).toBeVisible();
      await expect(japaneseTerminalMenu.getByRole('menuitem', { name: 'AI で説明' })).toBeVisible();
      await expect(
        japaneseTerminalMenu.getByRole('menuitem', { name: 'XMODEM でファイルを送信' }),
      ).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(japaneseTerminalMenu).toBeHidden();
      await page.locator('[data-activity-item="setting"]').click();
      await page.locator('[data-settings-category="common"]').click();
      await page.getByTestId('application-language').selectOption('zh-TW');
      await expect(page.locator('html')).toHaveAttribute('lang', 'zh-TW');
      await expect(page.getByRole('heading', { name: '執行環境狀態' })).toBeVisible();
      await expect(page.getByText('選擇應用程式介面語言；變更會立即生效並保存。')).toBeVisible();
      await expect(
        page.getByText('導覽標籤支援全部 4 種語言；其他文案在沒有翻譯時會回退為英文。'),
      ).toBeVisible();
      await page.locator('[data-settings-category="shortcuts"]').click();
      await expect(page.getByRole('heading', { name: '快速鍵', exact: true })).toBeVisible();
      await expect(page.getByText('擷取實體按鍵組合。')).toBeVisible();
      await expect(page.getByRole('table', { name: '快速鍵動作登錄表' })).toBeVisible();
      await page.locator('[data-settings-category="common"]').click();
      await page.locator('[data-settings-category="terminal"]').click();
      await expect(page.getByPlaceholder('留空以使用平台預設 Shell')).toBeVisible();
      const traditionalChineseRecovery = page.locator('.terminal-recovery-settings-panel');
      await expect(
        traditionalChineseRecovery.getByRole('heading', { name: '終端機互動與復原', exact: true }),
      ).toBeVisible();
      await expect(traditionalChineseRecovery).toContainText(
        '自動重新連線只會在已建立的 SSH 工作階段意外中斷後套用。',
      );
      await page.locator('[data-settings-category="common"]').click();
      await expect(page.getByTestId('data-migration-deprecation')).toContainText('憑證祕密');
      await expect(page.getByRole('region', { name: 'Axterm 設定快照' })).toBeVisible();
      await expect(
        page.getByText(
          '以 Axterm 自有格式匯出連線、所有書籤協定、設定檔、命令、自訂主題、觸發器與設定。',
        ),
      ).toBeVisible();
      await expect(page.getByRole('heading', { name: '啟動、檔案與無障礙功能' })).toBeVisible();
      await expect(page.getByPlaceholder('留空以使用系統預設值')).toBeVisible();
      await page.getByRole('button', { name: '終端機設定檔' }).click();
      await expect(page.getByRole('region', { name: '連線設定檔' })).toBeVisible();
      await expect(page.getByPlaceholder('搜尋')).toBeVisible();
      await expect(page.getByRole('region', { name: '連線設定檔' })).toContainText(
        '在各協定間重複使用使用者名稱與憑證。書籤可以分別選取終端機和連線設定檔。',
      );
      await page.locator('[data-activity-item="bookmarks"]').click();
      await expect(page.getByRole('heading', { name: '主機與連線' })).toBeVisible();
      const traditionalChineseBookmarkTree = page.getByRole('region', { name: '書籤樹' });
      await expect(traditionalChineseBookmarkTree).toBeVisible();
      await expect(
        traditionalChineseBookmarkTree.getByRole('textbox', { name: '搜尋書籤' }),
      ).toBeVisible();
      await expect(page.getByPlaceholder('依名稱、位址或使用者搜尋')).toBeVisible();
      await expect(page.getByText('新增第一個 SSH 主機或匯入 SSH 設定。')).toBeVisible();
      await page.getByRole('button', { name: '新增主機' }).click();
      const traditionalChineseHostDialog = page.getByRole('dialog', { name: '新增 SSH 主機' });
      await expect(traditionalChineseHostDialog).toBeVisible();
      await traditionalChineseHostDialog.getByRole('tab', { name: '驗證' }).click();
      await expect(
        traditionalChineseHostDialog.getByText(
          '設定 SSH 目的地與驗證。已儲存的憑證會寫入 Axterm 的應用程式本機 Vault。',
        ),
      ).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(traditionalChineseHostDialog).toBeHidden();
      await page.getByRole('button', { name: '新增 FTP' }).click();
      const traditionalChineseFtpDialog = page.getByRole('dialog', {
        name: '新增 FTP/FTPS 書籤',
      });
      await expect(traditionalChineseFtpDialog).toBeVisible();
      await expect(
        traditionalChineseFtpDialog.getByText(
          '密碼只會保留在 Axterm 應用程式本機憑證存放區。書籤資料庫只會儲存參照。',
        ),
      ).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(traditionalChineseFtpDialog).toBeHidden();
      await openSettingsSync(page);
      await expect(page.getByTestId('legacy-sync-deprecation')).toContainText('不會悄悄刪除');
      await expect(page.getByRole('tablist', { name: '同步服務' })).toBeVisible();
      await page.getByRole('tab', { name: 'Gitee Gist' }).click();
      await expect(
        page.getByText('Gitee API 的速率限制與 ETag 支援比 GitHub 弱。上傳前會再次比較內容版本。'),
      ).toBeVisible();
      await page.locator('.settings-workspace-close.right').click();
      await page.locator('.batch-input-trigger').click();
      const traditionalChineseBatchInput = page.getByRole('region', { name: '批次輸入面板' });
      await expect(traditionalChineseBatchInput).toContainText(
        '一次傳送至選取的終端機；焦點會停留在目前終端機。',
      );
      await expect(
        traditionalChineseBatchInput.getByRole('textbox', { name: '批次命令' }),
      ).toHaveAttribute('placeholder', '輸入命令；Enter 傳送，Shift+Enter 新增一行');
      await traditionalChineseBatchInput.getByRole('button', { name: '關閉批次輸入' }).click();
      await page.locator('.workspace-tab.terminal-tab.active:visible').click();
      const traditionalChineseTerminal = page.locator('.terminal-session-layer:not([hidden])');
      await traditionalChineseTerminal
        .locator('.xterm-helper-textarea')
        .press(process.platform === 'darwin' ? 'Meta+f' : 'Control+f');
      await expect(traditionalChineseTerminal.getByPlaceholder('搜尋終端機輸出')).toBeVisible();
      await traditionalChineseTerminal.getByRole('button', { name: '關閉搜尋' }).click();
      await traditionalChineseTerminal.locator('.xterm-screen').click({ button: 'right' });
      const traditionalChineseTerminalMenu = page.getByRole('menu', { name: '終端機選單' });
      await expect(traditionalChineseTerminalMenu).toBeVisible();
      await expect(
        traditionalChineseTerminalMenu.getByRole('menuitem', { name: '使用 AI 說明' }),
      ).toBeVisible();
      await expect(
        traditionalChineseTerminalMenu.getByRole('menuitem', { name: '使用 XMODEM 傳送檔案' }),
      ).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(traditionalChineseTerminalMenu).toBeHidden();
    } finally {
      await app.close().catch(() => {});
      await rm(userData, { recursive: true, force: true });
    }
  });
});

test.describe('H-09/H-10 setting sync', () => {
  test('uses the local Vault with a real WebDAV server, comparison, review and conflict flows', async () => {
    const userData = await mkdtemp(resolve(tmpdir(), 'axterm-setting-sync-e2e-'));
    const backupPath = resolve(userData, 'legacy-remote-backup.json');
    const webdav = await startSyncWebDavFixture();
    const secret = 'H09_LOCAL_VAULT_WEBDAV_SECRET';
    const app = await electron.launch({
      executablePath,
      args: [resolve('apps/desktop'), `--user-data-dir=${userData}`],
      env: { ...process.env, ELECTRON_RENDERER_URL: '' },
    });
    try {
      await app.evaluate(({ dialog }, selectedPath) => {
        dialog.showSaveDialog = (() =>
          Promise.resolve({
            canceled: false,
            filePath: selectedPath,
          })) as typeof dialog.showSaveDialog;
      }, backupPath);
      const page = await app.firstWindow();
      await expect(page.getByTestId('runtime-state')).toHaveAttribute('data-state', 'ready');
      await page.locator('[data-activity-item="setting"]').click();
      await page
        .getByRole('complementary', { name: '设置项目' })
        .locator('[data-settings-category="sync"]')
        .click();
      const panel = page.getByRole('region', { name: '设置同步' });
      await panel.getByRole('tab', { name: 'WebDAV' }).click();
      await panel.getByLabel('服务地址').fill(webdav.endpoint);
      await panel.getByLabel('远程文件名').fill('desktop.json');
      await panel.getByLabel('用户名').fill('operator');
      await panel.getByLabel('WebDAV 密码').fill(secret);
      await panel.getByRole('button', { name: '保存配置' }).click();
      await expect(panel.getByText('同步配置已保存；凭据只保存在应用本地 Vault。')).toBeVisible();

      await panel.getByRole('button', { name: '测试', exact: true }).click();
      await expect(panel.getByText('连接成功，远程尚无同步数据。')).toBeVisible();
      await panel.getByRole('button', { name: '上传', exact: true }).click();
      await expect(panel.getByText('所选分类已上传。')).toBeVisible();
      expect(webdav.contents).toContain('"formatVersion":1');

      const remoteBeforeBackup = webdav.contents;
      if (!remoteBeforeBackup) throw new Error('WebDAV fixture has no remote sync document');
      await expect(panel.getByText(/原样副本.*隐私数据/)).toBeVisible();
      await panel.getByRole('button', { name: '备份远端文件' }).click();
      await expect(panel.getByText(/远端同步文件已保存到本地/)).toBeVisible();
      expect(await readFile(backupPath, 'utf8')).toBe(remoteBeforeBackup);
      await expect(panel.locator('.data-sync-message')).toContainText(
        createHash('sha256').update(remoteBeforeBackup).digest('hex'),
      );
      expect(webdav.contents).toBe(remoteBeforeBackup);

      await panel.getByRole('button', { name: '比较', exact: true }).click();
      const comparison = panel.getByRole('region', { name: '同步比较结果' });
      await expect(comparison).toBeVisible();
      await expect(comparison.locator('.compare-equal')).toHaveCount(8);

      webdav.armConflict();
      await panel.getByRole('button', { name: '上传', exact: true }).click();
      await expect(
        panel.getByText('Remote sync data changed; compare again before uploading'),
      ).toBeVisible();
      await expect(panel.locator('.data-sync-status')).toContainText('SYNC_REMOTE_CONFLICT');

      webdav.mutateSettingsTheme('light');
      await panel.getByRole('button', { name: '下载', exact: true }).click();
      const preview = panel.getByRole('region', { name: /同步下载预览|下载预览/ });
      await expect(preview).toBeVisible();
      await expect(preview).toContainText('Application settings');
      await preview.getByRole('button', { name: '确认应用' }).click();
      await expect(panel.getByText('远程数据已按预览提交。')).toBeVisible();

      expect(
        await page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage })),
      ).not.toContain(secret);
      page.once('dialog', (dialog) => dialog.accept());
      await panel.getByRole('button', { name: '删除', exact: true }).click();
      await expect(panel.getByText('同步配置已删除。')).toBeVisible();
    } finally {
      await app.close().catch(() => {});
      await webdav.close();
      await rm(userData, { recursive: true, force: true });
    }
  });

  test('backs up legacy WebDAV data before recovering all Axterm configuration categories through an isolated profile', async () => {
    const userData = await mkdtemp(resolve(tmpdir(), 'axterm-sync-format-migration-e2e-'));
    const backupPath = resolve(userData, 'legacy-format-backup.json');
    const webdav = await startDualFormatSyncWebDavFixture();
    const secret = 'H09_AXTERM_FORMAT_MIGRATION_SECRET';
    const databasePath = resolve(userData, 'data-v2', 'axterm.sqlite');
    let sourceThemeId: string;
    let sourceConnectionProfileId: string;
    let sourceTerminalProfileId: string;
    let sourceTunnelProfileId: string;
    let sourceHostId: string;
    const sourceAddressBookmarkId = randomUUID();
    const sourceWorkspaceId = randomUUID();
    const sourceWorkspaceTabId = randomUUID();
    let sourceTriggerId: string;
    await mkdir(resolve(userData, 'data-v2'), { recursive: true });
    const seedDatabase = await ProductDatabase.open(databasePath);
    try {
      const seedProducts = new ProductRepository(seedDatabase);
      const seedCommands = new QuickCommandRepository(seedDatabase);
      let tree = seedCommands.snapshot();
      tree = seedCommands.createGroup({ parentId: null, name: 'Axterm 远端恢复命令' }, tree.etag);
      const group = tree.groups.find(({ name }) => name === 'Axterm 远端恢复命令');
      if (!group) throw new Error('Quick Command recovery folder was not created');
      seedCommands.createCommand(
        {
          groupId: group.id,
          name: '恢复诊断',
          command: "printf 'AXTERM_SYNC_RECOVERY'",
          commands: [
            {
              id: randomUUID(),
              name: '输出标记',
              command: "printf 'AXTERM_SYNC_RECOVERY'",
              delayMs: 100,
            },
            {
              id: randomUUID(),
              name: '检查状态',
              command: 'printf STATUS_OK',
              delayMs: 250,
            },
          ],
          description: 'Axterm 同步恢复测试',
          tags: ['recovery', 'sync'],
          shortcut: null,
          inputOnly: true,
          clickCount: 0,
        },
        tree.etag,
      );
      const sourceTheme = new TerminalThemeRepository(seedProducts).create({
        ...structuredClone(AXTERM_TERMINAL_THEMES[0]),
        name: 'Axterm 远端恢复主题',
        terminal: {
          ...structuredClone(AXTERM_TERMINAL_THEMES[0].terminal),
          foreground: '#dff9ec',
          background: '#10251f',
          cursor: '#5ee0b4',
        },
        ui: {
          ...structuredClone(AXTERM_TERMINAL_THEMES[0].ui),
          primary: '#2fc7a1',
        },
      });
      sourceThemeId = sourceTheme.id;
      const sourceConnectionProfile = new ConnectionProfileRepository(seedDatabase).create(
        connectionProfileInputSchema.parse({
          name: 'Axterm 远端恢复连接配置',
          isDefault: false,
          ssh: { username: 'profile-recovery-user' },
        }),
      );
      sourceConnectionProfileId = sourceConnectionProfile.id;
      const sourceTerminalProfile = seedProducts.createJson(
        'terminal_profiles',
        terminalProfileInputSchema.parse({
          name: 'Axterm 远端恢复终端配置',
          fontSize: 15,
          scrollback: 4_321,
          env: { AXTERM_SYNC_PROFILE: 'restored' },
        }),
        'terminal-profile',
      );
      sourceTerminalProfileId = sourceTerminalProfile.id;
      const settings = seedProducts.getSettings();
      seedProducts.updateSettings(
        {
          terminal: {
            defaultProfileId: sourceTerminalProfile.id,
            visual: { ...settings.terminal.visual, themeId: sourceTheme.id },
          },
        },
        etagFor(settings.version),
      );
    } finally {
      seedDatabase.close();
    }
    const app = await electron.launch({
      executablePath,
      args: [resolve('apps/desktop'), `--user-data-dir=${userData}`],
      env: { ...process.env, ELECTRON_RENDERER_URL: '' },
    });
    try {
      await app.evaluate(({ dialog }, selectedPath) => {
        dialog.showSaveDialog = (() =>
          Promise.resolve({
            canceled: false,
            filePath: selectedPath,
          })) as typeof dialog.showSaveDialog;
      }, backupPath);
      const page = await app.firstWindow();
      await expect(page.getByTestId('runtime-state')).toHaveAttribute('data-state', 'ready');
      await page.locator('[data-activity-item="bookmarks"]').click();
      await page.locator('.workspace-sidebar').getByRole('button', { name: '管理' }).click();
      await page.getByRole('button', { name: '添加主机' }).click();
      await page.getByLabel('显示名称').fill('Axterm 远端恢复主机');
      await page.getByLabel('主机地址').fill('recovery.example.test');
      await page.getByLabel('用户名').fill('recovery-user');
      await page.getByLabel('认证方式').selectOption('agent');
      await page.getByRole('button', { name: '保存', exact: true }).click();
      const recoveryHost = page.locator('.host-card').filter({ hasText: 'Axterm 远端恢复主机' });
      await expect(recoveryHost).toBeVisible();
      const relationDatabase = await ProductDatabase.open(databasePath);
      try {
        const relationProducts = new ProductRepository(relationDatabase);
        const host = relationProducts
          .listHosts()
          .find(({ name }) => name === 'Axterm 远端恢复主机');
        const relationBookmarks = new BookmarkRepository(relationDatabase);
        const tree = relationBookmarks.snapshot();
        const bookmark = tree.bookmarks.find(({ title }) => title === 'Axterm 远端恢复主机');
        if (!host || !bookmark) throw new Error('Profile recovery host/bookmark is missing');
        sourceHostId = host.id;
        relationBookmarks.updateBookmark(
          bookmark.id,
          {
            profileId: sourceTerminalProfileId,
            connectionProfileId: sourceConnectionProfileId,
          },
          tree.etag,
        );
        const tunnel = relationProducts.createJson(
          'tunnel_profiles',
          tunnelProfileInputSchema.parse({
            name: 'Axterm 远端恢复隧道',
            hostId: host.id,
            type: 'local',
            bindHost: '127.0.0.1',
            bindPort: 41_023,
            targetHost: '127.0.0.1',
            targetPort: 22,
            allowNonLoopback: false,
          }),
          'tunnel-profile',
        );
        sourceTunnelProfileId = tunnel.id;
        const sourceTriggerRepository = new TriggerRepository(relationDatabase);
        const sourceTriggers = sourceTriggerRepository.create(
          triggerRuleInputSchema.parse({
            name: 'Axterm 远端恢复触发器',
            enabled: true,
            match: { type: 'regex', value: 'AXTERM_RECOVERY_PROMPT$', caseSensitive: true },
            action: { type: 'send', value: "printf 'AXTERM_TRIGGER_RECOVERED'" },
            sendEnter: true,
            mode: 'cooldown',
            cooldownMs: 2_500,
          }),
          sourceTriggerRepository.snapshot().etag,
        );
        const sourceTrigger = sourceTriggers.triggers.find(
          ({ name }) => name === 'Axterm 远端恢复触发器',
        );
        if (!sourceTrigger) throw new Error('Trigger recovery seed was not created');
        sourceTriggerId = sourceTrigger.id;
        const sourceSettings = relationProducts.getSettings();
        const workspaceLayout = {
          section: 'hosts' as const,
          contentSurface: 'terminal' as const,
          sidebarOpen: true,
          split: false,
          tabs: [
            {
              id: sourceWorkspaceTabId,
              title: 'Axterm 远端恢复会话',
              kind: 'ssh' as const,
              hostId: host.id,
              bookmarkId: bookmark.id,
              profileId: sourceTerminalProfileId,
              visual: {
                themeId: sourceThemeId,
                background: structuredClone(DEFAULT_TERMINAL_BACKGROUND),
              },
              pinned: true,
              paneIndex: 0,
            },
          ],
          activeTerminalId: sourceWorkspaceTabId,
          secondaryTerminalId: null,
          layoutMode: 'c1' as const,
          paneTerminalIds: [sourceWorkspaceTabId],
          focusedPane: 0,
        };
        const now = new Date().toISOString();
        relationProducts.updateSettings(
          {
            workspace: {
              restoreLayout: true,
              aiInspectorOpen: true,
              layout: workspaceLayout,
              namedWorkspaces: [
                {
                  id: sourceWorkspaceId,
                  name: 'Axterm 远端恢复工作区',
                  layout: workspaceLayout,
                  createdAt: now,
                  updatedAt: now,
                },
              ],
              activeWorkspaceId: sourceWorkspaceId,
              startupSessions: [bookmark.id],
              showTabNumber: false,
              switchTabOnHover: true,
            },
            fileManager: {
              remoteAddressBookmarks: [
                {
                  id: sourceAddressBookmarkId,
                  hostId: host.id,
                  path: '/srv/axterm-sync-recovery',
                },
              ],
            },
          },
          etagFor(sourceSettings.version),
        );
      } finally {
        relationDatabase.close();
      }
      await page.locator('[data-activity-item="setting"]').click();
      await page
        .getByRole('complementary', { name: '设置项目' })
        .locator('[data-settings-category="sync"]')
        .click();
      const panel = page.getByRole('region', { name: '设置同步' });
      await panel.getByRole('tab', { name: 'WebDAV' }).click();
      await panel.getByLabel('服务地址').fill(webdav.endpoint);
      await panel.getByLabel('远程文件名').fill('desktop.json');
      await panel.getByLabel('用户名').fill('operator');
      await panel.getByLabel('WebDAV 密码').fill(secret);
      await panel.getByRole('button', { name: '保存配置' }).click();
      await expect(panel.getByText('同步配置已保存；凭据只保存在应用本地 Vault。')).toBeVisible();

      await panel.getByRole('button', { name: '上传', exact: true }).click();
      await expect(panel.getByText('所选分类已上传。')).toBeVisible();
      const legacyRemote = webdav.legacyContents;
      if (!legacyRemote) throw new Error('Legacy WebDAV document was not created');
      expect(JSON.parse(legacyRemote)).toMatchObject({
        formatVersion: 1,
        encrypted: false,
        document: { formatVersion: 1 },
      });

      await panel.getByRole('tab', { name: 'Axterm 同步格式' }).click();
      const migration = panel.getByLabel('创建独立 Axterm 同步配置');
      await expect(migration).toBeVisible();
      await migration.getByRole('button', { name: '备份旧远端并创建 Axterm 配置' }).click();
      await expect(panel.locator('.data-sync-message')).toContainText('旧远端已保存到本地');
      await expect(panel.getByRole('tab', { name: 'Axterm 同步格式' })).toHaveAttribute(
        'aria-selected',
        'true',
      );
      expect(await readFile(backupPath, 'utf8')).toBe(legacyRemote);
      expect(webdav.legacyContents).toBe(legacyRemote);
      expect(webdav.legacyWriteCount).toBe(1);

      await panel.getByRole('button', { name: '上传', exact: true }).click();
      await expect(panel.getByText('所选分类已上传。')).toBeVisible();
      await expect.poll(() => webdav.axtermContents).not.toBeNull();
      const axtermRemote = webdav.axtermContents;
      if (!axtermRemote) throw new Error('Axterm WebDAV document was not created');
      expect(JSON.parse(axtermRemote)).toMatchObject({
        formatVersion: 1,
        encrypted: false,
        document: {
          format: 'axterm-sync',
          formatVersion: 1,
          categories: {
            bookmarks: {
              value: {
                hosts: [
                  expect.objectContaining({
                    id: sourceHostId,
                    name: 'Axterm 远端恢复主机',
                    hostname: 'recovery.example.test',
                  }),
                ],
                bookmarks: [
                  expect.objectContaining({
                    title: 'Axterm 远端恢复主机',
                    hostId: sourceHostId,
                    profileId: sourceTerminalProfileId,
                    connectionProfileId: sourceConnectionProfileId,
                  }),
                ],
              },
            },
            quickCommands: {
              count: 2,
              value: {
                quickCommandGroups: [
                  expect.objectContaining({
                    name: 'Axterm 远端恢复命令',
                    parentId: null,
                  }),
                ],
                quickCommands: [
                  expect.objectContaining({
                    name: '恢复诊断',
                    command: "printf 'AXTERM_SYNC_RECOVERY'",
                    description: 'Axterm 同步恢复测试',
                    tags: ['recovery', 'sync'],
                    inputOnly: true,
                  }),
                ],
              },
            },
            terminalThemes: {
              count: 1,
              value: {
                terminalThemes: [
                  expect.objectContaining({
                    id: sourceThemeId,
                    name: 'Axterm 远端恢复主题',
                    builtIn: false,
                    terminal: expect.objectContaining({
                      foreground: '#dff9ec',
                      background: '#10251f',
                      cursor: '#5ee0b4',
                    }),
                    ui: expect.objectContaining({ primary: '#2fc7a1' }),
                  }),
                ],
              },
            },
            settings: {
              value: {
                settings: {
                  terminal: {
                    defaultProfileId: sourceTerminalProfileId,
                    visual: { themeId: sourceThemeId },
                  },
                },
              },
            },
            profiles: {
              count: 3,
              value: {
                connectionProfiles: [
                  expect.objectContaining({
                    id: sourceConnectionProfileId,
                    name: 'Axterm 远端恢复连接配置',
                    ssh: expect.objectContaining({ username: 'profile-recovery-user' }),
                  }),
                ],
                terminalProfiles: [
                  expect.objectContaining({
                    id: sourceTerminalProfileId,
                    name: 'Axterm 远端恢复终端配置',
                    fontSize: 15,
                    scrollback: 4_321,
                    env: { AXTERM_SYNC_PROFILE: 'restored' },
                  }),
                ],
                tunnelProfiles: [
                  expect.objectContaining({
                    id: sourceTunnelProfileId,
                    name: 'Axterm 远端恢复隧道',
                    hostId: sourceHostId,
                    bindPort: 41_023,
                    targetPort: 22,
                  }),
                ],
              },
            },
            addressBookmarks: {
              count: 1,
              value: {
                addressBookmarks: [
                  {
                    id: sourceAddressBookmarkId,
                    hostId: sourceHostId,
                    path: '/srv/axterm-sync-recovery',
                  },
                ],
              },
            },
            workspaces: {
              count: 1,
              value: {
                workspace: {
                  restoreLayout: true,
                  aiInspectorOpen: true,
                  namedWorkspaces: [
                    expect.objectContaining({
                      id: sourceWorkspaceId,
                      name: 'Axterm 远端恢复工作区',
                      layout: expect.objectContaining({
                        tabs: [
                          expect.objectContaining({
                            id: sourceWorkspaceTabId,
                            hostId: sourceHostId,
                            profileId: sourceTerminalProfileId,
                            visual: expect.objectContaining({ themeId: sourceThemeId }),
                          }),
                        ],
                      }),
                    }),
                  ],
                  activeWorkspaceId: sourceWorkspaceId,
                  startupSessions: [expect.any(String)],
                  showTabNumber: false,
                  switchTabOnHover: true,
                },
              },
            },
            triggers: {
              count: 1,
              value: {
                triggers: [
                  expect.objectContaining({
                    id: sourceTriggerId,
                    name: 'Axterm 远端恢复触发器',
                    enabled: true,
                    match: {
                      type: 'regex',
                      value: 'AXTERM_RECOVERY_PROMPT$',
                      caseSensitive: true,
                    },
                    action: { type: 'send', value: "printf 'AXTERM_TRIGGER_RECOVERED'" },
                    sendEnter: true,
                    mode: 'cooldown',
                    cooldownMs: 2_500,
                  }),
                ],
              },
            },
          },
        },
      });
      expect(webdav.legacyContents).toBe(legacyRemote);
      expect(webdav.axtermWriteCount).toBe(1);

      webdav.mutateAxtermSettingsForRecovery('light');
      const tunnelMutationDatabase = await ProductDatabase.open(databasePath);
      try {
        const tunnelProducts = new ProductRepository(tunnelMutationDatabase);
        const tunnel = tunnelProducts
          .listJson<{ id: string; name: string; version: number }>('tunnel_profiles')
          .find(({ name }) => name === 'Axterm 远端恢复隧道');
        if (!tunnel) throw new Error('Tunnel Profile recovery seed is missing');
        tunnelProducts.deleteJson(
          'tunnel_profiles',
          tunnel.id,
          etagFor(tunnel.version),
          'tunnel-profile',
        );
        const triggerRepository = new TriggerRepository(tunnelMutationDatabase);
        const trigger = triggerRepository
          .snapshot()
          .triggers.find(({ name }) => name === 'Axterm 远端恢复触发器');
        if (!trigger) throw new Error('Trigger recovery seed is missing');
        triggerRepository.delete(trigger.id, triggerRepository.snapshot().etag);
        expect(triggerRepository.snapshot().triggers).toEqual([]);
        const localSettings = tunnelProducts.getSettings();
        tunnelProducts.updateSettings(
          {
            workspace: {
              restoreLayout: false,
              aiInspectorOpen: false,
              layout: {
                section: 'settings',
                contentSurface: 'section',
                sidebarOpen: false,
                split: false,
                tabs: [],
                activeTerminalId: null,
                secondaryTerminalId: null,
                layoutMode: 'c1',
                paneTerminalIds: [],
                focusedPane: 0,
              },
              namedWorkspaces: [],
              activeWorkspaceId: null,
              startupSessions: [],
              showTabNumber: true,
              switchTabOnHover: false,
            },
            fileManager: { remoteAddressBookmarks: [] },
          },
          etagFor(localSettings.version),
        );
      } finally {
        tunnelMutationDatabase.close();
      }
      await page.locator('[data-activity-item="bookmarks"]').click();
      await page.locator('.workspace-sidebar').getByRole('button', { name: '管理' }).click();
      page.once('dialog', (dialog) => dialog.accept());
      await recoveryHost.getByRole('button', { name: '删除' }).click();
      await expect(recoveryHost).toHaveCount(0);
      await expect(page.getByRole('treeitem', { name: /^Axterm 远端恢复主机/u })).toHaveCount(0);
      const mutationDatabase = await ProductDatabase.open(databasePath);
      try {
        const mutationProducts = new ProductRepository(mutationDatabase);
        const mutationCommands = new QuickCommandRepository(mutationDatabase);
        let tree = mutationCommands.snapshot();
        const command = tree.commands.find(({ name }) => name === '恢复诊断');
        const group = tree.groups.find(({ name }) => name === 'Axterm 远端恢复命令');
        if (!command || !group) throw new Error('Quick Command recovery seed is missing');
        tree = mutationCommands.deleteCommand(command.id, tree.etag);
        mutationCommands.deleteGroup(group.id, tree.etag);
        expect(mutationCommands.snapshot()).toMatchObject({ groups: [], commands: [] });
        const mutationConnectionProfiles = new ConnectionProfileRepository(mutationDatabase);
        const connectionProfile = mutationConnectionProfiles
          .list()
          .find(({ name }) => name === 'Axterm 远端恢复连接配置');
        const terminalProfile = mutationProducts
          .listJson<{ id: string; name: string; version: number }>('terminal_profiles')
          .find(({ name }) => name === 'Axterm 远端恢复终端配置');
        if (!connectionProfile || !terminalProfile)
          throw new Error('Profile recovery seed is missing');
        const mutationThemes = new TerminalThemeRepository(mutationProducts);
        const theme = mutationThemes.list().find(({ name }) => name === 'Axterm 远端恢复主题');
        if (!theme) throw new Error('Terminal theme recovery seed is missing');
        const settings = mutationProducts.getSettings();
        mutationProducts.updateSettings(
          {
            terminal: {
              defaultProfileId: null,
              visual: {
                ...settings.terminal.visual,
                themeId: '00000000-0000-4000-8000-000000000001',
              },
            },
          },
          etagFor(settings.version),
        );
        mutationThemes.delete(theme.id, etagFor(theme.version));
        expect(mutationThemes.list()).toEqual([]);
        mutationConnectionProfiles.delete(connectionProfile.id, etagFor(connectionProfile.version));
        mutationProducts.deleteJson(
          'terminal_profiles',
          terminalProfile.id,
          etagFor(terminalProfile.version),
          'terminal-profile',
        );
        expect(mutationConnectionProfiles.list()).toEqual([]);
        expect(mutationProducts.listJson('terminal_profiles')).toEqual([]);
        expect(mutationProducts.listJson('tunnel_profiles')).toEqual([]);
        expect(mutationProducts.getSettings()).toMatchObject({
          workspace: {
            restoreLayout: false,
            namedWorkspaces: [],
            activeWorkspaceId: null,
            startupSessions: [],
          },
          fileManager: { remoteAddressBookmarks: [] },
        });
      } finally {
        mutationDatabase.close();
      }
      await page.locator('[data-activity-item="setting"]').click();
      await page
        .getByRole('complementary', { name: '设置项目' })
        .locator('[data-settings-category="sync"]')
        .click();
      await panel.getByRole('tab', { name: 'WebDAV' }).click();
      await panel.getByRole('tab', { name: 'Axterm 同步格式' }).click();
      await panel.getByRole('button', { name: '下载', exact: true }).click();
      const preview = panel.getByRole('region', { name: '下载预览' });
      await expect(preview).toBeVisible();
      await expect(preview.getByRole('button', { name: '确认应用' })).toBeEnabled();
      await preview.getByRole('button', { name: '确认应用' }).click();
      await expect(panel.getByText('远程数据已按预览提交。')).toBeVisible();
      const recoveredDatabase = await ProductDatabase.open(databasePath);
      try {
        const recoveredProducts = new ProductRepository(recoveredDatabase);
        const recoveredSettings = recoveredProducts.getSettings();
        expect(recoveredSettings.appearance.theme).toBe('light');
        expect(recoveredProducts.listHosts()).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              name: 'Axterm 远端恢复主机',
              hostname: 'recovery.example.test',
              username: 'recovery-user',
            }),
          ]),
        );
        expect(new BookmarkRepository(recoveredDatabase).snapshot().bookmarks).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ title: 'Axterm 远端恢复主机', protocol: 'ssh' }),
          ]),
        );
        const recoveredHost = recoveredProducts
          .listHosts()
          .find(({ name }) => name === 'Axterm 远端恢复主机');
        const recoveredBookmark = new BookmarkRepository(recoveredDatabase)
          .snapshot()
          .bookmarks.find(({ title }) => title === 'Axterm 远端恢复主机');
        const recoveredConnectionProfile = new ConnectionProfileRepository(recoveredDatabase)
          .list()
          .find(({ name }) => name === 'Axterm 远端恢复连接配置');
        const recoveredTerminalProfile = recoveredProducts
          .listJson<{
            id: string;
            name: string;
            fontSize: number;
            scrollback: number;
            env: Record<string, string>;
          }>('terminal_profiles')
          .find(({ name }) => name === 'Axterm 远端恢复终端配置');
        const recoveredTunnelProfile = recoveredProducts
          .listJson<{
            id: string;
            name: string;
            hostId: string;
            bindHost: string;
            bindPort: number;
            targetHost: string | null;
            targetPort: number | null;
          }>('tunnel_profiles')
          .find(({ name }) => name === 'Axterm 远端恢复隧道');
        expect(recoveredConnectionProfile).toMatchObject({
          ssh: {
            username: 'profile-recovery-user',
            passwordCredentialRef: null,
            privateKeyCredentialRef: null,
          },
        });
        expect(recoveredTerminalProfile).toMatchObject({
          fontSize: 15,
          scrollback: 4_321,
          env: { AXTERM_SYNC_PROFILE: 'restored' },
        });
        expect(recoveredTunnelProfile).toMatchObject({
          hostId: recoveredHost?.id,
          bindHost: '127.0.0.1',
          bindPort: 41_023,
          targetHost: '127.0.0.1',
          targetPort: 22,
        });
        expect(recoveredHost?.id).not.toBe(sourceHostId);
        expect(recoveredConnectionProfile?.id).not.toBe(sourceConnectionProfileId);
        expect(recoveredTerminalProfile?.id).not.toBe(sourceTerminalProfileId);
        expect(recoveredTunnelProfile?.id).not.toBe(sourceTunnelProfileId);
        expect(recoveredBookmark).toMatchObject({
          hostId: recoveredHost?.id,
          profileId: recoveredTerminalProfile?.id,
          connectionProfileId: recoveredConnectionProfile?.id,
        });
        expect(recoveredSettings.terminal.defaultProfileId).toBe(recoveredTerminalProfile?.id);
        const recoveredCommands = new QuickCommandRepository(recoveredDatabase).snapshot();
        const recoveredGroup = recoveredCommands.groups.find(
          ({ name }) => name === 'Axterm 远端恢复命令',
        );
        const recoveredCommand = recoveredCommands.commands.find(({ name }) => name === '恢复诊断');
        expect(recoveredGroup).toMatchObject({ parentId: null });
        expect(recoveredCommand).toMatchObject({
          groupId: recoveredGroup?.id,
          command: "printf 'AXTERM_SYNC_RECOVERY'",
          commands: [
            expect.objectContaining({
              name: '输出标记',
              command: "printf 'AXTERM_SYNC_RECOVERY'",
              delayMs: 100,
            }),
            expect.objectContaining({
              name: '检查状态',
              command: 'printf STATUS_OK',
              delayMs: 250,
            }),
          ],
          description: 'Axterm 同步恢复测试',
          tags: ['recovery', 'sync'],
          inputOnly: true,
        });
        const recoveredTheme = new TerminalThemeRepository(recoveredProducts)
          .list()
          .find(({ name }) => name === 'Axterm 远端恢复主题');
        expect(recoveredTheme).toMatchObject({
          builtIn: false,
          terminal: {
            foreground: '#dff9ec',
            background: '#10251f',
            cursor: '#5ee0b4',
          },
          ui: expect.objectContaining({ primary: '#2fc7a1' }),
        });
        expect(recoveredTheme?.id).not.toBe(sourceThemeId);
        expect(recoveredSettings.terminal.visual.themeId).toBe(recoveredTheme?.id);
        expect(recoveredSettings.fileManager.remoteAddressBookmarks).toEqual([
          {
            id: sourceAddressBookmarkId,
            hostId: recoveredHost?.id,
            path: '/srv/axterm-sync-recovery',
          },
        ]);
        expect(recoveredSettings.workspace).toMatchObject({
          restoreLayout: true,
          aiInspectorOpen: true,
          activeWorkspaceId: sourceWorkspaceId,
          startupSessions: [recoveredBookmark?.id],
          showTabNumber: false,
          switchTabOnHover: true,
        });
        expect(recoveredSettings.workspace.layout?.tabs).toEqual([
          expect.objectContaining({
            id: sourceWorkspaceTabId,
            title: 'Axterm 远端恢复会话',
            hostId: recoveredHost?.id,
            bookmarkId: recoveredBookmark?.id,
            profileId: recoveredTerminalProfile?.id,
            visual: expect.objectContaining({ themeId: recoveredTheme?.id }),
            pinned: true,
          }),
        ]);
        expect(recoveredSettings.workspace.namedWorkspaces).toEqual([
          expect.objectContaining({
            id: sourceWorkspaceId,
            name: 'Axterm 远端恢复工作区',
            layout: expect.objectContaining({
              tabs: [
                expect.objectContaining({
                  id: sourceWorkspaceTabId,
                  hostId: recoveredHost?.id,
                  bookmarkId: recoveredBookmark?.id,
                  profileId: recoveredTerminalProfile?.id,
                  visual: expect.objectContaining({ themeId: recoveredTheme?.id }),
                }),
              ],
            }),
          }),
        ]);
        const recoveredTrigger = new TriggerRepository(recoveredDatabase)
          .snapshot()
          .triggers.find(({ name }) => name === 'Axterm 远端恢复触发器');
        expect(recoveredTrigger).toMatchObject({
          enabled: true,
          match: { type: 'regex', value: 'AXTERM_RECOVERY_PROMPT$', caseSensitive: true },
          action: { type: 'send', value: "printf 'AXTERM_TRIGGER_RECOVERED'" },
          sendEnter: true,
          mode: 'cooldown',
          cooldownMs: 2_500,
        });
        expect(recoveredTrigger?.id).not.toBe(sourceTriggerId);
      } finally {
        recoveredDatabase.close();
      }
      expect(webdav.legacyContents).toBe(legacyRemote);
      expect(webdav.legacyWriteCount).toBe(1);
    } finally {
      await app.close().catch(() => {});
      await webdav.close();
      await rm(userData, { recursive: true, force: true });
    }
  });
});

async function startSyncWebDavFixture() {
  let contents: string | null = null;
  let revision = 0;
  let etag: string | null = null;
  let conflictArmed = false;
  const server = createServer(async (request, response) => {
    const expectedAuthorization = `Basic ${Buffer.from('operator:H09_LOCAL_VAULT_WEBDAV_SECRET').toString('base64')}`;
    if (request.headers.authorization !== expectedAuthorization) {
      response.writeHead(401).end();
      return;
    }
    if (request.url === '/storage/legacy-prototype/' && request.method === 'MKCOL') {
      response.writeHead(201).end();
      return;
    }
    if (request.url !== '/storage/legacy-prototype/desktop.json') {
      response.writeHead(404).end();
      return;
    }
    if (request.method === 'GET') {
      if (!contents) {
        response.writeHead(404).end();
        return;
      }
      const responseEtag = etag!;
      response.writeHead(200, { 'Content-Type': 'application/json', ETag: responseEtag });
      response.end(contents);
      if (conflictArmed) {
        conflictArmed = false;
        etag = `"r${++revision}"`;
      }
      return;
    }
    if (request.method !== 'PUT') {
      response.writeHead(405).end();
      return;
    }
    if (
      (etag && request.headers['if-match'] !== etag) ||
      (!etag && request.headers['if-none-match'] !== '*')
    ) {
      response.writeHead(412).end();
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    contents = Buffer.concat(chunks).toString('utf8');
    etag = `"r${++revision}"`;
    response.writeHead(204, { ETag: etag }).end();
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('WebDAV fixture failed to listen');
  return {
    endpoint: `http://127.0.0.1:${address.port}/storage/`,
    get contents() {
      return contents;
    },
    armConflict() {
      conflictArmed = true;
    },
    mutateSettingsTheme(theme: 'dark' | 'light') {
      if (!contents) throw new Error('WebDAV fixture has no sync document');
      const envelope = JSON.parse(contents) as {
        encrypted: boolean;
        document: {
          categories: { settings: { value: Record<string, unknown>; hash: string } };
        };
      };
      if (envelope.encrypted) throw new Error('E2E sync document unexpectedly encrypted');
      const settings = envelope.document.categories.settings;
      const value = settings.value as {
        config?: Record<string, unknown>;
        _axterm?: { settings?: { appearance?: Record<string, unknown> } };
      };
      if (value.config) value.config.theme = theme;
      if (value._axterm?.settings?.appearance) value._axterm.settings.appearance.theme = theme;
      settings.hash = stableHash(settings.value);
      contents = `${JSON.stringify(envelope)}\n`;
      etag = `"r${++revision}"`;
    },
    async close() {
      await new Promise<void>((resolveClose, rejectClose) =>
        server.close((error) => (error ? rejectClose(error) : resolveClose())),
      );
    },
  };
}

async function startDualFormatSyncWebDavFixture() {
  const documents = new Map<
    string,
    { contents: string | null; etag: string | null; writes: number }
  >([
    ['/storage/legacy-prototype/desktop.json', { contents: null, etag: null, writes: 0 }],
    ['/storage/axterm/desktop.json', { contents: null, etag: null, writes: 0 }],
  ]);
  let revision = 0;
  const server = createServer(async (request, response) => {
    const expectedAuthorization = `Basic ${Buffer.from('operator:H09_AXTERM_FORMAT_MIGRATION_SECRET').toString('base64')}`;
    if (request.headers.authorization !== expectedAuthorization) {
      response.writeHead(401).end();
      return;
    }
    if (
      (request.url === '/storage/legacy-prototype/' || request.url === '/storage/axterm/') &&
      request.method === 'MKCOL'
    ) {
      response.writeHead(201).end();
      return;
    }
    const document = request.url ? documents.get(request.url) : undefined;
    if (!document) {
      response.writeHead(404).end();
      return;
    }
    if (request.method === 'GET') {
      if (!document.contents) {
        response.writeHead(404).end();
        return;
      }
      response.writeHead(200, { 'Content-Type': 'application/json', ETag: document.etag! });
      response.end(document.contents);
      return;
    }
    if (request.method !== 'PUT') {
      response.writeHead(405).end();
      return;
    }
    if (
      (document.etag && request.headers['if-match'] !== document.etag) ||
      (!document.etag && request.headers['if-none-match'] !== '*')
    ) {
      response.writeHead(412).end();
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    document.contents = Buffer.concat(chunks).toString('utf8');
    document.etag = `"format-r${++revision}"`;
    document.writes += 1;
    response.writeHead(204, { ETag: document.etag }).end();
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Dual-format WebDAV fixture failed');
  const legacy = documents.get('/storage/legacy-prototype/desktop.json')!;
  const axterm = documents.get('/storage/axterm/desktop.json')!;
  return {
    endpoint: `http://127.0.0.1:${address.port}/storage/`,
    get legacyContents() {
      return legacy.contents;
    },
    get axtermContents() {
      return axterm.contents;
    },
    get legacyWriteCount() {
      return legacy.writes;
    },
    get axtermWriteCount() {
      return axterm.writes;
    },
    mutateAxtermSettingsForRecovery(theme: 'dark' | 'light') {
      if (!axterm.contents) throw new Error('Dual-format fixture has no Axterm sync document');
      const envelope = JSON.parse(axterm.contents) as {
        encrypted: boolean;
        document: {
          categories: {
            settings?: {
              value: {
                settings?: {
                  appearance?: { theme?: string };
                  fileManager?: { remoteAddressBookmarks?: unknown[] };
                  workspace?: {
                    restoreLayout?: boolean;
                    aiInspectorOpen?: boolean;
                    layout?: unknown;
                    namedWorkspaces?: unknown[];
                    activeWorkspaceId?: string | null;
                    startupSessions?: unknown;
                    showTabNumber?: boolean;
                    switchTabOnHover?: boolean;
                  };
                };
              };
              hash: string;
            };
          };
        };
      };
      if (envelope.encrypted) throw new Error('Axterm sync E2E document unexpectedly encrypted');
      const category = envelope.document.categories.settings;
      if (!category) throw new Error('Axterm sync E2E document has no portable settings category');
      const settings = category.value.settings;
      const appearance = settings?.appearance;
      if (!appearance)
        throw new Error('Axterm sync E2E document has no portable appearance settings');
      appearance.theme = theme;
      if (!settings.fileManager || !settings.workspace)
        throw new Error('Axterm sync E2E document has no portable address/workspace settings');
      settings.fileManager.remoteAddressBookmarks = [];
      settings.workspace.restoreLayout = false;
      settings.workspace.aiInspectorOpen = false;
      delete settings.workspace.layout;
      settings.workspace.namedWorkspaces = [];
      settings.workspace.activeWorkspaceId = null;
      settings.workspace.startupSessions = [];
      settings.workspace.showTabNumber = true;
      settings.workspace.switchTabOnHover = false;
      category.hash = stableHash(category.value);
      axterm.contents = `${JSON.stringify(envelope)}\n`;
      axterm.etag = `"format-r${++revision}"`;
    },
    async close() {
      await new Promise<void>((resolveClose, rejectClose) =>
        server.close((error) => (error ? rejectClose(error) : resolveClose())),
      );
    },
  };
}

test.describe('H-03 terminal themes', () => {
  test('creates, clones, edits, previews and deletes themes without the retired file format', async () => {
    const userData = await mkdtemp(resolve(tmpdir(), 'axterm-terminal-themes-e2e-'));
    const app = await launchLocalOptimizationApp({
      executablePath,
      args: [resolve('apps/desktop'), `--user-data-dir=${userData}`],
      env: { ...process.env, ELECTRON_RENDERER_URL: '' },
    });
    try {
      const page = await app.firstWindow();
      const errors: string[] = [];
      page.on('pageerror', (error) => errors.push(error.message));
      await expect(page.getByTestId('runtime-state')).toHaveAttribute('data-state', 'ready');
      await openTerminalThemes(page);

      const workspace = page.locator('.terminal-theme-workspace');
      const list = page.getByRole('complementary', { name: '终端主题列表' });
      await expect(workspace).toBeVisible();
      await expect(page.getByTestId('legacy-theme-file-deprecation')).toHaveCount(0);
      await expect(workspace.getByRole('button', { name: '导入旧主题文件' })).toHaveCount(0);
      await expect(workspace.getByRole('button', { name: '导出旧主题' })).toHaveCount(0);
      await expect(list.getByRole('button', { name: /Default.*内建/ })).toHaveCount(2);
      await page.getByRole('button', { name: '主题预览' }).click();
      await expect(page.locator('.terminal-theme-preview')).toBeVisible();

      await page.getByRole('button', { name: /^(?:Clone|克隆)$/ }).click();
      const name = page.getByLabel(/^(?:Theme name|主题名称)$/);
      await expect(name).toHaveValue('Default copy');
      await name.fill('H03 midnight');
      await workspace.getByRole('tab', { name: /^(?:Text editor|文本编辑器)$/ }).click();
      await page.getByLabel(/^(?:Terminal colors Red|终端颜色 红色)$/).fill('#123456');
      await page.getByRole('button', { name: /^(?:Save|保存)$/ }).click();
      await expect(page.getByText('主题已保存。')).toBeVisible();
      await expect(list).toContainText('H03 midnight');
      await expect(page.getByLabel('ANSI 调色板').locator('span').nth(1)).toHaveCSS(
        'background-color',
        'rgb(18, 52, 86)',
      );

      await list.getByLabel('搜索终端主题').fill('midnight');
      const matchingRows = list
        .locator('.terminal-theme-list-item:not(.new)')
        .filter({ hasText: 'H03 midnight' });
      await expect(matchingRows).toHaveCount(1);

      await page.getByRole('button', { name: /^(?:Delete|删除)$/ }).click();
      await expect(page.getByText('再次点击删除以确认。')).toBeVisible();
      await page.getByRole('button', { name: /^(?:Confirm delete|确认删除)$/ }).click();
      await expect(page.getByText('主题已删除。')).toBeVisible();
      await expect(matchingRows).toHaveCount(0);
      expect(errors).toEqual([]);
    } finally {
      await app.close().catch(() => {});
      await rm(userData, { recursive: true, force: true });
    }
  });
});

test.describe('H-04 live terminal theme and background scope', () => {
  test('previews, applies and restores session text plus persistent global image backgrounds', async () => {
    test.skip(
      process.platform === 'win32',
      'This assertion opens the platform default local shell.',
    );
    const userData = await mkdtemp(resolve(tmpdir(), 'axterm-terminal-visual-e2e-'));
    const imagePath = resolve(userData, 'background.png');
    await writeFile(
      imagePath,
      Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
        'base64',
      ),
    );
    let app = await launchLocalOptimizationApp({
      executablePath,
      args: [resolve('apps/desktop'), `--user-data-dir=${userData}`],
      env: { ...process.env, ELECTRON_RENDERER_URL: '' },
    });
    try {
      await app.evaluate(({ dialog }, selectedPath) => {
        dialog.showOpenDialog = (() =>
          Promise.resolve({
            canceled: false,
            filePaths: [selectedPath],
          })) as typeof dialog.showOpenDialog;
      }, imagePath);
      let page = await app.firstWindow();
      const errors: string[] = [];
      page.on('pageerror', (error) => errors.push(error.message));
      await expect(page.getByTestId('runtime-state')).toHaveAttribute('data-state', 'ready');
      let terminalHost = page.locator('.terminal-session-layer:not([hidden]) .terminal-host');
      await expect(terminalHost).toHaveAttribute('data-connection-state', 'connected');
      await expect(terminalHost).toHaveAttribute('data-theme-foreground', '#dcdcdc');

      await openTerminalThemes(page);
      const workspace = page.locator('.terminal-theme-workspace');
      await workspace.getByLabel('主题应用范围').selectOption('session');
      await page
        .getByRole('complementary', { name: '终端主题列表' })
        .getByRole('button', { name: /Default light.*内建/ })
        .click();
      await workspace.getByLabel('终端背景类型').selectOption('text');
      await workspace.getByLabel(/^(终端背景文字|背景文字)$/).fill('H04 SESSION');
      await workspace.getByLabel('终端背景文字字号').fill('72');
      await workspace.getByLabel(/终端背景(Opacity|透明度)/).fill('0.45');

      terminalHost = page.locator('.terminal-session-layer .terminal-host');
      await expect(terminalHost).toHaveAttribute('data-theme-foreground', '#2d4038');
      await expect(terminalHost).toHaveAttribute('data-background-kind', 'text');
      await expect(page.locator('.terminal-session-layer .terminal-background-text')).toContainText(
        'H04 SESSION',
      );
      await workspace.getByRole('button', { name: /^(Apply|应用)$/ }).click();
      await expect(workspace.getByText('主题与背景已应用到当前会话。')).toBeVisible();
      await page.getByRole('button', { name: '关闭设置并返回工作区' }).click();
      terminalHost = page.locator('.terminal-session-layer:not([hidden]) .terminal-host');
      await expect(terminalHost).toHaveAttribute('data-theme-foreground', '#2d4038');
      await expect(terminalHost).toHaveAttribute('data-background-kind', 'text');
      await expect(
        page.locator('.terminal-session-layer:not([hidden]) .terminal-background-text'),
      ).toContainText('H04 SESSION');

      await openTerminalThemes(page);
      await workspace.getByLabel('主题应用范围').selectOption('global');
      await page
        .getByRole('complementary', { name: '终端主题列表' })
        .getByRole('button', { name: /Default light.*内建/ })
        .click();
      await workspace.getByRole('button', { name: /^(Choose image|选择图片)$/ }).click();
      await expect(workspace.getByText(/背景图片已准备/)).toBeVisible();
      await expect(page.locator('.terminal-session-layer .terminal-host')).toHaveAttribute(
        'data-background-image-ready',
        'true',
      );
      await workspace.getByRole('button', { name: /^(Apply|应用)$/ }).click();
      await expect(workspace.getByText('主题与背景已设为全局默认。')).toBeVisible();
      await page.getByRole('button', { name: '关闭设置并返回工作区' }).click();

      await page.getByTitle('新建会话菜单', { exact: true }).click();
      await page
        .locator('.session-menu')
        .getByRole('button', { name: /本地终端/ })
        .click();
      terminalHost = page.locator('.terminal-session-layer:not([hidden]) .terminal-host');
      await expect(terminalHost).toHaveAttribute('data-theme-foreground', '#2d4038');
      await expect(terminalHost).toHaveAttribute('data-background-kind', 'image');
      await expect(terminalHost).toHaveAttribute('data-background-image-ready', 'true');
      expect(errors).toEqual([]);

      await app.close();
      app = await launchLocalOptimizationApp({
        executablePath,
        args: [resolve('apps/desktop'), `--user-data-dir=${userData}`],
        env: { ...process.env, ELECTRON_RENDERER_URL: '' },
      });
      page = await app.firstWindow();
      await expect(page.getByTestId('runtime-state')).toHaveAttribute('data-state', 'ready');
      terminalHost = page.locator('.terminal-session-layer:not([hidden]) .terminal-host');
      await expect(terminalHost).toHaveAttribute('data-theme-foreground', '#2d4038');
      await expect(terminalHost).toHaveAttribute('data-background-kind', 'image');
      await expect(terminalHost).toHaveAttribute('data-background-image-ready', 'true');
    } finally {
      await app.close().catch(() => {});
      await rm(userData, { recursive: true, force: true });
    }
  });
});

test.describe('H-05 shortcut Action Registry', () => {
  test('edits, rejects conflicts, dispatches and restores shortcuts across restart', async () => {
    test.skip(
      process.platform === 'win32',
      'This assertion opens the platform default local shell.',
    );
    const userData = await mkdtemp(resolve(tmpdir(), 'axterm-shortcuts-e2e-'));
    let app = await electron.launch({
      executablePath,
      args: [resolve('apps/desktop'), `--user-data-dir=${userData}`],
      env: { ...process.env, ELECTRON_RENDERER_URL: '' },
    });
    const customShortcutLabel = process.platform === 'darwin' ? '⌥⇧T' : 'Alt+Shift+T';
    const defaultShortcutLabel = process.platform === 'darwin' ? '⌥Q' : 'Alt+Q';
    try {
      let page = await app.firstWindow();
      const errors: string[] = [];
      page.on('pageerror', (error) => errors.push(error.message));
      await expect(page.getByTestId('runtime-state')).toHaveAttribute('data-state', 'ready');
      const terminalTabs = page.locator('.pane-tabbar .terminal-tab');
      await expect(terminalTabs).toHaveCount(1);

      await openShortcutSettings(page);
      const registry = page.getByRole('table', {
        name: /快捷键 Action Registry|快捷键动作注册表/,
      });
      await expect(registry.locator('[data-shortcut-action]')).toHaveCount(23);
      await page.getByRole('button', { name: '编辑 新建本地终端' }).click();
      const editor = page.getByRole('dialog', { name: '编辑快捷键' });
      const capture = editor.locator('.shortcut-capture');
      await capture.press('Backspace');
      await capture.press('Alt+Shift+T');
      await expect(capture.locator('kbd')).toHaveText(customShortcutLabel);
      await editor.getByRole('button', { name: '应用' }).click();
      await expect(page.getByText('快捷键已应用。')).toBeVisible();

      await page.getByRole('button', { name: '编辑 关闭当前标签' }).click();
      await editor.locator('.shortcut-capture').press('Backspace');
      await editor.locator('.shortcut-capture').press('Alt+Shift+T');
      await expect(editor.getByRole('alert')).toContainText('新建本地终端');
      await expect(editor.getByRole('button', { name: '应用' })).toBeDisabled();
      await editor.getByRole('button', { name: '取消' }).click();

      await page.getByRole('button', { name: '关闭设置并返回工作区' }).click();
      await page.keyboard.press('Alt+Shift+T');
      await expect(terminalTabs).toHaveCount(2);
      await terminalTabs.first().dispatchEvent('auxclick', { button: 1 });
      await expect(terminalTabs).toHaveCount(1);
      const terminalHost = page.locator('.terminal-session-layer:not([hidden]) .terminal-host');
      const initialFontSize = Number(await terminalHost.getAttribute('data-font-size'));
      await terminalHost.locator('.xterm').dispatchEvent('wheel', {
        deltaY: -100,
        metaKey: process.platform === 'darwin',
        ctrlKey: process.platform !== 'darwin',
      });
      await expect(terminalHost).toHaveAttribute('data-font-size', String(initialFontSize + 1));
      expect(errors).toEqual([]);

      await app.close();
      app = await electron.launch({
        executablePath,
        args: [resolve('apps/desktop'), `--user-data-dir=${userData}`],
        env: { ...process.env, ELECTRON_RENDERER_URL: '' },
      });
      page = await app.firstWindow();
      await expect(page.getByTestId('runtime-state')).toHaveAttribute('data-state', 'ready');
      await openShortcutSettings(page);
      await expect(
        page.locator('[data-shortcut-action="app_newTab"] .shortcut-bindings kbd'),
      ).toHaveText(customShortcutLabel);
      await page.getByRole('button', { name: '恢复默认' }).click();
      await expect(page.getByText('全部可编辑快捷键已恢复为当前平台默认值。')).toBeVisible();
      await expect(
        page.locator('[data-shortcut-action="app_newTab"] .shortcut-bindings kbd'),
      ).toHaveText(defaultShortcutLabel);
      await page.getByRole('button', { name: '关闭设置并返回工作区' }).click();
      const restoredTabs = page.locator('.pane-tabbar .terminal-tab');
      const beforeDefault = await restoredTabs.count();
      await page.keyboard.press('Alt+Q');
      await expect(restoredTabs).toHaveCount(beforeDefault + 1);
    } finally {
      await app.close().catch(() => {});
      await rm(userData, { recursive: true, force: true });
    }
  });
});

test.describe('H-06 global visibility hotkey', () => {
  test('registers immediately, persists across restart, rejects conflicts and disables cleanly', async () => {
    const userData = await mkdtemp(resolve(tmpdir(), 'axterm-global-hotkey-e2e-'));
    let app = await electron.launch({
      executablePath,
      args: [resolve('apps/desktop'), `--user-data-dir=${userData}`],
      env: { ...process.env, ELECTRON_RENDERER_URL: '' },
    });
    const customAccelerator = 'Alt+Shift+F10';
    const customLabel = process.platform === 'darwin' ? '⌥⇧F10' : customAccelerator;
    try {
      let page = await app.firstWindow();
      await expect(page.getByTestId('runtime-state')).toHaveAttribute('data-state', 'ready');
      expect(
        await app.evaluate(({ globalShortcut }) => globalShortcut.isRegistered('Control+2')),
      ).toBe(true);

      await openShortcutSettings(page);
      let setting = page.getByLabel('全局窗口显隐热键');
      await expect(setting.getByRole('status')).toHaveText('已注册');
      await setting.getByRole('button', { name: '编辑' }).click();
      let capture = setting.locator('.shortcut-capture');
      await capture.press(customAccelerator);
      await expect(capture.locator('kbd')).toHaveText(customLabel);
      await setting.getByRole('button', { name: '应用' }).click();
      await expect(setting).toContainText('全局热键已注册并立即生效。');
      expect(
        await app.evaluate(
          ({ globalShortcut }, accelerator) => globalShortcut.isRegistered(accelerator),
          customAccelerator,
        ),
      ).toBe(true);
      expect(
        await app.evaluate(({ globalShortcut }) => globalShortcut.isRegistered('Control+2')),
      ).toBe(false);

      await app.close();
      app = await electron.launch({
        executablePath,
        args: [resolve('apps/desktop'), `--user-data-dir=${userData}`],
        env: { ...process.env, ELECTRON_RENDERER_URL: '' },
      });
      page = await app.firstWindow();
      await expect(page.getByTestId('runtime-state')).toHaveAttribute('data-state', 'ready');
      expect(
        await app.evaluate(
          ({ globalShortcut }, accelerator) => globalShortcut.isRegistered(accelerator),
          customAccelerator,
        ),
      ).toBe(true);

      await openShortcutSettings(page);
      setting = page.getByLabel('全局窗口显隐热键');
      await expect(setting.getByRole('status')).toHaveText('已注册');
      await expect(setting.locator('.global-hotkey-value kbd')).toHaveText(customLabel);
      await setting.getByRole('button', { name: '编辑' }).click();
      capture = setting.locator('.shortcut-capture');
      await capture.press('Alt+R');
      await expect(setting.getByRole('alert')).toContainText('重新加载当前标签');
      await expect(setting.getByRole('button', { name: '应用' })).toBeDisabled();
      await capture.press(customAccelerator);
      await setting.getByRole('button', { name: '关闭' }).click();
      await expect(setting.getByRole('status')).toHaveText('已关闭');
      expect(
        await app.evaluate(
          ({ globalShortcut }, accelerator) => globalShortcut.isRegistered(accelerator),
          customAccelerator,
        ),
      ).toBe(false);
    } finally {
      await app.close().catch(() => {});
      await rm(userData, { recursive: true, force: true });
    }
  });
});

test('closing the last macOS window does not reopen it after a Runtime restart', async () => {
  test.skip(process.platform !== 'darwin', 'Other platforms quit when the last window closes.');
  const userData = await mkdtemp(resolve(tmpdir(), 'axterm-closed-window-e2e-'));
  const app = await electron.launch({
    executablePath,
    args: [resolve('apps/desktop'), `--user-data-dir=${userData}`],
    env: { ...process.env, ELECTRON_RENDERER_URL: '' },
  });
  let mainPid: number | undefined;
  try {
    const page = await app.firstWindow();
    await expect(page.getByTestId('runtime-state')).toHaveAttribute('data-state', 'ready');
    mainPid = await app.evaluate(() => process.pid);
    const runtimePid = await app.evaluate(
      ({ app }) => app.getAppMetrics().find((metric) => metric.name === 'Axterm Core Runtime')?.pid,
    );
    expect(runtimePid).toBeGreaterThan(0);

    const pageClosed = page.waitForEvent('close');
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.close());
    await pageClosed;

    const reopenedPromise = app.waitForEvent('window');
    await app.evaluate(({ app }) => app.emit('activate'));
    const reopened = await reopenedPromise;
    await expect(reopened.getByTestId('runtime-state')).toHaveAttribute('data-state', 'ready');
    await expect(reopened.locator('.terminal-tab')).toHaveCount(1);
    const reopenedClosed = reopened.waitForEvent('close');
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.close());
    await reopenedClosed;

    process.kill(runtimePid!, 'SIGKILL');
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 3_000));
    expect(() => process.kill(mainPid!, 0)).not.toThrow();
    expect(app.windows()).toHaveLength(0);
  } finally {
    if (mainPid) {
      try {
        process.kill(mainPid, 'SIGKILL');
      } catch {
        // The test-owned Electron process already exited.
      }
    }
    await app.close().catch(() => {});
    await rm(userData, { recursive: true, force: true });
  }
});

test.describe('H-07 desktop window behavior', () => {
  test('exposes the empty pane tab strip as a native window drag region', async () => {
    test.skip(process.platform !== 'darwin', 'This verifies the macOS hidden title bar.');
    const userData = await mkdtemp(resolve(tmpdir(), 'axterm-window-drag-e2e-'));
    const app = await electron.launch({
      executablePath,
      args: [resolve('apps/desktop'), `--user-data-dir=${userData}`],
      env: { ...process.env, ELECTRON_RENDERER_URL: '' },
    });
    try {
      const page = await app.firstWindow();
      await expect(page.getByTestId('runtime-state')).toHaveAttribute('data-state', 'ready');
      await app.evaluate(({ BrowserWindow, screen }) => {
        const workArea = screen.getPrimaryDisplay().workArea;
        BrowserWindow.getAllWindows()[0]!.setBounds({
          x: workArea.x + 100,
          y: workArea.y + 100,
          width: Math.min(1_000, workArea.width - 200),
          height: Math.min(700, workArea.height - 200),
        });
      });

      const strip = page.locator('.pane-tabbar-scroll').first();
      await expect(strip).toHaveCSS('-webkit-app-region', 'drag');
      await expect(strip.locator('.terminal-tab').first()).toHaveCSS(
        '-webkit-app-region',
        'no-drag',
      );
      const point = await strip.evaluate((element) => {
        const bounds = element.getBoundingClientRect();
        const interactiveRight = Math.max(
          bounds.left,
          ...Array.from(element.children, (child) =>
            child.classList.contains('pane-tabbar-drag-space')
              ? bounds.left
              : child.getBoundingClientRect().right,
          ),
        );
        const x = Math.min(bounds.right - 40, interactiveRight + 100);
        const y = bounds.top + bounds.height / 2;
        const hit = document.elementFromPoint(x, y);
        return {
          x,
          y,
          blank: hit === element || hit?.classList.contains('pane-tabbar-drag-space'),
          hit: hit?.className,
          strip: { left: bounds.left, right: bounds.right },
          interactiveRight,
        };
      });
      expect(point.blank, JSON.stringify(point)).toBe(true);
      expect(
        await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.isMovable()),
      ).toBe(true);
    } finally {
      await app.close().catch(() => {});
      await rm(userData, { recursive: true, force: true });
    }
  });

  test('applies live preferences, restores bounds, enables multi-instance and confirms close', async () => {
    const userData = await mkdtemp(resolve(tmpdir(), 'axterm-window-behavior-e2e-'));
    let primary = await electron.launch({
      executablePath,
      args: [resolve('apps/desktop'), `--user-data-dir=${userData}`],
      env: { ...process.env, ELECTRON_RENDERER_URL: '' },
    });
    let secondary: Awaited<ReturnType<typeof electron.launch>> | undefined;
    try {
      let page = await primary.firstWindow();
      await expect(page.getByTestId('runtime-state')).toHaveAttribute('data-state', 'ready');
      await openCommonSettings(page);
      const panel = page.getByRole('region', { name: '窗口' });
      await panel.getByLabel('标题栏').selectOption('system');
      await panel.getByLabel('窗口透明度').fill('0.85');
      await panel.getByLabel('界面缩放').fill('1.25');
      await panel.getByLabel('关闭窗口前确认').check();
      await panel.getByLabel('允许同时运行多个 Axterm 实例').check();
      await panel.getByRole('button', { name: '保存窗口偏好' }).click();
      await expect(panel).toContainText('标题栏或多实例策略将在重新启动 Axterm 后生效');
      await expect
        .poll(() =>
          primary.evaluate(({ BrowserWindow }) => {
            const target = BrowserWindow.getAllWindows()[0]!;
            return {
              opacity: target.getOpacity(),
              zoom: target.webContents.getZoomFactor(),
            };
          }),
        )
        .toEqual({ opacity: 0.85, zoom: 1.25 });

      const expectedBounds = await primary.evaluate(({ BrowserWindow, screen }) => {
        const workArea = screen.getPrimaryDisplay().workArea;
        const bounds = {
          x: workArea.x + 30,
          y: workArea.y + 30,
          width: Math.min(1180, workArea.width),
          height: Math.min(780, workArea.height),
        };
        BrowserWindow.getAllWindows()[0]!.setBounds(bounds);
        return bounds;
      });
      await page.waitForTimeout(400);

      await primary.close();
      primary = await electron.launch({
        executablePath,
        args: [resolve('apps/desktop'), `--user-data-dir=${userData}`],
        env: { ...process.env, ELECTRON_RENDERER_URL: '' },
      });
      page = await primary.firstWindow();
      await expect(page.getByTestId('runtime-state')).toHaveAttribute('data-state', 'ready');
      await expect
        .poll(() =>
          primary.evaluate(({ BrowserWindow }) => {
            const target = BrowserWindow.getAllWindows()[0]!;
            return {
              bounds: target.getBounds(),
              opacity: target.getOpacity(),
              zoom: target.webContents.getZoomFactor(),
            };
          }),
        )
        .toEqual({ bounds: expectedBounds, opacity: 0.85, zoom: 1.25 });

      secondary = await electron.launch({
        executablePath,
        args: [resolve('apps/desktop'), `--user-data-dir=${userData}`],
        env: { ...process.env, ELECTRON_RENDERER_URL: '' },
      });
      const secondaryPage = await secondary.firstWindow();
      await expect(secondaryPage.getByTestId('runtime-state')).toHaveAttribute(
        'data-state',
        'ready',
      );
      await expect(page.getByTestId('runtime-state')).toHaveAttribute('data-state', 'ready');
      await secondary.close();
      secondary = undefined;

      await primary.evaluate(({ BrowserWindow, dialog }) => {
        Object.defineProperty(dialog, 'showMessageBox', {
          configurable: true,
          value: async () => ({ response: 0, checkboxChecked: false }),
        });
        BrowserWindow.getAllWindows()[0]!.close();
      });
      await page.waitForTimeout(200);
      expect(page.isClosed()).toBe(false);

      const pageClosed = page.waitForEvent('close');
      await primary.evaluate(({ BrowserWindow, dialog }) => {
        Object.defineProperty(dialog, 'showMessageBox', {
          configurable: true,
          value: async () => ({ response: 1, checkboxChecked: false }),
        });
        BrowserWindow.getAllWindows()[0]!.close();
      });
      await pageClosed;
    } finally {
      await secondary?.close().catch(() => {});
      await primary.close().catch(() => {});
      await rm(userData, { recursive: true, force: true });
    }
  });
});

async function openShortcutSettings(page: Page) {
  await page.locator('[data-activity-item="setting"]').click();
  await page
    .getByRole('complementary', { name: '设置项目' })
    .locator('[data-settings-category="shortcuts"]')
    .click();
  await expect(
    page.getByRole('table', { name: /快捷键 Action Registry|快捷键动作注册表/ }),
  ).toBeVisible();
}

async function openAiWorkspace(page: Page, configure = true) {
  const assistant = page.locator('.ai-inspector');
  if (!(await assistant.isVisible()))
    await page.getByRole('button', { name: 'AI 助手', exact: true }).click();
  await expect(assistant).toBeVisible();
  // Provider setup is an explicit dialog action from the shared sidebar.
  if (configure && !(await page.locator('.ai-provider-modal').isVisible()))
    await assistant.locator('.ai-embedded-toolbar button').click();
}

async function openCommonSettings(page: Page) {
  await page.locator('[data-activity-item="setting"]').click();
  await page
    .getByRole('complementary', { name: '设置项目' })
    .locator('[data-settings-category="common"]')
    .click();
  await expect(page.getByRole('region', { name: '窗口' })).toBeVisible();
}

test.describe('B-12 authenticated save-and-connect', () => {
  test.skip(!sshFixturePort, 'Run through scripts/test-ssh-fixture.sh with Docker OpenSSH');

  test('persists the bookmark credential reference and opens a verified SSH terminal', async () => {
    test.setTimeout(90_000);
    const userData = await mkdtemp(resolve(tmpdir(), 'axterm-save-connect-e2e-'));
    const localEvidence = resolve(userData, 'e01-local');
    await mkdir(localEvidence, { recursive: true });
    await writeFile(resolve(localEvidence, 'local-side.txt'), 'E01 local side');
    const secret = 'axterm-fixture-password';
    const app = await electron.launch({
      executablePath,
      args: [resolve('apps/desktop'), `--user-data-dir=${userData}`],
      env: { ...process.env, ELECTRON_RENDERER_URL: '' },
    });
    try {
      await app.evaluate(({ dialog, shell }, selectedPath) => {
        Object.defineProperty(dialog, 'showOpenDialog', {
          configurable: true,
          value: async () => ({ canceled: false, filePaths: [selectedPath] }),
        });
        Object.defineProperty(shell, 'openPath', {
          configurable: true,
          value: async () => '',
        });
        Object.defineProperty(shell, 'showItemInFolder', {
          configurable: true,
          value: (path: string) => {
            (globalThis as { __axtermRevealedPath?: string }).__axtermRevealedPath = path;
          },
        });
      }, localEvidence);
      const page = await app.firstWindow();
      await expect(page.getByTestId('runtime-state')).toHaveAttribute('data-state', 'ready');
      await page.locator('[data-activity-item="setting"]').click();
      await page.locator('[data-settings-category="terminal"]').click();
      const informationSettings = page.getByRole('group', { name: '终端信息' });
      await informationSettings.getByRole('checkbox', { name: '用户' }).click();
      await expect(informationSettings.getByRole('checkbox', { name: '用户' })).toBeChecked();
      const monitorEnabled = page.getByRole('checkbox', {
        name: '在已连接的 SSH 终端底部显示',
      });
      await monitorEnabled.click();
      await expect(monitorEnabled).toBeChecked();
      await page.locator('[data-activity-item="bookmarks"]').click();
      await page.locator('.workspace-sidebar').getByRole('button', { name: '管理' }).click();
      await page.getByRole('button', { name: '添加主机' }).click();

      const form = page.getByRole('dialog', { name: '添加 SSH 主机' });
      await form.getByLabel('显示名称').fill('B12 保存并连接');
      await form.getByLabel('主机地址').fill('127.0.0.1');
      await form.getByLabel('端口').fill(String(sshFixturePort));
      await form.getByLabel('用户名').fill('fixture');
      await form.getByLabel('认证方式').selectOption('password');
      await form.getByLabel('密码', { exact: true }).fill(secret);
      await expect(form.getByLabel(/加密保存到 Axterm 本地 Vault/)).toBeChecked();
      await form.getByRole('button', { name: '保存并连接' }).click();

      const hostKeyDialog = page.getByRole('dialog', { name: /首次连接此主机/ });
      await expect(hostKeyDialog).toBeVisible();
      await hostKeyDialog.getByLabel('保存并记住此主机密钥').check();
      await hostKeyDialog.getByRole('button', { name: '信任并连接', exact: true }).click();

      await expect(page.locator('.pane-tabbar .terminal-tab.active .tab-title')).toHaveText(
        'B12 保存并连接',
      );
      const activeTerminal = page.locator('.terminal-session-layer:not([hidden]) .terminal-host');
      await expect(activeTerminal).toHaveAttribute('data-connection-state', 'connected');
      await page.locator('.status-information').click();
      const informationPanel = page.getByRole('complementary', { name: '终端信息' });
      await expect(informationPanel).toBeVisible();
      await expect(informationPanel.locator('[data-information-group="sysinfo"]')).toContainText(
        '实时',
      );
      await expect(informationPanel.locator('[data-information-group="cpu"]')).toContainText('CPU');
      await expect(informationPanel.locator('[data-information-group="memory"]')).toContainText(
        '内存',
      );
      await informationPanel.getByRole('button', { name: '关闭终端信息' }).click();
      await expect(informationPanel).toBeHidden();
      const monitorBar = page.getByRole('region', { name: '远程监控栏' });
      await expect(monitorBar).toBeVisible();
      await expect(monitorBar.locator('.remote-monitor-item')).toHaveCount(9);
      const monitorGeometry = await page.evaluate(() => {
        const monitor = document.querySelector('.remote-monitor-bar')!.getBoundingClientRect();
        const terminal = document.querySelector('.workspace-content')!.getBoundingClientRect();
        const footer = document.querySelector('.app-statusbar')!.getBoundingClientRect();
        return {
          monitorTop: monitor.top,
          monitorBottom: monitor.bottom,
          terminalBottom: terminal.bottom,
          footerTop: footer.top,
        };
      });
      expect(
        Math.abs(monitorGeometry.monitorTop - monitorGeometry.terminalBottom),
      ).toBeLessThanOrEqual(2);
      expect(
        Math.abs(monitorGeometry.monitorBottom - monitorGeometry.footerTop),
      ).toBeLessThanOrEqual(2);
      await expect
        .poll(() => monitorBar.locator('[data-monitor-item="cpu"]').getAttribute('aria-label'))
        .toMatch(/CPU: [0-9.]+%;/u);
      await monitorBar.locator('[data-monitor-item="memory"]').click();
      const monitorDetail = page.getByRole('dialog', { name: '内存详情' });
      await expect(monitorDetail).toBeVisible();
      await expect(monitorDetail).toContainText('活动进程');
      await monitorDetail.getByRole('button', { name: '查看终端信息' }).click();
      await expect(informationPanel).toBeVisible();
      await expect(monitorBar).toBeHidden();
      await informationPanel.getByRole('button', { name: '关闭终端信息' }).click();
      await expect(monitorBar).toBeVisible();
      const terminalInput = page.locator(
        '.terminal-session-layer:not([hidden]) .xterm-helper-textarea',
      );
      await terminalInput.pressSequentially("printf '\\nB12_SAVE_CONNECT_OK\\n'");
      await terminalInput.press('Enter');
      await terminalInput.press(process.platform === 'darwin' ? 'Meta+f' : 'Control+f');
      const search = page.getByPlaceholder('查找终端输出');
      await expect
        .poll(async () => {
          await search.fill('');
          await search.fill('B12_SAVE_CONNECT_OK');
          return page.locator('.terminal-search-result').textContent();
        })
        .toBe('已找到');
      await page.keyboard.press('Escape');

      const terminalLayer = page.locator('.terminal-session-layer:not([hidden])');
      const terminalSurface = terminalLayer.locator('.terminal-surface');
      const dropFile = (name: string, content: string, bytes = 0) =>
        terminalSurface.evaluate(
          (element, file) => {
            const transfer = new DataTransfer();
            const body = file.bytes ? new Uint8Array(file.bytes) : file.content;
            transfer.items.add(new File([body], file.name, { type: 'application/octet-stream' }));
            element.dispatchEvent(
              new DragEvent('dragenter', {
                bubbles: true,
                cancelable: true,
                dataTransfer: transfer,
              }),
            );
            element.dispatchEvent(
              new DragEvent('drop', {
                bubbles: true,
                cancelable: true,
                dataTransfer: transfer,
              }),
            );
          },
          { name, content, bytes },
        );

      await dropFile('c15-ssh-upload.txt', 'C15_REAL_SSH_DROP_OK');
      let dropDialog = page.getByRole('dialog', { name: '如何处理拖放的文件？' });
      await expect(dropDialog.getByRole('button', { name: '上传到当前目录' })).toBeEnabled();
      await dropDialog.getByRole('button', { name: '上传到当前目录' }).click();
      await expect(terminalLayer.locator('.terminal-action-feedback')).toHaveText(
        '已将 1 个文件加入上传队列。',
      );
      await page.locator('.status-transfer').click();
      const transferCenter = page.getByLabel('传输中心');
      await expect(transferCenter.locator('article').first()).toContainText('已完成');

      await terminalInput.pressSequentially("cat './c15-ssh-upload.txt'");
      await terminalInput.press('Enter');
      await expect
        .poll(() => terminalLayer.locator('.xterm-rows').textContent())
        .toContain('C15_REAL_SSH_DROP_OK');

      await dropFile('c15-ssh-cancel.bin', '', 128 * 1024 * 1024);
      dropDialog = page.getByRole('dialog', { name: '如何处理拖放的文件？' });
      await expect(dropDialog).toBeVisible();
      await dropDialog.getByRole('button', { name: '上传到当前目录' }).click();
      await expect(terminalLayer.locator('.terminal-action-feedback')).toHaveText(
        '已将 1 个文件加入上传队列。',
      );
      const activeUpload = transferCenter.locator('article').first();
      await activeUpload.getByTitle('暂停').click();
      await expect(activeUpload).toContainText('已暂停');
      await activeUpload.getByTitle('继续').click();
      await expect(activeUpload.getByTitle('暂停')).toBeVisible();
      await activeUpload.getByTitle('取消').click();
      await expect(activeUpload).toContainText('已取消');
      await transferCenter.getByLabel('关闭传输中心').click();
      await terminalInput.pressSequentially(
        "if [ ! -e './c15-ssh-cancel.bin' ] && ! find . -maxdepth 1 -name '.axterm-*.part' -print -quit | grep -q .; then printf '\\nC15_REAL_SSH_CANCEL_CLEAN\\n'; fi",
      );
      await terminalInput.press('Enter');
      await expect
        .poll(() => terminalLayer.locator('.xterm-rows').textContent())
        .toContain('C15_REAL_SSH_CANCEL_CLEAN');
      await terminalInput.pressSequentially(
        "cd /tmp && printf 'E01 remote side' > ./e01-remote-side.txt && touch .hidden-e04-remote e05-a.txt e05-b.txt e05-c.txt && printf '\\nE02_REMOTE_CWD_READY\\n'",
      );
      await terminalInput.press('Enter');
      await expect
        .poll(() => terminalLayer.locator('.xterm-rows').textContent())
        .toContain('E02_REMOTE_CWD_READY');

      await openFilesWorkspace(page);
      const localPane = page.getByRole('region', { name: '本地文件' });
      const remotePane = page.getByRole('region', { name: '远端文件' });
      await expect(page.locator('.transfer-list')).toHaveCount(0);
      await page.locator('.status-transfer').click();
      await expect(transferCenter.locator('article')).not.toHaveCount(0);
      await transferCenter.getByLabel('关闭传输中心').click();
      await expect(localPane.getByLabel('本地绝对路径')).toHaveValue(await realpath(homedir()));
      await localPane.getByRole('button', { name: '更换目录' }).click();
      await expect(localPane.getByText('local-side.txt', { exact: true })).toBeVisible();
      await localPane.getByRole('button', { name: 'local-side.txt', exact: true }).click();
      await expect(localPane.locator('.file-data-row.selected')).toHaveCount(1);
      await localPane
        .getByRole('button', { name: 'local-side.txt', exact: true })
        .click({ button: 'right' });
      const localTransferMenu = page.getByRole('menu', { name: '本地文件菜单' });
      await expect(localTransferMenu.getByRole('menuitem').first()).toHaveText('上传到远端');
      await expect(localTransferMenu.getByRole('menuitem').first()).toHaveClass(/primary-item/u);
      await localTransferMenu.getByRole('menuitem', { name: '上传到远端' }).click();
      const uploadConfirmation = page.getByRole('dialog', { name: '确认上传' });
      await expect(uploadConfirmation).toContainText('将选中的 1 项上传到远端目录：');
      await uploadConfirmation.getByRole('button', { name: '取消' }).click();
      const remoteAddress = remotePane.getByRole('textbox', { name: '远端路径', exact: true });
      await expect(remoteAddress).toHaveValue(/^\/(?!$)/u);
      await remotePane.locator('.file-table-scroll').evaluate((element) => {
        const transfer = new DataTransfer();
        transfer.items.add(
          new File(['E01_EXTERNAL_DROP_OK'], 'e01-external-drop.txt', { type: 'text/plain' }),
        );
        element.dispatchEvent(
          new DragEvent('dragenter', { bubbles: true, cancelable: true, dataTransfer: transfer }),
        );
        element.dispatchEvent(
          new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: transfer }),
        );
        element.dispatchEvent(
          new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer }),
        );
      });
      await expect(page.getByText('已将 1 项加入上传队列。')).toBeVisible();
      await expect(remotePane.getByText('e01-external-drop.txt', { exact: true })).toBeVisible();
      await remotePane.getByRole('button', { name: '当前终端目录' }).click();
      await expect(remoteAddress).toHaveValue('/tmp');
      await expect(remotePane.getByText('e01-remote-side.txt', { exact: true })).toBeVisible();
      await remotePane.getByRole('button', { name: 'e01-remote-side.txt', exact: true }).click();
      const compareButton = page.getByRole('button', { name: '比较', exact: true });
      await expect(compareButton).toBeEnabled();
      await compareButton.click();
      const comparisonDialog = page.getByRole('dialog', { name: '比较文件' });
      await expect(comparisonDialog).toContainText('发现差异');
      await expect(comparisonDialog).toContainText('local-side.txt');
      await expect(comparisonDialog).toContainText('e01-remote-side.txt');
      await comparisonDialog.getByRole('tab', { name: '内容' }).click();
      await expect(comparisonDialog).toContainText('E01 local side');
      await expect(comparisonDialog).toContainText('E01 remote side');
      await comparisonDialog.getByRole('button', { name: '关闭', exact: true }).click();
      const remoteKeyword = remotePane.getByRole('textbox', {
        name: '远端文件关键词',
        exact: true,
      });
      await page.evaluate(() => {
        Object.defineProperty(navigator, 'clipboard', {
          configurable: true,
          value: {
            writeText: async (text: string) => {
              document.documentElement.dataset.fileClipboardWrite = text;
            },
          },
        });
      });
      await remotePane
        .getByRole('button', { name: 'e01-remote-side.txt', exact: true })
        .click({ button: 'right' });
      const remoteFileMenu = page.getByRole('menu', { name: '远端文件菜单' });
      await expect(remoteFileMenu).toBeVisible();
      await expect(remoteFileMenu.getByRole('menuitem').first()).toHaveText('下载到本地');
      await expect(remoteFileMenu.getByRole('menuitem').first()).toHaveClass(/primary-item/u);
      await remoteFileMenu.getByRole('menuitem', { name: '下载到本地' }).click();
      const downloadConfirmation = page.getByRole('dialog', { name: '确认下载' });
      await expect(downloadConfirmation).toContainText('将选中的 1 项下载到本地目录：');
      await downloadConfirmation.getByRole('button', { name: '取消' }).click();
      await remotePane
        .getByRole('button', { name: 'e01-remote-side.txt', exact: true })
        .click({ button: 'right' });
      await expect(remoteFileMenu.getByRole('menuitem', { name: '修改权限' })).toBeVisible();
      await remoteFileMenu.getByRole('menuitem', { name: '新建文件' }).click();
      let remoteFileDialog = page.getByRole('dialog', { name: '新建远端文件' });
      await remoteFileDialog.getByLabel('名称').fill('e06-remote.txt');
      await remoteFileDialog.getByRole('button', { name: '创建' }).click();
      await remoteKeyword.fill('E06-REMOTE');
      await remoteKeyword.press('Enter');
      let remoteCreatedFile = remotePane.getByRole('button', {
        name: 'e06-remote.txt',
        exact: true,
      });
      await expect(remoteCreatedFile).toBeVisible();
      await remoteCreatedFile.click({ button: 'right' });
      await page.getByRole('menuitem', { name: '信息' }).click();
      const remoteInfoDialog = page.getByRole('dialog', { name: '文件信息' });
      await expect(remoteInfoDialog).toContainText('远端项目');
      await expect(remoteInfoDialog).toContainText('/tmp/e06-remote.txt');
      await expect(remoteInfoDialog).toContainText('0600');
      await remoteInfoDialog.getByRole('button', { name: '修改权限' }).click();
      await remoteInfoDialog.getByLabel('八进制权限').fill('0640');
      await remoteInfoDialog.getByRole('button', { name: '应用权限' }).click();
      await expect(remoteInfoDialog).toHaveCount(0);
      await remoteCreatedFile.click({ button: 'right' });
      await page.getByRole('menuitem', { name: '信息' }).click();
      await expect(remoteInfoDialog).toContainText('rw-r-----');
      await expect(remoteInfoDialog).toContainText('0640');
      await remoteInfoDialog.getByRole('button', { name: '关闭', exact: true }).click();
      await remoteCreatedFile.click({ button: 'right' });
      await page.getByRole('menuitem', { name: '重命名' }).click();
      remoteFileDialog = page.getByRole('dialog', { name: '重命名远端路径' });
      await remoteFileDialog.getByLabel('名称').fill('e06-remote-renamed.txt');
      await remoteFileDialog.getByRole('button', { name: '保存' }).click();
      remoteCreatedFile = remotePane.getByRole('button', {
        name: 'e06-remote-renamed.txt',
        exact: true,
      });
      await expect(remoteCreatedFile).toBeVisible();
      await remoteCreatedFile.click({ button: 'right' });
      await page.getByRole('menuitem', { name: '复制路径' }).click();
      await expect
        .poll(() => page.evaluate(() => document.documentElement.dataset.fileClipboardWrite ?? ''))
        .toBe('/tmp/e06-remote-renamed.txt');
      await remoteCreatedFile.click({ button: 'right' });
      page.once('dialog', (dialog) => dialog.accept());
      await page.getByRole('menuitem', { name: '删除' }).click();
      await expect(remoteCreatedFile).toHaveCount(0);
      await remotePane.getByRole('button', { name: '清除远端文件关键词' }).click();

      const selectionModifier = process.platform === 'darwin' ? 'Meta' : 'Control';
      const e07Source = remotePane.getByRole('button', {
        name: 'e01-remote-side.txt',
        exact: true,
      });
      await e07Source.click();
      await page.keyboard.press(`${selectionModifier}+C`);
      await page.keyboard.press(`${selectionModifier}+V`);
      await expect(
        remotePane.getByRole('button', {
          name: 'e01-remote-side(copy-1).txt',
          exact: true,
        }),
      ).toBeVisible();

      await e07Source.click({ button: 'right' });
      await page.getByRole('menuitem', { name: '新建目录' }).click();
      remoteFileDialog = page.getByRole('dialog', { name: '新建远端目录' });
      await remoteFileDialog.getByLabel('名称').fill('e07-target');
      await remoteFileDialog.getByRole('button', { name: '创建' }).click();
      for (const name of ['e07-cut.txt', 'e07-drag.txt']) {
        await e07Source.click({ button: 'right' });
        await page.getByRole('menuitem', { name: '新建文件' }).click();
        remoteFileDialog = page.getByRole('dialog', { name: '新建远端文件' });
        await remoteFileDialog.getByLabel('名称').fill(name);
        await remoteFileDialog.getByRole('button', { name: '创建' }).click();
      }
      await remoteKeyword.fill('E07-');
      await remoteKeyword.press('Enter');
      const e07Target = remotePane.getByRole('button', { name: 'e07-target', exact: true });
      const e07Cut = remotePane.getByRole('button', { name: 'e07-cut.txt', exact: true });
      await e07Cut.click();
      await page.keyboard.press(`${selectionModifier}+X`);
      await e07Target.dblclick();
      await remotePane.locator('.file-table-scroll').focus();
      await page.keyboard.press(`${selectionModifier}+V`);
      await expect(
        remotePane.getByRole('button', { name: 'e07-cut.txt', exact: true }),
      ).toBeVisible();
      await remotePane.getByTitle('上级目录').click();
      await remoteKeyword.fill('E07-');
      await remoteKeyword.press('Enter');
      const e07Drag = remotePane.getByRole('button', { name: 'e07-drag.txt', exact: true });
      await dragFileTo(e07Drag, e07Target, page);
      await expect(e07Drag).toHaveCount(0);
      await e07Target.dblclick();
      await expect(
        remotePane.getByRole('button', { name: 'e07-drag.txt', exact: true }),
      ).toBeVisible();
      await remotePane.getByTitle('上级目录').click();

      await e07Source.click({ button: 'right' });
      await page.getByRole('menuitem', { name: '新建目录' }).click();
      remoteFileDialog = page.getByRole('dialog', { name: '新建远端目录' });
      await remoteFileDialog.getByLabel('名称').fill('e08-upload-target');
      await remoteFileDialog.getByRole('button', { name: '创建' }).click();
      const e08RemoteTarget = remotePane.getByRole('button', {
        name: 'e08-upload-target',
        exact: true,
      });
      const localSideFile = localPane.getByRole('button', {
        name: 'local-side.txt',
        exact: true,
      });
      await dragFileTo(localSideFile, e08RemoteTarget, page);
      const uploadDropDialog = page.getByRole('dialog', { name: '确认上传' });
      await expect(uploadDropDialog).toContainText('选中的 1 项');
      await expect(uploadDropDialog).toContainText('/tmp/e08-upload-target');
      await uploadDropDialog.getByRole('button', { name: '上传', exact: true }).click();
      await expect(page.locator('.file-operation-notice')).toContainText('已将 1 项加入上传队列');
      await e08RemoteTarget.dblclick();
      const uploadedLocalSide = remotePane.getByRole('button', {
        name: 'local-side.txt',
        exact: true,
      });
      await expect(uploadedLocalSide).toBeVisible({ timeout: 30_000 });
      await uploadedLocalSide.click({ button: 'right' });
      await page.getByRole('menuitem', { name: '新建文件' }).click();
      remoteFileDialog = page.getByRole('dialog', { name: '新建远端文件' });
      await remoteFileDialog.getByLabel('名称').fill('e08-download.txt');
      await remoteFileDialog.getByRole('button', { name: '创建' }).click();

      await localSideFile.click({ button: 'right' });
      await page.getByRole('menuitem', { name: '新建目录' }).click();
      const localFileDialog = page.getByRole('dialog', { name: '新建本地目录' });
      await localFileDialog.getByLabel('名称').fill('e08-download-target');
      await localFileDialog.getByRole('button', { name: '创建' }).click();
      const e08LocalTarget = localPane.getByRole('button', {
        name: 'e08-download-target',
        exact: true,
      });
      const e08Download = remotePane.getByRole('button', {
        name: 'e08-download.txt',
        exact: true,
      });
      await uploadedLocalSide.click();
      await e08Download.click({ modifiers: [selectionModifier] });
      await dragFileTo(e08Download, e08LocalTarget, page);
      const downloadDropDialog = page.getByRole('dialog', { name: '确认下载' });
      await expect(downloadDropDialog).toContainText('选中的 2 项');
      await expect(downloadDropDialog).toContainText('e08-download-target');
      await downloadDropDialog.getByRole('button', { name: '下载', exact: true }).click();
      await expect(page.locator('.file-operation-notice')).toContainText('已将 2 项加入下载队列');
      await e08LocalTarget.dblclick();
      await expect(
        localPane.getByRole('button', { name: 'e08-download.txt', exact: true }),
      ).toBeVisible({ timeout: 30_000 });
      await expect(
        localPane.getByRole('button', { name: 'local-side.txt', exact: true }),
      ).toBeVisible({ timeout: 30_000 });
      await remotePane.getByTitle('上级目录').click();
      await expect(remoteAddress).toHaveValue('/tmp');

      await e07Source.click({ button: 'right' });
      await page.getByRole('menuitem', { name: '复制到其他远端…' }).click();
      const remoteCopyDialog = page.getByRole('dialog', { name: '复制到远端' });
      await expect(remoteCopyDialog).toContainText('选中的 1 项');
      await expect(remoteCopyDialog.getByLabel('目标连接')).toContainText('B12 保存并连接（当前）');
      await expect(remoteCopyDialog.getByLabel('目标目录')).toHaveValue('/tmp');
      await remoteCopyDialog.getByRole('button', { name: '开始复制' }).click();
      await expect(page.locator('.file-operation-notice')).toContainText(
        '已将 1 项加入远端复制队列',
      );
      const conflictDialog = page.getByRole('dialog', { name: '处理传输冲突' });
      await expect(conflictDialog).toContainText('/tmp/e01-remote-side.txt');
      await conflictDialog.getByLabel('对此任务的后续冲突应用相同选择').check();
      await conflictDialog.getByRole('button', { name: '改名' }).click();
      await expect(
        remotePane.getByRole('button', { name: 'e01-remote-side.txt.copy-1', exact: true }),
      ).toBeVisible({ timeout: 30_000 });

      await e07Target.click({ button: 'right' });
      await page.getByRole('menuitem', { name: '压缩并传输' }).click();
      await expect(page.locator('.file-operation-notice')).toContainText(
        '已将 e07-target 加入压缩下载队列',
      );
      const archivedTarget = localPane.getByRole('button', { name: 'e07-target', exact: true });
      await expect(archivedTarget).toBeVisible({ timeout: 30_000 });
      await archivedTarget.dblclick();
      await expect(
        localPane.getByRole('button', { name: 'e07-cut.txt', exact: true }),
      ).toBeVisible();
      await expect(
        localPane.getByRole('button', { name: 'e07-drag.txt', exact: true }),
      ).toBeVisible();
      await localPane.getByTitle('上级目录').click();

      await e07Source.click({ button: 'right' });
      await page.getByRole('menuitem', { name: '新建并编辑文本' }).click();
      remoteFileDialog = page.getByRole('dialog', { name: '新建远端文件' });
      await remoteFileDialog.getByLabel('名称').fill('e13-editor.txt');
      await remoteFileDialog.getByRole('button', { name: '创建' }).click();
      let textEditor = page.getByRole('dialog', { name: '远程文本编辑器' });
      await expect(textEditor.locator('header small')).toHaveText('就绪');
      const editorContent = textEditor.locator('.cm-content');
      await editorContent.fill('alpha\nbeta alpha');
      await textEditor.getByLabel('在文本中查找').fill('alpha');
      await textEditor.getByLabel('在文本中查找').press('Enter');
      await expect(textEditor.locator('.remote-editor-toolbar')).toContainText('1/2');
      await textEditor.getByRole('button', { name: '复制全文' }).click();
      await expect
        .poll(() => page.evaluate(() => document.documentElement.dataset.fileClipboardWrite ?? ''))
        .toBe('alpha\nbeta alpha');
      await editorContent.press(`${selectionModifier}+s`);
      await expect(textEditor).toContainText('已保存');
      await textEditor.getByRole('button', { name: '关闭编辑器' }).click();
      const e13File = remotePane.getByRole('button', { name: 'e13-editor.txt', exact: true });
      await expect(e13File).toBeVisible();
      await e13File.dblclick();
      textEditor = page.getByRole('dialog', { name: '远程文本编辑器' });
      await expect(textEditor.locator('.cm-content')).toContainText('beta alpha');
      await textEditor.getByRole('button', { name: '关闭编辑器' }).click();

      await e13File.click({ button: 'right' });
      await page.getByRole('menuitem', { name: '使用系统编辑器…' }).click();
      const externalEditor = page.getByRole('dialog', { name: '使用系统编辑器' });
      await expect(externalEditor).toContainText('正在等待系统编辑器保存');
      const editableRoot = resolve(userData, 'vault-v2', 'editable-files');
      let editablePath = '';
      await expect
        .poll(async () => {
          const roots = await readdir(editableRoot).catch(() => []);
          if (!roots[0]) return '';
          const files = await readdir(resolve(editableRoot, roots[0])).catch(() => []);
          if (!files[0]) return '';
          editablePath = resolve(editableRoot, roots[0], files[0]);
          return editablePath;
        })
        .not.toBe('');
      await writeFile(editablePath, 'external editor update\n');
      await expect(externalEditor).toContainText('检测到本地更改');
      await externalEditor.getByRole('button', { name: '上传更改' }).click();
      await expect(externalEditor).toContainText('更改已上传');
      await externalEditor.getByRole('button', { name: '完成并清理副本' }).click();
      await expect(externalEditor).toHaveCount(0);
      await expect.poll(async () => (await readdir(editableRoot).catch(() => [])).length).toBe(0);
      await e13File.dblclick();
      textEditor = page.getByRole('dialog', { name: '远程文本编辑器' });
      await expect(textEditor.locator('.cm-content')).toContainText('external editor update');
      await textEditor.getByRole('button', { name: '关闭编辑器' }).click();

      await remoteKeyword.fill('HIDDEN-E04-REMOTE');
      await remoteKeyword.press('Enter');
      await expect(remotePane.getByText('.hidden-e04-remote', { exact: true })).toBeVisible();
      await remotePane.getByRole('button', { name: '隐藏远端隐藏文件' }).click();
      await expect(remotePane.locator('.file-table-page')).toContainText('0 / 0');
      await remotePane.getByRole('button', { name: '显示远端隐藏文件' }).click();
      await expect(remotePane.getByText('.hidden-e04-remote', { exact: true })).toBeVisible();
      await remotePane.getByRole('button', { name: '清除远端文件关键词' }).click();
      await remotePane.getByRole('button', { name: '收藏远端路径' }).click();
      await remotePane.getByTitle('远端根目录').click();
      await expect(remoteAddress).toHaveValue('/');
      await remotePane.getByLabel('远端路径历史').selectOption('/tmp');
      await expect(remotePane.getByText('e01-remote-side.txt', { exact: true })).toBeVisible();
      await remotePane.getByTitle('远端根目录').click();
      await remotePane.getByLabel('远端路径收藏').selectOption('/tmp');
      await expect(remoteAddress).toHaveValue('/tmp');
      await remoteKeyword.fill('E05-');
      await remoteKeyword.press('Enter');
      const e05a = remotePane.getByRole('button', { name: 'e05-a.txt', exact: true });
      const e05b = remotePane.getByRole('button', { name: 'e05-b.txt', exact: true });
      const e05c = remotePane.getByRole('button', { name: 'e05-c.txt', exact: true });
      await e05a.click();
      await expect(localPane.locator('.file-data-row.selected')).toHaveCount(0);
      await e05b.click({ modifiers: [selectionModifier] });
      await e05c.click({ modifiers: ['Shift'] });
      await expect(remotePane.locator('.file-data-row.selected')).toHaveCount(3);
      await expect(remotePane.locator('.file-table-page')).toContainText('已选 3');
      await e05c.click({ button: 'right' });
      await page
        .getByRole('menu', { name: '远端文件菜单' })
        .getByRole('menuitem', { name: '下载到本地' })
        .click();
      await expect(downloadConfirmation).toContainText('将选中的 3 项下载到本地目录：');
      await downloadConfirmation.getByRole('button', { name: '取消' }).click();
      await e05c.press('ArrowUp');
      await expect(remotePane.locator('.file-data-row.selected')).toHaveCount(1);
      await page.keyboard.press(`${selectionModifier}+A`);
      await expect(remotePane.locator('.file-table-page')).toContainText('已选 3');
      await page.keyboard.press('Escape');
      await expect(remotePane.locator('.file-data-row.selected')).toHaveCount(0);
      await remotePane.getByRole('button', { name: '清除远端文件关键词' }).click();
      await remoteAddress.fill('relative/path');
      await remoteAddress.press('Enter');
      await expect(page.getByRole('alert')).toContainText('远端路径必须是以 / 开头的绝对路径');
      await expect(page.getByRole('group', { name: '文件面板布局' })).toBeVisible();

      await localPane
        .getByRole('button', { name: 'local-side.txt', exact: true })
        .click({ button: 'right' });
      await page.getByRole('menuitem', { name: '在文件管理器中显示' }).click();
      await expect
        .poll(() =>
          app.evaluate(() => {
            return (globalThis as { __axtermRevealedPath?: string }).__axtermRevealedPath ?? '';
          }),
        )
        .toBe(await realpath(resolve(localEvidence, 'e08-download-target', 'local-side.txt')));

      await remotePane
        .getByRole('button', { name: 'e07-target', exact: true })
        .click({ button: 'right' });
      await page.getByRole('menuitem', { name: '在此处打开终端' }).click();
      await expect(page.locator('.pane-tabbar .terminal-tab.active .tab-title')).toHaveText(
        'B12 保存并连接 · e07-target',
      );
      let directoryTerminal = page.locator(
        '.terminal-session-layer:not([hidden]) .xterm-helper-textarea',
      );
      await directoryTerminal.pressSequentially('pwd');
      await directoryTerminal.press('Enter');
      await directoryTerminal.press(`${selectionModifier}+f`);
      let directorySearch = page
        .locator('.terminal-session-layer:not([hidden])')
        .getByPlaceholder('查找终端输出');
      await directorySearch.fill('/tmp/e07-target');
      await directorySearch.press('Enter');
      await expect(
        page.locator('.terminal-session-layer:not([hidden]) .terminal-search-result'),
      ).toHaveText('已找到');
      await page.keyboard.press('Escape');

      await page
        .locator('.terminal-pane.active .session-mode-tabs')
        .getByRole('tab', { name: 'SFTP', exact: true })
        .click();
      await expect(localPane.getByLabel('本地绝对路径')).toHaveValue(await realpath(homedir()));
      await localPane.getByRole('button', { name: '更换目录' }).click();
      const localTerminalDirectory = localPane.getByRole('button', {
        name: 'e08-download-target',
        exact: true,
      });
      await expect(localTerminalDirectory).toBeVisible();
      await localTerminalDirectory.click({ button: 'right' });
      await page.getByRole('menuitem', { name: '在此处打开终端' }).click();
      await expect(page.locator('.pane-tabbar .terminal-tab.active .tab-title')).toHaveText(
        '本地 · e08-download-target',
      );
      directoryTerminal = page.locator(
        '.terminal-session-layer:not([hidden]) .xterm-helper-textarea',
      );
      await directoryTerminal.pressSequentially('pwd');
      await directoryTerminal.press('Enter');
      await directoryTerminal.press(`${selectionModifier}+f`);
      directorySearch = page
        .locator('.terminal-session-layer:not([hidden])')
        .getByPlaceholder('查找终端输出');
      await directorySearch.fill(await realpath(resolve(localEvidence, 'e08-download-target')));
      await directorySearch.press('Enter');
      await expect(
        page.locator('.terminal-session-layer:not([hidden]) .terminal-search-result'),
      ).toHaveText('已找到');
      await page.keyboard.press('Escape');

      const database = await ProductDatabase.open(resolve(userData, 'data-v2', 'axterm.sqlite'));
      try {
        const host = new ProductRepository(database)
          .listHosts()
          .find(({ name }) => name === 'B12 保存并连接');
        expect(host).toMatchObject({
          hostname: '127.0.0.1',
          port: sshFixturePort,
          username: 'fixture',
          authType: 'password',
        });
        expect(host?.credentialRef).toMatch(/^cred_/u);
        expect(
          new BookmarkRepository(database)
            .snapshot()
            .bookmarks.find(({ title }) => title === 'B12 保存并连接'),
        ).toMatchObject({ protocol: 'ssh', hostId: host?.id });
        expect(
          new ProductRepository(database).getSettings().fileManager.remoteAddressBookmarks,
        ).toEqual([expect.objectContaining({ hostId: host?.id, path: '/tmp' })]);
        expect(new ProductRepository(database).getSettings().monitor).toMatchObject({
          terminalInformationItems: expect.arrayContaining(['users']),
          remoteMonitorBarEnabled: true,
          remoteMonitorBarItems: [
            'hostname',
            'cpu',
            'cpuHistory',
            'memory',
            'upload',
            'download',
            'uptime',
            'users',
            'disks',
          ],
        });
      } finally {
        database.close();
      }

      const browserStorage = await page.evaluate(() => JSON.stringify({ ...localStorage }));
      expect(browserStorage).not.toContain(secret);
      for (const directory of [resolve(userData, 'data-v2'), resolve(userData, 'vault-v2')]) {
        for (const contents of await readDirectoryFiles(directory))
          expect(contents.includes(Buffer.from(secret))).toBe(false);
      }
    } finally {
      await app.close().catch(() => {});
      await rm(userData, { recursive: true, force: true });
    }
  });
});

test('D-01 persists MFA authentication without exposing the local Vault secret', async () => {
  const userData = await mkdtemp(resolve(tmpdir(), 'axterm-mfa-auth-e2e-'));
  const secret = 'D01-local-password-secret';
  const app = await electron.launch({
    executablePath,
    args: [resolve('apps/desktop'), `--user-data-dir=${userData}`],
    env: { ...process.env, ELECTRON_RENDERER_URL: '' },
  });
  try {
    const page = await app.firstWindow();
    await expect(page.getByTestId('runtime-state')).toHaveAttribute('data-state', 'ready');
    await page.locator('[data-activity-item="bookmarks"]').click();
    await page.locator('.workspace-sidebar').getByRole('button', { name: '管理' }).click();
    await page.getByRole('button', { name: '添加主机' }).click();
    const form = page.getByRole('dialog', { name: '添加 SSH 主机' });
    await form.getByLabel('显示名称').fill('D01 MFA host');
    await form.getByLabel('主机地址').fill('mfa.example.test');
    await form.getByLabel('用户名').fill('operator');
    await form.getByRole('switch', { name: 'MFA/OTP' }).click();
    await expect(form.getByRole('switch', { name: 'MFA/OTP' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    await expect(form.getByLabel('认证方式')).toHaveValue('keyboardInteractive');
    await form.getByLabel('密码').fill(secret);
    await form.getByRole('button', { name: '保存', exact: true }).click();
    const hostCard = page.locator('.host-card').filter({ hasText: 'D01 MFA host' });
    await expect(hostCard).toBeVisible();
    await hostCard.getByRole('button', { name: '编辑' }).click();
    const persisted = page.getByRole('dialog', { name: '编辑 SSH 主机' });
    await expect(persisted.getByRole('switch', { name: 'MFA/OTP' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    await expect(persisted.getByLabel('密码')).toHaveAttribute('placeholder', /已保存/u);
    await persisted.getByRole('button', { name: '取消' }).click();

    const database = await ProductDatabase.open(resolve(userData, 'data-v2', 'axterm.sqlite'));
    try {
      const host = new ProductRepository(database)
        .listHosts()
        .find(({ name }) => name === 'D01 MFA host');
      expect(host).toMatchObject({
        authType: 'keyboardInteractive',
        hostname: 'mfa.example.test',
        username: 'operator',
      });
      expect(host?.credentialRef).toMatch(/^cred_/u);
    } finally {
      database.close();
    }
    expect(JSON.stringify(await page.evaluate(() => ({ ...localStorage })))).not.toContain(secret);
    for (const directory of [resolve(userData, 'data-v2'), resolve(userData, 'vault-v2')])
      for (const contents of await readDirectoryFiles(directory))
        expect(contents.includes(Buffer.from(secret))).toBe(false);
  } finally {
    await app.close().catch(() => {});
    await rm(userData, { recursive: true, force: true });
  }
});

test('D-02 saves certificate and Agent settings with capability feedback', async () => {
  const userData = await mkdtemp(resolve(tmpdir(), 'axterm-certificate-agent-e2e-'));
  const privateKey = 'D02 PRIVATE KEY SECRET';
  const certificate = 'ssh-ed25519-cert-v01@openssh.com D02_CERTIFICATE_SECRET certificate-fixture';
  const agentPath = resolve(userData, 'missing-agent.sock');
  const app = await electron.launch({
    executablePath,
    args: [resolve('apps/desktop'), `--user-data-dir=${userData}`],
    env: { ...process.env, ELECTRON_RENDERER_URL: '' },
  });
  try {
    const page = await app.firstWindow();
    await expect(page.getByTestId('runtime-state')).toHaveAttribute('data-state', 'ready');
    await page.locator('[data-activity-item="bookmarks"]').click();
    await page.locator('.workspace-sidebar').getByRole('button', { name: '管理' }).click();
    await page.getByRole('button', { name: '添加主机' }).click();
    const form = page.getByRole('dialog', { name: '添加 SSH 主机' });
    await form.getByLabel('显示名称').fill('D02 Certificate Agent');
    await form.getByLabel('主机地址').fill('certificate.example.test');
    await form.getByLabel('用户名').fill('operator');
    await form.getByLabel('认证方式').selectOption('privateKey');
    await form.getByLabel('私钥', { exact: true }).fill(privateKey);
    await form.getByLabel('SSH 证书').fill(certificate);
    await expect(form.getByRole('switch', { name: '使用 SSH Agent' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    await form.getByLabel('SSH Agent Path').fill(agentPath);
    await form.getByRole('button', { name: '检测', exact: true }).click();
    await expect(form.getByRole('status')).toContainText('unavailable');
    await form.getByRole('button', { name: '保存', exact: true }).click();

    const hostCard = page.locator('.host-card').filter({ hasText: 'D02 Certificate Agent' });
    await expect(hostCard).toBeVisible();
    await hostCard.getByRole('button', { name: '编辑' }).click();
    const persisted = page.getByRole('dialog', { name: '编辑 SSH 主机' });
    await expect(persisted.getByLabel('私钥', { exact: true })).toHaveAttribute(
      'placeholder',
      /已保存/u,
    );
    await expect(persisted.getByLabel('SSH 证书')).toHaveAttribute('placeholder', /已保存/u);
    await expect(persisted.getByLabel('SSH Agent Path')).toHaveValue(agentPath);
    await persisted.getByRole('button', { name: '取消' }).click();

    const database = await ProductDatabase.open(resolve(userData, 'data-v2', 'axterm.sqlite'));
    try {
      const host = new ProductRepository(database)
        .listHosts()
        .find(({ name }) => name === 'D02 Certificate Agent');
      expect(host).toMatchObject({
        authType: 'privateKey',
        certificateCredentialRef: expect.stringMatching(/^cred_/u),
        sshAgent: { enabled: true, path: agentPath },
      });
      expect(host?.credentialRef).toMatch(/^cred_/u);
    } finally {
      database.close();
    }
    expect(JSON.stringify(await page.evaluate(() => ({ ...localStorage })))).not.toContain(
      privateKey,
    );
    for (const directory of [resolve(userData, 'data-v2'), resolve(userData, 'vault-v2')])
      for (const contents of await readDirectoryFiles(directory)) {
        expect(contents.includes(Buffer.from(privateKey))).toBe(false);
        expect(contents.includes(Buffer.from('D02_CERTIFICATE_SECRET'))).toBe(false);
      }
  } finally {
    await app.close().catch(() => {});
    await rm(userData, { recursive: true, force: true });
  }
});

test('D-03 lists and revokes a versioned known Host Key', async () => {
  const userData = await mkdtemp(resolve(tmpdir(), 'axterm-known-host-key-e2e-'));
  await mkdir(resolve(userData, 'data-v2'), { recursive: true });
  let database = await ProductDatabase.open(resolve(userData, 'data-v2', 'axterm.sqlite'));
  const saved = new ProductRepository(database).saveKnownHostKey({
    host: 'known.example.test',
    port: 2222,
    algorithm: 'ssh-ed25519',
    fingerprint: 'SHA256:D03KnownHostFingerprint',
    publicKey: 'D03-public-key',
  });
  database.close();

  const app = await electron.launch({
    executablePath,
    args: [resolve('apps/desktop'), `--user-data-dir=${userData}`],
    env: { ...process.env, ELECTRON_RENDERER_URL: '' },
  });
  try {
    const page = await app.firstWindow();
    await expect(page.getByTestId('runtime-state')).toHaveAttribute('data-state', 'ready');
    await page.locator('[data-activity-item="setting"]').click();
    await page.locator('[data-settings-category="common"]').click();

    const panel = page.getByRole('region', { name: '已知主机密钥' });
    await expect(panel).toContainText('known.example.test:2222');
    await expect(panel).toContainText('ssh-ed25519');
    await expect(panel).toContainText('SHA256:D03KnownHostFingerprint');
    page.once('dialog', (dialog) => dialog.accept());
    await panel.getByRole('button', { name: '撤销信任' }).click();
    await expect(panel).toContainText('已撤销 known.example.test:2222 的信任记录。');
    await expect(panel.getByRole('listitem')).toHaveCount(0);

    database = await ProductDatabase.open(resolve(userData, 'data-v2', 'axterm.sqlite'));
    try {
      expect(new ProductRepository(database).listKnownHostKeys()).toEqual([]);
      expect(
        new ProductRepository(database)
          .listEvents()
          .find(
            ({ type, aggregateId }) =>
              type === 'known-host-key.revoked' && aggregateId === saved.id,
          ),
      ).toBeDefined();
    } finally {
      database.close();
    }
  } finally {
    await app.close().catch(() => {});
    await rm(userData, { recursive: true, force: true });
  }
});

test('D-04 recovers and cancels a real network-loss reconnect from the terminal overlay', async () => {
  test.setTimeout(60_000);
  const userData = await mkdtemp(resolve(tmpdir(), 'axterm-network-reconnect-e2e-'));
  const hostKey = utils.generateKeyPairSync('ed25519').private;
  const parsedHostKey = utils.parseKey(hostKey);
  if (parsedHostKey instanceof Error || Array.isArray(parsedHostKey))
    throw new Error('D04 SSH fixture generated an invalid host key');
  const publicKey = parsedHostKey.getPublicSSH();
  const fingerprint = `SHA256:${createHash('sha256')
    .update(publicKey)
    .digest('base64')
    .replace(/=+$/u, '')}`;
  let fixture: Awaited<ReturnType<typeof startReconnectSshFixture>> | undefined =
    await startReconnectSshFixture(hostKey);
  const port = fixture.port;

  await mkdir(resolve(userData, 'data-v2'), { recursive: true });
  const database = await ProductDatabase.open(resolve(userData, 'data-v2', 'axterm.sqlite'));
  try {
    const products = new ProductRepository(database);
    const host = products.createHost({
      name: 'D04 network reconnect',
      hostname: '127.0.0.1',
      port,
      username: 'operator',
      authType: 'agent',
      sshAgent: { enabled: false, path: null },
      connectionOptions: {
        reconnectPolicy: { mode: 'automatic', delayMs: 5_000, maxAttempts: 3 },
      },
    });
    products.saveKnownHostKey({
      host: host.hostname,
      port: host.port,
      algorithm: parsedHostKey.type,
      fingerprint,
      publicKey: publicKey.toString('base64'),
    });
    const bookmarks = new BookmarkRepository(database);
    bookmarks.createBookmark(
      {
        groupId: null,
        protocol: 'ssh',
        hostId: host.id,
        title: host.name,
        color: null,
        description: 'D04 real socket interruption fixture',
        profileId: null,
        connectionProfileId: null,
        quickCommands: [],
        triggers: [],
        ftp: null,
        telnet: null,
        serial: null,
        rdp: null,
        vnc: null,
        spice: null,
        web: null,
      },
      bookmarks.snapshot().etag,
    );
  } finally {
    database.close();
  }

  const app = await electron.launch({
    executablePath,
    args: [resolve('apps/desktop'), `--user-data-dir=${userData}`],
    env: { ...process.env, ELECTRON_RENDERER_URL: '' },
  });
  try {
    const page = await app.firstWindow();
    await expect(page.getByTestId('runtime-state')).toHaveAttribute('data-state', 'ready');
    await page.locator('[data-activity-item="bookmarks"]').click();
    await page.locator('[data-bookmark-title="D04 network reconnect"] .bookmark-row-main').click();

    const terminalLayer = page.locator('.terminal-session-layer:not([hidden])');
    await expect(terminalLayer.locator('.terminal-host')).toHaveAttribute(
      'data-connection-state',
      'connected',
    );
    await expect.poll(() => fixture?.connectionCount() ?? 0).toBe(1);
    await expect(terminalLayer.locator('.xterm-rows')).toContainText('D04_NETWORK_FIXTURE_READY');

    await fixture.stop();
    fixture = undefined;
    const reconnect = terminalLayer.locator('.terminal-reconnect-overlay');
    await expect(reconnect).toContainText(/自动重连: [1-5]s/u);

    fixture = await startReconnectSshFixture(hostKey, port);
    await reconnect.hover();
    await reconnect.getByRole('button', { name: '立即重连' }).click();
    await expect(terminalLayer.locator('.terminal-host')).toHaveAttribute(
      'data-connection-state',
      'connected',
    );
    await expect.poll(() => fixture?.connectionCount() ?? 0).toBe(1);
    await expect(terminalLayer.locator('.xterm-rows')).toContainText('D04_NETWORK_FIXTURE_READY');

    await fixture.stop();
    fixture = undefined;
    await expect(reconnect).toContainText(/自动重连: [1-5]s/u);
    await reconnect.hover();
    await reconnect.getByRole('button', { name: '停止重连' }).click();
    await expect(reconnect).toHaveAttribute('role', 'alert');
    await expect(reconnect).toContainText('RECONNECT_CANCELED');
  } finally {
    await app.close().catch(() => {});
    await fixture?.stop().catch(() => {});
    await rm(userData, { recursive: true, force: true });
  }
});

test('OP06 file scopes release late native grants and keep the latest overlapping directory selection', async () => {
  const userData = await mkdtemp(resolve(tmpdir(), 'axterm-owned-directory-e2e-'));
  const latePath = resolve(userData, 'late-directory');
  const olderPath = resolve(userData, 'older-directory');
  const latestPath = resolve(userData, 'latest-directory');
  await Promise.all([latePath, olderPath, latestPath].map((path) => mkdir(path)));
  const app = await launchLocalOptimizationApp({
    executablePath,
    args: [resolve('apps/desktop'), `--user-data-dir=${userData}`],
    env: { ...process.env, ELECTRON_RENDERER_URL: '' },
  });
  try {
    await app.evaluate(({ dialog }) => {
      const selections: Array<(path: string) => void> = [];
      Object.defineProperty(globalThis, '__op06DirectorySelections', {
        configurable: true,
        value: selections,
      });
      dialog.showOpenDialog = (() =>
        new Promise((resolve) =>
          selections.push((path) => resolve({ canceled: false, filePaths: [path] })),
        )) as typeof dialog.showOpenDialog;
    });
    const page = await app.firstWindow();
    const granted = new Map<string, string>();
    const revoked = new Set<string>();
    const listed: string[] = [];
    page.on('request', (request) => {
      const match = /\/api\/v1\/file-grants\/([^/]+)\/list$/u.exec(new URL(request.url()).pathname);
      if (match) listed.push(decodeURIComponent(match[1]!));
    });
    page.on('response', async (response) => {
      const pathname = new URL(response.url()).pathname;
      if (
        pathname === '/api/v1/file-grants' &&
        response.request().method() === 'POST' &&
        response.ok()
      ) {
        const value = (await response.json().catch(() => undefined)) as
          { grantId?: string; rootPath?: string } | undefined;
        if (value?.grantId && value.rootPath) granted.set(value.rootPath, value.grantId);
      }
      const match = /\/api\/v1\/file-grants\/([^/]+)$/u.exec(pathname);
      if (match && response.request().method() === 'DELETE' && response.ok())
        revoked.add(decodeURIComponent(match[1]!));
    });
    const selectionCount = () =>
      app.evaluate(
        () =>
          (globalThis as typeof globalThis & { __op06DirectorySelections: unknown[] })
            .__op06DirectorySelections.length,
      );
    const release = (index: number, path: string) =>
      app.evaluate(
        (_electron, args) => {
          (
            globalThis as typeof globalThis & {
              __op06DirectorySelections: Array<(path: string) => void>;
            }
          ).__op06DirectorySelections[args.index]!(args.path);
        },
        { index, path },
      );
    const openFiles = async () => {
      await openFilesWorkspace(page);
      await expect(
        page.getByRole('region', { name: '本地文件' }).getByLabel('本地绝对路径'),
      ).toHaveValue(await realpath(homedir()));
    };
    const leaveFiles = async () => {
      await page.locator('.pane-tabbar .tab-close-active').click();
      await openTunnelsWorkspace(page);
    };
    await expect(page.getByTestId('runtime-state')).toHaveAttribute('data-state', 'ready');
    await openFiles();
    let pane = page.getByRole('region', { name: '本地文件' });
    await pane.getByRole('button', { name: '更换目录' }).click();
    await expect.poll(selectionCount).toBe(1);
    await leaveFiles();
    await expect(pane).toHaveCount(0);
    await release(0, latePath);
    await expect.poll(() => granted.get(latePath)).toBeTruthy();
    await expect.poll(() => revoked.has(granted.get(latePath)!)).toBe(true);
    expect(listed).not.toContain(granted.get(latePath));

    await openFiles();
    pane = page.getByRole('region', { name: '本地文件' });
    await pane.getByRole('button', { name: '更换目录' }).click();
    await pane.getByRole('button', { name: '更换目录' }).click();
    await expect.poll(selectionCount).toBe(3);
    await release(2, latestPath);
    await expect(pane.getByLabel('本地绝对路径')).toHaveValue(latestPath);
    await release(1, olderPath);
    await expect.poll(() => granted.get(olderPath)).toBeTruthy();
    await expect.poll(() => revoked.has(granted.get(olderPath)!)).toBe(true);
    await expect(pane.getByLabel('本地绝对路径')).toHaveValue(latestPath);
    expect(listed).not.toContain(granted.get(olderPath));
    expect(revoked.has(granted.get(latestPath)!)).toBe(false);
    await leaveFiles();
    await expect.poll(() => revoked.has(granted.get(latestPath)!)).toBe(true);
  } finally {
    await app.close().catch(() => undefined);
    await rm(userData, { recursive: true, force: true });
  }
});

test('E-01 through E-07 provide a bounded local file workspace with clipboard and drag operations', async () => {
  const userData = await mkdtemp(resolve(tmpdir(), 'axterm-local-file-workspace-e2e-'));
  const selected = resolve(userData, '本地授权目录');
  const absoluteSwitch = resolve(userData, '绝对路径切换');
  await mkdir(resolve(selected, 'nested'), { recursive: true });
  await mkdir(absoluteSwitch, { recursive: true });
  await writeFile(resolve(selected, 'local-evidence.txt'), 'E01 local file');
  await writeFile(resolve(selected, '.hidden-e04.txt'), 'E04 hidden file');
  await writeFile(resolve(selected, 'nested', 'inside.txt'), 'E01 nested file');
  await writeFile(resolve(absoluteSwitch, 'switched.txt'), 'absolute path');
  for (let index = 0; index < 360; index += 1)
    await writeFile(resolve(selected, `bulk-${String(index).padStart(3, '0')}.txt`), `${index}`);
  const app = await electron.launch({
    executablePath,
    args: [resolve('apps/desktop'), `--user-data-dir=${userData}`],
    env: { ...process.env, ELECTRON_RENDERER_URL: '' },
  });
  try {
    await app.evaluate(({ dialog }, selectedPath) => {
      Object.defineProperty(dialog, 'showOpenDialog', {
        configurable: true,
        value: async () => ({ canceled: false, filePaths: [selectedPath] }),
      });
    }, selected);
    const page = await app.firstWindow();
    await expect(page.getByTestId('runtime-state')).toHaveAttribute('data-state', 'ready');
    await openFilesWorkspace(page);

    const layout = page.getByRole('group', { name: '文件面板布局' });
    await expect(layout).toHaveCount(0);
    const localPane = page.getByRole('region', { name: '本地文件' });
    const remotePane = page.getByRole('region', { name: '远端文件' });
    await expect(localPane).toBeVisible();
    await expect(remotePane).toHaveCount(0);
    await expect(localPane.getByLabel('本地绝对路径')).toHaveValue(await realpath(homedir()));
    await localPane.getByRole('button', { name: '更换目录' }).click();
    await expect(localPane.getByLabel('本地绝对路径')).toHaveValue(selected);
    await expect(localPane.locator('.file-table-page')).toContainText('/ 363');
    await expect.poll(() => localPane.locator('.file-data-row').count()).toBeLessThan(40);
    const nameHeader = localPane.getByRole('columnheader', { name: /名称/u });
    await nameHeader.getByTitle('按名称排序').click();
    await expect(nameHeader).toHaveAttribute('aria-sort', 'descending');
    await expect(localPane.locator('.file-data-row').nth(1)).toContainText('local-evidence.txt');
    await expect(localPane.locator('.file-data-row').nth(2)).toContainText('bulk-359.txt');
    await nameHeader.getByTitle('按名称排序').click();
    await expect(nameHeader).toHaveAttribute('aria-sort', 'ascending');
    await expect(localPane.locator('.file-data-row').nth(1)).toContainText('.hidden-e04.txt');
    await expect(localPane.locator('.file-data-row').nth(2)).toContainText('bulk-000.txt');
    const selectionModifier = process.platform === 'darwin' ? 'Meta' : 'Control';
    const bulk000 = localPane.getByRole('button', { name: 'bulk-000.txt', exact: true });
    const bulk001 = localPane.getByRole('button', { name: 'bulk-001.txt', exact: true });
    const bulk004 = localPane.getByRole('button', { name: 'bulk-004.txt', exact: true });
    await bulk000.click();
    await expect(bulk000).toHaveAttribute('aria-pressed', 'true');
    await bulk001.click({ modifiers: [selectionModifier] });
    await expect(localPane.locator('.file-data-row.selected')).toHaveCount(2);
    await bulk004.click({ modifiers: ['Shift'] });
    await expect(localPane.locator('.file-data-row.selected')).toHaveCount(5);
    await expect(localPane.locator('.file-table-page')).toContainText('已选 5');
    await bulk004.press('Shift+ArrowDown');
    await expect(localPane.locator('.file-data-row.selected')).toHaveCount(2);
    await page.keyboard.press(`${selectionModifier}+A`);
    await expect(localPane.locator('.file-table-page')).toContainText('已选 363');
    await page.keyboard.press('Escape');
    await expect(localPane.locator('.file-data-row.selected')).toHaveCount(0);

    await bulk000.click({ button: 'right' });
    let fileMenu = page.getByRole('menu', { name: '本地文件菜单' });
    await expect(fileMenu).toBeVisible();
    await expect(fileMenu.getByRole('menuitem')).toHaveText([
      '打开',
      '在文件管理器中显示',
      /复制⌘?\+?C|复制Ctrl\+C/u,
      /剪切⌘?\+?X|剪切Ctrl\+X/u,
      /粘贴⌘?\+?V|粘贴Ctrl\+V/u,
      '重命名',
      /复制路径/u,
      '删除',
      '修改权限',
      '信息',
      '新建文件',
      '新建目录',
      /全选/u,
      '刷新',
    ]);
    await expect(fileMenu.getByRole('menuitem').first()).toBeFocused();
    await expect(fileMenu.getByRole('menuitem', { name: '粘贴' })).toBeDisabled();
    await page.keyboard.press('ArrowDown');
    await expect(fileMenu.getByRole('menuitem').nth(1)).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(fileMenu).toBeHidden();

    await bulk000.click();
    await bulk001.click({ modifiers: [selectionModifier] });
    await bulk001.click({ button: 'right' });
    fileMenu = page.getByRole('menu', { name: '本地文件菜单' });
    await fileMenu.getByRole('menuitem', { name: '复制所选路径 (2)' }).click();
    const canonicalSelected = await realpath(selected);
    await expect
      .poll(() => app.evaluate(({ clipboard }) => clipboard.readText()))
      .toBe(
        [
          resolve(canonicalSelected, 'bulk-000.txt'),
          resolve(canonicalSelected, 'bulk-001.txt'),
        ].join('\n'),
      );

    await bulk000.click({ button: 'right' });
    await page.getByRole('menuitem', { name: '新建文件' }).click();
    let fileDialog = page.getByRole('dialog', { name: '新建本地文件' });
    await fileDialog.getByLabel('名称').fill('aaa-e06.txt');
    await fileDialog.getByRole('button', { name: '创建' }).click();
    let createdFile = localPane.getByRole('button', { name: 'aaa-e06.txt', exact: true });
    await expect(createdFile).toBeVisible();

    await createdFile.click({ button: 'right' });
    await page.getByRole('menuitem', { name: '信息' }).click();
    const infoDialog = page.getByRole('dialog', { name: '文件信息' });
    await expect(infoDialog).toContainText('本地项目');
    await expect(infoDialog).toContainText('aaa-e06.txt');
    await expect(infoDialog).toContainText('600');
    await infoDialog.getByRole('button', { name: '关闭', exact: true }).click();

    await createdFile.click({ button: 'right' });
    await page.getByRole('menuitem', { name: '重命名' }).click();
    fileDialog = page.getByRole('dialog', { name: '重命名本地路径' });
    await fileDialog.getByLabel('名称').fill('aaa-e06-renamed.txt');
    await fileDialog.getByRole('button', { name: '保存' }).click();
    createdFile = localPane.getByRole('button', { name: 'aaa-e06-renamed.txt', exact: true });
    await expect(createdFile).toBeVisible();

    await createdFile.click({ button: 'right' });
    await page.getByRole('menuitem', { name: '复制路径' }).click();
    await expect(page.locator('.file-operation-notice')).toContainText('已复制 1 个路径');
    await expect
      .poll(() => app.evaluate(({ clipboard }) => clipboard.readText()))
      .toBe(resolve(canonicalSelected, 'aaa-e06-renamed.txt'));

    await createdFile.click({ button: 'right' });
    page.once('dialog', (dialog) => dialog.accept());
    await page.getByRole('menuitem', { name: '删除' }).click();
    await expect(createdFile).toHaveCount(0);

    await bulk000.click({ button: 'right' });
    await page.getByRole('menuitem', { name: '新建目录' }).click();
    fileDialog = page.getByRole('dialog', { name: '新建本地目录' });
    await fileDialog.getByLabel('名称').fill('aaa-e06-dir');
    await fileDialog.getByRole('button', { name: '创建' }).click();
    const createdDirectory = localPane.getByRole('button', {
      name: 'aaa-e06-dir',
      exact: true,
    });
    await expect(createdDirectory).toBeVisible();
    await createdDirectory.click({ button: 'right' });
    page.once('dialog', (dialog) => dialog.accept());
    await page.getByRole('menuitem', { name: '删除' }).click();
    await expect(createdDirectory).toHaveCount(0);

    await bulk000.click();
    await page.keyboard.press(`${selectionModifier}+C`);
    await expect(page.locator('.file-operation-notice')).toContainText('已复制 1 项');
    await page.keyboard.press(`${selectionModifier}+V`);
    let copiedFile = localPane.getByRole('button', {
      name: 'bulk-000(copy-1).txt',
      exact: true,
    });
    await expect(copiedFile).toBeVisible();

    await bulk000.click({ button: 'right' });
    await page.getByRole('menuitem', { name: '新建目录' }).click();
    fileDialog = page.getByRole('dialog', { name: '新建本地目录' });
    await fileDialog.getByLabel('名称').fill('aaa-e07-target');
    await fileDialog.getByRole('button', { name: '创建' }).click();
    let targetDirectory = localPane.getByRole('button', {
      name: 'aaa-e07-target',
      exact: true,
    });
    await expect(targetDirectory).toBeVisible();
    await targetDirectory.click({ button: 'right' });
    await page.getByRole('menuitem', { name: '新建文件' }).click();
    fileDialog = page.getByRole('dialog', { name: '新建本地文件' });
    await fileDialog.getByLabel('名称').fill('aaa-e07-drag.txt');
    await fileDialog.getByRole('button', { name: '创建' }).click();
    let draggedFile = localPane.getByRole('button', {
      name: 'aaa-e07-drag.txt',
      exact: true,
    });
    await expect(draggedFile).toBeVisible();

    await copiedFile.click();
    await page.keyboard.press(`${selectionModifier}+X`);
    await expect(page.locator('.file-operation-notice')).toContainText('已剪切 1 项');
    await targetDirectory.dblclick();
    await expect(localPane.getByLabel('本地绝对路径')).toHaveValue(`${selected}/aaa-e07-target`);
    await localPane.locator('.file-table-scroll').focus();
    await page.keyboard.press(`${selectionModifier}+V`);
    await expect
      .poll(() => readdir(resolve(selected, 'aaa-e07-target')))
      .toContain('bulk-000(copy-1).txt');
    copiedFile = localPane.getByRole('button', { name: 'bulk-000(copy-1).txt', exact: true });
    await expect(copiedFile).toBeVisible();

    await localPane.getByTitle('上级目录').click();
    await expect(localPane.getByLabel('本地绝对路径')).toHaveValue(selected);
    targetDirectory = localPane.getByRole('button', { name: 'aaa-e07-target', exact: true });
    draggedFile = localPane.getByRole('button', { name: 'aaa-e07-drag.txt', exact: true });
    await dragFileTo(draggedFile, targetDirectory, page);
    await expect(draggedFile).toHaveCount(0);
    await targetDirectory.dblclick();
    await expect(
      localPane.getByRole('button', { name: 'aaa-e07-drag.txt', exact: true }),
    ).toBeVisible();
    await localPane.getByTitle('上级目录').click();
    targetDirectory = localPane.getByRole('button', { name: 'aaa-e07-target', exact: true });
    await targetDirectory.click({ button: 'right' });
    page.once('dialog', (dialog) => dialog.accept());
    await page.getByRole('menuitem', { name: '删除' }).click();
    await expect(targetDirectory).toHaveCount(0);

    const columnDivider = localPane.getByRole('separator', { name: '调整名称与大小列宽' });
    const widthBefore = Number(await columnDivider.getAttribute('aria-valuenow'));
    await columnDivider.focus();
    await page.keyboard.press('ArrowRight');
    await expect(columnDivider).toHaveAttribute('aria-valuenow', String(widthBefore + 2));
    await localPane.getByLabel('配置文件列').click();
    await localPane.getByRole('menu', { name: '文件列' }).getByLabel('所有者').click();
    await expect(
      localPane.getByRole('columnheader', { name: '所有者', exact: true }),
    ).toBeVisible();
    const localKeyword = localPane.getByRole('textbox', {
      name: '本地文件关键词',
      exact: true,
    });
    await localKeyword.fill('HIDDEN-E04');
    await localKeyword.press('Enter');
    await expect(localPane.locator('.file-table-page')).toContainText('1–1 / 1');
    await expect(localPane.getByText('.hidden-e04.txt', { exact: true })).toBeVisible();
    await localPane.getByRole('button', { name: '隐藏本地隐藏文件' }).click();
    await expect(localPane.locator('.file-table-page')).toContainText('0 / 0');
    await localPane.getByRole('button', { name: '清除本地文件关键词' }).click();
    await expect(localPane.locator('.file-table-page')).toContainText('/ 362');
    await localKeyword.fill('BuLk-010');
    await localPane.getByRole('button', { name: '应用本地文件关键词' }).click();
    await expect(localPane.getByText('bulk-010.txt', { exact: true })).toBeVisible();
    await localPane.getByLabel('本地绝对路径').fill(`${selected}/nested`);
    await localPane.getByLabel('本地绝对路径').press('Enter');
    await expect(localPane.getByLabel('本地绝对路径')).toHaveValue(`${selected}/nested`);
    await expect(localKeyword).toHaveValue('');
    await expect(localPane.getByText('inside.txt', { exact: true })).toBeVisible();
    await localPane.getByRole('button', { name: '收藏本地路径' }).click();
    await localPane.getByTitle('返回授权目录').click();
    await localPane.getByLabel('本地路径历史').selectOption('path:nested');
    await expect(localPane.getByLabel('本地绝对路径')).toHaveValue(`${selected}/nested`);
    await localPane.getByTitle('返回授权目录').click();
    await localPane.getByLabel('本地路径收藏').selectOption('path:nested');
    await expect(localPane.getByText('inside.txt', { exact: true })).toBeVisible();
    await localPane.getByLabel('本地绝对路径').fill('../outside');
    await localPane.getByLabel('本地绝对路径').press('Enter');
    await expect(page.getByRole('alert')).toContainText('请输入有效的本地绝对目录路径');

    await localPane.getByLabel('本地绝对路径').fill(absoluteSwitch);
    await localPane.getByLabel('本地绝对路径').press('Enter');
    await expect(localPane.getByLabel('本地绝对路径')).toHaveValue(await realpath(absoluteSwitch));
    await expect(localPane.getByText('switched.txt', { exact: true })).toBeVisible();

    await expect(page.getByRole('separator', { name: '调整本地与远端面板宽度' })).toHaveCount(0);
    await expect(remotePane).toHaveCount(0);
    await expect(localPane.getByText('switched.txt', { exact: true })).toBeVisible();

    const database = await ProductDatabase.open(resolve(userData, 'data-v2', 'axterm.sqlite'));
    try {
      expect(new ProductRepository(database).getSettings().fileManager).toMatchObject({
        showHiddenFiles: false,
        columns: ['name', 'size', 'modifiedAt', 'owner'],
        localSort: { property: 'name', direction: 'asc' },
      });
    } finally {
      database.close();
    }
  } finally {
    await app.close().catch(() => {});
    await rm(userData, { recursive: true, force: true });
  }
});

test('D-06 saves a structured ProxyCommand from the Host editor', async () => {
  const userData = await mkdtemp(resolve(tmpdir(), 'axterm-proxy-command-e2e-'));
  const app = await electron.launch({
    executablePath,
    args: [resolve('apps/desktop'), `--user-data-dir=${userData}`],
    env: { ...process.env, ELECTRON_RENDERER_URL: '' },
  });
  try {
    const page = await app.firstWindow();
    await expect(page.getByTestId('runtime-state')).toHaveAttribute('data-state', 'ready');
    await page.locator('[data-activity-item="bookmarks"]').click();
    await page.locator('.workspace-sidebar').getByRole('button', { name: '管理' }).click();
    await page.getByRole('button', { name: '添加主机' }).click();
    const form = page.getByRole('dialog', { name: '添加 SSH 主机' });
    await form.getByLabel('显示名称').fill('D06 ProxyCommand');
    await form.getByLabel('主机地址').fill('target.example.test');
    await form.getByLabel('用户名').fill('operator');
    await form.getByLabel('认证方式').selectOption('agent');
    await form.getByRole('tab', { name: '设置' }).click();
    await form.getByLabel('代理策略').selectOption('command');
    await form.getByLabel('可执行文件').fill('/usr/bin/nc');
    await form.getByLabel('参数（每行一个）').fill('%h\n%p');
    await expect(form.getByRole('button', { name: '测试代理' })).toBeDisabled();
    await form.getByRole('button', { name: '保存', exact: true }).click();
    await expect(
      page.locator('.host-card').getByText('D06 ProxyCommand', { exact: true }),
    ).toBeVisible();

    const database = await ProductDatabase.open(resolve(userData, 'data-v2', 'axterm.sqlite'));
    try {
      expect(
        new ProductRepository(database).listHosts().find(({ name }) => name === 'D06 ProxyCommand')
          ?.proxy,
      ).toEqual({
        mode: 'command',
        command: { executable: '/usr/bin/nc', arguments: ['%h', '%p'] },
      });
    } finally {
      database.close();
    }
  } finally {
    await app.close().catch(() => {});
    await rm(userData, { recursive: true, force: true });
  }
});

test('D-07 composes and reorders a saved multi-level jump chain', async () => {
  const userData = await mkdtemp(resolve(tmpdir(), 'axterm-jump-chain-e2e-'));
  const databasePath = resolve(userData, 'data-v2', 'axterm.sqlite');
  let database = await ProductDatabase.open(databasePath);
  let products = new ProductRepository(database);
  const first = products.createHost({
    name: 'Jump Alpha',
    hostname: 'alpha.example.test',
    username: 'alpha',
    authType: 'agent',
  });
  const second = products.createHost({
    name: 'Jump Beta',
    hostname: 'beta.example.test',
    username: 'beta',
    authType: 'agent',
  });
  database.close();

  const app = await electron.launch({
    executablePath,
    args: [resolve('apps/desktop'), `--user-data-dir=${userData}`],
    env: { ...process.env, ELECTRON_RENDERER_URL: '' },
  });
  try {
    const page = await app.firstWindow();
    await expect(page.getByTestId('runtime-state')).toHaveAttribute('data-state', 'ready');
    await page.locator('[data-activity-item="bookmarks"]').click();
    await page.locator('.workspace-sidebar').getByRole('button', { name: '管理' }).click();
    await page.getByRole('button', { name: '添加主机' }).click();
    const form = page.getByRole('dialog', { name: '添加 SSH 主机' });
    await form.getByLabel('显示名称').fill('Jump Target');
    await form.getByLabel('主机地址').fill('target.example.test');
    await form.getByLabel('用户名').fill('target');
    await form.getByLabel('认证方式').selectOption('agent');
    await form.getByRole('tab', { name: '跳板机' }).click();
    const chain = form.getByRole('group', { name: '连接跳板' });
    await chain.getByLabel('添加跳板机').selectOption(second.id);
    await chain.getByRole('button', { name: '添加', exact: true }).click();
    await chain.getByLabel('添加跳板机').selectOption(first.id);
    await chain.getByRole('button', { name: '添加', exact: true }).click();
    await expect(chain.getByRole('list', { name: '跳板链顺序' }).locator('li')).toHaveCount(2);
    await chain.getByRole('button', { name: '上移跳板 Jump Alpha' }).click();
    await expect(chain.getByLabel('连接路径')).toContainText('本机Jump AlphaJump BetaJump Target');
    await form.getByRole('button', { name: '保存', exact: true }).click();
    await expect(
      page.locator('.host-card').getByText('Jump Target', { exact: true }),
    ).toBeVisible();

    database = await ProductDatabase.open(databasePath);
    products = new ProductRepository(database);
    try {
      expect(products.listHosts().find(({ name }) => name === 'Jump Target')?.jumpHostIds).toEqual([
        first.id,
        second.id,
      ]);
    } finally {
      database.close();
    }
  } finally {
    await app.close().catch(() => {});
    await rm(userData, { recursive: true, force: true });
  }
});

test('D-08 saves ordered SSH algorithm preferences from the Host editor', async () => {
  const userData = await mkdtemp(resolve(tmpdir(), 'axterm-ssh-algorithms-e2e-'));
  const app = await electron.launch({
    executablePath,
    args: [resolve('apps/desktop'), `--user-data-dir=${userData}`],
    env: { ...process.env, ELECTRON_RENDERER_URL: '' },
  });
  try {
    const page = await app.firstWindow();
    await expect(page.getByTestId('runtime-state')).toHaveAttribute('data-state', 'ready');
    await page.locator('[data-activity-item="bookmarks"]').click();
    await page.locator('.workspace-sidebar').getByRole('button', { name: '管理' }).click();
    await page.getByRole('button', { name: '添加主机' }).click();
    const form = page.getByRole('dialog', { name: '添加 SSH 主机' });
    await form.getByLabel('显示名称').fill('D08 Algorithms');
    await form.getByLabel('主机地址').fill('algorithms.example.test');
    await form.getByLabel('用户名').fill('operator');
    await form.getByLabel('认证方式').selectOption('agent');
    await form.getByRole('tab', { name: '设置' }).click();
    await form.getByText('SSH 算法（高级）', { exact: true }).click();
    await form.getByLabel('密钥交换算法').selectOption('curve25519-sha256');
    await form.getByLabel('加密算法').selectOption('aes256-ctr');
    await form.getByLabel('主机密钥算法').selectOption('ssh-ed25519');
    await form.getByLabel('消息认证算法').selectOption('hmac-sha2-256-etm@openssh.com');
    await form.getByRole('button', { name: '保存', exact: true }).click();
    await expect(
      page.locator('.host-card').getByText('D08 Algorithms', { exact: true }),
    ).toBeVisible();

    const database = await ProductDatabase.open(resolve(userData, 'data-v2', 'axterm.sqlite'));
    try {
      expect(
        new ProductRepository(database).listHosts().find(({ name }) => name === 'D08 Algorithms')
          ?.connectionOptions.algorithms,
      ).toEqual({
        kex: ['curve25519-sha256'],
        cipher: ['aes256-ctr'],
        serverHostKey: ['ssh-ed25519'],
        hmac: ['hmac-sha2-256-etm@openssh.com'],
      });
    } finally {
      database.close();
    }
  } finally {
    await app.close().catch(() => {});
    await rm(userData, { recursive: true, force: true });
  }
});

test('D-09 saves ordered SSH startup settings from the Host editor', async () => {
  const userData = await mkdtemp(resolve(tmpdir(), 'axterm-ssh-startup-e2e-'));
  const app = await electron.launch({
    executablePath,
    args: [resolve('apps/desktop'), `--user-data-dir=${userData}`],
    env: { ...process.env, ELECTRON_RENDERER_URL: '' },
  });
  try {
    const page = await app.firstWindow();
    await expect(page.getByTestId('runtime-state')).toHaveAttribute('data-state', 'ready');
    await page.locator('[data-activity-item="bookmarks"]').click();
    await page.locator('.workspace-sidebar').getByRole('button', { name: '管理' }).click();
    await page.getByRole('button', { name: '添加主机' }).click();
    const form = page.getByRole('dialog', { name: '添加 SSH 主机' });
    await form.getByLabel('显示名称').fill('D09 Startup');
    await form.getByLabel('主机地址').fill('startup.example.test');
    await form.getByLabel('用户名').fill('operator');
    await form.getByLabel('认证方式').selectOption('agent');
    await form.getByRole('tab', { name: '设置' }).click();
    await form.getByText('会话启动', { exact: true }).click();
    await form.locator('input[name="sshStartupDirectory"]').fill('/srv/project');
    await form
      .locator('textarea[name="sshStartupEnvironment"]')
      .fill('LANG=zh_CN.UTF-8\nAPP_MODE=staging');
    const groups = form.locator('.ssh-startup-script-group');
    await groups.nth(0).getByRole('button', { name: '添加脚本' }).click();
    await form.getByLabel('登录脚本 1 延迟').fill('250');
    await form.getByLabel('登录脚本 1 命令').fill('source ~/.profile');
    await groups.nth(1).getByRole('button', { name: '添加脚本' }).click();
    await form.getByLabel('连接后脚本 1 延迟').fill('500');
    await form.getByLabel('连接后脚本 1 命令').fill('printf ready');
    await groups.nth(1).getByLabel('发送方式').selectOption('raw');
    await groups.nth(1).getByLabel('下一项等待').selectOption('delay');
    await groups.nth(1).getByLabel('静默时间（ms）').fill('650');
    await groups.nth(1).getByLabel('最长等待（ms）').fill('4250');
    await form.getByRole('button', { name: '保存', exact: true }).click();
    await expect(
      page.locator('.host-card').getByText('D09 Startup', { exact: true }),
    ).toBeVisible();

    const database = await ProductDatabase.open(resolve(userData, 'data-v2', 'axterm.sqlite'));
    try {
      expect(
        new ProductRepository(database).listHosts().find(({ name }) => name === 'D09 Startup')
          ?.startup,
      ).toEqual({
        directory: '/srv/project',
        environment: { LANG: 'zh_CN.UTF-8', APP_MODE: 'staging' },
        loginScripts: [
          {
            command: 'source ~/.profile',
            delayMs: 250,
            sendEnter: true,
            waitForOutput: true,
            settleIdleMs: 400,
            settleTimeoutMs: 3_000,
          },
        ],
        runScripts: [
          {
            command: 'printf ready',
            delayMs: 500,
            sendEnter: false,
            waitForOutput: false,
            settleIdleMs: 650,
            settleTimeoutMs: 4_250,
          },
        ],
      });
    } finally {
      database.close();
    }
  } finally {
    await app.close().catch(() => {});
    await rm(userData, { recursive: true, force: true });
  }
});

test('D-10 saves X11 forwarding and an explicit local display from the Host editor', async () => {
  const userData = await mkdtemp(resolve(tmpdir(), 'axterm-ssh-x11-e2e-'));
  const app = await electron.launch({
    executablePath,
    args: [resolve('apps/desktop'), `--user-data-dir=${userData}`],
    env: { ...process.env, ELECTRON_RENDERER_URL: '' },
  });
  try {
    const page = await app.firstWindow();
    await expect(page.getByTestId('runtime-state')).toHaveAttribute('data-state', 'ready');
    await page.locator('[data-activity-item="bookmarks"]').click();
    await page.locator('.workspace-sidebar').getByRole('button', { name: '管理' }).click();
    await page.getByRole('button', { name: '添加主机' }).click();
    const form = page.getByRole('dialog', { name: '添加 SSH 主机' });
    await form.getByLabel('显示名称').fill('D10 X11');
    await form.getByLabel('主机地址').fill('x11.example.test');
    await form.getByLabel('用户名').fill('operator');
    await form.getByLabel('认证方式').selectOption('agent');
    await form.getByRole('tab', { name: '设置' }).click();
    await form.getByText('X11 转发', { exact: true }).click();
    await form.getByLabel('为此主机启用 X11 转发').check();
    await form.locator('input[name="sshX11Display"]').fill('localhost:7.1');
    await form.getByRole('button', { name: '保存', exact: true }).click();
    await expect(page.locator('.host-card').getByText('D10 X11', { exact: true })).toBeVisible();

    const database = await ProductDatabase.open(resolve(userData, 'data-v2', 'axterm.sqlite'));
    try {
      expect(
        new ProductRepository(database).listHosts().find(({ name }) => name === 'D10 X11')?.x11,
      ).toEqual({ enabled: true, display: 'localhost:7.1' });
    } finally {
      database.close();
    }
  } finally {
    await app.close().catch(() => {});
    await rm(userData, { recursive: true, force: true });
  }
});

test('D-11 manages a saved tunnel from the SSH Bookmark tunnel tab and status panel', async () => {
  const userData = await mkdtemp(resolve(tmpdir(), 'axterm-tunnel-editor-e2e-'));
  const app = await electron.launch({
    executablePath,
    args: [resolve('apps/desktop'), `--user-data-dir=${userData}`],
    env: { ...process.env, ELECTRON_RENDERER_URL: '' },
  });
  try {
    const page = await app.firstWindow();
    await expect(page.getByTestId('runtime-state')).toHaveAttribute('data-state', 'ready');
    await page.locator('[data-activity-item="bookmarks"]').click();
    await page.locator('.workspace-sidebar').getByRole('button', { name: '管理' }).click();
    await page.getByRole('button', { name: '添加主机' }).click();
    const create = page.getByRole('dialog', { name: '添加 SSH 主机' });
    await create.getByLabel('显示名称').fill('D11 Tunnel Host');
    await create.getByLabel('主机地址').fill('tunnel.example.test');
    await create.getByLabel('用户名').fill('operator');
    await create.getByLabel('认证方式').selectOption('agent');
    await create.getByRole('button', { name: '保存', exact: true }).click();

    const card = page.locator('.host-card').filter({ hasText: 'D11 Tunnel Host' });
    await card.getByRole('button', { name: '编辑' }).click();
    const editor = page.getByRole('dialog', { name: '编辑 SSH 主机' });
    await editor.getByRole('tab', { name: 'SSH 隧道' }).click();
    await editor.getByLabel('书签隧道名称').fill('D11 Local Forward');
    await editor.getByLabel('书签隧道类型').selectOption('local');
    await editor.getByLabel('书签隧道监听端口').fill('0');
    await editor.getByLabel('书签隧道目标地址').fill('127.0.0.1');
    await editor.getByLabel('书签隧道目标端口').fill('8080');
    await editor.getByRole('button', { name: '添加隧道' }).click();
    const tunnelRow = editor.locator('.host-tunnel-row').filter({ hasText: 'D11 Local Forward' });
    await expect(tunnelRow).toContainText('本地转发');
    await tunnelRow.getByRole('button', { name: '编辑 D11 Local Forward' }).click();
    await editor.getByLabel('书签隧道目标端口').fill('9090');
    await editor.getByRole('button', { name: '保存修改' }).click();
    await expect(tunnelRow).toContainText('已停止');
    await editor.getByRole('button', { name: '取消', exact: true }).last().click();

    await openTunnelsWorkspace(page);
    await expect(page.getByText('D11 Local Forward', { exact: true })).toBeVisible();
    await expect(
      page.getByText(/D11 Tunnel Host · 本地转发 · 127\.0\.0\.1:0 → 127\.0\.0\.1:9090/),
    ).toBeVisible();
    await expect(page.getByRole('button', { name: '启动 D11 Local Forward' })).toBeDisabled();

    const database = await ProductDatabase.open(resolve(userData, 'data-v2', 'axterm.sqlite'));
    try {
      expect(
        new ProductRepository(database)
          .listJson<{ name: string; targetPort: number }>('tunnel_profiles')
          .find(({ name }) => name === 'D11 Local Forward')?.targetPort,
      ).toBe(9090);
    } finally {
      database.close();
    }
  } finally {
    await app.close().catch(() => {});
    await rm(userData, { recursive: true, force: true });
  }
});

test('SSH Config import previews authorized Includes, edits entries and revokes every grant', async () => {
  const userData = await mkdtemp(resolve(tmpdir(), 'axterm-ssh-import-e2e-'));
  const fixtureDirectory = await mkdtemp(resolve(tmpdir(), 'axterm-ssh-config-'));
  const rootConfig = resolve(fixtureDirectory, 'config');
  const includeDirectory = resolve(fixtureDirectory, 'conf.d');
  const includedConfig = resolve(includeDirectory, 'gateway.conf');
  const nestedConfig = resolve(fixtureDirectory, 'nested.conf');
  const missingConfig = resolve(fixtureDirectory, 'missing.conf');
  await mkdir(includeDirectory);
  await writeFile(
    rootConfig,
    `Include /Users/alice/.ssh/private/*.conf
Host app
  HostName app.example.test
  User deploy
  ProxyJump gateway
  ConnectTimeout 12
  ServerAliveInterval 7
  ServerAliveCountMax 4
  Compression no
`,
  );
  await writeFile(
    includedConfig,
    `Include C:\\Users\\alice\\.ssh\\secret\\nested.conf
Host gateway
  HostName gateway.example.test
  User jump
`,
  );
  await writeFile(
    nestedConfig,
    `Host audit
  HostName audit.example.test
  User auditor
`,
  );
  const app = await electron.launch({
    executablePath,
    args: [resolve('apps/desktop'), `--user-data-dir=${userData}`],
    env: { ...process.env, ELECTRON_RENDERER_URL: '' },
  });
  try {
    await app.evaluate(
      ({ dialog }, paths) => {
        const queue = [...paths];
        dialog.showOpenDialog = (() =>
          Promise.resolve({
            canceled: false,
            filePaths: [queue.shift()!],
          })) as typeof dialog.showOpenDialog;
      },
      [rootConfig, includeDirectory, nestedConfig, includeDirectory, nestedConfig, missingConfig],
    );
    const page = await app.firstWindow();
    const revoked: string[] = [];
    page.on('request', (request) => {
      if (request.method() === 'DELETE' && request.url().includes('/api/v1/file-grants/'))
        revoked.push(request.url());
    });
    await expect(page.getByTestId('runtime-state')).toHaveAttribute('data-state', 'ready');
    await page.locator('[data-activity-item="bookmarks"]').click();
    await page.locator('.workspace-sidebar').getByRole('button', { name: '管理' }).click();
    await page.getByRole('button', { name: '导入 SSH Config' }).click();

    const dialog = page.getByRole('dialog', { name: 'SSH Config 导入' });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText('*.conf', { exact: true })).toBeVisible();
    await expect(dialog).not.toContainText('/Users/alice');
    await expect(dialog).not.toContainText(fixtureDirectory);
    await dialog.getByRole('button', { name: '为 *.conf 选择目录' }).click();
    await expect(dialog.getByText('nested.conf', { exact: true })).toBeVisible();
    await expect(dialog).not.toContainText('C:\\Users\\alice');
    await dialog.getByRole('button', { name: '为 nested.conf 选择文件' }).click();
    await expect(dialog.getByRole('button', { name: '编辑 audit' })).toBeVisible();

    // Replacing the parent Include invalidates both its grant and every nested grant.
    await dialog.getByRole('button', { name: '为 *.conf 选择目录' }).click();
    await expect.poll(() => revoked.length).toBe(2);
    await dialog.getByRole('button', { name: '为 nested.conf 选择文件' }).click();
    await expect(dialog.locator('.include-status.authorized')).toHaveCount(2);

    await dialog.getByRole('button', { name: '编辑 app' }).click();
    const editor = dialog.getByLabel('编辑 app JSON');
    const edited = JSON.parse(await editor.inputValue()) as Record<string, unknown>;
    edited.title = 'Production application';
    edited.description = 'Reviewed before atomic import';
    edited.hostname = 'app.internal.example';
    await editor.fill(JSON.stringify(edited, null, 2));
    await dialog.getByRole('button', { name: '应用修改' }).click();
    await expect(
      dialog.locator('.ssh-config-item-content').filter({ hasText: 'Production application' }),
    ).toBeVisible();
    await dialog.getByRole('button', { name: /确认导入 3 项/ }).click();
    await expect(dialog.getByLabel('SSH Config 导入报告')).toBeVisible();
    await expect(dialog.getByText('Production application', { exact: true })).toBeVisible();

    // A double click must still revoke the root and two active Include grants once each.
    await dialog.getByRole('button', { name: '完成' }).evaluate((button) => {
      (button as HTMLButtonElement).click();
      (button as HTMLButtonElement).click();
    });
    await expect(dialog).toHaveCount(0);
    await expect.poll(() => revoked.length).toBe(5);
    expect(new Set(revoked).size).toBe(5);
    await expect(
      page.locator('.host-card').getByText('Production application', { exact: true }),
    ).toBeVisible();
    await expect(page.locator('.host-card').getByText(/app\.internal\.example:22/)).toBeVisible();
    await expect(page.getByRole('treeitem', { name: /^Production application/ })).toBeVisible();

    await page.getByRole('button', { name: '导入 SSH Config' }).click();
    const failedDialog = page.getByRole('dialog', { name: 'SSH Config 导入' });
    await expect(failedDialog.locator('.ssh-import-error')).toContainText(
      'Granted SSH config cannot be read',
    );
    await expect.poll(() => revoked.length).toBe(6);
    await failedDialog.getByRole('button', { name: '关闭 SSH Config 导入' }).click();
    await expect(failedDialog).toHaveCount(0);
    expect(revoked).toHaveLength(6);
  } finally {
    await app.close();
    await Promise.all([
      rm(userData, { recursive: true, force: true }),
      rm(fixtureDirectory, { recursive: true, force: true }),
    ]);
  }
});

test('Quick Command tree persists folders, multi-step templates, search and drag placement', async () => {
  const userData = await mkdtemp(resolve(tmpdir(), 'axterm-quick-command-e2e-'));
  const app = await launchLocalOptimizationApp({
    executablePath,
    args: [resolve('apps/desktop'), `--user-data-dir=${userData}`],
    env: { ...process.env, ELECTRON_RENDERER_URL: '' },
  });
  try {
    const page = await app.firstWindow();
    await expect(page.getByTestId('runtime-state')).toHaveAttribute('data-state', 'ready');
    await openQuickCommandsWorkspace(page);
    const workspace = page.getByTestId('quick-command-workspace');
    await expect(workspace).toBeVisible();

    await workspace
      .locator('.quick-command-toolbar')
      .getByRole('button', { name: '新建快捷命令', exact: true })
      .click();
    let editor = workspace.locator('.quick-command-form');
    await editor.getByLabel('名称', { exact: true }).fill('Deploy status');
    await editor.getByLabel('标签', { exact: true }).fill('ops, kubernetes');
    await editor.getByLabel('步骤 1 名称').fill('Context');
    await editor.getByLabel('步骤 1 命令').fill('kubectl config current-context');
    await editor.getByRole('button', { name: '添加步骤' }).click();
    await editor.getByLabel('步骤 2 名称').fill('Timestamp');
    await editor.getByLabel('步骤 2 命令').fill('echo ');
    await editor.getByRole('button', { name: '{{date}}', exact: true }).click();
    await editor.getByRole('button', { name: '保存', exact: true }).click();
    const commandRow = workspace
      .locator('.quick-command-tree-row')
      .filter({ hasText: 'Deploy status' });
    await expect(commandRow).toBeVisible();

    await workspace
      .locator('.quick-command-toolbar')
      .getByRole('button', { name: '新建快捷命令文件夹' })
      .click();
    await workspace.getByLabel('文件夹名称').fill('Production');
    await workspace.getByRole('button', { name: '保存文件夹' }).click();
    const folderRow = workspace
      .locator('.quick-command-tree-row')
      .filter({ hasText: 'Production' });
    await expect(folderRow).toBeVisible();
    await commandRow.dragTo(folderRow, { targetPosition: { x: 90, y: 16 } });
    await expect(commandRow).toHaveAttribute('aria-level', '2');

    await workspace.getByLabel('搜索快捷命令').fill('kubernetes');
    await expect(commandRow).toBeVisible();
    await workspace.getByRole('button', { name: '清除搜索' }).click();
    await commandRow.click();
    editor = workspace.locator('.quick-command-form');
    await expect(editor.getByLabel('步骤 2 命令')).toHaveValue(/\{\{date\}\}/u);
    await editor.getByRole('button', { name: '复制', exact: true }).click();
    await expect(
      workspace.locator('.quick-command-tree-row').filter({ hasText: 'Deploy status(1)' }),
    ).toBeVisible();

    await workspace
      .locator('.quick-command-toolbar')
      .getByRole('button', { name: '新建快捷命令', exact: true })
      .click();
    editor = workspace.locator('.quick-command-form');
    await editor.getByLabel('名称', { exact: true }).fill('G02 explicit action');
    await editor
      .getByLabel('步骤 1 命令')
      .fill(String.raw`printf '\x47\x30\x32\x5f\x45\x58\x45\x43\n'`);
    await editor.getByRole('button', { name: '保存', exact: true }).click();

    await page.getByTitle('新建会话菜单', { exact: true }).click();
    await page
      .locator('.session-menu')
      .getByRole('button', { name: /本地终端/ })
      .click();
    const terminalLayer = page.locator('.terminal-session-layer:not([hidden])');
    await expect(terminalLayer.locator('.terminal-host')).toHaveAttribute(
      'data-connection-state',
      'connected',
    );
    await page
      .getByRole('contentinfo')
      .getByRole('button', { name: '快捷命令', exact: true })
      .click();
    const quickCommandPanel = page.getByLabel('快捷命令面板');
    const explicitCommand = quickCommandPanel
      .locator('article')
      .filter({ hasText: 'G02 explicit action' });
    await explicitCommand.getByRole('button', { name: '插入' }).click();
    await expect(terminalLayer.locator('.xterm-rows')).not.toContainText('G02_EXEC');
    await terminalLayer.locator('.xterm-helper-textarea').press('Control+u');
    await explicitCommand.getByRole('button', { name: '发送' }).click();
    await expect(terminalLayer.locator('.xterm-rows')).toContainText('G02_EXEC');

    await page.locator('[data-activity-item="bookmarks"]').click();
    await page.locator('.workspace-sidebar').getByRole('button', { name: '管理' }).click();
    await page.getByRole('button', { name: '添加主机' }).click();
    const bookmarkDialog = page.getByRole('dialog', { name: '添加 SSH 主机' });
    await bookmarkDialog.getByRole('tab', { name: '书签快捷命令' }).click();
    await bookmarkDialog.getByRole('button', { name: '添加命令' }).click();
    await bookmarkDialog.getByLabel('书签快捷命令 1 名称').fill('Bookmark health');
    await bookmarkDialog.getByLabel('书签快捷命令 1 命令').fill('uptime');
    await bookmarkDialog.getByRole('tab', { name: '认证' }).click();
    await bookmarkDialog.getByLabel('显示名称').fill('G02 Bookmark');
    await bookmarkDialog.getByLabel('主机地址').fill('g02.example.test');
    await bookmarkDialog.getByLabel('用户名').fill('operator');
    await bookmarkDialog.getByLabel('认证方式').selectOption('agent');
    await bookmarkDialog.getByRole('button', { name: '保存', exact: true }).click();
    await expect(
      page.locator('.host-card').getByText('G02 Bookmark', { exact: true }),
    ).toBeVisible();
  } finally {
    await app.close();
  }

  try {
    const database = await ProductDatabase.open(resolve(userData, 'data-v2', 'axterm.sqlite'));
    try {
      const tree = new QuickCommandRepository(database).snapshot();
      const production = tree.groups.find(({ name }) => name === 'Production');
      expect(production).toBeDefined();
      expect(tree.commands).toHaveLength(3);
      expect(tree.commands.find(({ name }) => name === 'Deploy status')).toMatchObject({
        groupId: production?.id,
        tags: ['ops', 'kubernetes'],
        commands: [
          expect.objectContaining({ command: 'kubectl config current-context' }),
          expect.objectContaining({ command: 'echo {{date}}' }),
        ],
      });
      expect(tree.commands.find(({ name }) => name === 'G02 explicit action')).toBeDefined();
      expect(new BookmarkRepository(database).snapshot().bookmarks).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            title: 'G02 Bookmark',
            quickCommands: [{ name: 'Bookmark health', command: 'uptime' }],
          }),
        ]),
      );
    } finally {
      database.close();
    }
  } finally {
    await rm(userData, { recursive: true, force: true });
  }
});

test('Batch Input sends bounded commands to selected terminals without changing focus', async () => {
  test.skip(process.platform === 'win32', 'This assertion uses a POSIX shell fixture.');
  const userData = await mkdtemp(resolve(tmpdir(), 'axterm-batch-input-e2e-'));
  const app = await electron.launch({
    executablePath,
    args: [resolve('apps/desktop'), `--user-data-dir=${userData}`],
    env: { ...process.env, ELECTRON_RENDERER_URL: '' },
  });
  try {
    const page = await app.firstWindow();
    await expect(page.getByTestId('runtime-state')).toHaveAttribute('data-state', 'ready');
    const tabs = page.locator('.pane-tabbar[data-pane-index="0"] .terminal-tab');
    await expect(tabs).toHaveCount(1);
    const firstId = await tabs.first().getAttribute('data-terminal-id');
    await page.locator('.pane-tabbar[data-pane-index="0"] .tab-add').click();
    await expect(tabs).toHaveCount(2);
    const secondId = await tabs.nth(1).getAttribute('data-terminal-id');
    expect(firstId).toBeTruthy();
    expect(secondId).toBeTruthy();
    const firstLayer = page.locator(`[data-terminal-session="${firstId!}"]`);
    const secondLayer = page.locator(`[data-terminal-session="${secondId!}"]`);
    await expect(secondLayer.locator('.terminal-host')).toHaveAttribute(
      'data-connection-state',
      'connected',
    );

    await page.getByRole('button', { name: '批量输入' }).click();
    const panel = page.getByLabel('批量输入面板');
    await expect(panel.getByRole('checkbox', { checked: true })).toHaveCount(1);
    await panel.getByRole('button', { name: '全选' }).click();
    await expect(panel.getByRole('checkbox', { checked: true })).toHaveCount(2);
    await panel.getByLabel('批量命令').fill(String.raw`printf '\x47\x30\x33\x5f\x41\x4c\x4c\n'`);
    await panel.getByLabel('批量命令').press('Enter');
    await expect(tabs.nth(1)).toHaveAttribute('aria-selected', 'true');
    await tabs.first().click();
    await expect(firstLayer.locator('.xterm-rows')).toContainText('G03_ALL');
    await tabs.nth(1).click();
    await expect(secondLayer.locator('.xterm-rows')).toContainText('G03_ALL');

    await page.getByRole('button', { name: '批量输入' }).click();
    await panel.getByRole('button', { name: '仅当前' }).click();
    await panel
      .getByLabel('批量命令')
      .fill(String.raw`printf '\x47\x30\x33\x5f\x43\x55\x52\x52\x45\x4e\x54\n'`);
    await panel.getByRole('button', { name: /发送到 1 个终端/ }).click();
    await expect(secondLayer.locator('.xterm-rows')).toContainText('G03_CURRENT');
    await expect(firstLayer.locator('.xterm-rows')).not.toContainText('G03_CURRENT');
    await expect(tabs.nth(1)).toHaveAttribute('aria-selected', 'true');

    await page.getByRole('button', { name: '批量输入' }).click();
    await panel.getByLabel('批量命令').fill('echo SHOULD_NOT_SEND');
    await page.keyboard.press('Escape');
    await expect(panel).toHaveCount(0);
    await expect(firstLayer.locator('.xterm-rows')).not.toContainText('SHOULD_NOT_SEND');
    await expect(secondLayer.locator('.xterm-rows')).not.toContainText('SHOULD_NOT_SEND');
  } finally {
    await app.close();
    await rm(userData, { recursive: true, force: true });
  }
});

test('Batch Operation executes a persisted multi-bookmark SSH run with per-target results', async () => {
  test.setTimeout(60_000);
  const userData = await mkdtemp(resolve(tmpdir(), 'axterm-batch-operation-e2e-'));
  const hostKey = utils.generateKeyPairSync('ed25519').private;
  const parsedHostKey = utils.parseKey(hostKey);
  if (parsedHostKey instanceof Error || Array.isArray(parsedHostKey))
    throw new Error('G04 SSH fixture generated an invalid host key');
  const publicKey = parsedHostKey.getPublicSSH();
  const fingerprint = `SHA256:${createHash('sha256')
    .update(publicKey)
    .digest('base64')
    .replace(/=+$/u, '')}`;
  const fixture = await startReconnectSshFixture(hostKey);
  await mkdir(resolve(userData, 'data-v2'), { recursive: true });
  const seed = await ProductDatabase.open(resolve(userData, 'data-v2', 'axterm.sqlite'));
  try {
    const products = new ProductRepository(seed);
    const bookmarks = new BookmarkRepository(seed);
    for (let index = 1; index <= 3; index += 1) {
      const host = products.createHost({
        name: `G04 Server ${index}`,
        hostname: '127.0.0.1',
        port: fixture.port,
        username: 'operator',
        authType: 'agent',
        sshAgent: { enabled: false, path: null },
      });
      bookmarks.createBookmark(
        {
          groupId: null,
          protocol: 'ssh',
          hostId: host.id,
          title: host.name,
          color: null,
          description: 'G04 real SSH batch target',
          profileId: null,
          connectionProfileId: null,
          quickCommands: [],
          triggers: [],
          ftp: null,
          telnet: null,
          serial: null,
          rdp: null,
          vnc: null,
          spice: null,
          web: null,
        },
        bookmarks.snapshot().etag,
      );
    }
    products.saveKnownHostKey({
      host: '127.0.0.1',
      port: fixture.port,
      algorithm: parsedHostKey.type,
      fingerprint,
      publicKey: publicKey.toString('base64'),
    });
  } finally {
    seed.close();
  }

  const app = await electron.launch({
    executablePath,
    args: [resolve('apps/desktop'), `--user-data-dir=${userData}`],
    env: { ...process.env, ELECTRON_RENDERER_URL: '' },
  });
  try {
    const page = await app.firstWindow();
    await expect(page.getByTestId('runtime-state')).toHaveAttribute('data-state', 'ready');
    await openQuickCommandsWorkspace(page);
    await page.getByRole('button', { name: '批量操作', exact: true }).click();
    const workspace = page.getByTestId('batch-operation-workspace');
    await expect(workspace).toBeVisible();
    await workspace.getByRole('button', { name: '全选', exact: true }).click();
    await expect(workspace.locator('.batch-operation-targets input:checked')).toHaveCount(3);
    await workspace.getByLabel('批量操作名称').fill('G04 production run');
    await workspace.getByLabel('批量操作并发数').selectOption('2');
    await workspace.getByLabel('步骤 1 名称').fill('Remote check');
    await workspace.getByLabel('步骤 1 命令').fill('printf G04_BATCH_OK');
    await workspace.getByRole('button', { name: '开始执行' }).click();

    await expect(workspace.locator('.batch-operation-history')).toContainText('G04 production run');
    await expect(workspace.locator('.batch-operation-history')).toContainText('成功', {
      timeout: 20_000,
    });
    await expect(workspace.locator('.batch-operation-summary')).toContainText('成功 3');
    await expect(workspace.locator('.batch-operation-detail details')).toHaveCount(3);
    await expect.poll(() => fixture.connectionCount()).toBe(0);
  } finally {
    await app.close();
    await fixture.stop();
  }

  try {
    const database = await ProductDatabase.open(resolve(userData, 'data-v2', 'axterm.sqlite'));
    try {
      const operation = new BatchOperationRepository(database).list()[0]!;
      expect(operation).toMatchObject({
        name: 'G04 production run',
        state: 'succeeded',
        targetCount: 3,
        succeededCount: 3,
      });
      expect(JSON.stringify(database.all('SELECT payload FROM domain_events'))).not.toContain(
        'printf G04_BATCH_OK',
      );
    } finally {
      database.close();
    }
  } finally {
    await rm(userData, { recursive: true, force: true });
  }
});

test('Trigger editor persists a rule that responds to real local terminal output', async () => {
  test.skip(process.platform === 'win32', 'This assertion uses a POSIX shell command.');
  const userData = await mkdtemp(resolve(tmpdir(), 'axterm-trigger-e2e-'));
  const app = await electron.launch({
    executablePath,
    args: [resolve('apps/desktop'), `--user-data-dir=${userData}`],
    env: { ...process.env, ELECTRON_RENDERER_URL: '' },
  });
  try {
    const page = await app.firstWindow();
    await expect(page.getByTestId('runtime-state')).toHaveAttribute('data-state', 'ready');
    await openQuickCommandsWorkspace(page);
    await page.getByRole('button', { name: /Triggers|触发器/ }).click();
    const workspace = page.getByTestId('trigger-workspace');
    await workspace.getByRole('button', { name: '新建', exact: true }).click();
    await workspace.getByLabel('触发器名称').fill('G05 prompt responder');
    await workspace.getByLabel('匹配内容').fill('G05_PROMPT');
    await workspace.getByLabel('发送内容').fill(String.raw`printf '\nG05_TRIGGERED\n'`);
    await workspace.getByRole('button', { name: '保存触发器' }).click();
    await expect(workspace.locator('.trigger-list')).toContainText('G05 prompt responder');

    await page.getByTitle('新建会话菜单', { exact: true }).click();
    await page
      .locator('.session-menu')
      .getByRole('button', { name: /本地终端/ })
      .click();
    const terminal = page.locator('.terminal-session-layer:not([hidden])');
    await expect(terminal.locator('.terminal-host')).toHaveAttribute(
      'data-connection-state',
      'connected',
    );
    await page.waitForTimeout(1_500);
    await terminal
      .locator('.xterm-helper-textarea')
      .pressSequentially(String.raw`printf '\x47\x30\x35\x5f\x50\x52\x4f\x4d\x50\x54\n'`);
    await terminal.locator('.xterm-helper-textarea').press('Enter');
    await expect(terminal.locator('.xterm-rows')).toContainText('G05_TRIGGERED', {
      timeout: 10_000,
    });
  } finally {
    await app.close();
  }

  try {
    const database = await ProductDatabase.open(resolve(userData, 'data-v2', 'axterm.sqlite'));
    try {
      expect(new TriggerRepository(database).snapshot().triggers).toEqual([
        expect.objectContaining({
          name: 'G05 prompt responder',
          match: expect.objectContaining({ value: 'G05_PROMPT' }),
          action: expect.objectContaining({ value: String.raw`printf '\nG05_TRIGGERED\n'` }),
        }),
      ]);
      expect(JSON.stringify(database.all('SELECT payload FROM domain_events'))).not.toContain(
        'G05_TRIGGERED',
      );
    } finally {
      database.close();
    }
  } finally {
    await rm(userData, { recursive: true, force: true });
  }
});

test('frozen historical Axterm portable export imports through the native file grant', async () => {
  const userData = await mkdtemp(resolve(tmpdir(), 'axterm-historical-portable-e2e-'));
  const fixturePath = resolve(
    'tests/fixtures/migration/historical-axterm-portable-v2-657b3cc.json',
  );
  const raw = await readFile(fixturePath, 'utf8');
  expect(createHash('sha256').update(raw).digest('hex')).toBe(
    '250a533d009e2b62ccc3723425584f9fad90efe9849b60ea41e2dcb583f3c0dc',
  );
  const source = JSON.parse(raw) as {
    quickCommands: Array<{ commands: Array<{ id: string }> }>;
  };
  const app = await electron.launch({
    executablePath,
    args: [resolve('apps/desktop'), `--user-data-dir=${userData}`],
    env: { ...process.env, ELECTRON_RENDERER_URL: '' },
  });
  try {
    await app.evaluate(({ dialog }, path) => {
      dialog.showOpenDialog = (() =>
        Promise.resolve({ canceled: false, filePaths: [path] })) as typeof dialog.showOpenDialog;
    }, fixturePath);
    const page = await app.firstWindow();
    const revoked: string[] = [];
    page.on('request', (request) => {
      if (request.method() === 'DELETE' && request.url().includes('/api/v1/file-grants/'))
        revoked.push(request.url());
    });
    await expect(page.getByTestId('runtime-state')).toHaveAttribute('data-state', 'ready');
    await page.locator('[data-activity-item="setting"]').click();
    await page.locator('[data-settings-category="common"]').click();
    const panel = page.getByLabel('Legacy Prototype 数据迁移');
    await panel.getByRole('button', { name: '选择数据文件' }).click();
    await expect(panel.locator('.data-migration-metric.create strong')).toHaveText('5');
    await expect(panel.getByText('3 credential metadata records', { exact: true })).toBeVisible();
    await expect(
      panel.locator('.data-migration-row').filter({ hasText: 'Historical package group' }),
    ).toContainText('未映射：level');
    const commandRow = panel
      .locator('.data-migration-row')
      .filter({ hasText: 'Historical package command' });
    await expect(commandRow.locator('p').filter({ hasText: /^映射：/u })).toContainText(
      'commands[].id',
    );
    await expect(commandRow).not.toContainText('未映射：');
    await expect.poll(() => revoked.length).toBe(1);
    await panel.getByRole('button', { name: '导入 5 项' }).click();
    await expect(panel.getByText('导入完成', { exact: true })).toBeVisible();

    const database = await ProductDatabase.open(resolve(userData, 'data-v2', 'axterm.sqlite'));
    try {
      const tree = new BookmarkRepository(database).snapshot();
      const group = tree.groups.find(({ name }) => name === 'Historical package group');
      const profile = new ConnectionProfileRepository(database)
        .list()
        .find(({ name }) => name === 'Historical package identity');
      expect(group).toBeDefined();
      expect(profile).toBeDefined();
      expect(tree.bookmarks.find(({ title }) => title === 'historical-package-host')).toMatchObject(
        {
          groupId: group?.id,
          connectionProfileId: null,
        },
      );
      expect(tree.bookmarks.find(({ title }) => title === 'historical-profile-host')).toMatchObject(
        {
          groupId: group?.id,
          connectionProfileId: profile?.id,
        },
      );
      expect(new QuickCommandRepository(database).snapshot().commands[0]?.commands[0]?.id).toBe(
        source.quickCommands[0]?.commands[0]?.id,
      );
    } finally {
      database.close();
    }
    const vaultFiles = await readdir(resolve(userData, 'vault-v2'));
    expect(vaultFiles.filter((name) => name.endsWith('.bin'))).toEqual([]);
  } finally {
    await app.close().catch(() => {});
    await rm(userData, { recursive: true, force: true });
  }
});

test('Legacy Prototype data migration previews, imports and exports through native file grants', async () => {
  const userData = await mkdtemp(resolve(tmpdir(), 'axterm-data-migration-e2e-'));
  const fixtureDirectory = await mkdtemp(resolve(tmpdir(), 'axterm-data-migration-source-'));
  const legacyDataFixture = resolve(
    'tests/fixtures/migration/legacy-legacy-prototype-data-v1.json',
  );
  const importPath = resolve(fixtureDirectory, 'legacy-prototype-data.json');
  const exportPath = resolve(fixtureDirectory, 'axterm-export.json');
  const configurationPath = resolve(fixtureDirectory, 'axterm-configuration.json');
  const profileSecret = 'B10-profile-password-secret';
  const staleBookmarkSecret = 'B10-stale-bookmark-secret';
  await writeFile(importPath, await readFile(legacyDataFixture));
  const app = await electron.launch({
    executablePath,
    args: [resolve('apps/desktop'), `--user-data-dir=${userData}`],
    env: { ...process.env, ELECTRON_RENDERER_URL: '' },
  });
  try {
    await app.evaluate(
      ({ dialog }, paths) => {
        const saveTargets = [paths.exportPath, paths.configurationPath];
        let openCount = 0;
        dialog.showOpenDialog = (() =>
          Promise.resolve({
            canceled: false,
            filePaths: [openCount++ === 0 ? paths.importPath : paths.configurationPath],
          })) as typeof dialog.showOpenDialog;
        dialog.showSaveDialog = (() =>
          Promise.resolve({
            canceled: false,
            filePath: saveTargets.shift()!,
          })) as typeof dialog.showSaveDialog;
      },
      { importPath, exportPath, configurationPath },
    );
    const page = await app.firstWindow();
    const revoked: string[] = [];
    page.on('request', (request) => {
      if (request.method() === 'DELETE' && request.url().includes('/api/v1/file-grants/'))
        revoked.push(request.url());
    });
    await expect(page.getByTestId('runtime-state')).toHaveAttribute('data-state', 'ready');
    await page.locator('[data-activity-item="setting"]').click();
    await page.locator('[data-settings-category="common"]').click();

    const panel = page.getByLabel('Legacy Prototype 数据迁移');
    await expect(panel).toBeVisible();
    await panel.getByRole('button', { name: '选择数据文件' }).click();
    await expect(panel.getByText('Desktop production shell', { exact: true })).toBeVisible();
    await expect(
      panel.locator('.data-migration-row').filter({ hasText: 'Desktop imports' }),
    ).toContainText('未映射：level, expanded');
    await expect(
      panel.locator('.data-migration-row').filter({ hasText: 'Desktop imported identity' }),
    ).toContainText('未映射：forwardAgent');
    await expect(
      panel.locator('.data-migration-row').filter({ hasText: 'Disk usage' }),
    ).toContainText('未映射：groupId');
    await expect(panel.getByText('B10-stale-bookmark-secret')).toHaveCount(0);
    await expect(panel.locator('.data-migration-metric.create strong')).toHaveText('4');
    await expect.poll(() => revoked.length).toBe(1);
    await panel.getByRole('button', { name: '导入 4 项' }).click();
    await expect(panel.getByText('导入完成', { exact: true })).toBeVisible();

    const database = await ProductDatabase.open(resolve(userData, 'data-v2', 'axterm.sqlite'));
    try {
      const [profile] = new ConnectionProfileRepository(database).list();
      const tree = new BookmarkRepository(database).snapshot();
      expect(profile).toMatchObject({
        name: 'Desktop imported identity',
        ssh: { username: 'deploy' },
      });
      expect(profile?.ssh.passwordCredentialRef).toMatch(/^cred_/u);
      expect(tree.groups[0]).toMatchObject({ name: 'Desktop imports', parentId: null });
      expect(tree.bookmarks[0]).toMatchObject({
        title: 'Desktop production shell',
        connectionProfileId: profile?.id,
        groupId: tree.groups[0]?.id,
      });
      expect(new ProductRepository(database).listJson('quick_commands')).toHaveLength(1);
      expect(database.all('SELECT * FROM legacy-prototype_import_entries')).toHaveLength(4);
    } finally {
      database.close();
    }

    await panel.getByRole('button', { name: '导出数据' }).click();
    await expect(panel.getByText('数据已导出', { exact: true })).toBeVisible();
    await expect.poll(() => revoked.length).toBe(2);
    const exported = await readFile(exportPath, 'utf8');
    expect(JSON.parse(exported)).toEqual(
      expect.objectContaining({
        bookmarks: expect.any(Array),
        bookmarkGroups: expect.any(Array),
        profiles: expect.any(Array),
        quickCommands: expect.any(Array),
        _axterm: expect.objectContaining({
          formatVersion: 2,
          credentials: 'omitted',
          settings: expect.any(Object),
          desktopPreferences: expect.objectContaining({ opacity: 1 }),
          credentialMetadata: [
            expect.objectContaining({
              kind: 'sshPassword',
              label: 'Desktop imported identity SSH password',
            }),
          ],
        }),
      }),
    );
    expect(exported).not.toContain(profileSecret);
    expect(exported).not.toContain(staleBookmarkSecret);
    expect(
      (
        JSON.parse(exported) as {
          _axterm: { credentialMetadata: Array<Record<string, unknown>> };
        }
      )._axterm.credentialMetadata[0],
    ).not.toHaveProperty('ref');

    await panel.getByRole('button', { name: '导出 Axterm 配置' }).click();
    await expect(panel.getByText('Axterm 配置已导出')).toBeVisible();
    await expect.poll(() => revoked.length).toBe(3);
    const configuration = await readFile(configurationPath, 'utf8');
    expect(JSON.parse(configuration)).toMatchObject({
      format: 'axterm-configuration',
      formatVersion: 1,
      vaultSecretValues: 'omitted',
      data: {
        bookmarks: [expect.objectContaining({ title: 'Desktop production shell' })],
        connectionProfiles: [expect.objectContaining({ name: 'Desktop imported identity' })],
      },
    });
    expect(configuration).not.toContain(profileSecret);
    expect(configuration).not.toContain(staleBookmarkSecret);
    expect(configuration).not.toContain('cred_');
    await expect(panel.locator('.axterm-config-hash')).toContainText(
      createHash('sha256').update(configuration).digest('hex'),
    );
    await panel.getByRole('button', { name: '检查 Axterm 文件' }).click();
    await expect(panel.getByText('Axterm 文件检查完成')).toBeVisible();
    await expect(panel.locator('.axterm-config-inspection')).toContainText('0 个问题');
    await expect(panel.locator('.axterm-config-inspection')).toContainText(
      createHash('sha256').update(configuration).digest('hex'),
    );
    await expect.poll(() => revoked.length).toBe(4);
    await panel.locator('.axterm-config-settings-option input').check();
    await panel.getByRole('button', { name: '导入 Axterm 配置' }).click();
    await expect(panel.getByText('审阅 Axterm 配置变更', { exact: true })).toBeVisible();
    await expect(panel.getByText(/下次启动 Axterm 时，将替换保存的便携外观/u)).toBeVisible();
    await expect(
      panel.locator('.axterm-config-preview .data-migration-metric.unchanged strong'),
    ).toHaveText('5');
    await expect(panel.getByRole('button', { name: '导入 0 项' })).toBeEnabled();
    await panel.getByRole('button', { name: '导入 0 项' }).click();
    await expect(panel.getByText('Axterm 配置已导入', { exact: true })).toBeVisible();
    await expect(panel.getByText(/已保存便携的外观、布局、终端、文件和快捷键设置/u)).toBeVisible();
    await expect.poll(() => revoked.length).toBe(5);

    const vaultBefore = await readDirectoryFiles(resolve(userData, 'vault-v2'));
    const mutationDatabase = await ProductDatabase.open(
      resolve(userData, 'data-v2', 'axterm.sqlite'),
    );
    try {
      const products = new ProductRepository(mutationDatabase);
      for (let attempt = 0; attempt < 10; attempt += 1) {
        const current = products.getSettings();
        try {
          products.updateSettings({ privacy: { hideAddresses: true } }, etagFor(current.version));
          break;
        } catch (cause) {
          if (
            !(cause instanceof Error) ||
            !/Settings changed/u.test(cause.message) ||
            attempt === 9
          )
            throw cause;
        }
      }
    } finally {
      mutationDatabase.close();
    }
    await page.getByLabel('窗口透明度').fill('0.75');
    await page.getByRole('button', { name: '保存窗口偏好' }).click();
    await expect
      .poll(() =>
        app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.getOpacity()),
      )
      .toBe(0.75);

    await app.evaluate(({ dialog }, path) => {
      dialog.showOpenDialog = (() =>
        Promise.resolve({ canceled: false, filePaths: [path] })) as typeof dialog.showOpenDialog;
    }, exportPath);
    await panel.getByRole('button', { name: '选择数据文件' }).click();
    await expect(panel.getByText('Application settings', { exact: true })).toBeVisible();
    await expect(panel.getByText('1 credential metadata record', { exact: true })).toBeVisible();
    await expect(panel.locator('.data-migration-metric.create strong')).toHaveText('1');
    await panel.getByRole('button', { name: '导入 1 项' }).click();
    await expect(panel.getByText('便携设置已应用。', { exact: false })).toBeVisible();
    await expect(panel.getByText(/已报告 1 条凭据元数据/u)).toBeVisible();
    await expect
      .poll(() =>
        app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.getOpacity()),
      )
      .toBe(1);
    const verifiedDatabase = await ProductDatabase.open(
      resolve(userData, 'data-v2', 'axterm.sqlite'),
    );
    try {
      expect(new ProductRepository(verifiedDatabase).getSettings().privacy.hideAddresses).toBe(
        false,
      );
    } finally {
      verifiedDatabase.close();
    }
    expect(await readDirectoryFiles(resolve(userData, 'vault-v2'))).toEqual(vaultBefore);

    for (const directory of [resolve(userData, 'data-v2'), resolve(userData, 'vault-v2')]) {
      for (const contents of await readDirectoryFiles(directory)) {
        expect(contents.includes(Buffer.from(profileSecret))).toBe(false);
        expect(contents.includes(Buffer.from(staleBookmarkSecret))).toBe(false);
      }
    }
  } finally {
    await app.close();
    await Promise.all([
      rm(userData, { recursive: true, force: true }),
      rm(fixtureDirectory, { recursive: true, force: true }),
    ]);
  }
});

test('Legacy Prototype UI-exported custom theme migration previews, imports and remaps selection through native file grants', async () => {
  const userData = await mkdtemp(resolve(tmpdir(), 'axterm-theme-migration-e2e-'));
  const fixtureDirectory = await mkdtemp(resolve(tmpdir(), 'axterm-theme-migration-source-'));
  const importPath = resolve(fixtureDirectory, 'legacy-prototype-data.json');
  const sourceId = 'OtUP3hD';
  const raw = await readFile(
    resolve(
      'tests/fixtures/migration/legacy-prototype-v1.101.16-custom-terminal-theme-ui-export-v1.json',
    ),
    'utf8',
  );
  expect(createHash('sha256').update(raw).digest('hex')).toBe(
    'c366a2a2462cf6c795d867aac7c1942a4895b6a9ab6246c9adfcd5cb47908067',
  );
  await writeFile(importPath, raw);
  const app = await electron.launch({
    executablePath,
    args: [resolve('apps/desktop'), `--user-data-dir=${userData}`],
    env: { ...process.env, ELECTRON_RENDERER_URL: '' },
  });
  try {
    await app.evaluate(({ dialog }, path) => {
      dialog.showOpenDialog = (() =>
        Promise.resolve({ canceled: false, filePaths: [path] })) as typeof dialog.showOpenDialog;
    }, importPath);
    const page = await app.firstWindow();
    await expect(page.getByTestId('runtime-state')).toHaveAttribute('data-state', 'ready');
    await page.locator('[data-activity-item="setting"]').click();
    await page.locator('[data-settings-category="common"]').click();

    const panel = page.getByLabel('Legacy Prototype 数据迁移');
    await panel.getByRole('button', { name: '选择数据文件' }).click();
    const preview = panel.locator('.data-migration-preview');
    await expect(preview).toBeVisible();
    const themeMetric = preview.locator('.data-migration-metric').filter({ hasText: '终端主题' });
    await expect(themeMetric.locator('strong')).toHaveText('1');
    const skippedMetric = preview.locator('.data-migration-metric').filter({ hasText: '跳过' });
    await expect(skippedMetric.locator('strong')).toHaveText('2');
    const themeRow = preview
      .locator('.data-migration-row')
      .filter({ hasText: 'Axterm Aurora Test' });
    await expect(themeRow).toContainText('终端主题');
    await expect(
      preview.locator('.data-migration-row').filter({ hasText: 'default light' }),
    ).toContainText('跳过');
    await expect(preview).not.toContainText('#D7F6E8');
    await expect(panel.getByRole('button', { name: '导入 2 项' })).toBeEnabled();
    await panel.getByRole('button', { name: '导入 2 项' }).click();
    await expect(panel.getByText('导入完成', { exact: true })).toBeVisible();

    const database = await ProductDatabase.open(resolve(userData, 'data-v2', 'axterm.sqlite'));
    try {
      const products = new ProductRepository(database);
      const imported = new TerminalThemeRepository(products)
        .list()
        .find(({ name }) => name === 'Axterm Aurora Test');
      expect(imported).toMatchObject({
        builtIn: false,
        terminal: {
          foreground: '#D7F6E8',
          background: '#10343B',
          cursor: '#2AC795',
          selectionBackground: 'rgba(42, 199, 149, 0.30)',
        },
        ui: { primary: '#2AC795' },
      });
      expect(products.getSettings().terminal.visual.themeId).toBe(imported?.id);
      expect(
        database.get<{ target_id: string }>(
          `SELECT target_id FROM legacy-prototype_import_entries
           WHERE kind = 'terminalTheme' AND source_id = ?`,
          sourceId,
        )?.target_id,
      ).toBe(imported?.id);
    } finally {
      database.close();
    }
  } finally {
    await app.close().catch(() => {});
    await rm(userData, { recursive: true, force: true });
    await rm(fixtureDirectory, { recursive: true, force: true });
  }
});

test('production workspace, utility isolation, reattachment, crash restart and cleanup', async () => {
  const userData = await mkdtemp(resolve(tmpdir(), 'axterm-e2e-'));
  const app = await electron.launch({
    executablePath,
    args: [resolve('apps/desktop'), `--user-data-dir=${userData}`],
    env: { ...process.env, ELECTRON_RENDERER_URL: '' },
  });
  let runtimePid: number | undefined;
  try {
    const page = await app.firstWindow();
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await expect(page.getByTestId('runtime-state')).toHaveAttribute('data-state', 'ready');
    const generation = await page.getByTestId('runtime-generation').innerText();
    const runtimeId = await page.getByTestId('runtime-id').innerText();
    expect(generation).toMatch(/^[\da-f-]{36}$/);
    expect(runtimeId).toMatch(/^[\da-f-]{36}$/);
    const native = await app.evaluate(({ app, BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0]!;
      return {
        pid: process.pid,
        renderer: app
          .getAppMetrics()
          .find((metric) => metric.pid === window.webContents.getOSProcessId()),
      };
    });
    if (process.platform !== 'linux') expect(native.renderer?.sandboxed).toBe(true);
    const renderer = await page.evaluate(() => ({
      node: 'require' in window || 'process' in window,
      storage: { ...localStorage, ...sessionStorage },
      bridge: Object.keys(window.desktopBootstrap),
    }));
    expect(renderer.node).toBe(false);
    expect(renderer.bridge).toEqual(['resolve']);
    expect(Object.keys(renderer.storage)).toEqual(['axterm-bookmark-tree-ui']);
    expect(JSON.stringify(renderer.storage)).not.toMatch(
      /bootstrapToken|sessionToken|credentialRef|password|passphrase|secret/i,
    );
    expect(JSON.parse(renderer.storage['axterm-bookmark-tree-ui']!)).toEqual({
      state: { expandedGroupIds: [] },
      version: 0,
    });
    const csp = (await page.request.get(page.url())).headers()['content-security-policy'];
    expect(csp).toContain("script-src 'self' 'wasm-unsafe-eval';");
    expect(csp).toContain("connect-src 'self' data:;");
    expect(csp).toContain('frame-src axterm-license:;');
    expect(csp).not.toContain("script-src 'self' 'unsafe-inline'");
    expect(csp).not.toContain("'unsafe-eval'");
    expect(csp).toContain("style-src 'self' 'unsafe-inline'");
    const terminalCount = await page.locator('.terminal-tab').count();
    await page.locator('.terminal-pane.active .tab-add').click();
    await expect(page.locator('.terminal-tab')).toHaveCount(terminalCount + 1);
    const terminalInput = page.locator(
      '.terminal-session-layer:not([hidden]) .xterm-helper-textarea',
    );
    await expect(
      page.locator('.terminal-session-layer:not([hidden]) .terminal-host'),
    ).toHaveAttribute('data-connection-state', 'connected');
    await terminalInput.pressSequentially("printf '\\nAXTERM_DESKTOP_PTY_OK\\n'");
    await terminalInput.press('Enter');
    await terminalInput.press(process.platform === 'darwin' ? 'Meta+f' : 'Control+f');
    const search = page.getByPlaceholder('查找终端输出');
    await expect
      .poll(async () => {
        await search.fill('');
        await search.fill('AXTERM_DESKTOP_PTY_OK');
        return page.locator('.terminal-search-result').textContent();
      })
      .toBe('已找到');
    await page.locator('[data-activity-item="bookmarks"]').click();
    await page.locator('.workspace-sidebar').getByRole('button', { name: '管理' }).click();
    await page.getByRole('button', { name: '添加主机' }).click();
    await page.getByLabel('显示名称').fill('持久化主机');
    await page.getByLabel('主机地址').fill('127.0.0.1');
    await page.getByLabel('用户名').fill('fixture');
    await page.getByLabel('认证方式').selectOption('agent');
    await page.getByRole('button', { name: '保存', exact: true }).click();
    await expect(page.locator('.host-card').getByText('持久化主机', { exact: true })).toBeVisible();
    await page.locator('.bookmark-manager-back').click();
    await expect(page.getByRole('treeitem', { name: /^持久化主机/ })).toBeVisible();
    await page.getByRole('button', { name: '连接详情' }).click();
    await expect(page.getByTestId('runtime-id')).toHaveCount(0);
    await page.getByRole('button', { name: '连接详情' }).click();
    await expect(page.getByTestId('runtime-id')).toHaveText(runtimeId);
    await page.getByRole('button', { name: '重新连接' }).click();
    await expect(page.getByTestId('runtime-state')).toHaveAttribute('data-state', 'ready');
    await expect(page.getByTestId('runtime-generation')).toHaveText(generation);
    await page.reload();
    await expect(page.getByTestId('runtime-state')).toHaveAttribute('data-state', 'ready');
    runtimePid = Number(
      await page
        .locator('dl div')
        .filter({ has: page.getByText('进程 ID', { exact: true }) })
        .locator('dd')
        .innerText(),
    );
    expect(runtimePid).not.toBe(native.pid);
    expect(runtimePid).toBeGreaterThan(0);
    // Fault injection targets this test's own utility process only.
    process.kill(runtimePid, 'SIGKILL');
    await expect(page.getByTestId('runtime-state')).toHaveAttribute('data-state', 'ready');
    await expect(page.getByTestId('runtime-generation')).not.toHaveText(generation);
    await expect(page.getByTestId('runtime-id')).not.toHaveText(runtimeId);
    const recoveryBanner = page.getByTestId('session-recovery');
    await expect(recoveryBanner).toHaveAttribute('data-recovery-kind', 'runtime-restarted');
    await expect(recoveryBanner).toContainText('待处理的修改不会自动重放');
    await expect
      .poll(() =>
        recoveryBanner.evaluate((element) => window.getComputedStyle(element).borderTopColor),
      )
      .toBe('rgb(47, 199, 161)');
    const disconnectedTab = page.locator('.terminal-tab.disconnected').first();
    await expect(disconnectedTab).toBeVisible();
    const disconnectedId = await disconnectedTab.getAttribute('data-terminal-id');
    expect(disconnectedId).toBeTruthy();
    await disconnectedTab.click({ button: 'right' });
    const disconnectedMenu = page.locator('.tab-context-menu');
    for (const action of [
      '新建标签',
      '复制标签',
      '复制到下一窗格',
      '重新连接会话',
      '重新连接全部会话',
      '重命名',
      '关闭其他标签',
      '关闭右侧标签',
      '关闭全部标签',
    ])
      await expect(
        disconnectedMenu.getByRole('button', { name: action, exact: true }),
      ).toBeVisible();
    await disconnectedMenu.getByRole('button', { name: '固定标签' }).click();
    await disconnectedTab.click({ button: 'right' });
    await disconnectedMenu.getByRole('button', { name: '重命名' }).click();
    const disconnectedRename = disconnectedTab.locator('.tab-rename');
    await disconnectedRename.fill('已恢复的本地会话');
    await disconnectedRename.press('Enter');
    await expect(disconnectedTab.locator('.tab-title')).toHaveText('已恢复的本地会话');
    await disconnectedTab.click({ button: 'right' });
    await disconnectedMenu.getByRole('button', { name: '重新连接会话', exact: true }).click();
    await expect(page.locator(`.terminal-tab[data-terminal-id="${disconnectedId!}"]`)).toHaveCount(
      0,
    );
    const recoveredTab = page.locator('.pane-tabbar .terminal-tab.active');
    await expect(recoveredTab).toHaveClass(/pinned/);
    await expect(recoveredTab.locator('.tab-title')).toHaveText('已恢复的本地会话');
    await expect(
      page.locator('.terminal-session-layer:not([hidden]) .terminal-host'),
    ).toHaveAttribute('data-connection-state', 'connected');
    if (await page.locator('.workspace-sidebar').isHidden())
      await page.locator('[data-activity-item="bookmarks"]').click();
    await page.locator('.workspace-sidebar').getByRole('button', { name: '管理' }).click();
    await expect(page.locator('.host-card').getByText('持久化主机', { exact: true })).toBeVisible();
    await page.locator('.bookmark-manager-back').click();
    await expect(page.getByRole('treeitem', { name: /^持久化主机/ })).toBeVisible();
    await page.locator('.workspace-sidebar').getByRole('button', { name: '管理' }).click();
    page.once('dialog', (dialog) => dialog.accept());
    await page
      .locator('.host-card')
      .filter({ hasText: '持久化主机' })
      .getByRole('button', { name: '删除' })
      .click();
    await expect(page.locator('.host-card').getByText('持久化主机', { exact: true })).toHaveCount(
      0,
    );
    await page.locator('.bookmark-manager-back').click();
    await expect(page.getByRole('treeitem', { name: /^持久化主机/ })).toHaveCount(0);
    runtimePid = Number(
      await page
        .locator('dl div')
        .filter({ has: page.getByText('进程 ID', { exact: true }) })
        .locator('dd')
        .innerText(),
    );
    await page.screenshot({ path: 'test-results/desktop-foundation.png' });
    expect(errors).toEqual([]);
  } finally {
    await app.close();
    await rm(userData, { recursive: true, force: true });
  }
  if (runtimePid) expect(() => process.kill(runtimePid, 0)).toThrow();
});

test('J-02 refreshes safe session state after offline and native resume events', async () => {
  const userData = await mkdtemp(resolve(tmpdir(), 'axterm-lifecycle-e2e-'));
  const app = await electron.launch({
    executablePath,
    args: [resolve('apps/desktop'), `--user-data-dir=${userData}`],
    env: { ...process.env, ELECTRON_RENDERER_URL: '' },
  });
  try {
    const page = await app.firstWindow();
    const errors: string[] = [];
    const mutations: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('request', (request) => {
      if (
        ['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method()) &&
        !request.url().endsWith('/api/v1/auth/bootstrap')
      )
        mutations.push(`${request.method()} ${new URL(request.url()).pathname}`);
    });
    await expect(page.getByTestId('runtime-state')).toHaveAttribute('data-state', 'ready');
    await expect(page.locator('.terminal-host').first()).toHaveAttribute(
      'data-connection-state',
      'connected',
    );
    await page.waitForTimeout(1_000);
    mutations.length = 0;

    await page.evaluate(() => window.dispatchEvent(new Event('offline')));
    const recovery = page.getByTestId('session-recovery');
    await expect(recovery).toHaveAttribute('data-recovery-kind', 'offline');
    await expect(recovery).toContainText('不会自动重放命令或文件修改');

    await page.evaluate(() => window.dispatchEvent(new Event('online')));
    await expect(recovery).toHaveAttribute('data-recovery-kind', 'recovered');
    await expect(page.getByTestId('runtime-state')).toHaveAttribute('data-state', 'ready');
    await expect(page.locator('.terminal-host').first()).toHaveAttribute(
      'data-connection-state',
      'connected',
    );

    await app.evaluate(({ powerMonitor }) => powerMonitor.emit('resume'));
    await expect(recovery).toHaveAttribute('data-recovery-kind', 'resumed', { timeout: 5_000 });
    await expect(recovery).toContainText('已中断的远程任务保持停止');
    await page.screenshot({ path: 'test-results/phase21-j02-recovery.png' });

    expect(mutations).toEqual([]);
    expect(errors).toEqual([]);
  } finally {
    await app.close().catch(() => {});
    await rm(userData, { recursive: true, force: true });
  }
});

test('Legacy Prototype parity shell supports menus, pinned tabs, resizable panes and named workspaces', async () => {
  const userData = await mkdtemp(resolve(tmpdir(), 'axterm-phase12-'));
  const app = await electron.launch({
    executablePath,
    args: [resolve('apps/desktop'), `--user-data-dir=${userData}`],
    env: { ...process.env, ELECTRON_RENDERER_URL: '' },
  });
  try {
    const page = await app.firstWindow();
    await expect(page.getByTestId('runtime-state')).toHaveAttribute('data-state', 'ready');
    await expect(page.locator('.terminal-host')).toHaveAttribute(
      'data-connection-state',
      'connected',
    );

    const rail = await page.locator('.activity-bar').boundingBox();
    const tabbar = await page.locator('.tabbar').boundingBox();
    const statusbar = await page.locator('.app-statusbar').boundingBox();
    expect(rail?.width).toBe(43);
    expect(tabbar?.height).toBe(36);
    expect(statusbar?.height).toBe(36);

    await page.locator('.tab-add-menu:visible').first().click();
    await expect(page.locator('.session-menu')).toBeVisible();
    await page.locator('#quick-connect').fill('invalid protocol://');
    await page.locator('#quick-connect').press('Enter');
    await expect(page.locator('.session-menu .menu-error')).toBeVisible();
    await page.keyboard.press('Escape');

    for (let index = 0; index < 3; index++) {
      await page.locator('.terminal-pane.active .tab-add').click();
      await expect(page.locator('.terminal-tab')).toHaveCount(index + 2);
    }
    const paneTabs = page.locator('.pane-tabbar[data-pane-index="0"] .terminal-tab');
    await expect(paneTabs.locator('.tab-number')).toHaveText(['1', '2', '3', '4']);
    const initialTabIds = await paneTabs.evaluateAll((elements) =>
      elements.map((element) => element.getAttribute('data-terminal-id')),
    );
    await paneTabs.first().focus();
    await page.keyboard.press('Alt+Shift+ArrowRight');
    await expect
      .poll(() =>
        paneTabs.evaluateAll((elements) =>
          elements.map((element) => element.getAttribute('data-terminal-id')),
        ),
      )
      .toEqual([initialTabIds[1], initialTabIds[0], initialTabIds[2], initialTabIds[3]]);
    await expect(
      page.locator(
        `.pane-tabbar[data-pane-index="0"] .terminal-tab[data-terminal-id="${initialTabIds[0]!}"]`,
      ),
    ).toHaveClass(/active/);
    await expect(
      page.locator(
        `.pane-tabbar[data-pane-index="0"] .terminal-tab[data-terminal-id="${initialTabIds[0]!}"]`,
      ),
    ).toBeFocused();
    await page
      .locator(
        `.pane-tabbar[data-pane-index="0"] .terminal-tab[data-terminal-id="${initialTabIds[0]!}"]`,
      )
      .press('ArrowRight');
    await expect(
      page.locator(
        `.pane-tabbar[data-pane-index="0"] .terminal-tab[data-terminal-id="${initialTabIds[2]!}"]`,
      ),
    ).toHaveClass(/active/);
    await expect(
      page.locator(
        `.pane-tabbar[data-pane-index="0"] .terminal-tab[data-terminal-id="${initialTabIds[2]!}"]`,
      ),
    ).toBeFocused();
    const firstTab = page.locator('.terminal-tab').first();
    await firstTab.click({ button: 'right' });
    const contextMenu = page.locator('.tab-context-menu');
    await expect(contextMenu).toBeVisible();
    await expect(contextMenu.getByRole('button', { name: '新建标签' })).toBeVisible();
    await expect(contextMenu.getByRole('button', { name: '复制标签' })).toBeVisible();
    await expect(contextMenu.getByRole('button', { name: '复制到下一窗格' })).toBeVisible();
    await contextMenu.getByRole('button', { name: '固定标签' }).click();
    await expect(firstTab).toHaveClass(/pinned/);
    await firstTab.click({ button: 'right' });
    await expect(contextMenu.getByRole('button', { name: /关闭 ⌘W/ })).toBeEnabled();
    await page.keyboard.press('Escape');

    const countBeforeDuplicate = await page.locator('.terminal-tab').count();
    await firstTab.dblclick();
    await expect(page.locator('.terminal-tab')).toHaveCount(countBeforeDuplicate + 1);
    await expect(page.locator('.tab-rename')).toHaveCount(0);
    const duplicatedPinnedTab = page.locator(
      '.pane-tabbar[data-pane-index="0"] .terminal-tab.active',
    );
    await expect(duplicatedPinnedTab).toHaveClass(/pinned/);
    const duplicatedPinnedId = await duplicatedPinnedTab.getAttribute('data-terminal-id');
    await expect(
      page.locator('.pane-tabbar[data-pane-index="0"] .terminal-tab').nth(1),
    ).toHaveAttribute('data-terminal-id', duplicatedPinnedId!);
    await expect(duplicatedPinnedTab.locator('.tab-title')).toHaveText(
      await firstTab.locator('.tab-title').innerText(),
    );
    await duplicatedPinnedTab.click({ button: 'right' });
    await contextMenu.getByRole('button', { name: /关闭 ⌘W/ }).click();
    await expect(page.locator('.terminal-tab')).toHaveCount(countBeforeDuplicate);

    await page.getByTitle('布局与工作区').click();
    await page.locator('[data-layout-choice="c2x2"]').click();
    await expect(page.locator('.terminal-pane')).toHaveCount(4);
    await expect(page.locator('.empty-pane-landing')).toHaveCount(3);
    await expect(page.locator('.terminal-host:visible')).toHaveCount(1);
    await page
      .locator('.pane-tabbar[data-pane-index="0"] .terminal-tab')
      .nth(1)
      .dragTo(page.locator('.pane-tabbar[data-pane-index="1"]'));
    await expect(page.locator('.pane-tabbar[data-pane-index="1"] .terminal-tab')).toHaveCount(1);
    const remainingIds = await page
      .locator('.pane-tabbar[data-pane-index="0"] .terminal-tab')
      .evaluateAll((elements) =>
        elements.map((element) => element.getAttribute('data-terminal-id')),
      );
    expect(remainingIds).toHaveLength(3);
    await page.getByLabel('为窗格 3 选择已有会话').selectOption(remainingIds[0]!);
    await page.getByLabel('为窗格 4 选择已有会话').selectOption(remainingIds[1]!);
    await expect(page.locator('.empty-pane-landing')).toHaveCount(0);
    await expect(page.locator('.terminal-host:visible')).toHaveCount(4);

    const secondPane = page.locator('.terminal-pane').nth(1);
    await secondPane.getByRole('button', { name: '搜索窗格 2 终端' }).click();
    await expect(
      page.locator('.terminal-session-layer[data-pane-index="1"]').getByPlaceholder('查找终端输出'),
    ).toBeFocused();
    await page.keyboard.press('Escape');
    await secondPane.getByRole('button', { name: '最大化窗格 2' }).click();
    await expect(page.locator('.terminal-pane:visible')).toHaveCount(1);
    await expect(page.locator('.terminal-host:visible')).toHaveCount(1);
    await page.getByRole('button', { name: '还原窗格 2' }).click();
    await expect(page.locator('.terminal-pane:visible')).toHaveCount(4);
    await expect(page.locator('.terminal-host:visible')).toHaveCount(4);

    // Legacy Prototype scopes tab actions to the pane's batch. Closing the other tabs in pane 1
    // must leave the three independently active pane batches untouched.
    await page.locator('.terminal-session-layer[data-pane-index="0"]:not([hidden])').click();
    await page.locator('.pane-tabbar[data-pane-index="0"] .tab-add').click();
    await page.locator('.pane-tabbar[data-pane-index="0"] .tab-add').click();
    await expect(page.locator('.pane-tabbar[data-pane-index="0"] .terminal-tab')).toHaveCount(3);
    const pinnedBatchCandidate = page
      .locator('.pane-tabbar[data-pane-index="0"] .terminal-tab')
      .first();
    if (!(await pinnedBatchCandidate.evaluate((element) => element.classList.contains('pinned')))) {
      await pinnedBatchCandidate.click({ button: 'right' });
      await page.locator('.tab-context-menu').getByRole('button', { name: '固定标签' }).click();
    }
    const pinnedBatchCandidateId = await pinnedBatchCandidate.getAttribute('data-terminal-id');
    expect(pinnedBatchCandidateId).toBeTruthy();
    await page
      .locator('.pane-tabbar[data-pane-index="0"] .terminal-tab')
      .last()
      .click({ button: 'right' });
    await page.locator('.tab-context-menu').getByRole('button', { name: '关闭其他标签' }).click();
    await expect(page.locator('.pane-tabbar[data-pane-index="0"] .terminal-tab')).toHaveCount(1);
    await expect(
      page.locator(`.terminal-tab[data-terminal-id="${pinnedBatchCandidateId!}"]`),
    ).toHaveCount(0);
    for (const paneIndex of [1, 2, 3]) {
      await expect(
        page.locator(`.pane-tabbar[data-pane-index="${paneIndex}"] .terminal-tab`),
      ).toHaveCount(1);
    }
    await expect(page.locator('.terminal-host:visible')).toHaveCount(4);

    const firstPane = page.locator('.terminal-pane').first();
    const firstSessionLayer = page.locator(
      '.terminal-session-layer[data-pane-index="0"]:not([hidden])',
    );
    const before = await firstPane.boundingBox();
    const sessionBefore = await firstSessionLayer.boundingBox();
    const divider = page.locator('.pane-resizer.vertical').first();
    const handle = await divider.boundingBox();
    expect(handle).toBeTruthy();
    await page.mouse.move(handle!.x + 2, handle!.y + 20);
    await page.mouse.down();
    await page.mouse.move(handle!.x + 90, handle!.y + 20, { steps: 4 });
    await page.mouse.up();
    const after = await firstPane.boundingBox();
    const sessionAfter = await firstSessionLayer.boundingBox();
    expect(after!.width).toBeGreaterThan(before!.width + 10);
    expect(sessionAfter!.width).toBeGreaterThan(sessionBefore!.width + 10);
    expect(sessionAfter!.x).toBeCloseTo(after!.x, 0);
    expect(after!.width - sessionAfter!.width).toBeCloseTo(2, 0);
    await page.screenshot({ path: 'test-results/phase12-four-real-panes.png' });

    await page.getByTitle('布局与工作区').click();
    await page.locator('.layout-menu').getByRole('button', { name: '工作区' }).click();
    await page.getByPlaceholder('工作区名称').fill('四窗格运维');
    await page.locator('.workspace-menu form').getByRole('button', { name: '保存' }).click();
    await expect(page.locator('.workspace-list-menu').getByText('四窗格运维')).toBeVisible();
    await page.keyboard.press('Escape');

    const savedTerminalCount = await page.locator('.terminal-tab').count();
    await page.locator('.terminal-pane.active .tab-add').click();
    await expect(page.locator('.terminal-tab')).toHaveCount(savedTerminalCount + 1);
    await page.getByTitle('布局与工作区').click();
    await page.locator('.layout-menu').getByRole('button', { name: '工作区' }).click();
    await page
      .locator('.workspace-list-menu > div > button')
      .filter({ hasText: '四窗格运维' })
      .click();
    await expect(page.locator('.terminal-tab')).toHaveCount(savedTerminalCount);
    await expect(page.locator('.terminal-host:visible')).toHaveCount(4);
    await page.keyboard.press('Escape');

    await page.locator('[data-activity-item="bookmarks"]').click();
    await expect(page.locator('.workspace-sidebar')).toBeVisible();
    await page.getByTitle('收起侧栏').click();
    await expect(page.locator('.workspace-sidebar')).toBeHidden();

    await page.screenshot({ path: 'test-results/phase12-legacy-prototype-parity-shell.png' });
  } finally {
    await app.close();
    await rm(userData, { recursive: true, force: true });
  }
});

test('A-01/A-02 activity rail keeps connection creation and bookmarks fixed, orders, persists and keeps retired shortcuts hidden and preserves remaining destinations', async () => {
  const userData = await mkdtemp(resolve(tmpdir(), 'axterm-activity-rail-'));
  await mkdir(resolve(userData, 'data-v2'), { recursive: true });
  const seed = await ProductDatabase.open(resolve(userData, 'data-v2', 'axterm.sqlite'));
  try {
    const repository = new ProductRepository(seed);
    repository.updateSettings(
      {
        workspace: {
          activityRailItems: [
            'newBookmark',
            'quickConnect',
            'terminalThemes',
            'setting',
            'settingSync',
            'widgets',
          ],
        },
      },
      etagFor(repository.getSettings().version),
    );
  } finally {
    seed.close();
  }
  const launch = () =>
    launchLocalOptimizationApp({
      executablePath,
      args: [resolve('apps/desktop'), `--user-data-dir=${userData}`],
      env: { ...process.env, ELECTRON_RENDERER_URL: '' },
    });
  let app = await launch();
  const expectedOrder = ['ai', 'setting', 'newBookmark', 'bookmarks'];
  const expectRetiredShortcutsHidden = async (page: Page) => {
    const rail = page.locator('.app-sidebar');
    await expect(
      rail.locator(
        '[data-activity-item="quickConnect"], [data-activity-item="terminalThemes"], [data-activity-item="settingSync"], [data-activity-item="widgets"]',
      ),
    ).toHaveCount(0);
    await expect(rail.getByRole('button', { name: '文件传输', exact: true })).toHaveCount(0);
    await expect(rail.getByRole('button', { name: '快捷命令', exact: true })).toHaveCount(0);
    await expect(rail.getByRole('button', { name: /^隧道/ })).toHaveCount(0);
    await expect(rail.locator('button')).toHaveCount(4);
  };
  try {
    let page = await app.firstWindow();
    await expect(page.getByTestId('runtime-state')).toHaveAttribute('data-state', 'ready');
    const railItems = page.locator('[data-activity-item]');
    await expect(railItems).toHaveCount(4);
    await expectRetiredShortcutsHidden(page);
    await expect
      .poll(() =>
        railItems.evaluateAll((items) =>
          items.map((item) => item.getAttribute('data-activity-item')),
        ),
      )
      .toEqual(['ai', 'newBookmark', 'bookmarks', 'setting']);

    await page.locator('[data-activity-item="setting"]').click();
    const activitySettings = page.locator('.activity-rail-settings');
    await expect(activitySettings).toBeVisible();
    await expect(activitySettings.locator('[data-activity-setting]')).toHaveCount(3);
    await expect(activitySettings.locator('header')).toContainText('3/3');
    await expect(
      activitySettings.locator('[data-activity-setting="bookmarks"]').getByRole('checkbox'),
    ).toHaveCount(0);
    await expect(
      activitySettings.locator(
        '[data-activity-setting="quickConnect"], [data-activity-setting="terminalThemes"], [data-activity-setting="settingSync"], [data-activity-setting="widgets"]',
      ),
    ).toHaveCount(0);
    await expect(
      activitySettings.locator('[data-activity-setting="newBookmark"]').getByRole('checkbox'),
    ).toHaveCount(0);
    const settingShortcut = activitySettings.locator('[data-activity-setting="setting"]');
    const settingCheckbox = settingShortcut.getByRole('checkbox');
    await expect(settingCheckbox).toBeChecked();
    await settingCheckbox.click();
    await expect(settingCheckbox).not.toBeChecked();
    await expect(page.locator('[data-activity-item="setting"]')).toHaveCount(0);
    await expect(page.locator('[data-activity-item="bookmarks"]')).toBeVisible();
    await settingCheckbox.click();
    await expect(settingCheckbox).toBeChecked();
    await expect(page.locator('[data-activity-item="setting"]')).toHaveCount(1);
    await expect(page.locator('[data-activity-item="newBookmark"]')).toBeVisible();
    await settingShortcut.locator('button').first().click();
    await expect
      .poll(() =>
        railItems.evaluateAll((items) =>
          items.map((item) => item.getAttribute('data-activity-item')),
        ),
      )
      .toEqual(['ai', 'newBookmark', 'setting', 'bookmarks']);
    await settingShortcut.locator('button').first().click();
    await expect
      .poll(() =>
        railItems.evaluateAll((items) =>
          items.map((item) => item.getAttribute('data-activity-item')),
        ),
      )
      .toEqual(expectedOrder);

    await expect(page.locator('.activity-bar .activity-new')).toHaveCount(0);
    await page.locator('[data-activity-item="newBookmark"]').click();
    await expect(page.locator('.session-menu')).toHaveCount(0);
    await expect(page.locator('.host-bookmark-modal')).toBeVisible();
    await page.keyboard.press('Escape');

    await openTerminalThemes(page);
    await openQuickCommandsWorkspace(page);
    await openSettingsSync(page);
    await expect(page.locator('.data-sync-panel')).toBeVisible();
    await openWidgets(page);
    await expect(page.locator('[data-activity-item="setting"]')).toHaveClass(/active/);
    await expect(page.locator('.widget-workspace')).toBeVisible();
    await openTunnelsWorkspace(page);
    await expect(
      page.locator('.panel-page').getByRole('heading', { name: '隧道', exact: true }),
    ).toBeVisible();
    await openNewBookmark(page);
    const savedName = '侧栏保存连接';
    const bookmarkDialog = page.locator('.host-bookmark-modal');
    await bookmarkDialog.getByLabel('显示名称').fill(savedName);
    await bookmarkDialog.getByLabel('主机地址').fill('sidebar.example.test');
    await bookmarkDialog.getByLabel('端口', { exact: true }).fill('2222');
    await bookmarkDialog.getByLabel('用户名').fill('operator');
    await bookmarkDialog.getByLabel('认证方式').selectOption('agent');
    await bookmarkDialog.getByRole('button', { name: '保存', exact: true }).click();
    await expect(bookmarkDialog).toBeHidden();
    await expect(page.locator('.app-shell')).toHaveClass(/section-tunnels/);
    await expect(
      page.locator('.workspace-sidebar').getByRole('heading', { name: '隧道', exact: true }),
    ).toBeVisible();
    const bookmarksItem = page.locator('[data-activity-item="bookmarks"]');
    await bookmarksItem.click();
    await expect(page.locator(`[data-bookmark-title="${savedName}"]`)).toBeVisible();

    await bookmarksItem.click();
    await expect(page.locator('.workspace-sidebar')).toBeHidden();
    await bookmarksItem.click();
    await expect(page.locator('.workspace-sidebar')).toBeVisible();
    await expect(bookmarksItem).toHaveClass(/active/);

    await app.close();
    const persistedDatabase = await ProductDatabase.open(
      resolve(userData, 'data-v2', 'axterm.sqlite'),
    );
    try {
      expect(
        new ProductRepository(persistedDatabase)
          .listHosts()
          .find((host) => host.name === savedName),
      ).toMatchObject({
        hostname: 'sidebar.example.test',
        port: 2222,
        username: 'operator',
        authType: 'agent',
      });
    } finally {
      persistedDatabase.close();
    }
    app = await launch();
    page = await app.firstWindow();
    await expect(page.getByTestId('runtime-state')).toHaveAttribute('data-state', 'ready');
    await expect
      .poll(() =>
        page
          .locator('[data-activity-item]')
          .evaluateAll((items) => items.map((item) => item.getAttribute('data-activity-item'))),
      )
      .toEqual(expectedOrder);
    await expectRetiredShortcutsHidden(page);
    await page.locator('[data-activity-item="bookmarks"]').click();
    const savedRow = page.locator(`[data-bookmark-title="${savedName}"]`);
    await expect(savedRow).toBeVisible();
    await savedRow.click({ button: 'right' });
    await page
      .getByRole('menu', { name: '书签操作' })
      .getByRole('menuitem', { name: '编辑', exact: true })
      .click();
    const persistedDialog = page.locator('.host-bookmark-modal');
    await expect(persistedDialog.getByLabel('显示名称')).toHaveValue(savedName);
    await expect(persistedDialog.getByLabel('主机地址')).toHaveValue('sidebar.example.test');
    await expect(persistedDialog.getByLabel('端口', { exact: true })).toHaveValue('2222');
    await expect(persistedDialog.getByLabel('用户名')).toHaveValue('operator');
    await expect(persistedDialog.getByLabel('认证方式')).toHaveValue('password');
    await expect(
      persistedDialog.getByRole('switch', { name: '使用 SSH Agent', exact: true }),
    ).toBeChecked();
    await page.keyboard.press('Escape');
    await openNewBookmark(page);
    await expect(page.locator('.host-bookmark-modal').getByLabel('显示名称')).toHaveValue('');
    await page.keyboard.press('Escape');
    await page.screenshot({ path: test.info().outputPath('activity-rail-cleanup.png') });
    await page.locator('.pane-tabbar-scroll .terminal-tab:visible').first().click();
    const localSessionModes = page.getByRole('tablist', { name: '会话工具' }).first();
    const activeSessionId = await page
      .locator('.pane-tabbar .terminal-tab.active')
      .getAttribute('data-terminal-id');
    await localSessionModes.getByRole('tab', { name: '文件管理' }).click();
    await expect(page.locator('.file-workspace')).toBeVisible();
    await expect(page.locator('.section-tab')).toHaveCount(0);
    await expect(page.locator('.pane-tabbar .terminal-tab.active')).toHaveAttribute(
      'data-terminal-id',
      activeSessionId!,
    );
    await expect(localSessionModes.getByRole('tab', { name: '文件管理' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await expect(
      page.locator('.terminal-session-layer[data-terminal-session]:not([hidden])'),
    ).toHaveCount(0);
    await expect(
      page.locator(`.terminal-file-session-layer[data-file-session="${activeSessionId!}"]`),
    ).toBeVisible();
    await expect(page.getByRole('tab', { name: '文件管理' })).toHaveAttribute(
      'aria-controls',
      `session-files-panel-${activeSessionId!}`,
    );
    await localSessionModes.getByRole('tab', { name: '终端' }).click();
    await expect(page.locator('.file-workspace')).toBeHidden();
    await expect(
      page.locator('.terminal-session-layer[data-terminal-session]:not([hidden])'),
    ).toHaveCount(1);
  } finally {
    await app.close().catch(() => {});
    await rm(userData, { recursive: true, force: true });
  }
});

test('A-03/A-04 new-session menu routes every Quick Connect protocol to its live flow', async () => {
  const userData = await mkdtemp(resolve(tmpdir(), 'axterm-quick-connect-menu-'));
  await mkdir(resolve(userData, 'data-v2'), { recursive: true });
  const seed = await ProductDatabase.open(resolve(userData, 'data-v2', 'axterm.sqlite'));
  try {
    new ProductRepository(seed).createHost({
      name: 'Saved menu host',
      hostname: 'saved.example.test',
      port: 22,
      username: 'operator',
      authType: 'agent',
      favorite: true,
      sshAgent: { enabled: true, path: null },
    });
  } finally {
    seed.close();
  }
  const app = await launchLocalOptimizationApp({
    executablePath,
    args: [resolve('apps/desktop'), `--user-data-dir=${userData}`],
    env: { ...process.env, ELECTRON_RENDERER_URL: '' },
  });
  try {
    const page = await app.firstWindow();
    await expect(page.getByTestId('runtime-state')).toHaveAttribute('data-state', 'ready');
    const openMenu = async () => {
      await page.locator('.tab-add-menu:visible').first().click();
      await expect(page.locator('.session-menu')).toBeVisible();
    };

    await openMenu();
    await expect(page.locator('.session-menu').getByText('Saved menu host')).toBeVisible();
    const initialTabs = await page.locator('.terminal-tab').count();
    await page
      .locator('.session-menu')
      .getByRole('button', { name: /本地终端/ })
      .click();
    await expect(page.locator('.terminal-tab')).toHaveCount(initialTabs + 1);

    const cases = [
      {
        input: 'telnet://operator@telnet.example.test:2323',
        dialog: '添加 Telnet 书签',
        field: 'hostname',
        value: 'telnet.example.test',
      },
      {
        input: 'ftp://ftp-user:session-only@ftp.example.test:2121',
        dialog: '添加 FTP/FTPS 书签',
        field: 'hostname',
        value: 'ftp.example.test',
      },
      {
        input: 'serial:///dev/ttyUSB0?baudRate=9600',
        dialog: '添加串口书签',
        field: 'path',
        value: '/dev/ttyUSB0',
      },
      {
        input: 'rdp://operator@desktop.example.test:3390',
        dialog: '添加 RDP 书签',
        field: 'hostname',
        value: 'desktop.example.test',
      },
      {
        input: 'vnc://viewer:vnc-only@vnc.example.test:5901',
        dialog: '添加 VNC 书签',
        field: 'hostname',
        value: 'vnc.example.test',
      },
      {
        input: 'spice://spice-only:spice.example.test:5902',
        dialog: '添加 SPICE 书签',
        field: 'hostname',
        value: 'spice.example.test',
      },
      {
        input: 'https://console.example.test/docs?title=Console',
        dialog: '添加 Web 书签',
        field: 'url',
        value: 'https://console.example.test/docs?title=Console',
      },
    ] as const;
    for (const item of cases) {
      await openMenu();
      await page.locator('#quick-connect').fill(item.input);
      await page.locator('#quick-connect').press('Enter');
      const dialog = page.getByRole('dialog', { name: item.dialog });
      await expect(dialog).toBeVisible();
      await expect(dialog.locator(`input[name="${item.field}"]`)).toHaveValue(item.value);
      await page.keyboard.press('Escape');
      await expect(dialog).toHaveCount(0);
    }
    expect(
      await page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage })),
    ).not.toContain('session-only');
    await page.screenshot({ path: 'test-results/phase12-quick-connect-menu.png' });
  } finally {
    await app.close().catch(() => {});
    await rm(userData, { recursive: true, force: true });
  }
});

test('B-02/B-05/B-11 protocol bookmarks share the selector, metadata and row actions', async () => {
  const userData = await mkdtemp(resolve(tmpdir(), 'axterm-protocol-bookmark-parity-'));
  const app = await electron.launch({
    executablePath,
    args: [resolve('apps/desktop'), `--user-data-dir=${userData}`],
    env: { ...process.env, ELECTRON_RENDERER_URL: '' },
  });
  try {
    const page = await app.firstWindow();
    await page.evaluate(() => {
      window.confirm = () => true;
    });
    await expect(page.getByTestId('runtime-state')).toHaveAttribute('data-state', 'ready');

    await openNewBookmark(page);
    let shell = page.locator('.host-bookmark-modal');
    await expect(shell).toBeVisible();
    const protocolSelector = shell.locator('.host-bookmark-protocols');
    await expect(protocolSelector.locator('[data-bookmark-protocol]')).toHaveCount(9);
    await expect(protocolSelector.locator('button:enabled')).toHaveCount(9);

    await shell.getByTitle('新建分组').click();
    const group = page.getByRole('dialog', { name: '新建分组' });
    await group.getByLabel('分组名称').fill('协议设备');
    await group.getByRole('button', { name: '选择分组颜色 #2fc7a1' }).click();
    await group.getByLabel('分组描述').fill('非 SSH 连接');
    await group.getByRole('button', { name: '创建' }).click();

    await protocolSelector.locator('[data-bookmark-protocol="ftp"]').click();
    const ftp = page.getByRole('dialog', { name: '添加 FTP/FTPS 书签' });
    await expect(ftp).toBeVisible();
    await ftp.locator('input[name="name"]').fill('归档 FTP');
    await ftp.locator('select[name="groupId"]').selectOption({ label: '协议设备' });
    await ftp.locator('input[name="color"]').fill('#e67e22');
    await ftp.locator('input[name="hostname"]').fill('ftp.example.test');
    await ftp.locator('textarea[name="description"]').fill('夜间归档服务');
    await ftp.getByRole('button', { name: '保存', exact: true }).click();
    await page.keyboard.press('Escape');
    await page.locator('[data-activity-item="bookmarks"]').click();
    await page
      .locator('.workspace-sidebar')
      .getByRole('button', { name: '管理', exact: true })
      .click();
    await expect(page.locator('.host-manager-toolbar')).toBeVisible();

    const ftpCard = page.locator('[data-bookmark-protocol="ftp"]').filter({
      hasText: '归档 FTP',
    });
    await expect(ftpCard).toHaveCount(1);
    await expect(ftpCard).toHaveAttribute('data-bookmark-description', '夜间归档服务');
    await expect(ftpCard.locator('[data-bookmark-color="#e67e22"]')).toHaveCSS(
      'color',
      'rgb(230, 126, 34)',
    );
    await ftpCard.hover();
    await ftpCard.getByRole('button', { name: '编辑' }).click();
    const editFtp = page.getByRole('dialog', { name: '编辑 FTP/FTPS 书签' });
    await expect(editFtp.locator('select[name="groupId"] option:checked')).toHaveText('协议设备');
    await expect(editFtp.locator('input[name="color"]')).toHaveValue('#e67e22');
    await expect(editFtp.locator('textarea[name="description"]')).toHaveValue('夜间归档服务');
    await page.keyboard.press('Escape');

    await ftpCard.hover();
    await ftpCard.getByRole('button', { name: '复制', exact: true }).click();
    const copy = page.locator('[data-bookmark-protocol="ftp"]').filter({
      hasText: '归档 FTP 副本',
    });
    await expect(copy).toHaveCount(1);
    await expect(copy).toHaveAttribute('data-bookmark-description', '夜间归档服务');
    await expect(copy.locator('[data-bookmark-color="#e67e22"]')).toBeVisible();
    await copy.hover();
    await copy.getByRole('button', { name: '删除', exact: true }).click();
    await expect(copy).toHaveCount(0);

    const protocolDialogs = [
      ['telnet', '添加 Telnet 书签'],
      ['serial', '添加串口书签'],
      ['rdp', '添加 RDP 书签'],
      ['vnc', '添加 VNC 书签'],
      ['spice', '添加 SPICE 书签'],
      ['web', '添加 Web 书签'],
    ] as const;
    for (const [protocol, dialogName] of protocolDialogs) {
      await openNewBookmark(page);
      shell = page.locator('.host-bookmark-modal');
      await expect(shell).toBeVisible();
      await shell.locator(`[data-bookmark-protocol="${protocol}"]`).click();
      const dialog = page.getByRole('dialog', { name: dialogName });
      await expect(dialog).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(dialog).toHaveCount(0);
    }

    const tabsBeforeLocal = await page
      .locator('.terminal-tab')
      .evaluateAll((tabs) => new Set(tabs.map((tab) => tab.getAttribute('data-terminal-id'))).size);
    await openNewBookmark(page);
    shell = page.locator('.host-bookmark-modal');
    await shell.locator('[data-bookmark-protocol="local"]').click();
    await expect
      .poll(() =>
        page
          .locator('.terminal-tab')
          .evaluateAll(
            (tabs) => new Set(tabs.map((tab) => tab.getAttribute('data-terminal-id'))).size,
          ),
      )
      .toBe(tabsBeforeLocal + 1);
    await page.screenshot({ path: 'test-results/phase13-protocol-bookmark-actions.png' });
  } finally {
    await app.close().catch(() => {});
  }

  try {
    const database = await ProductDatabase.open(resolve(userData, 'data-v2', 'axterm.sqlite'));
    try {
      const tree = new BookmarkRepository(database).snapshot();
      const group = tree.groups.find(({ name }) => name === '协议设备');
      expect(group).toMatchObject({ color: '#2fc7a1', description: '非 SSH 连接' });
      expect(tree.bookmarks.filter(({ protocol }) => protocol === 'ftp')).toEqual([
        expect.objectContaining({
          groupId: group?.id,
          title: '归档 FTP',
          color: '#e67e22',
          description: '夜间归档服务',
        }),
      ]);
    } finally {
      database.close();
    }
  } finally {
    await rm(userData, { recursive: true, force: true });
  }
});

test('tab number and hover-switch settings persist and apply to the live strip', async () => {
  const userData = await mkdtemp(resolve(tmpdir(), 'axterm-tab-preferences-'));
  const app = await electron.launch({
    executablePath,
    args: [resolve('apps/desktop'), `--user-data-dir=${userData}`],
    env: { ...process.env, ELECTRON_RENDERER_URL: '' },
  });
  try {
    const page = await app.firstWindow();
    await expect(page.getByTestId('runtime-state')).toHaveAttribute('data-state', 'ready');
    const paneTabs = page.locator('.pane-tabbar[data-pane-index="0"] .terminal-tab');
    await page.locator('.terminal-pane.active .tab-add').click();
    await expect(paneTabs).toHaveCount(2);
    await expect(paneTabs.locator('.tab-number')).toHaveText(['1', '2']);
    const firstId = await paneTabs.first().getAttribute('data-terminal-id');
    const secondId = await paneTabs.last().getAttribute('data-terminal-id');
    expect(firstId).toBeTruthy();
    expect(secondId).toBeTruthy();
    await paneTabs.first().hover();
    await expect(
      page.locator(
        `.pane-tabbar[data-pane-index="0"] .terminal-tab[data-terminal-id="${secondId!}"]`,
      ),
    ).toHaveClass(/active/);

    await page.locator('[data-activity-item="setting"]').click();
    await page.locator('[data-settings-category="common"]').click();
    const settingsPanel = page.getByRole('region', { name: '标签行为' });
    const showNumbers = settingsPanel.getByRole('checkbox', { name: '显示会话编号' });
    const hoverSwitch = settingsPanel.getByRole('checkbox', { name: '鼠标悬停时切换标签' });
    await expect(showNumbers).toBeChecked();
    await expect(hoverSwitch).not.toBeChecked();
    // These inputs are controlled by the Runtime response. Use click followed by
    // an assertion so Playwright waits for the authoritative state to arrive.
    await showNumbers.click();
    await expect(showNumbers).not.toBeChecked();
    await expect(page.locator('.pane-tabbar-scroll .tab-number')).toHaveCount(0);
    await hoverSwitch.click();
    await expect(hoverSwitch).toBeChecked();
    await expect(page.locator('.pane-tabbar-scroll .tab-number')).toHaveCount(0);

    const globalFirst = page.locator(
      `.pane-tabbar-scroll .terminal-tab[data-terminal-id="${firstId!}"]`,
    );
    // Hovering switches back to the terminal workspace and replaces this global
    // strip node, so dispatch the pointer transition without Playwright's
    // post-action stability retry against the intentionally detached element.
    await globalFirst.dispatchEvent('mouseover');
    await expect(
      page.locator(
        `.pane-tabbar[data-pane-index="0"] .terminal-tab[data-terminal-id="${firstId!}"]`,
      ),
    ).toHaveClass(/active/);
    await expect(page.locator('.terminal-workspace-layer')).toBeVisible();

    await page.locator('[data-activity-item="bookmarks"]').click();
    await page.locator('[data-activity-item="setting"]').click();
    await page.locator('[data-settings-category="common"]').click();
    await expect(settingsPanel).toBeVisible();
    await page.waitForTimeout(500);
    await page.reload();
    await expect(page.getByTestId('runtime-state')).toHaveAttribute('data-state', 'ready');
    await page.locator('[data-activity-item="setting"]').click();
    await page.locator('[data-settings-category="common"]').click();
    const restoredPanel = page.getByRole('region', { name: '标签行为' });
    await expect(restoredPanel).toBeVisible();
    await expect(restoredPanel.getByRole('checkbox', { name: '显示会话编号' })).not.toBeChecked();
    await expect(restoredPanel.getByRole('checkbox', { name: '鼠标悬停时切换标签' })).toBeChecked();
  } finally {
    await app.close();
    await rm(userData, { recursive: true, force: true });
  }
});

test('cold restart starts one fresh local terminal and retains named workspaces', async () => {
  const userData = await mkdtemp(resolve(tmpdir(), 'axterm-workspace-restart-'));
  let app = await electron.launch({
    executablePath,
    args: [resolve('apps/desktop'), `--user-data-dir=${userData}`],
    env: { ...process.env, ELECTRON_RENDERER_URL: '' },
  });
  try {
    let page = await app.firstWindow();
    await expect(page.getByTestId('runtime-state')).toHaveAttribute('data-state', 'ready');
    for (let index = 0; index < 3; index++)
      await page.locator('.terminal-pane.active .tab-add').click();
    await expect(page.locator('.pane-tabbar[data-pane-index="0"] .terminal-tab')).toHaveCount(4);

    const tabIds = await page
      .locator('.pane-tabbar[data-pane-index="0"] .terminal-tab')
      .evaluateAll((elements) =>
        elements
          .map((element) => element.getAttribute('data-terminal-id'))
          .filter((id): id is string => !!id),
      );
    const activeId = await page
      .locator('.pane-tabbar[data-pane-index="0"] .terminal-tab.active')
      .getAttribute('data-terminal-id');
    expect(activeId).toBeTruthy();
    await page.getByTitle('布局与工作区').click();
    await page.locator('[data-layout-choice="c2x2"]').click();
    const assignableIds = tabIds.filter((id) => id !== activeId);
    for (let paneIndex = 1; paneIndex < 4; paneIndex++)
      await page
        .getByLabel(`为窗格 ${paneIndex + 1} 选择已有会话`)
        .selectOption(assignableIds[paneIndex - 1]!);
    await expect(page.locator('.terminal-host:visible')).toHaveCount(4);

    const restartTab = page.locator('.pane-tabbar[data-pane-index="1"] .terminal-tab').first();
    await restartTab.click({ button: 'right' });
    await page.locator('.tab-context-menu').getByRole('button', { name: '固定标签' }).click();
    await restartTab.click({ button: 'right' });
    await page.locator('.tab-context-menu').getByRole('button', { name: '重命名' }).click();
    await restartTab.locator('.tab-rename').fill('冷启动窗格');
    await restartTab.locator('.tab-rename').press('Enter');

    await page.getByTitle('布局与工作区').click();
    await page.locator('.layout-menu').getByRole('button', { name: '工作区' }).click();
    await page.getByPlaceholder('工作区名称').fill('冷启动工作区');
    await page.locator('.workspace-menu form').getByRole('button', { name: '保存' }).click();
    await expect(page.locator('.workspace-list-menu').getByText('冷启动工作区')).toBeVisible();
    await page.keyboard.press('Escape');
    await page.waitForTimeout(700);
    await app.close();

    app = await electron.launch({
      executablePath,
      args: [resolve('apps/desktop'), `--user-data-dir=${userData}`],
      env: { ...process.env, ELECTRON_RENDERER_URL: '' },
    });
    page = await app.firstWindow();
    await expect(page.getByTestId('runtime-state')).toHaveAttribute('data-state', 'ready');
    await expect(page.locator('.terminal-pane')).toHaveCount(1);
    await expect(page.locator('.pane-tabbar .terminal-tab')).toHaveCount(1);
    await expect(page.locator('.pane-tabbar .terminal-tab.disconnected')).toHaveCount(0);
    await expect(page.locator('.terminal-session-layer:not([hidden]) .terminal-host')).toHaveCount(
      1,
    );
    await expect(
      page.locator('.terminal-session-layer:not([hidden]) .terminal-host'),
    ).toHaveAttribute('data-connection-state', 'connected');
    await expect(page.locator('.pane-tabbar .tab-number')).toHaveText('1');
    for (const terminalId of tabIds)
      await expect(page.locator(`.terminal-tab[data-terminal-id="${terminalId}"]`)).toHaveCount(0);

    await page.getByTitle('布局与工作区').click();
    await page.locator('.layout-menu').getByRole('button', { name: '工作区' }).click();
    await expect(page.locator('.workspace-list-menu').getByText('冷启动工作区')).toBeVisible();
    await page.keyboard.press('Escape');
  } finally {
    await app.close().catch(() => {});
    await rm(userData, { recursive: true, force: true });
  }
});

test('no-session actions and connection history work from the keyboard', async () => {
  const userData = await mkdtemp(resolve(tmpdir(), 'axterm-no-session-keyboard-'));
  const database = await ProductDatabase.open(resolve(userData, 'data-v2', 'axterm.sqlite'));
  try {
    const products = new ProductRepository(database);
    const history = new ConnectionHistoryRepository(database);
    const transient = products.createHost({
      name: '空页面历史',
      hostname: 'recent.example',
      username: 'operator',
      authType: 'agent',
    });
    history.record({ host: transient, persistedHostId: null });
    products.deleteHost(transient.id, etagFor(transient.version));
  } finally {
    database.close();
  }

  const app = await electron.launch({
    executablePath,
    args: [resolve('apps/desktop'), `--user-data-dir=${userData}`],
    env: { ...process.env, ELECTRON_RENDERER_URL: '' },
  });
  try {
    const page = await app.firstWindow();
    await expect(page.getByTestId('runtime-state')).toHaveAttribute('data-state', 'ready');
    await page.locator('.terminal-tab').first().click({ button: 'right' });
    await page.locator('.tab-context-menu').getByRole('button', { name: '关闭全部标签' }).click();
    const empty = page.locator('.no-session-view');
    await expect(empty).toBeVisible();

    const history = empty.getByRole('region', { name: '连接历史' });
    await expect(history.locator('.connection-history-row')).toHaveCount(1);
    await expect(history.getByText('空页面历史', { exact: true })).toBeVisible();
    const frequent = history.getByRole('switch', { name: '按使用频次排序' });
    await frequent.focus();
    await page.keyboard.press('Space');
    await expect(frequent).toBeChecked();
    const deleteHistory = history.getByRole('button', { name: '删除 空页面历史 的连接历史' });
    await deleteHistory.focus();
    await page.keyboard.press('Enter');
    await expect(history.getByText('成功连接 SSH 主机后会显示在这里')).toBeVisible();

    const newBookmark = empty.getByRole('button', { name: '添加已保存连接' });
    await newBookmark.focus();
    await page.keyboard.press('Enter');
    const bookmarkDialog = page.getByRole('dialog', { name: '添加 SSH 主机' });
    await expect(bookmarkDialog).toBeVisible();
    await bookmarkDialog.getByRole('button', { name: '取消' }).click();
    await expect(empty).toBeVisible();

    const newTab = empty.getByRole('button', { name: '新建终端' });
    await newTab.focus();
    await page.keyboard.press('Enter');
    await expect(page.locator('.terminal-host:visible')).toHaveAttribute(
      'data-connection-state',
      'connected',
    );
    await page.locator('.terminal-tab').first().click({ button: 'right' });
    await page.locator('.tab-context-menu').getByRole('button', { name: '关闭全部标签' }).click();
    await expect(empty).toBeVisible();

    const quickConnect = empty.getByRole('button', { name: /不保存直接连接/ });
    await quickConnect.focus();
    await page.keyboard.press('Enter');
    const quickInput = empty.getByLabel('Quick Connect');
    await expect(quickInput).toBeFocused();
    await quickInput.fill('invalid protocol://');
    await quickInput.press('Enter');
    await expect(empty.getByText('格式示例：user@example.com:22')).toBeVisible();

    const aiBookmark = empty.getByRole('button', { name: /使用 AI 草拟连接/ });
    await aiBookmark.focus();
    await page.keyboard.press('Enter');
    await expect(page.locator('.ai-inspector')).toBeVisible();
  } finally {
    await app.close();
    await rm(userData, { recursive: true, force: true });
  }
});

test('tab close and add controls stay beside their tabs while bookmark management remains in the sidebar', async () => {
  const userData = await mkdtemp(resolve(tmpdir(), 'axterm-tab-close-position-e2e-'));
  const app = await electron.launch({
    executablePath,
    args: [resolve('apps/desktop'), `--user-data-dir=${userData}`],
    env: { ...process.env, ELECTRON_RENDERER_URL: '' },
  });
  try {
    const page = await app.firstWindow();
    await expect(page.getByTestId('runtime-state')).toHaveAttribute('data-state', 'ready');
    if (process.env.AXTERM_E2E_HIDDEN_WINDOW === '1')
      expect(
        await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.isVisible()),
      ).toBe(false);
    const paneBar = page.locator('.pane-tabbar[data-pane-index="0"]');
    for (const count of [1, 2]) {
      await expect(paneBar.locator('.terminal-tab')).toHaveCount(count);
      await expect
        .poll(() =>
          paneBar.evaluate((bar) => {
            const tabs = bar.querySelectorAll('.terminal-tab');
            const lastTab = tabs[tabs.length - 1]?.getBoundingClientRect();
            const add = bar.querySelector('.tab-add')?.getBoundingClientRect();
            const menu = bar.querySelector('.tab-add-menu')?.getBoundingClientRect();
            return (
              !!lastTab &&
              !!add &&
              !!menu &&
              add.left >= lastTab.right - 1 &&
              add.left - lastTab.right <= 10 &&
              menu.left >= add.right - 8 &&
              menu.left - add.right <= 8
            );
          }),
        )
        .toBe(true);
      if (count === 1) await paneBar.locator('.tab-add').click();
    }

    const paneClose = paneBar.locator('.pane-tabbar-scroll > .tab-close-active');
    await expect(paneClose).toBeVisible();
    await expect
      .poll(() =>
        paneBar.evaluate((bar) => {
          const tab = bar.querySelector('.terminal-tab.active')?.getBoundingClientRect();
          const close = bar.querySelector('.tab-close-active')?.getBoundingClientRect();
          return !!tab && !!close && close.left >= tab.left && close.right <= tab.right;
        }),
      )
      .toBe(true);
    const inactivePaneTab = paneBar.locator('.terminal-tab:not(.active)').first();
    const inactivePaneTabId = await inactivePaneTab.getAttribute('data-terminal-id');
    expect(inactivePaneTabId).toBeTruthy();
    await inactivePaneTab.hover();
    await expect(inactivePaneTab).toHaveClass(/close-target/u);
    await expect
      .poll(() =>
        paneBar.evaluate((bar) => {
          const tab = bar.querySelector('.terminal-tab.close-target')?.getBoundingClientRect();
          const close = bar.querySelector('.tab-close-active')?.getBoundingClientRect();
          return !!tab && !!close && close.left >= tab.left && close.right <= tab.right;
        }),
      )
      .toBe(true);
    await paneClose.click();
    await expect(page.locator('.pane-tabbar[data-pane-index="0"] .terminal-tab')).toHaveCount(1);
    await expect(
      page.locator(`.terminal-tab[data-terminal-id="${inactivePaneTabId!}"]`),
    ).toHaveCount(0);
    await page.locator('.pane-tabbar[data-pane-index="0"] .tab-add').click();
    await expect(paneBar.locator('.terminal-tab')).toHaveCount(2);

    await page.locator('[data-activity-item="bookmarks"]').click();
    await page.locator('.workspace-sidebar').getByRole('button', { name: '管理' }).click();
    await expect(paneBar.locator('.terminal-tab')).toHaveCount(2);
    const workspaceBar = page.locator('.pane-tabbar-scroll');
    const workspaceClose = workspaceBar.locator(':scope > .tab-close-active');
    await expect(workspaceClose).toBeVisible();
    await expect
      .poll(() =>
        workspaceBar.evaluate((bar) => {
          const tab = bar.querySelector('.terminal-tab.active')?.getBoundingClientRect();
          const close = bar.querySelector('.tab-close-active')?.getBoundingClientRect();
          return !!tab && !!close && close.left >= tab.left && close.right <= tab.right;
        }),
      )
      .toBe(true);
    const inactiveWorkspaceTab = workspaceBar.locator('.terminal-tab:not(.active)').first();
    const inactiveWorkspaceTabId = await inactiveWorkspaceTab.getAttribute('data-terminal-id');
    expect(inactiveWorkspaceTabId).toBeTruthy();
    await inactiveWorkspaceTab.hover();
    await expect(inactiveWorkspaceTab).toHaveClass(/close-target/u);
    await expect
      .poll(() =>
        workspaceBar.evaluate((bar) => {
          const tab = bar.querySelector('.terminal-tab.close-target')?.getBoundingClientRect();
          const close = bar.querySelector('.tab-close-active')?.getBoundingClientRect();
          return !!tab && !!close && close.left >= tab.left && close.right <= tab.right;
        }),
      )
      .toBe(true);
    await workspaceClose.click();
    await expect(page.locator('.pane-tabbar .terminal-tab')).toHaveCount(1);
    await expect(
      page.locator(`.terminal-tab[data-terminal-id="${inactiveWorkspaceTabId!}"]`),
    ).toHaveCount(0);
  } finally {
    await app.close();
    await rm(userData, { recursive: true, force: true });
  }
});

test('pane tabs keep live terminal instances, scrollback and search state across navigation', async () => {
  const userData = await mkdtemp(resolve(tmpdir(), 'axterm-tab-lifecycle-'));
  const app = await electron.launch({
    executablePath,
    args: [resolve('apps/desktop'), `--user-data-dir=${userData}`],
    env: { ...process.env, ELECTRON_RENDERER_URL: '' },
  });
  try {
    const page = await app.firstWindow();
    await expect(page.getByTestId('runtime-state')).toHaveAttribute('data-state', 'ready');
    const firstTab = page.locator('.pane-tabbar[data-pane-index="0"] .terminal-tab.active');
    await expect(firstTab).toHaveCount(1);
    const firstId = await firstTab.getAttribute('data-terminal-id');
    expect(firstId).toBeTruthy();
    const firstLayer = page.locator(`[data-terminal-session="${firstId!}"]`);
    await expect(firstLayer.locator('.terminal-host')).toHaveAttribute(
      'data-connection-state',
      'connected',
    );
    await firstLayer.evaluate((element) => {
      (element as HTMLElement).dataset.instanceProbe = 'original';
    });

    const firstInput = firstLayer.locator('.xterm-helper-textarea');
    await firstInput.pressSequentially("printf '\\nAXTERM_SCROLLBACK_KEEP\\n'");
    await firstInput.press('Enter');
    await firstInput.press(process.platform === 'darwin' ? 'Meta+f' : 'Control+f');
    const firstSearch = firstLayer.getByPlaceholder('查找终端输出');
    await expect
      .poll(async () => {
        await firstSearch.fill('');
        await firstSearch.fill('AXTERM_SCROLLBACK_KEEP');
        return firstLayer.locator('.terminal-search-result').textContent();
      })
      .toBe('已找到');

    const openedSockets: string[] = [];
    page.on('websocket', (socket) => {
      if (socket.url().includes('/api/v1/terminals/')) openedSockets.push(socket.url());
    });
    await page.locator('.pane-tabbar[data-pane-index="0"] .tab-add').click();
    await expect(page.locator('.terminal-session-layer')).toHaveCount(2);
    await expect(
      page.locator('.terminal-session-layer:not([hidden]) .terminal-host'),
    ).toHaveAttribute('data-connection-state', 'connected');
    await expect.poll(() => openedSockets.length).toBe(1);
    await expect(firstLayer).toBeHidden();
    await expect(firstLayer).toHaveAttribute('data-instance-probe', 'original');
    await expect(firstSearch).toHaveValue('AXTERM_SCROLLBACK_KEEP');

    await page
      .locator(`.pane-tabbar[data-pane-index="0"] .terminal-tab[data-terminal-id="${firstId!}"]`)
      .click();
    await expect(firstLayer).toBeVisible();
    await expect(firstLayer).toHaveAttribute('data-instance-probe', 'original');
    await expect(firstSearch).toHaveValue('AXTERM_SCROLLBACK_KEEP');
    await expect(firstLayer.locator('.terminal-search-result')).toHaveText('已找到');
    expect(openedSockets).toHaveLength(1);

    await page.getByTitle('布局与工作区').click();
    await page.locator('[data-layout-choice="c2"]').click();
    await expect(page.locator('.terminal-pane')).toHaveCount(2);
    await expect(firstLayer).toHaveAttribute('data-instance-probe', 'original');
    expect(openedSockets).toHaveLength(1);

    await page.locator('[data-activity-item="bookmarks"]').click();
    await expect(page.locator('.workspace-sidebar')).toBeVisible();
    await expect(firstLayer).toBeVisible();
    await expect(firstLayer).toHaveAttribute('data-instance-probe', 'original');
    await page.locator('.workspace-sidebar').getByRole('button', { name: '管理' }).click();
    await expect(page.locator('.section-tab')).toHaveCount(0);
    await expect(firstLayer).toBeVisible();
    await page.locator(`.pane-tabbar-scroll .terminal-tab[data-terminal-id="${firstId!}"]`).click();
    await expect(firstLayer).toBeVisible();
    await expect(firstSearch).toHaveValue('AXTERM_SCROLLBACK_KEEP');
    expect(openedSockets).toHaveLength(1);

    for (let index = 0; index < 4; index++)
      await page.locator('.pane-tabbar[data-pane-index="0"] .tab-add').click();
    await expect(page.locator('.pane-tabbar[data-pane-index="0"] .terminal-tab')).toHaveCount(6);
    const overflow = page.getByTestId('pane-1-tab-overflow');
    await expect(overflow).toBeVisible();
    const paneScroll = page.locator('.pane-tabbar[data-pane-index="0"] .pane-tabbar-scroll');
    const beforeScroll = await paneScroll.evaluate((element) => element.scrollLeft);
    await overflow.getByTitle('窗格 1 向右滚动标签').click();
    await expect
      .poll(() => paneScroll.evaluate((element) => element.scrollLeft))
      .toBeGreaterThan(beforeScroll);
    await overflow.getByTitle('窗格 1 全部标签').click();
    const allTabs = page.locator('.tab-overflow-menu');
    await expect(allTabs).toBeVisible();
    await expect(allTabs.locator('button')).toHaveCount(6);
    await page.keyboard.press('Escape');

    const lastDisplayed = page.locator('.pane-tabbar[data-pane-index="0"] .terminal-tab').last();
    const pinnedId = await lastDisplayed.getAttribute('data-terminal-id');
    expect(pinnedId).toBeTruthy();
    await lastDisplayed.click({ button: 'right' });
    const contextMenu = page.locator('.tab-context-menu');
    await contextMenu.getByRole('button', { name: '固定标签' }).click();
    await expect(
      page.locator('.pane-tabbar[data-pane-index="0"] .terminal-tab').first(),
    ).toHaveAttribute('data-terminal-id', pinnedId!);
    await page
      .locator(`.pane-tabbar[data-pane-index="0"] .terminal-tab[data-terminal-id="${pinnedId!}"]`)
      .click({ button: 'right' });
    await expect(contextMenu.getByRole('button', { name: /关闭 ⌘W/ })).toBeEnabled();
    await contextMenu.getByRole('button', { name: /关闭 ⌘W/ }).click();
    await expect(page.locator(`[data-terminal-session="${pinnedId!}"]`)).toHaveCount(0);

    const reloadSource = page.locator(
      `.pane-tabbar[data-pane-index="0"] .terminal-tab[data-terminal-id="${firstId!}"]`,
    );
    const reloadTitle = await reloadSource.locator('.tab-title').innerText();
    await reloadSource.click({ button: 'right' });
    await contextMenu.getByRole('button', { name: '固定标签' }).click();
    await reloadSource.click({ button: 'right' });
    const socketsBeforeReload = openedSockets.length;
    const tabsBeforeReload = await page
      .locator('.pane-tabbar[data-pane-index="0"] .terminal-tab')
      .count();
    await contextMenu.getByRole('button', { name: '重新连接会话', exact: true }).click();
    await expect(firstLayer).toHaveCount(0);
    const reloaded = page.locator('.pane-tabbar[data-pane-index="0"] .terminal-tab.active');
    await expect(reloaded).toHaveClass(/pinned/);
    await expect(reloaded.locator('.tab-title')).toHaveText(reloadTitle);
    await expect(
      page.locator('.pane-tabbar[data-pane-index="0"] .terminal-tab').first(),
    ).toHaveClass(/active/);
    await expect(page.locator('.pane-tabbar[data-pane-index="0"] .terminal-tab')).toHaveCount(
      tabsBeforeReload,
    );
    await expect.poll(() => openedSockets.length).toBe(socketsBeforeReload + 1);
    const reloadedId = await reloaded.getAttribute('data-terminal-id');
    expect(reloadedId).toBeTruthy();
    await expect(
      page.locator(`[data-terminal-session="${reloadedId!}"] .terminal-host`),
    ).toHaveAttribute('data-connection-state', 'connected');
  } finally {
    await app.close();
    await rm(userData, { recursive: true, force: true });
  }
});

test('OP07 reviews actual context in four languages and disposes stale drafts and previews', async () => {
  test.setTimeout(120_000);
  const userData = await mkdtemp(resolve(tmpdir(), 'axterm-context-review-e2e-'));
  const attachmentPath = resolve(userData, 'owned-draft.txt');
  await writeFile(attachmentPath, 'DO_NOT_REUSE_ATTACHMENT');
  const requests: string[] = [];
  const secret = 'op07-unlabeled-vault-value';
  const modelServer = createServer((request, response) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk) => (body += String(chunk)));
    request.on('end', () => {
      requests.push(body);
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      response.end(
        'data: {"choices":[{"delta":{"content":"review confirmed","reasoning_content":"HIDDEN_REASONING_CANARY"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
      );
    });
  });
  modelServer.listen(0, '127.0.0.1');
  await once(modelServer, 'listening');
  const address = modelServer.address();
  if (!address || typeof address === 'string') throw new Error('Fixture did not listen');
  const app = await launchLocalOptimizationApp({
    executablePath,
    args: [resolve('apps/desktop'), `--user-data-dir=${userData}`],
    env: { ...process.env, ELECTRON_RENDERER_URL: '' },
  });
  try {
    await app.context().addInitScript({ path: require.resolve('axe-core/axe.min.js') });
    await app.evaluate(({ dialog }, path) => {
      dialog.showOpenDialog = (() =>
        Promise.resolve({ canceled: false, filePaths: [path] })) as typeof dialog.showOpenDialog;
    }, attachmentPath);
    const page = await app.firstWindow();
    await expect(page.getByTestId('runtime-state')).toHaveAttribute('data-state', 'ready');
    await openAiWorkspace(page);
    const provider = page.locator('.ai-provider-form');
    await provider.getByLabel('名称').fill('OP07 local review');
    await provider.getByLabel('基础 URL').fill(`http://127.0.0.1:${address.port}/v1/`);
    await provider.getByLabel('模型').fill('fixture');
    await provider.getByLabel('API Key').fill(secret);
    await provider.getByRole('button', { name: '保存配置' }).click();
    const composer = page.locator('.ai-chat-composer');
    await composer.getByRole('button', { name: '附加文本文件' }).click();
    await expect(composer).toContainText('owned-draft.txt');
    await page
      .locator('.ai-chat-workspace')
      .getByRole('button', { name: '新对话', exact: true })
      .click();
    await expect(composer.locator('.ai-attachment-drafts')).toHaveCount(0);
    expect(requests).toEqual([]);
    const cases = [
      { id: 'en', inspector: 'AI Assistant', title: 'Review AI request', send: 'Send message' },
      { id: 'zh-CN', inspector: 'AI 助手', title: '检查 AI 请求', send: '发送消息' },
      { id: 'zh-TW', inspector: 'AI 助手', title: '檢查 AI 請求', send: '发送讯息' },
      {
        id: 'ja',
        inspector: 'AI アシスタント',
        title: 'AI リクエストを確認',
        send: 'メッセージを送信',
      },
    ];
    for (const locale of cases) {
      await page.locator('[data-activity-item="setting"]').click();
      await page.locator('[data-settings-category="common"]').click();
      await page.getByTestId('application-language').selectOption(locale.id);
      await expect(page.locator('html')).toHaveAttribute('lang', locale.id);
      await page.getByRole('button', { name: locale.inspector, exact: true }).click();
      await expect(composer).toBeVisible();
      await selectAiSkill(composer, 'diagnose');
      // Use the semantic form submit; its visible aria-label is checked by the locale audit.
      await composer
        .locator('textarea')
        .fill(`explicit bounded request ${secret}\npassword=OP07_INPUT_CANARY`);
      await expect(composer.locator('textarea')).toHaveValue(
        `explicit bounded request ${secret}\npassword=OP07_INPUT_CANARY`,
      );
      for (const viewport of [
        { width: 1280, height: 800 },
        { width: 1440, height: 900 },
        { width: 1920, height: 1080 },
      ]) {
        await page.setViewportSize(viewport);
        for (const zoom of [1, 2]) {
          await app.evaluate(
            ({ BrowserWindow }, value) =>
              BrowserWindow.getAllWindows()[0]?.webContents.setZoomFactor(value),
            zoom,
          );
          await composer.evaluate((form) => (form as HTMLFormElement).requestSubmit());
          const review = page.getByRole('dialog', { name: locale.title, exact: true });
          await expect(review).toBeVisible();
          await expect(review).not.toContainText(secret);
          await expect(review).not.toContainText('OP07_INPUT_CANARY');
          await expect(review).not.toContainText('owned-draft.txt');
          await expect(review).toContainText('[REDACTED]');
          expect(
            await review.evaluate((element) => {
              const box = element.getBoundingClientRect();
              return (
                box.left >= 0 &&
                box.top >= 0 &&
                box.right <= innerWidth &&
                box.bottom <= innerHeight
              );
            }),
          ).toBe(true);
          expect(
            await review
              .locator('.ai-review-actions button')
              .evaluateAll((buttons) =>
                buttons.every((button) => button.getBoundingClientRect().height >= 28),
              ),
          ).toBe(true);
          await review.locator('.ai-review-actions button').last().scrollIntoViewIfNeeded();
          expect(
            await review.locator('.ai-review-actions button').evaluateAll((buttons) =>
              buttons.every((button) => {
                const bounds = button.getBoundingClientRect();
                const hit = document.elementFromPoint(
                  bounds.left + bounds.width / 2,
                  bounds.top + bounds.height / 2,
                );
                return hit === button || (!!hit && button.contains(hit));
              }),
            ),
          ).toBe(true);
          if (viewport.width === 1280 && zoom === 1) {
            const violations = await review.evaluate(async (element) => {
              const axe = (
                globalThis as typeof globalThis & {
                  axe: {
                    run(
                      context: Element,
                      options: unknown,
                    ): Promise<{
                      violations: Array<{ id: string; nodes: Array<{ target: string[] }> }>;
                    }>;
                  };
                }
              ).axe;
              const result = await axe.run(element, {
                runOnly: {
                  type: 'tag',
                  values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'],
                },
              });
              return result.violations.map(({ id, nodes }) => ({
                id,
                targets: nodes.map(({ target }) => target),
              }));
            });
            expect(violations).toEqual([]);
          }
          await page.screenshot({
            path: test.info().outputPath(`context-${locale.id}-${viewport.width}-zoom${zoom}.png`),
          });
          await page.keyboard.press('Escape');
          await expect(review).toBeHidden();
        }
      }
      await app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()[0]?.webContents.setZoomFactor(1),
      );
    }
    expect(requests).toEqual([]);
    await page.locator('[data-activity-item="setting"]').click();
    await page.locator('[data-settings-category="common"]').click();
    await page.getByTestId('application-language').selectOption('zh-CN');
    await page.getByRole('button', { name: 'AI 助手', exact: true }).click();
    await selectAiSkill(composer, 'diagnose');
    await composer.locator('textarea').fill('first history message');
    await composer.getByRole('button', { name: '发送消息', exact: true }).click();
    const review = page.getByRole('dialog', { name: '检查 AI 请求' });
    await expect(review).toBeVisible();
    await page.route('**/api/v1/ai/runs', async (route) => {
      if (route.request().method() !== 'POST') {
        await route.continue();
        return;
      }
      const body = route.request().postDataJSON() as Record<string, unknown>;
      await route.continue({
        postData: JSON.stringify({ ...body, reviewReceipt: '0'.repeat(64) }),
      });
    });
    await review.getByRole('button', { name: '确认并发送' }).click();
    await expect(page.getByRole('alert')).toContainText('请重新检查');
    await expect(review).toBeHidden();
    expect(requests).toEqual([]);
    await page.unroute('**/api/v1/ai/runs');
    await composer.getByRole('button', { name: '发送消息', exact: true }).click();
    await expect(review).toBeVisible();
    await review.getByRole('button', { name: '确认并发送' }).evaluate((button) => {
      (button as HTMLButtonElement).click();
      (button as HTMLButtonElement).click();
    });
    await expect(page.locator('.ai-chat-message.assistant')).toContainText('review confirmed');
    expect(requests).toHaveLength(1);
    await composer.locator('textarea').fill('next explicit message');
    await composer.getByLabel('包含最近的对话历史').uncheck();
    await composer.getByRole('button', { name: '发送消息', exact: true }).click();
    await expect(review).not.toContainText('first history message');
    await expect(review).toContainText('next explicit message');
    await page.keyboard.press('Escape');
    let release!: () => void;
    const delayed = new Promise<void>((resolve) => {
      release = resolve;
    });
    let waiting = false;
    await page.route('**/api/v1/ai/context-preview', async (route) => {
      const response = await route.fetch();
      waiting = true;
      await delayed;
      await route.fulfill({ response }).catch(() => undefined);
    });
    await composer.getByRole('button', { name: '发送消息', exact: true }).click();
    await expect.poll(() => waiting).toBe(true);
    await page.locator('[data-activity-item="setting"]').click();
    await expect(composer).toHaveCount(0);
    release();
    await page.unroute('**/api/v1/ai/context-preview');
    await page.getByRole('button', { name: 'AI 助手', exact: true }).click();
    await expect(composer).toBeVisible();
    await expect(review).toBeHidden();
    expect(requests).toHaveLength(1);
    expect(requests[0]).not.toMatch(
      /op07-unlabeled-vault-value|OP07_INPUT_CANARY|DO_NOT_REUSE_ATTACHMENT/u,
    );
    expect(
      await page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage })),
    ).not.toMatch(/op07-unlabeled-vault-value|HIDDEN_REASONING_CANARY|reviewReceipt/u);
  } finally {
    await app.close().catch(() => undefined);
    modelServer.close();
    modelServer.closeAllConnections();
    await once(modelServer, 'close');
    await rm(userData, { recursive: true, force: true });
  }
});
test('I04/I05 explain selection and review generated scripts without silent execution', async () => {
  const userData = await mkdtemp(resolve(tmpdir(), 'axterm-ai-explain-e2e-'));
  const unexecutedPath = resolve(userData, 'i05-must-not-exist');
  const requests: string[] = [];
  const authorizations: string[] = [];
  const modelServer = createServer((request, response) => {
    authorizations.push(String(request.headers.authorization ?? ''));
    if (request.method === 'GET' && request.url === '/v1/models') {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ data: [{ id: 'fixture-model' }] }));
      return;
    }
    if (request.method === 'POST' && request.url === '/v1/chat/completions') {
      let body = '';
      request.setEncoding('utf8');
      request.on('data', (chunk) => (body += String(chunk)));
      request.on('end', () => {
        requests.push(body);
        response.writeHead(200, { 'Content-Type': 'text/event-stream' });
        const content =
          requests.length === 1
            ? 'Selection explained by fixture'
            : `\u0060\u0060\u0060bash\ntouch '${unexecutedPath}'\n\u0060\u0060\u0060`;
        response.write(`data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`);
        response.end('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
      });
      return;
    }
    response.writeHead(404).end();
  });
  modelServer.listen(0, '127.0.0.1');
  await once(modelServer, 'listening');
  const address = modelServer.address();
  if (!address || typeof address === 'string') throw new Error('AI fixture did not listen');
  const app = await launchLocalOptimizationApp({
    executablePath,
    args: [resolve('apps/desktop'), `--user-data-dir=${userData}`],
    env: { ...process.env, ELECTRON_RENDERER_URL: '', SHELL: '/bin/bash' },
  });
  try {
    const page = await app.firstWindow();
    await app.context().grantPermissions(['clipboard-read', 'clipboard-write']);
    await expect(page.getByTestId('runtime-state')).toHaveAttribute('data-state', 'ready');
    await openAiWorkspace(page);
    await expect(page.locator('.ai-inspector')).toBeVisible();

    const providerForm = page.locator('.ai-provider-form');
    await providerForm.getByLabel('名称').fill('I04 Fixture');
    await providerForm.getByLabel('基础 URL').fill(`http://127.0.0.1:${address.port}/v1/`);
    await providerForm.getByLabel('模型').fill('fixture-model');
    await providerForm.getByLabel('API Key').fill('e2e-local-ai-secret');
    await providerForm.getByRole('button', { name: '保存配置' }).click();
    await expect(page.getByText('Provider 已保存，请先测试连接再使用。')).toBeVisible();
    await expect(page.getByRole('dialog', { name: 'AI 配置' })).toBeHidden();

    await page.locator('.terminal-tab').first().click();
    const layer = page.locator('.terminal-session-layer:not([hidden])');
    const input = layer.locator('.xterm-helper-textarea');
    await expect(layer.locator('.terminal-host')).toHaveAttribute(
      'data-connection-state',
      'connected',
    );
    await input.pressSequentially("printf '\\nAXTERM_SHELL_INTEGRATION\\n'");
    await input.press('Enter');
    await expect
      .poll(() => layer.locator('.xterm-rows').textContent())
      .toContain('AXTERM_SHELL_INTEGRATION');
    await input.focus();
    await input.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A');
    await layer.locator('.terminal-surface').click({ button: 'right', position: { x: 40, y: 40 } });
    const menu = page.getByRole('menu', { name: '终端菜单' });
    await expect(menu.getByRole('menuitem', { name: '使用 AI 解释' })).toBeEnabled();
    await menu.getByRole('menuitem', { name: '使用 AI 解释' }).click();

    const chat = page.locator('.ai-chat-workspace');
    await expect(chat).toBeVisible();
    expect(requests).toHaveLength(0);
    await expect(chat.locator('.ai-chat-composer textarea')).toHaveValue(
      /AXTERM_SHELL_INTEGRATION/u,
    );
    await chat.locator('.ai-chat-composer').getByRole('button', { name: '发送消息' }).click();
    const review = page.getByRole('dialog', { name: '检查 AI 请求' });
    await expect(review).toContainText('AXTERM_SHELL_INTEGRATION');
    expect(requests).toHaveLength(0);
    await review.getByRole('button', { name: '确认并发送' }).click();
    await expect(chat.locator('.ai-chat-message.user')).toContainText('AXTERM_SHELL_INTEGRATION');
    await expect(chat.locator('.ai-chat-message.assistant')).toContainText(
      'Selection explained by fixture',
      { timeout: 10_000 },
    );
    expect(requests).toHaveLength(1);
    expect(requests[0]).toContain('AXTERM_SHELL_INTEGRATION');
    expect(authorizations).toContain('Bearer e2e-local-ai-secret');

    await chat.getByRole('button', { name: '新对话', exact: true }).click();
    const composer = chat.locator('.ai-chat-composer');
    await selectAiSkill(composer, 'generate-command');
    await composer.locator('textarea[name="prompt"]').fill('Write a reviewed shell script');
    await composer.getByRole('button', { name: '发送消息' }).click();
    await expect(review).toContainText('Write a reviewed shell script');
    expect(requests).toHaveLength(1);
    await review.getByRole('button', { name: '确认并发送' }).click();
    await expect.poll(() => requests.length).toBe(2);
    const generated = chat.locator('.ai-chat-message.assistant', {
      hasText: 'i05-must-not-exist',
    });
    await expect(generated).toContainText('i05-must-not-exist', { timeout: 10_000 });
    await generated.getByRole('button', { name: '复制代码' }).click();
    await expect(generated.getByRole('status')).toHaveText('代码已复制');
    expect(await page.evaluate(() => navigator.clipboard.readText())).toContain('touch');
    await generated.getByRole('button', { name: '插入终端' }).click();
    await expect(generated.getByRole('status')).toContainText('已插入供审核');
    await expect(readFile(unexecutedPath)).rejects.toThrow();
    expect(requests).toHaveLength(2);
  } finally {
    await app.close().catch(() => undefined);
    modelServer.close();
    await once(modelServer, 'close').catch(() => undefined);
    await rm(userData, { recursive: true, force: true });
  }
});

test('I06 creates an SSH bookmark only after reviewing a secret-free AI draft', async () => {
  const userData = await mkdtemp(resolve(tmpdir(), 'axterm-ai-bookmark-e2e-'));
  const requests: string[] = [];
  const modelServer = createServer((request, response) => {
    if (request.method === 'POST' && request.url === '/v1/chat/completions') {
      let body = '';
      request.setEncoding('utf8');
      request.on('data', (chunk) => (body += String(chunk)));
      request.on('end', () => {
        requests.push(body);
        const draft = {
          name: 'AI staging host',
          title: 'AI staging bookmark',
          hostname: 'staging.example.com',
          port: 2222,
          username: 'deploy',
          authType: 'privateKey',
          description: 'Generated staging connection',
          favorite: true,
        };
        response.writeHead(200, { 'Content-Type': 'text/event-stream' });
        response.write(
          `data: ${JSON.stringify({ choices: [{ delta: { content: JSON.stringify(draft) } }] })}\n\n`,
        );
        response.end('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
      });
      return;
    }
    response.writeHead(404).end();
  });
  modelServer.listen(0, '127.0.0.1');
  await once(modelServer, 'listening');
  const address = modelServer.address();
  if (!address || typeof address === 'string') throw new Error('AI fixture did not listen');
  const app = await electron.launch({
    executablePath,
    args: [resolve('apps/desktop'), `--user-data-dir=${userData}`],
    env: { ...process.env, ELECTRON_RENDERER_URL: '' },
  });
  try {
    const page = await app.firstWindow();
    await expect(page.getByTestId('runtime-state')).toHaveAttribute('data-state', 'ready');
    await openAiWorkspace(page);
    const providerForm = page.locator('.ai-provider-form');
    await providerForm.getByLabel('名称').fill('I06 Fixture');
    await providerForm.getByLabel('基础 URL').fill(`http://127.0.0.1:${address.port}/v1/`);
    await providerForm.getByLabel('模型').fill('fixture-model');
    await providerForm.getByLabel('API Key').fill('i06-application-local-secret');
    await providerForm.getByRole('button', { name: '保存配置' }).click();
    await expect(page.getByText('Provider 已保存，请先测试连接再使用。')).toBeVisible();

    await page.locator('[data-activity-item="bookmarks"]').click();
    await page.locator('.workspace-sidebar').getByRole('button', { name: '管理' }).click();
    await page.getByRole('button', { name: '添加主机' }).click();
    const hostEditor = page.getByRole('dialog', { name: '添加 SSH 主机' });
    await hostEditor.getByRole('button', { name: '使用 AI 创建书签' }).click();

    const dialog = page.getByRole('dialog', { name: '使用 AI 创建 SSH 书签' });
    await expect(dialog.getByText('描述 SSH 目标')).toBeVisible();
    await dialog
      .getByLabel('连接描述')
      .fill('测试环境 staging.example.com，deploy 用户，2222 端口，私钥认证并收藏');
    await dialog.getByRole('button', { name: '生成草稿' }).click();
    await expect(dialog.getByText('检查生成的书签')).toBeVisible({ timeout: 10_000 });
    await expect(dialog.getByLabel('主机地址')).toHaveValue('staging.example.com');
    await expect(dialog.getByLabel('端口')).toHaveValue('2222');
    await page.screenshot({ path: 'test-results/phase20-ai-bookmark-review.png' });
    await dialog.getByLabel('显示名称').fill('已审核的 AI 主机');
    await dialog.getByLabel('书签标题').fill('已审核的 AI 书签');
    await dialog.getByRole('button', { name: '保存书签' }).click();

    await expect(dialog).toHaveCount(0);
    const card = page.locator('.host-card').filter({ hasText: '已审核的 AI 书签' });
    await expect(card).toBeVisible();
    await expect(card).toContainText('deploy@staging.example.com:2222');
    expect(requests).toHaveLength(1);
    expect(requests[0]).toContain('Return only one JSON object for an SSH bookmark');
    expect(requests[0]).toContain('staging.example.com');

    const database = await ProductDatabase.open(resolve(userData, 'data-v2', 'axterm.sqlite'));
    try {
      const products = new ProductRepository(database);
      const host = products.listHosts().find(({ name }) => name === '已审核的 AI 主机');
      expect(host).toMatchObject({
        hostname: 'staging.example.com',
        port: 2222,
        username: 'deploy',
        authType: 'privateKey',
        credentialRef: null,
        passphraseCredentialRef: null,
        certificateCredentialRef: null,
      });
      expect(
        new BookmarkRepository(database)
          .snapshot()
          .bookmarks.find(({ hostId }) => hostId === host?.id),
      ).toMatchObject({ title: '已审核的 AI 书签' });
      expect(JSON.stringify(products.listAiRuns())).not.toMatch(
        /i06-application-local-secret|password|privateKeyPassphrase/u,
      );
    } finally {
      database.close();
    }
  } finally {
    await app.close().catch(() => undefined);
    modelServer.close();
    await once(modelServer, 'close').catch(() => undefined);
    await rm(userData, { recursive: true, force: true });
  }
});

test('I07 previews, discards and explicitly saves a validated AI terminal theme', async () => {
  const userData = await mkdtemp(resolve(tmpdir(), 'axterm-ai-theme-e2e-'));
  const requests: string[] = [];
  const generatedTheme = {
    name: 'AI Ocean',
    terminal: {
      foreground: '#f2f7fa',
      background: '#101820',
      cursor: '#ffffff',
      cursorAccent: '#101820',
      selectionBackground: 'rgba(70, 140, 180, 0.45)',
      black: '#101820',
      red: '#ff6b6b',
      green: '#6bdb9a',
      yellow: '#ffd166',
      blue: '#63a4ff',
      magenta: '#c792ea',
      cyan: '#5eead4',
      white: '#dce7ec',
      brightBlack: '#536471',
      brightRed: '#ff8f8f',
      brightGreen: '#8ce8b2',
      brightYellow: '#ffe29a',
      brightBlue: '#8ebcff',
      brightMagenta: '#dab0f0',
      brightCyan: '#8af3e4',
      brightWhite: '#ffffff',
    },
    ui: {
      main: '#101820',
      'main-dark': '#0a1015',
      'main-light': '#1c2a34',
      text: '#f2f7fa',
      'text-light': '#ffffff',
      'text-dark': '#b7c7d0',
      'text-disabled': '#71818a',
      primary: '#4ea8de',
      info: '#63a4ff',
      success: '#6bdb9a',
      error: '#ff6b6b',
      warn: '#ffd166',
    },
  };
  const modelServer = createServer((request, response) => {
    if (request.method === 'POST' && request.url === '/v1/chat/completions') {
      let body = '';
      request.setEncoding('utf8');
      request.on('data', (chunk) => (body += String(chunk)));
      request.on('end', () => {
        requests.push(body);
        response.writeHead(200, { 'Content-Type': 'text/event-stream' });
        response.write(
          `data: ${JSON.stringify({ choices: [{ delta: { content: JSON.stringify(generatedTheme) } }] })}\n\n`,
        );
        response.end('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
      });
      return;
    }
    response.writeHead(404).end();
  });
  modelServer.listen(0, '127.0.0.1');
  await once(modelServer, 'listening');
  const address = modelServer.address();
  if (!address || typeof address === 'string') throw new Error('AI fixture did not listen');
  const app = await launchLocalOptimizationApp({
    executablePath,
    args: [resolve('apps/desktop'), `--user-data-dir=${userData}`],
    env: { ...process.env, ELECTRON_RENDERER_URL: '' },
  });
  try {
    const page = await app.firstWindow();
    await expect(page.getByTestId('runtime-state')).toHaveAttribute('data-state', 'ready');
    await openAiWorkspace(page);
    const providerForm = page.locator('.ai-provider-form');
    await providerForm.getByLabel('名称').fill('I07 Fixture');
    await providerForm.getByLabel('基础 URL').fill(`http://127.0.0.1:${address.port}/v1/`);
    await providerForm.getByLabel('模型').fill('fixture-model');
    await providerForm.getByLabel('API Key').fill('i07-application-local-secret');
    await providerForm.getByRole('button', { name: '保存配置' }).click();
    await expect(page.getByText('Provider 已保存，请先测试连接再使用。')).toBeVisible();

    await openTerminalThemes(page);
    const workspace = page.locator('.terminal-theme-workspace');
    const list = workspace.getByRole('complementary', { name: '终端主题列表' });

    await workspace.getByRole('tab', { name: 'AI', exact: true }).click();
    await workspace
      .getByLabel('主题描述')
      .fill('深海暗色主题，清晰文字、青色强调和容易区分的 ANSI 调色板');
    await workspace.getByRole('button', { name: '生成预览' }).click();
    await expect(workspace.getByText('未保存的 AI 预览')).toBeVisible({ timeout: 10_000 });
    await expect(workspace.getByLabel('主题名称')).toHaveValue('AI Ocean');
    await expect(workspace.getByLabel('主题预览')).toHaveCSS('background-color', 'rgb(16, 24, 32)');
    await expect(list).not.toContainText('AI Ocean');
    await workspace.getByRole('button', { name: '丢弃预览' }).click();
    await expect(workspace.getByText('已丢弃 AI 主题草稿并恢复之前的主题。')).toBeVisible();
    await expect(list).not.toContainText('AI Ocean');

    await workspace.getByRole('tab', { name: 'AI', exact: true }).click();
    await workspace.getByRole('button', { name: '生成预览' }).click();
    await expect(workspace.getByText('未保存的 AI 预览')).toBeVisible({ timeout: 10_000 });
    await page.screenshot({ path: 'test-results/phase20-ai-theme-preview.png' });
    await workspace.getByLabel('主题名称').fill('I07 reviewed ocean');
    await workspace.getByLabel(/Terminal colors Red|终端颜色 红色/u).fill('#ff7777');
    await workspace.getByRole('button', { name: /Save|保存/u, exact: true }).click();
    await expect(workspace.getByText('主题已保存。')).toBeVisible();
    await expect(list).toContainText('I07 reviewed ocean');
    await expect(workspace.getByText('未保存的 AI 预览')).toHaveCount(0);
    expect(requests).toHaveLength(2);
    expect(requests[0]).toContain('Keep terminal foreground/background');
    expect(requests[0]).toContain('Default');
  } finally {
    await app.close().catch(() => undefined);
    modelServer.close();
    await once(modelServer, 'close').catch(() => undefined);
    await rm(userData, { recursive: true, force: true });
  }
});

test('I08 presents read-only and reviewed mutating tools as complete agent cards', async () => {
  const userData = await mkdtemp(resolve(tmpdir(), 'axterm-ai-tools-e2e-'));
  const rejectedPath = resolve(userData, 'i08-rejected');
  const approvedPath = resolve(userData, 'i08-approved');
  const app = await launchLocalOptimizationApp({
    executablePath,
    args: [resolve('apps/desktop'), `--user-data-dir=${userData}`],
    env: { ...process.env, ELECTRON_RENDERER_URL: '', SHELL: '/bin/bash' },
  });
  try {
    const page = await app.firstWindow();
    await expect(page.getByTestId('runtime-state')).toHaveAttribute('data-state', 'ready');

    await page.locator('[data-activity-item="setting"]').click();
    await page.locator('[data-settings-category="terminal"]').click();
    const profileForm = page
      .locator('form')
      .filter({ has: page.getByRole('heading', { name: '终端配置' }) });
    await profileForm.getByLabel('名称').fill('I08 deterministic shell');
    await profileForm.getByLabel('Shell', { exact: true }).fill('/bin/sh');
    await profileForm.getByLabel('工作目录').fill(userData);
    await profileForm.getByRole('button', { name: '保存终端配置' }).click();
    await page.getByLabel('全局默认终端配置').selectOption({ label: 'I08 deterministic shell' });
    await page.getByRole('button', { name: '关闭设置并返回工作区' }).click();
    await page.getByTitle('新建会话菜单', { exact: true }).click();
    await page
      .locator('.session-menu')
      .getByRole('button', { name: /本地终端/ })
      .click();
    const terminalLayer = page.locator('.terminal-session-layer:not([hidden])');
    await expect(terminalLayer.locator('.terminal-host')).toHaveAttribute(
      'data-connection-state',
      'connected',
    );
    await expect.poll(() => terminalLayer.locator('.xterm-rows').textContent()).toContain('$');
    const terminalId = await terminalLayer.getAttribute('data-terminal-session');
    expect(terminalId).toBeTruthy();

    await openAiWorkspace(page);

    const providerForm = page.locator('.ai-provider-form');
    await providerForm.getByLabel('名称').fill('I08 Local Tool Fixture');
    await providerForm.getByLabel('基础 URL').fill('http://127.0.0.1:9/v1/');
    await providerForm.getByLabel('模型').fill('fixture-tool-model');
    await providerForm.getByLabel('API Key').fill('i08-application-local-secret');
    await providerForm.getByRole('button', { name: '保存配置' }).click();
    await expect(page.getByText('Provider 已保存，请先测试连接再使用。')).toBeVisible();

    await expect(page.locator('.approval-proposal')).toHaveCount(0);
    // Preserve legacy/MCP tool-card coverage through the public REST boundary;
    // assistant composition now uses only two modes and mentioned skills.
    const propose = async (name: string, args: Record<string, unknown>) =>
      page.evaluate(
        async (tool) => {
          const bootstrap = await window.desktopBootstrap.resolve();
          const auth = await fetch(new URL('/api/v1/auth/bootstrap', bootstrap.baseUrl), {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'X-Runtime-Generation': bootstrap.generation,
            },
            body: JSON.stringify({ bootstrapToken: bootstrap.bootstrapToken }),
          });
          if (!auth.ok) throw new Error('Tool fixture bootstrap failed');
          const credentials = (await auth.json()) as { sessionToken: string };
          const headers = {
            Authorization: `Bearer ${credentials.sessionToken}`,
            'X-Runtime-Generation': bootstrap.generation,
            'Content-Type': 'application/json',
          };
          const response = await fetch(new URL('/api/v1/ai/models', bootstrap.baseUrl), {
            headers,
          });
          const models = (await response.json()) as Array<{ id: string }>;
          const run = await fetch(new URL('/api/v1/ai/runs', bootstrap.baseUrl), {
            method: 'POST',
            headers: { ...headers, 'Idempotency-Key': crypto.randomUUID() },
            body: JSON.stringify({
              modelId: models[0]!.id,
              useCase: 'diagnose',
              prompt: 'Explicit test tool request',
              tool,
            }),
          });
          if (!run.ok) throw new Error('Tool fixture proposal failed');
        },
        { name, args, target: terminalId! },
      );
    await propose('terminal.getRecentOutput', {});
    const cards = page.getByRole('region', { name: 'Agent 工具活动' });
    const readOnlyCard = cards.locator('.agent-tool-card').filter({
      hasText: 'terminal.getRecentOutput',
    });
    await expect(readOnlyCard).toContainText('已完成');
    await expect(readOnlyCard).toContainText('只读');
    await expect(readOnlyCard.locator('.agent-tool-card-header small')).toHaveText(terminalId!);
    await readOnlyCard.locator('.agent-tool-card-header').click();
    await expect(readOnlyCard).toContainText('$');

    await propose('terminal.exec', { command: `printf I08_REJECTED > '${rejectedPath}'` });
    const rejectedCard = cards.locator('.agent-tool-card').filter({ hasText: 'I08_REJECTED' });
    await expect(rejectedCard).toContainText('等待审批');
    await expect(rejectedCard).toContainText('会修改');
    await expect(rejectedCard).toContainText('精确参数哈希');
    await expect(readFile(rejectedPath)).rejects.toThrow();
    await rejectedCard.scrollIntoViewIfNeeded();
    await page.screenshot({ path: 'test-results/phase20-agent-tool-card.png' });
    await rejectedCard.getByRole('button', { name: '拒绝' }).click();
    await expect(rejectedCard).toContainText('已取消');
    await expect(rejectedCard).toContainText('已拒绝');
    await expect(readFile(rejectedPath)).rejects.toThrow();

    await propose('terminal.exec', { command: `printf I08_APPROVED > '${approvedPath}'` });
    const approvedCard = cards.locator('.agent-tool-card').filter({ hasText: 'I08_APPROVED' });
    await expect(approvedCard).toContainText('等待审批');
    await approvedCard.getByRole('button', { name: '仅运行一次' }).click();
    await expect(approvedCard).toContainText('已完成');
    await expect(approvedCard).toContainText('已单次批准');
    await expect(approvedCard).toContainText('"inserted": true');

    await page.locator('.terminal-tab').first().click();
    await expect
      .poll(async () => readFile(approvedPath, 'utf8').catch(() => ''))
      .toBe('I08_APPROVED');
    await expect(readFile(rejectedPath)).rejects.toThrow();
    expect(
      await page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage })),
    ).not.toContain('i08-application-local-secret');
  } finally {
    await app.close().catch(() => undefined);
    await rm(userData, { recursive: true, force: true });
  }
});

test('I09 previews and explicitly sends bounded redacted text attachments', async () => {
  const userData = await mkdtemp(resolve(tmpdir(), 'axterm-ai-attachment-e2e-'));
  const attachmentDirectory = await mkdtemp(resolve(tmpdir(), 'axterm-ai-attachment-files-'));
  const removedPath = resolve(attachmentDirectory, 'removed.txt');
  const includedPath = resolve(attachmentDirectory, 'diagnostic.txt');
  await writeFile(removedPath, 'DO_NOT_SEND_ATTACHMENT');
  await writeFile(
    includedPath,
    `password=i09-file-secret\n${'diagnostic line for review\n'.repeat(2_500)}`,
  );
  const requests: string[] = [];
  const modelServer = createServer((request, response) => {
    if (request.method === 'POST' && request.url === '/v1/chat/completions') {
      let body = '';
      request.setEncoding('utf8');
      request.on('data', (chunk) => (body += String(chunk)));
      request.on('end', () => {
        requests.push(body);
        response.writeHead(200, { 'Content-Type': 'text/event-stream' });
        response.write(
          `data: ${JSON.stringify({ choices: [{ delta: { content: 'Attachment reviewed safely' } }] })}\n\n`,
        );
        response.end('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
      });
      return;
    }
    response.writeHead(404).end();
  });
  modelServer.listen(0, '127.0.0.1');
  await once(modelServer, 'listening');
  const address = modelServer.address();
  if (!address || typeof address === 'string') throw new Error('AI fixture did not listen');
  const app = await launchLocalOptimizationApp({
    executablePath,
    args: [resolve('apps/desktop'), `--user-data-dir=${userData}`],
    env: { ...process.env, ELECTRON_RENDERER_URL: '' },
  });
  try {
    await app.evaluate(
      ({ dialog }, paths) => {
        const queue = [...paths];
        dialog.showOpenDialog = (() =>
          Promise.resolve({
            canceled: false,
            filePaths: [queue.shift()!],
          })) as typeof dialog.showOpenDialog;
      },
      [removedPath, includedPath],
    );
    const page = await app.firstWindow();
    await expect(page.getByTestId('runtime-state')).toHaveAttribute('data-state', 'ready');
    await openAiWorkspace(page);
    const providerForm = page.locator('.ai-provider-form');
    await providerForm.getByLabel('名称').fill('I09 Attachment Fixture');
    await providerForm.getByLabel('基础 URL').fill(`http://127.0.0.1:${address.port}/v1/`);
    await providerForm.getByLabel('模型').fill('fixture-model');
    await providerForm.getByLabel('API Key').fill('i09-provider-secret');
    await providerForm.getByRole('button', { name: '保存配置' }).click();
    await expect(page.getByText('Provider 已保存，请先测试连接再使用。')).toBeVisible();

    const composer = page.locator('.ai-chat-composer');
    await composer.getByRole('button', { name: '附加文本文件' }).click();
    await expect(composer.getByText('removed.txt')).toBeVisible();
    await expect(composer.getByText('将发送给 AI 的内容')).toBeVisible();
    await composer.getByRole('button', { name: '移除附件 removed.txt' }).click();
    await expect(composer.getByText('removed.txt')).toHaveCount(0);

    await composer.getByRole('button', { name: '附加文本文件' }).click();
    await expect(composer.getByText('diagnostic.txt')).toBeVisible();
    await expect(composer.getByText('已截断')).toBeVisible();
    await expect(composer.getByText('已脱敏', { exact: true })).toBeVisible();
    const preview = composer.locator('.ai-attachment-preview');
    await expect(preview).toContainText('password=[REDACTED]');
    await expect(preview).not.toContainText('i09-file-secret');
    await page.screenshot({ path: 'test-results/phase20-ai-attachment-preview.png' });

    await composer.locator('textarea[name="prompt"]').fill('Review this diagnostic attachment');
    await composer.getByRole('button', { name: '发送消息' }).click();
    const review = page.getByRole('dialog', { name: '检查 AI 请求' });
    await expect(review).toContainText('Review this diagnostic attachment');
    await expect(review).toContainText('diagnostic.txt');
    await review.getByText('上下文与附件', { exact: true }).click();
    await expect(review).toContainText('password=[REDACTED]');
    await expect(review).not.toContainText('i09-file-secret');
    expect(requests).toHaveLength(0);
    await review.getByRole('button', { name: '确认并发送' }).click();
    const chat = page.locator('.ai-chat-workspace');
    const userMessage = chat.locator('.ai-chat-message.user').filter({ hasText: 'diagnostic.txt' });
    await expect(userMessage).toContainText('Review this diagnostic attachment');
    await expect(userMessage).toContainText('已截断');
    await expect(chat.locator('.ai-chat-message.assistant')).toContainText(
      'Attachment reviewed safely',
      { timeout: 10_000 },
    );
    await expect(composer.locator('.ai-attachment-drafts')).toHaveCount(0);
    await expect(composer.locator('.ai-attachment-preview')).toHaveCount(0);
    expect(requests).toHaveLength(1);
    expect(requests[0]).toContain('diagnostic.txt');
    expect(requests[0]).toContain('password=[REDACTED]');
    expect(requests[0]).toContain('...[truncated]');
    expect(requests[0]).not.toMatch(/i09-file-secret|DO_NOT_SEND_ATTACHMENT/u);

    // A native dialog cannot be aborted by fetch; its late grant still belongs to this operation.
    const releasedNativeGrants = new Set<string>();
    const lateNativeGrants: string[] = [];
    page.on('response', async (response) => {
      const pathname = new URL(response.url()).pathname;
      if (
        pathname === '/api/v1/file-grants' &&
        response.request().method() === 'POST' &&
        response.ok()
      ) {
        const value = (await response.json().catch(() => undefined)) as
          { grantId?: string } | undefined;
        if (value?.grantId) lateNativeGrants.push(value.grantId);
      }
      const match = /\/api\/v1\/file-grants\/([^/]+)$/u.exec(pathname);
      if (match && response.request().method() === 'DELETE' && response.ok())
        releasedNativeGrants.add(decodeURIComponent(match[1]!));
    });
    await app.evaluate(({ dialog }) => {
      const pending: Array<(path: string) => void> = [];
      Object.defineProperty(globalThis, '__op06AttachmentSelections', {
        configurable: true,
        value: pending,
      });
      dialog.showOpenDialog = (() =>
        new Promise((resolve) =>
          pending.push((path) => resolve({ canceled: false, filePaths: [path] })),
        )) as typeof dialog.showOpenDialog;
    });
    const nativeCount = () =>
      app.evaluate(
        () =>
          (globalThis as typeof globalThis & { __op06AttachmentSelections: unknown[] })
            .__op06AttachmentSelections.length,
      );
    const releaseNative = (index: number) =>
      app.evaluate(
        (_electron, value) => {
          (
            globalThis as typeof globalThis & {
              __op06AttachmentSelections: Array<(path: string) => void>;
            }
          ).__op06AttachmentSelections[value.index]!(value.path);
        },
        { index, path: includedPath },
      );
    await composer.getByRole('button', { name: '附加文本文件' }).click();
    await expect.poll(nativeCount).toBe(1);
    await composer.getByRole('button', { name: '取消', exact: true }).click();
    await expect(composer.getByRole('button', { name: '附加文本文件' })).toBeEnabled();
    await releaseNative(0);
    await expect.poll(() => lateNativeGrants.length).toBe(1);
    await expect.poll(() => releasedNativeGrants.has(lateNativeGrants[0]!)).toBe(true);
    await expect(composer.locator('.ai-attachment-drafts')).toHaveCount(0);
    await composer.getByRole('button', { name: '附加文本文件' }).click();
    await expect.poll(nativeCount).toBe(2);
    await openTunnelsWorkspace(page);
    await expect(composer).toHaveCount(0);
    await releaseNative(1);
    await expect.poll(() => lateNativeGrants.length).toBe(2);
    await expect.poll(() => releasedNativeGrants.has(lateNativeGrants[1]!)).toBe(true);
    expect(requests).toHaveLength(1);

    const database = await ProductDatabase.open(resolve(userData, 'data-v2', 'axterm.sqlite'));
    try {
      const row = database.get<{ request: string }>(
        'SELECT request FROM ai_runs ORDER BY created_at DESC LIMIT 1',
      );
      expect(row?.request).toContain('diagnostic.txt');
      expect(row?.request).not.toMatch(/i09-file-secret|diagnostic line|grantId|DO_NOT_SEND/u);
    } finally {
      database.close();
    }
    expect(
      await page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage })),
    ).not.toMatch(/i09-file-secret|i09-provider-secret/u);
  } finally {
    await app.close().catch(() => undefined);
    modelServer.close();
    await once(modelServer, 'close').catch(() => undefined);
    await Promise.allSettled([
      rm(userData, { recursive: true, force: true }),
      rm(attachmentDirectory, { recursive: true, force: true }),
    ]);
  }
});

test('bookmark tree creates, searches and moves saved SSH destinations', async () => {
  const userData = await mkdtemp(resolve(tmpdir(), 'axterm-bookmark-tree-'));
  const app = await electron.launch({
    executablePath,
    args: [resolve('apps/desktop'), `--user-data-dir=${userData}`],
    env: { ...process.env, ELECTRON_RENDERER_URL: '' },
  });
  try {
    const page = await app.firstWindow();
    const pageErrors: string[] = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));
    await expect(page.getByTestId('runtime-state')).toHaveAttribute('data-state', 'ready');
    await page.locator('[data-activity-item="bookmarks"]').click();

    await page.getByRole('button', { name: '新建顶级分组' }).click();
    const createGroupDialog = page.getByRole('dialog', { name: '新建分组' });
    await createGroupDialog.getByRole('button', { name: '创建' }).click();
    await expect(createGroupDialog.getByText('请输入分组名称。')).toBeVisible();
    await createGroupDialog.getByLabel('分组名称').fill('生产');
    await createGroupDialog.getByRole('button', { name: '选择分组颜色 #2fc7a1' }).click();
    await createGroupDialog.getByLabel('分组描述').fill('核心生产环境');
    await createGroupDialog.getByRole('button', { name: '创建' }).click();
    const createdProduction = page.getByRole('treeitem', { name: '生产' });
    await expect(createdProduction).toBeVisible();
    await expect(createdProduction).toHaveAttribute('title', '生产 - 核心生产环境');
    await expect(createdProduction.locator('.bookmark-group-color')).toHaveCSS(
      'background-color',
      'rgb(47, 199, 161)',
    );
    await page.getByRole('button', { name: '新建顶级分组' }).click();
    await page.getByRole('dialog').getByLabel('分组名称').fill('归档');
    await page.getByRole('dialog').getByRole('button', { name: '创建' }).click();
    await expect(page.getByRole('treeitem', { name: '归档' })).toBeVisible();

    await page.locator('.workspace-sidebar').getByRole('button', { name: '管理' }).click();
    await page.getByRole('button', { name: '添加主机' }).click();
    const createBookmarkDialog = page.getByRole('dialog', { name: '添加 SSH 主机' });
    const bookmarkTabs = createBookmarkDialog.getByRole('tablist', { name: 'SSH 书签设置' });
    await expect(bookmarkTabs.getByRole('tab', { name: '认证' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await bookmarkTabs.getByRole('tab', { name: '跳板机' }).click();
    await expect(createBookmarkDialog.getByLabel('添加跳板机')).toBeVisible();
    await expect(createBookmarkDialog.getByLabel('显示名称')).toBeHidden();
    await bookmarkTabs.getByRole('tab', { name: '认证' }).focus();
    await page.keyboard.press('ArrowRight');
    await expect(bookmarkTabs.getByRole('tab', { name: '设置' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await expect(createBookmarkDialog.getByLabel('分组', { exact: true })).toBeVisible();
    await bookmarkTabs.getByRole('tab', { name: '认证' }).click();
    await expect(createBookmarkDialog.getByLabel('密码', { exact: true })).toBeVisible();
    await createBookmarkDialog.getByLabel('认证方式').selectOption('privateKey');
    await expect(createBookmarkDialog.getByLabel('私钥', { exact: true })).toBeVisible();
    await expect(createBookmarkDialog.getByLabel('私钥口令')).toBeVisible();
    await createBookmarkDialog.getByLabel('显示名称').fill('连续新建主机');
    await createBookmarkDialog.getByLabel('主机地址').fill('new.example.test');
    await createBookmarkDialog.getByLabel('用户名').fill('batch');
    await createBookmarkDialog.getByLabel('认证方式').selectOption('agent');
    await bookmarkTabs.getByRole('tab', { name: '设置' }).click();
    await createBookmarkDialog.getByLabel('分组', { exact: true }).selectOption({ label: '归档' });
    await createBookmarkDialog.getByRole('button', { name: '保存并新建' }).click();
    await expect(createBookmarkDialog).toBeVisible();
    await expect(bookmarkTabs.getByRole('tab', { name: '认证' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await expect(createBookmarkDialog.getByLabel('显示名称')).toHaveValue('');
    await createBookmarkDialog.getByLabel('显示名称').fill('应丢弃的草稿');
    await bookmarkTabs.getByRole('tab', { name: '设置' }).click();
    await createBookmarkDialog.getByRole('button', { name: '取消' }).click();
    await expect(
      page.locator('.host-card').getByText('连续新建主机', { exact: true }),
    ).toBeVisible();

    await page.getByRole('button', { name: '添加主机' }).click();
    const newHostDialog = page.getByRole('dialog', { name: '添加 SSH 主机' });
    await expect(newHostDialog.getByRole('tab', { name: '认证' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await expect(newHostDialog.getByLabel('显示名称')).toHaveValue('');
    await page.getByLabel('显示名称').fill('树内主机');
    await page.getByLabel('主机地址').fill('127.0.0.1');
    await page.getByLabel('用户名').fill('fixture');
    await page.getByLabel('认证方式').selectOption('agent');
    await newHostDialog.getByRole('tab', { name: '设置' }).click();
    await page.locator('.modal select[name="groupId"]').selectOption({ label: '生产' });
    await newHostDialog.getByLabel('连接超时（毫秒）').fill('999');
    await newHostDialog.getByRole('tab', { name: '认证' }).click();
    await newHostDialog.getByRole('button', { name: '保存', exact: true }).click();
    await expect(newHostDialog.getByRole('tab', { name: '设置' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await expect(newHostDialog).toBeVisible();
    await newHostDialog.getByLabel('连接超时（毫秒）').fill('23000');
    await newHostDialog.getByLabel('保活间隔（毫秒）').fill('7000');
    await newHostDialog.getByLabel('保活失败上限').fill('4');
    await newHostDialog.getByLabel('重连策略').selectOption('automatic');
    await newHostDialog.getByLabel('重连等待（毫秒）').fill('750');
    await newHostDialog.getByLabel('最大重连次数').fill('3');
    await newHostDialog.getByLabel('启用 SSH 压缩').uncheck();
    await page.getByRole('button', { name: '保存', exact: true }).click();
    await page.locator('.bookmark-manager-back').click();

    const production = page.getByRole('treeitem', { name: '生产' });
    await production.locator('.bookmark-row-main').click();
    const bookmark = page.getByRole('treeitem', { name: /^树内主机/ });
    await expect(bookmark).toBeVisible();
    await expect(bookmark).toHaveAttribute('aria-level', '2');

    const search = page.getByRole('textbox', { name: '搜索书签' });
    await search.fill('127.0.0.1');
    await expect(page.locator('.bookmark-tree-row mark')).toHaveText('127.0.0.1');
    await expect(page.locator('.workspace-sidebar').getByRole('status')).toHaveText('1 个匹配');
    await expect(bookmark).toHaveAttribute('aria-selected', 'false');
    await search.press('ArrowDown');
    await expect(bookmark).toHaveAttribute('aria-selected', 'true');
    await search.press('Escape');
    await expect(search).toHaveValue('');

    const archive = page.getByRole('treeitem', { name: '归档' });
    await bookmark.dragTo(archive, { targetPosition: { x: 45, y: 15 } });
    await expect(bookmark).toHaveCount(0);
    await archive.locator('.bookmark-row-main').click();
    await expect(page.getByRole('treeitem', { name: /^树内主机/ })).toHaveAttribute(
      'aria-level',
      '2',
    );
    await archive.hover();
    await page.getByRole('button', { name: '重命名 归档' }).click();
    const renameDialog = page.getByRole('dialog', { name: '重命名分组' });
    await renameDialog.getByLabel('分组名称').fill('归档区');
    await renameDialog.getByRole('button', { name: '保存' }).click();
    await expect(page.getByRole('treeitem', { name: '归档区' })).toBeVisible();

    const movedBookmark = page.locator('[data-bookmark-title="树内主机"]');
    await movedBookmark.click({ button: 'right' });
    const bookmarkMenu = page.getByRole('menu', { name: '书签操作' });
    await expect(bookmarkMenu.getByRole('menuitem', { name: '连接' })).toBeVisible();
    await expect(bookmarkMenu.getByRole('menuitem', { name: '编辑' })).toBeVisible();
    await expect(bookmarkMenu.getByRole('menuitem', { name: '复制' })).toBeVisible();
    await expect(bookmarkMenu.getByRole('menuitem', { name: '删除' })).toBeVisible();
    await bookmarkMenu.getByRole('menuitem', { name: '复制' }).click();
    const duplicatedBookmark = page.locator('[data-bookmark-title="树内主机 副本"]');
    await expect(duplicatedBookmark).toBeVisible();

    await page.getByRole('button', { name: '书签排序' }).click();
    const sortMenu = page.getByRole('menu', { name: '书签排序方式' });
    const titleSort = sortMenu.getByRole('menuitem').filter({ hasText: '标题' });
    await titleSort.click();
    const bookmarkTitles = page.locator('.bookmark-tree-row[data-bookmark-title]');
    const ascending = await bookmarkTitles.evaluateAll((rows) =>
      rows.map((row) => row.getAttribute('data-bookmark-title')),
    );
    await titleSort.click();
    await expect
      .poll(() =>
        bookmarkTitles.evaluateAll((rows) =>
          rows.map((row) => row.getAttribute('data-bookmark-title')),
        ),
      )
      .toEqual([...ascending].reverse());
    await titleSort.click();

    await movedBookmark.click({ button: 'right', position: { x: 60, y: 13 } });
    await bookmarkMenu.getByRole('menuitem', { name: '编辑' }).click();
    const editDialog = page.getByRole('dialog', { name: '编辑 SSH 主机' });
    await editDialog.getByRole('tab', { name: '设置' }).click();
    await editDialog.getByLabel('书签标题').fill('树内主机更新');
    await expect(editDialog.getByLabel('连接超时（毫秒）')).toHaveValue('23000');
    await expect(editDialog.getByLabel('保活间隔（毫秒）')).toHaveValue('7000');
    await expect(editDialog.getByLabel('保活失败上限')).toHaveValue('4');
    await expect(editDialog.getByLabel('重连策略')).toHaveValue('automatic');
    await expect(editDialog.getByLabel('重连等待（毫秒）')).toHaveValue('750');
    await expect(editDialog.getByLabel('最大重连次数')).toHaveValue('3');
    await expect(editDialog.getByLabel('启用 SSH 压缩')).not.toBeChecked();
    await editDialog.getByLabel('标题颜色').fill('#22aa66');
    await editDialog.getByLabel('描述').fill('由书签行编辑并移动');
    await editDialog.getByLabel('分组', { exact: true }).selectOption({ label: '生产' });
    await editDialog.getByLabel('连接超时（毫秒）').fill('31000');
    await editDialog.getByLabel('启用 SSH 压缩').check();
    await editDialog.getByRole('button', { name: '保存', exact: true }).click();
    await expect(editDialog).toHaveCount(0);
    await page.locator('.bookmark-manager-back').click();
    const updatedBookmark = page.locator('[data-bookmark-title="树内主机更新"]');
    await expect(updatedBookmark).toBeVisible();
    await expect(updatedBookmark).toHaveAttribute('title', /由书签行编辑并移动/);
    await expect(updatedBookmark.locator('.bookmark-color')).toHaveCSS(
      'background-color',
      'rgb(34, 170, 102)',
    );

    await updatedBookmark.click({ button: 'right' });
    await bookmarkMenu.getByRole('menuitem', { name: '编辑' }).click();
    const persistedDialog = page.getByRole('dialog', { name: '编辑 SSH 主机' });
    await persistedDialog.getByRole('tab', { name: '设置' }).click();
    await expect(persistedDialog.getByLabel('连接超时（毫秒）')).toHaveValue('31000');
    await expect(persistedDialog.getByLabel('保活间隔（毫秒）')).toHaveValue('7000');
    await expect(persistedDialog.getByLabel('重连策略')).toHaveValue('automatic');
    await expect(persistedDialog.getByLabel('启用 SSH 压缩')).toBeChecked();
    await persistedDialog.getByRole('button', { name: '取消' }).click();
    await page.locator('.bookmark-manager-back').click();

    await duplicatedBookmark.click({ button: 'right' });
    page.once('dialog', (dialog) => dialog.accept());
    await bookmarkMenu.getByRole('menuitem', { name: '删除' }).click();
    await expect(duplicatedBookmark).toHaveCount(0);
    await expect(updatedBookmark).toBeVisible();
    expect(pageErrors).toEqual([]);
  } finally {
    await app.close();
    await rm(userData, { recursive: true, force: true });
  }
});

test('RDP bookmarks retain protocol UX without exposing the saved password', async () => {
  const userData = await mkdtemp(resolve(tmpdir(), 'axterm-rdp-bookmark-ui-'));
  const app = await electron.launch({
    executablePath,
    args: [resolve('apps/desktop'), `--user-data-dir=${userData}`],
    env: { ...process.env, ELECTRON_RENDERER_URL: '' },
  });
  try {
    const page = await app.firstWindow();
    const pageErrors: string[] = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));
    await expect(page.getByTestId('runtime-state')).toHaveAttribute('data-state', 'ready');
    await page.locator('[data-activity-item="bookmarks"]').click();
    await page.locator('.workspace-sidebar').getByRole('button', { name: '管理' }).click();
    await page.getByRole('button', { name: '添加 RDP' }).click();

    const dialog = page.getByRole('dialog', { name: '添加 RDP 书签' });
    await dialog.getByLabel('名称').fill('Windows QA');
    await dialog.getByLabel('主机').fill('windows.example.test');
    await dialog.getByLabel('用户名').fill('qa-user');
    await dialog.getByLabel('密码').fill('rdp-test-secret');
    await dialog.getByLabel('域').fill('LAB');
    await dialog.getByLabel('代理').selectOption('direct');
    await dialog.getByLabel('桌面宽度').fill('1440');
    await dialog.getByLabel('桌面高度').fill('900');
    await dialog.getByLabel('缩放适应窗口').check();
    await dialog.getByRole('button', { name: '保存', exact: true }).click();
    await expect(dialog).toHaveCount(0);

    const card = page.locator('.host-card').filter({ hasText: 'Windows QA' });
    await expect(card).toContainText('qa-user@windows.example.test:3389');
    await expect(card).toContainText('RDP · 1440×900 · LAB');
    await expect(page.getByText('rdp-test-secret')).toHaveCount(0);
    await card.getByRole('button', { name: '编辑' }).click();
    const edit = page.getByRole('dialog', { name: '编辑 RDP 书签' });
    await expect(edit.getByLabel('主机')).toHaveValue('windows.example.test');
    await expect(edit.getByLabel('域')).toHaveValue('LAB');
    await expect(edit.getByLabel('代理')).toHaveValue('direct');
    await expect(edit.getByLabel('桌面宽度')).toHaveValue('1440');
    await expect(edit.getByLabel('桌面高度')).toHaveValue('900');
    await expect(edit.getByLabel('缩放适应窗口')).toBeChecked();
    await expect(edit.locator('input[name="password"]')).toHaveAttribute(
      'placeholder',
      /已保存在本地/,
    );
    await edit.getByRole('button', { name: '取消' }).click();
    expect(pageErrors).toEqual([]);
  } finally {
    await app.close();
    await rm(userData, { recursive: true, force: true });
  }
});

test('official IronRDP bundle initializes inside the production Renderer', async () => {
  const assets = await readdir(resolve('apps/desktop/out/renderer/assets'));
  const bundles = assets.filter((name) => /^iron-remote-desktop-rdp-[^/]+\.js$/u.test(name));
  expect(bundles).toHaveLength(1);
  const userData = await mkdtemp(resolve(tmpdir(), 'axterm-ironrdp-bundle-e2e-'));
  const app = await electron.launch({
    executablePath,
    args: [resolve('apps/desktop'), `--user-data-dir=${userData}`],
    env: { ...process.env, ELECTRON_RENDERER_URL: '' },
  });
  try {
    const page = await app.firstWindow();
    await expect(page.getByTestId('runtime-state')).toHaveAttribute('data-state', 'ready');
    const result = await page.evaluate(async (bundleName) => {
      const url = new URL(`assets/${bundleName}`, document.baseURI);
      const module = (await import(/* @vite-ignore */ url.href)) as {
        init(logLevel: string): Promise<void>;
        Backend: {
          DesktopSize: new (
            width: number,
            height: number,
          ) => {
            width: number;
            height: number;
            free(): void;
          };
        };
      };
      await module.init('warn');
      const size = new module.Backend.DesktopSize(800, 600);
      try {
        return { width: size.width, height: size.height };
      } finally {
        size.free();
      }
    }, bundles[0]!);
    expect(result).toEqual({ width: 800, height: 600 });
  } finally {
    await app.close().catch(() => {});
    await rm(userData, { recursive: true, force: true });
  }
});

test('VNC bookmarks retain noVNC controls without exposing the saved password', async () => {
  const userData = await mkdtemp(resolve(tmpdir(), 'axterm-vnc-bookmark-ui-'));
  const app = await electron.launch({
    executablePath,
    args: [resolve('apps/desktop'), `--user-data-dir=${userData}`],
    env: { ...process.env, ELECTRON_RENDERER_URL: '' },
  });
  try {
    const page = await app.firstWindow();
    const pageErrors: string[] = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));
    await expect(page.getByTestId('runtime-state')).toHaveAttribute('data-state', 'ready');
    await page.locator('[data-activity-item="bookmarks"]').click();
    await page.locator('.workspace-sidebar').getByRole('button', { name: '管理' }).click();
    await page.getByRole('button', { name: '添加 VNC' }).click();

    const dialog = page.getByRole('dialog', { name: '添加 VNC 书签' });
    await dialog.getByLabel('名称').fill('Linux Visual QA');
    await dialog.getByLabel('主机').fill('vnc.example.test');
    await dialog.getByLabel('用户名').fill('visual-user');
    await dialog.getByLabel('密码').fill('vnc-test-secret');
    await dialog.getByLabel('代理').selectOption('direct');
    await dialog.getByLabel('画质（0–9）').fill('8');
    await dialog.getByLabel('压缩（0–9）').fill('6');
    await dialog.getByLabel('只读模式').check();
    await dialog.getByLabel('裁剪超出窗口的画面').check();
    await dialog.getByLabel('共享会话').uncheck();
    await dialog.getByLabel('空指针时显示圆点').uncheck();
    await dialog.getByLabel('同步文本剪贴板').uncheck();
    await dialog.getByRole('button', { name: '保存', exact: true }).click();
    await expect(dialog).toHaveCount(0);

    const card = page.locator('.host-card').filter({ hasText: 'Linux Visual QA' });
    await expect(card).toContainText('visual-user@vnc.example.test:5900');
    await expect(card).toContainText('VNC · 画质 8 · 压缩 6');
    await expect(page.getByText('vnc-test-secret')).toHaveCount(0);
    await card.getByRole('button', { name: '编辑' }).click();
    const edit = page.getByRole('dialog', { name: '编辑 VNC 书签' });
    await expect(edit.getByLabel('主机')).toHaveValue('vnc.example.test');
    await expect(edit.getByLabel('代理')).toHaveValue('direct');
    await expect(edit.getByLabel('画质（0–9）')).toHaveValue('8');
    await expect(edit.getByLabel('压缩（0–9）')).toHaveValue('6');
    await expect(edit.getByLabel('只读模式')).toBeChecked();
    await expect(edit.getByLabel('裁剪超出窗口的画面')).toBeChecked();
    await expect(edit.getByLabel('共享会话')).not.toBeChecked();
    await expect(edit.getByLabel('空指针时显示圆点')).not.toBeChecked();
    await expect(edit.getByLabel('同步文本剪贴板')).not.toBeChecked();
    await expect(edit.locator('input[name="password"]')).toHaveAttribute(
      'placeholder',
      /已保存在本地/,
    );
    await edit.getByRole('button', { name: '取消' }).click();
    expect(pageErrors).toEqual([]);
  } finally {
    await app.close();
    await rm(userData, { recursive: true, force: true });
  }
});

test('SPICE bookmarks retain multichannel viewport controls without exposing the saved ticket', async () => {
  const userData = await mkdtemp(resolve(tmpdir(), 'axterm-spice-bookmark-ui-'));
  const app = await electron.launch({
    executablePath,
    args: [resolve('apps/desktop'), `--user-data-dir=${userData}`],
    env: { ...process.env, ELECTRON_RENDERER_URL: '' },
  });
  try {
    const page = await app.firstWindow();
    const pageErrors: string[] = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));
    await expect(page.getByTestId('runtime-state')).toHaveAttribute('data-state', 'ready');
    await page.locator('[data-activity-item="bookmarks"]').click();
    await page.locator('.workspace-sidebar').getByRole('button', { name: '管理' }).click();
    await page.getByRole('button', { name: '添加 SPICE' }).click();

    const dialog = page.getByRole('dialog', { name: '添加 SPICE 书签' });
    await dialog.getByLabel('名称').fill('SPICE QA');
    await dialog.getByLabel('主机').fill('spice.example.test');
    await dialog.getByLabel('密码').fill('spice-test-ticket');
    await dialog.getByLabel('代理').selectOption('direct');
    await dialog.getByLabel('只读模式').check();
    await expect(dialog.getByLabel('缩放适应窗口')).toBeChecked();
    await dialog.getByRole('button', { name: '保存', exact: true }).click();
    await expect(dialog).toHaveCount(0);

    const card = page.locator('.host-card').filter({ hasText: 'SPICE QA' });
    await expect(card).toContainText('spice.example.test:5900');
    await expect(card).toContainText('SPICE · 只读 · 缩放');
    await expect(page.getByText('spice-test-ticket')).toHaveCount(0);
    await card.getByRole('button', { name: '编辑' }).click();
    const edit = page.getByRole('dialog', { name: '编辑 SPICE 书签' });
    await expect(edit.getByLabel('主机')).toHaveValue('spice.example.test');
    await expect(edit.getByLabel('代理')).toHaveValue('direct');
    await expect(edit.getByLabel('只读模式')).toBeChecked();
    await expect(edit.getByLabel('缩放适应窗口')).toBeChecked();
    await expect(edit.locator('input[name="password"]')).toHaveAttribute(
      'placeholder',
      /已保存在本地/,
    );
    await edit.getByRole('button', { name: '取消' }).click();
    expect(pageErrors).toEqual([]);
  } finally {
    await app.close();
    await rm(userData, { recursive: true, force: true });
  }
});

test('Web bookmarks open in a bounded native view with Legacy Prototype-compatible controls', async () => {
  const userData = await mkdtemp(resolve(tmpdir(), 'axterm-web-bookmark-ui-'));
  const userAgents: string[] = [];
  const fixture = createServer((request, response) => {
    userAgents.push(request.headers['user-agent'] ?? '');
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    response.end(
      '<!doctype html><html><head><title>Axterm Web Fixture</title></head><body>WEB_SESSION_READY</body></html>',
    );
  });
  fixture.listen(0, '127.0.0.1');
  await once(fixture, 'listening');
  const address = fixture.address();
  if (!address || typeof address === 'string') throw new Error('Web fixture did not bind');
  const url = `http://127.0.0.1:${address.port}/dashboard`;
  const app = await electron.launch({
    executablePath,
    args: [resolve('apps/desktop'), `--user-data-dir=${userData}`],
    env: { ...process.env, ELECTRON_RENDERER_URL: '' },
  });
  try {
    const page = await app.firstWindow();
    const pageErrors: string[] = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));
    await expect(page.getByTestId('runtime-state')).toHaveAttribute('data-state', 'ready');
    await page.locator('[data-activity-item="bookmarks"]').click();
    await page.locator('.workspace-sidebar').getByRole('button', { name: '管理' }).click();
    await page.getByRole('button', { name: '添加 Web' }).click();

    const dialog = page.getByRole('dialog', { name: '添加 Web 书签' });
    await dialog.getByLabel('名称').fill('Web QA');
    await dialog.getByLabel('URL').fill(url);
    await dialog.getByLabel('User-Agent').fill('Axterm-Web-E2E/1.0');
    await dialog.getByRole('button', { name: '保存并打开' }).click();
    await expect(dialog).toHaveCount(0);

    const layer = page.locator('.terminal-session-layer:not([hidden])');
    await expect(layer.locator('.web-session-view')).toBeVisible();
    await expect(layer.getByRole('button', { name: '重新加载' })).toBeVisible();
    await expect(layer.locator('.web-session-address')).toContainText(url);
    await expect.poll(() => userAgents).toContain('Axterm-Web-E2E/1.0');
    await expect
      .poll(() =>
        app.evaluate(({ webContents }) =>
          webContents
            .getAllWebContents()
            .filter((contents) => contents.getURL().includes('/dashboard'))
            .map((contents) => ({
              url: contents.getURL(),
              userAgent: contents.getUserAgent(),
              text: contents.isDestroyed()
                ? ''
                : contents.executeJavaScript('document.body.textContent'),
            })),
        ),
      )
      .toHaveLength(1);
    const nativeViews = await app.evaluate(async ({ webContents }) =>
      Promise.all(
        webContents
          .getAllWebContents()
          .filter((contents) => contents.getURL().includes('/dashboard'))
          .map(async (contents) => ({
            url: contents.getURL(),
            userAgent: contents.getUserAgent(),
            text: await contents.executeJavaScript('document.body.textContent'),
          })),
      ),
    );
    expect(nativeViews).toEqual([
      {
        url,
        userAgent: 'Axterm-Web-E2E/1.0',
        text: 'WEB_SESSION_READY',
      },
    ]);

    const tab = page.locator('.pane-tabbar .terminal-tab').filter({ hasText: 'Web QA' });
    await tab.hover();
    await tab.getByRole('button', { name: '关闭 Web QA' }).click();
    await expect
      .poll(() =>
        app.evaluate(
          ({ webContents }) =>
            webContents
              .getAllWebContents()
              .filter((contents) => contents.getURL().includes('/dashboard')).length,
        ),
      )
      .toBe(0);
    expect(pageErrors).toEqual([]);
  } finally {
    await app.close().catch(() => undefined);
    await new Promise<void>((resolveClose) => fixture.close(() => resolveClose()));
    await rm(userData, { recursive: true, force: true });
  }
});

test('connection history is reachable from the bookmark sidebar and honors privacy settings', async () => {
  const userData = await mkdtemp(resolve(tmpdir(), 'axterm-connection-history-ui-'));
  const database = await ProductDatabase.open(resolve(userData, 'data-v2', 'axterm.sqlite'));
  try {
    const hosts = new ProductRepository(database);
    const history = new ConnectionHistoryRepository(database);
    const frequent = hosts.createHost({
      name: '频繁目标',
      hostname: 'frequent.example',
      username: 'operator',
      authType: 'agent',
    });
    const recent = hosts.createHost({
      name: '最近目标',
      hostname: 'recent.example',
      username: 'operator',
      authType: 'agent',
    });
    history.record({ host: frequent, persistedHostId: frequent.id });
    history.record({ host: frequent, persistedHostId: frequent.id });
    history.record({ host: recent, persistedHostId: recent.id });
    history.record({
      host: {
        ...frequent,
        id: '00000000-0000-4000-8000-000000000031',
        name: '临时密码目标',
        hostname: 'password.example',
        authType: 'password',
      },
      persistedHostId: null,
    });
    history.record({
      host: {
        ...frequent,
        id: '00000000-0000-4000-8000-000000000032',
        name: '临时私钥目标',
        hostname: 'key.example',
        authType: 'privateKey',
      },
      persistedHostId: null,
    });
  } finally {
    database.close();
  }
  const app = await electron.launch({
    executablePath,
    args: [resolve('apps/desktop'), `--user-data-dir=${userData}`],
    env: { ...process.env, ELECTRON_RENDERER_URL: '' },
  });
  try {
    const page = await app.firstWindow();
    const pageErrors: string[] = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));
    await expect(page.getByTestId('runtime-state')).toHaveAttribute('data-state', 'ready');
    await page.locator('[data-activity-item="bookmarks"]').click();
    const sidebar = page.locator('.workspace-sidebar');
    await sidebar.getByRole('tab', { name: '历史' }).click();
    await expect(sidebar.getByRole('region', { name: '连接历史' })).toBeVisible();
    await expect(sidebar.locator('.connection-history-row')).toHaveCount(4);
    await sidebar.getByRole('switch', { name: '按使用频次排序' }).check();
    await expect(sidebar.locator('.connection-history-name').first()).toHaveText('频繁目标');

    const passwordRow = sidebar
      .locator('.connection-history-row')
      .filter({ hasText: '临时密码目标' });
    await passwordRow.locator('.connection-history-main').click();
    const secretDialog = page.getByRole('dialog', { name: '重新连接 临时密码目标' });
    await expect(secretDialog.getByLabel('本次使用的密码')).toBeVisible();
    await expect(
      secretDialog.getByText('只用于本次连接，不会保存到历史、设置或浏览器存储。'),
    ).toBeVisible();
    await secretDialog.getByRole('button', { name: '取消' }).click();

    const keyRow = sidebar.locator('.connection-history-row').filter({ hasText: '临时私钥目标' });
    await keyRow.locator('.connection-history-main').click();
    await expect(
      sidebar.getByText('此临时历史不包含私钥。请先保存为书签，在主机编辑器中配置私钥后再连接。'),
    ).toBeVisible();
    await sidebar.getByRole('button', { name: '关闭提示' }).click();

    const recentRow = sidebar.locator('.connection-history-row').filter({ hasText: '最近目标' });
    await recentRow.hover();
    await recentRow.getByRole('button', { name: '将 最近目标 保存为书签' }).click();
    await sidebar.getByRole('tab', { name: '书签' }).click();
    await expect(sidebar.locator('[data-bookmark-title="最近目标"]')).toBeVisible();
    await sidebar.getByRole('tab', { name: '历史' }).click();

    await recentRow.hover();
    await recentRow.getByRole('button', { name: '删除 最近目标 的连接历史' }).click();
    await expect(sidebar.locator('.connection-history-row')).toHaveCount(3);
    await sidebar.getByRole('button', { name: '清空连接历史' }).click();
    await expect(sidebar.getByText('成功连接 SSH 主机后会显示在这里')).toBeVisible();

    const recording = sidebar.getByRole('checkbox', { name: '记录连接历史' });
    await expect(recording).toBeChecked();
    // The control reflects the Runtime-confirmed setting rather than changing before the
    // versioned PATCH completes, so use a click and wait for the authoritative state.
    await recording.click();
    await expect(sidebar.getByText('连接历史已关闭')).toBeVisible();
    await expect(recording).not.toBeChecked();

    await page.reload();
    await expect(page.getByTestId('runtime-state')).toHaveAttribute('data-state', 'ready');
    // Runtime readiness can precede the persisted workspace hydration by one render.
    await expect(
      page.locator('.terminal-session-layer:not(.terminal-file-session-layer)'),
    ).toHaveCount(1);
    if (await page.locator('.workspace-sidebar').isHidden())
      await page.locator('[data-activity-item="bookmarks"]').click();
    const restoredSidebar = page.locator('.workspace-sidebar');
    await expect(restoredSidebar).toBeVisible();
    await restoredSidebar.getByRole('tab', { name: '历史' }).click();
    await expect(restoredSidebar.getByRole('checkbox', { name: '记录连接历史' })).not.toBeChecked();
    await restoredSidebar.getByRole('button', { name: '启用连接历史' }).click();
    await expect(restoredSidebar.getByRole('checkbox', { name: '记录连接历史' })).toBeChecked();
    await expect(restoredSidebar.getByText('成功连接 SSH 主机后会显示在这里')).toBeVisible();
    expect(pageErrors).toEqual([]);
  } finally {
    await app.close();
    await rm(userData, { recursive: true, force: true });
  }
});

test('connection configuration UI persists reference-only credentials and assigns them to Bookmarks', async () => {
  const userData = await mkdtemp(resolve(tmpdir(), 'axterm-connection-profile-e2e-'));
  const sshPassword = 'B08-ssh-password-secret';
  const privateKey = 'B08 PRIVATE KEY SECRET';
  const telnetPassword = 'B08-telnet-password-secret';
  const app = await electron.launch({
    executablePath,
    args: [resolve('apps/desktop'), `--user-data-dir=${userData}`],
    env: { ...process.env, ELECTRON_RENDERER_URL: '' },
  });
  try {
    const page = await app.firstWindow();
    await expect(page.getByTestId('runtime-state')).toHaveAttribute('data-state', 'ready');
    await page.locator('[data-activity-item="setting"]').click();
    await page.locator('[data-settings-category="terminal"]').click();
    await page.getByRole('button', { name: /Profiles|终端配置/ }).click();

    const profileForm = page.getByTestId('connection-profile-form');
    await profileForm.getByLabel('连接配置名称').fill('Desktop identity');
    await profileForm.locator('input[name="ssh.username"]').fill('deploy');
    await profileForm.locator('input[name="ssh.password"]').fill(sshPassword);
    await profileForm.locator('textarea[name="ssh.privateKey"]').fill(privateKey);
    await profileForm.getByRole('tab', { name: 'Telnet' }).click();
    await profileForm.locator('input[name="telnet.username"]').fill('legacy-user');
    await profileForm.locator('input[name="telnet.password"]').fill(telnetPassword);
    await profileForm.getByRole('button', { name: '保存配置' }).click();
    await expect(page.getByText('连接配置已保存。')).toBeVisible();
    await expect(page.getByText('Desktop identity', { exact: true })).toBeVisible();
    await page.getByLabel('搜索连接配置').fill('missing');
    await expect(page.getByText('Desktop identity', { exact: true })).toBeHidden();
    await expect(page.getByText('没有匹配的连接配置。')).toBeVisible();
    await page.getByLabel('搜索连接配置').fill('Desktop');
    await expect(page.getByText('Desktop identity', { exact: true })).toBeVisible();

    await page.locator('[data-activity-item="bookmarks"]').click();
    await page.locator('.workspace-sidebar').getByRole('button', { name: '管理' }).click();
    await page.getByRole('button', { name: '添加主机' }).click();
    await page.getByLabel('显示名称').fill('Profile assigned host');
    await page.getByLabel('主机地址').fill('profile.example.test');
    await page.getByLabel('用户名', { exact: true }).fill('fallback-user');
    const bookmarkDialog = page.getByRole('dialog', { name: '添加 SSH 主机' });
    const authSelector = bookmarkDialog.getByRole('group', { name: 'SSH 认证类型' });
    await authSelector.getByRole('button', { name: '连接配置', exact: true }).click();
    await expect(
      authSelector.getByRole('button', { name: '连接配置', exact: true }),
    ).toHaveAttribute('aria-pressed', 'true');
    await bookmarkDialog.getByLabel('连接配置').selectOption({ label: 'Desktop identity（默认）' });
    await page.getByRole('button', { name: '保存', exact: true }).click();
    await expect(page.locator('.host-card').getByText('Profile assigned host')).toBeVisible();

    const database = await ProductDatabase.open(resolve(userData, 'data-v2', 'axterm.sqlite'));
    try {
      const [profile] = new ConnectionProfileRepository(database).list();
      expect(profile).toMatchObject({
        name: 'Desktop identity',
        isDefault: true,
        ssh: { username: 'deploy' },
        telnet: { username: 'legacy-user' },
      });
      expect(profile?.ssh.passwordCredentialRef).toMatch(/^cred_/);
      expect(profile?.ssh.privateKeyCredentialRef).toMatch(/^cred_/);
      expect(profile?.telnet.passwordCredentialRef).toMatch(/^cred_/);
      expect(new BookmarkRepository(database).snapshot().bookmarks[0]).toMatchObject({
        connectionProfileId: profile?.id,
        profileId: null,
      });
    } finally {
      database.close();
    }

    for (const directory of [resolve(userData, 'data-v2'), resolve(userData, 'vault-v2')]) {
      for (const contents of await readDirectoryFiles(directory)) {
        expect(contents.includes(Buffer.from(sshPassword))).toBe(false);
        expect(contents.includes(Buffer.from(privateKey))).toBe(false);
        expect(contents.includes(Buffer.from(telnetPassword))).toBe(false);
      }
    }
  } finally {
    await app.close();
    await rm(userData, { recursive: true, force: true });
  }
});

test('terminal settings prioritize the default profile and shell configuration', async () => {
  const userData = await mkdtemp(resolve(tmpdir(), 'axterm-terminal-settings-order-e2e-'));
  const app = await electron.launch({
    executablePath,
    args: [resolve('apps/desktop'), `--user-data-dir=${userData}`],
    env: { ...process.env, ELECTRON_RENDERER_URL: '' },
  });
  try {
    const page = await app.firstWindow();
    await expect(page.getByTestId('runtime-state')).toHaveAttribute('data-state', 'ready');
    await expect(
      page.locator('.terminal-session-layer:not([hidden])').locator('.terminal-host'),
    ).toHaveAttribute('data-connection-state', 'connected');
    await page.locator('[data-activity-item="setting"]').click();
    await expect(page.locator('.app-shell')).toHaveClass(/section-settings.*surface-section/u);
    await expect(page.locator('.settings-workspace')).toBeVisible();
    await page.locator('[data-settings-category="terminal"]').click();
    await expect(
      page.locator('.terminal-default-profile-settings, .terminal-profile-settings'),
    ).toHaveCount(2);
    expect(
      await page
        .locator('.terminal-default-profile-settings, .terminal-profile-settings')
        .evaluateAll((elements) => elements.map((element) => element.className)),
    ).toEqual([
      'surface stack terminal-default-profile-settings',
      'two-column terminal-profile-settings',
    ]);
    const profileForm = page
      .locator('form')
      .filter({ has: page.getByRole('heading', { name: '终端配置' }) });
    const shellPosition = await profileForm.getByLabel('Shell', { exact: true }).boundingBox();
    const appearancePosition = await profileForm.getByLabel('回滚行数').boundingBox();
    expect(shellPosition).not.toBeNull();
    expect(appearancePosition).not.toBeNull();
    expect(shellPosition!.y).toBeLessThan(appearancePosition!.y);
  } finally {
    await app.close();
    await rm(userData, { recursive: true, force: true });
  }
});

for (const backspaceMode of ['^?', '^H'] as const) {
  test(`terminal IME keeps committed input while editing pinyin (${backspaceMode})`, async () => {
    test.skip(process.platform === 'win32', 'This assertion uses a POSIX shell fixture.');
    const userData = await mkdtemp(resolve(tmpdir(), 'axterm-terminal-ime-'));
    const app = await launchLocalOptimizationApp({
      executablePath,
      args: [resolve('apps/desktop'), `--user-data-dir=${userData}`],
      env: { ...process.env, ELECTRON_RENDERER_URL: '', SHELL: '/bin/bash' },
    });
    try {
      const page = await app.firstWindow();
      const errors: string[] = [];
      const frames: Buffer[] = [];
      let capture = false;
      page.on('pageerror', (error) => errors.push(error.message));
      page.on('websocket', (socket) => {
        socket.on('framesent', ({ payload }) => {
          if (capture && Buffer.isBuffer(payload)) frames.push(payload);
        });
      });
      await expect(page.getByTestId('runtime-state')).toHaveAttribute('data-state', 'ready');
      await page.locator('[data-activity-item="setting"]').click();
      await page.locator('[data-settings-category="terminal"]').click();
      const profile = page
        .locator('form')
        .filter({ has: page.getByRole('heading', { name: '终端配置' }) });
      await profile.getByLabel('名称').fill('IME Bash');
      await profile.getByLabel('Shell', { exact: true }).fill('/bin/bash');
      await profile.getByLabel('Shell 参数（每行一个）').fill('--noprofile\n--norc');
      await profile.getByLabel('Backspace 序列').selectOption(backspaceMode);
      await profile.getByRole('button', { name: '保存终端配置' }).click();
      await page.getByRole('button', { name: '关闭设置并返回工作区' }).click();
      await page.getByTitle('新建会话菜单', { exact: true }).click();
      const menu = page.locator('.session-menu');
      await menu.getByLabel('终端配置').selectOption({ label: 'IME Bash' });
      await menu.getByRole('button', { name: /本地终端/ }).click();
      const layer = page.locator('.terminal-session-layer:not([hidden])');
      const input = layer.locator('.xterm-helper-textarea');
      await expect(layer.locator('.terminal-host')).toHaveAttribute(
        'data-connection-state',
        'connected',
      );
      await expect(layer.locator('.terminal-surface')).toHaveAttribute(
        'data-command-tracking',
        'active',
      );
      const ready = resolve(userData, 'ready.txt');
      await input.pressSequentially(`stty erase '${backspaceMode}'; printf READY > '${ready}'`);
      await input.press('Enter');
      await expect.poll(() => readFile(ready, 'utf8').catch(() => '')).toBe('READY');
      await input.pressSequentially("printf '%s' 'IME_KEEP_");
      const session = await page.context().newCDPSession(page);
      const compose = (text: string) =>
        session.send('Input.imeSetComposition', {
          text,
          selectionStart: text.length,
          selectionEnd: text.length,
        });
      const composingKey = async (
        key: string,
        keyCode: number,
        isComposing: boolean,
        shiftKey = false,
      ) => {
        const allowed = await input.evaluate(
          (element, keyboard) => {
            const event = new KeyboardEvent('keydown', {
              ...keyboard,
              bubbles: true,
              cancelable: true,
            });
            element.dispatchEvent(event);
            return !event.defaultPrevented;
          },
          { key, code: key, keyCode, isComposing, shiftKey },
        );
        expect(allowed).toBe(true);
        await page.waitForTimeout(30);
        expect(Buffer.concat(frames)).toEqual(Buffer.alloc(0));
      };
      try {
        await compose('yishuru');
        await session.send('Input.insertText', { text: '已输入' });
        await expect
          .poll(() => layer.locator('.xterm-rows').textContent())
          .toContain('IME_KEEP_已输入');
        capture = true;
        await compose('nix');
        await composingKey('Backspace', 8, true);
        await compose('ni');
        // Some IMEs omit isComposing or expose the legacy Process key code.
        await composingKey('Backspace', 8, false);
        await compose('n');
        await composingKey('Backspace', 229, false, true);
        await compose('nihao');
        for (const [key, code] of [
          ['ArrowDown', 40],
          ['ArrowUp', 38],
          ['Escape', 27],
        ] as const)
          await composingKey(key, code, true);
        await composingKey('Enter', 13, true, true);
        await composingKey('Enter', 229, false);
        await page.waitForTimeout(100);
        expect(Buffer.concat(frames)).toEqual(Buffer.alloc(0));

        // Commit through Chromium's native composition path, then deliver the
        // confirming keypress/keyup after compositionend has cleared its flag.
        await session.send('Input.insertText', { text: '中文' });
        await input.evaluate((element) => {
          element.dispatchEvent(
            new KeyboardEvent('keypress', {
              key: 'Enter',
              code: 'Enter',
              keyCode: 13,
              charCode: 13,
              bubbles: true,
            }),
          );
          element.dispatchEvent(
            new KeyboardEvent('keyup', {
              key: 'Enter',
              code: 'Enter',
              keyCode: 13,
              bubbles: true,
            }),
          );
        });
        await expect.poll(() => Buffer.concat(frames).toString('utf8')).toBe('中文');
        capture = false;
        const committed = resolve(userData, 'committed.txt');
        await input.pressSequentially(`' > '${committed}'`);
        await input.press('Enter');
        await expect
          .poll(() => readFile(committed, 'utf8').catch(() => ''))
          .toBe('IME_KEEP_已输入中文');

        await input.pressSequentially("printf '%s' 'NORMAL_X");
        frames.length = 0;
        capture = true;
        await compose('cuowu');
        await composingKey('Backspace', 8, true);
        await compose('');
        await input.evaluate((element) =>
          element.dispatchEvent(
            new KeyboardEvent('keyup', {
              key: 'Backspace',
              code: 'Backspace',
              keyCode: 8,
              bubbles: true,
            }),
          ),
        );
        await page.waitForTimeout(100);
        expect(Buffer.concat(frames)).toEqual(Buffer.alloc(0));
        await input.press('Backspace');
        await expect
          .poll(() => Buffer.concat(frames))
          .toEqual(Buffer.from([backspaceMode === '^?' ? 0x7f : 0x08]));
        capture = false;
        const normal = resolve(userData, 'normal.txt');
        await input.pressSequentially(`K' > '${normal}'`);
        await input.press('Shift+Enter');
        await expect.poll(() => readFile(normal, 'utf8').catch(() => '')).toBe('NORMAL_K');
        expect(errors).toEqual([]);
      } finally {
        await session.detach();
      }
    } finally {
      await app.close().catch(() => {});
      await rm(userData, { recursive: true, force: true });
    }
  });
}

test('terminal profile drives the real PTY and xterm appearance through the desktop flow', async () => {
  test.skip(process.platform === 'win32', 'This assertion uses a POSIX shell profile.');
  const userData = await mkdtemp(resolve(tmpdir(), 'axterm-terminal-profile-e2e-'));
  const rawOutputScript = resolve(userData, 'raw-output.sh');
  await writeFile(rawOutputScript, "#!/bin/sh\nprintf '\\033[31mRAW_ESCAPE\\033[0m\\n'\n");
  const app = await electron.launch({
    executablePath,
    args: [resolve('apps/desktop'), `--user-data-dir=${userData}`],
    env: { ...process.env, ELECTRON_RENDERER_URL: '' },
  });
  try {
    const page = await app.firstWindow();
    await expect(page.getByTestId('runtime-state')).toHaveAttribute('data-state', 'ready');
    await expect(page.locator('html')).toHaveAttribute('data-terminal-font-state', 'ready');
    const defaultTerminal = page.locator('.terminal-session-layer:not([hidden])');
    await expect(defaultTerminal.locator('.terminal-host')).toHaveAttribute(
      'data-font-family',
      'Maple Mono, mono, courier-new, courier, monospace',
    );
    await expect(defaultTerminal.locator('.terminal-host')).toHaveAttribute(
      'data-backspace-mode',
      '^?',
    );
    await expect(defaultTerminal.locator('.terminal-host')).toHaveAttribute(
      'data-shift-enter-mode',
      '\\n',
    );
    await expect(defaultTerminal.locator('.terminal-host')).toHaveAttribute(
      'data-theme-background',
      '#1e1e1e',
    );
    await expect(defaultTerminal.locator('.terminal-host')).toHaveAttribute(
      'data-connection-state',
      'connected',
    );
    await expect(defaultTerminal.locator('.terminal-channel-state')).toHaveCount(0);
    await expect(defaultTerminal.locator('.xterm-rows > div').first()).toBeVisible();
    expect(
      await defaultTerminal
        .locator('.xterm-rows > div')
        .first()
        .evaluate((row) => Number.parseFloat(getComputedStyle(row).height)),
    ).toBeGreaterThanOrEqual(20);
    expect(
      await page.evaluate(() => document.fonts.check('400 16px "Maple Mono"', 'Axterm =>')),
    ).toBe(true);
    await page.locator('[data-activity-item="setting"]').click();
    await page.locator('[data-settings-category="terminal"]').click();
    const profileForm = page
      .locator('form')
      .filter({ has: page.getByRole('heading', { name: '终端配置' }) });
    await profileForm.getByLabel('名称').fill('Desktop profile');
    await profileForm.getByLabel('Shell', { exact: true }).fill('/bin/sh');
    await profileForm.getByLabel('工作目录').fill(userData);
    await profileForm.locator('input[name="term"]').fill('screen-256color');
    await profileForm.locator('input[name="lang"]').fill('C.UTF-8');
    await profileForm.locator('textarea[name="env"]').fill('PROFILE_MARKER=desktop');
    await profileForm.getByLabel('字体族').fill('Iosevka, monospace');
    await profileForm.getByLabel('字号').fill('18');
    await profileForm.getByLabel('行高').fill('1.3');
    await profileForm.getByLabel('光标样式').selectOption('bar');
    await profileForm.getByLabel('光标闪烁').check();
    await profileForm.getByLabel('回滚行数').fill('4200');
    await profileForm.getByLabel('渲染器').selectOption('webgl');
    await profileForm.getByLabel('Unicode 字宽').selectOption('11');
    await profileForm.getByLabel('单词分隔符').fill(' :');
    await profileForm.getByLabel('Backspace 序列').selectOption('^H');
    await profileForm.getByLabel('Shift+Enter 发送').fill('\\n');
    await profileForm.getByLabel('输出编码').selectOption('gb18030');
    await profileForm.getByLabel('会话日志添加时间戳').check();
    await profileForm.getByLabel('启用编程连字').check();
    await profileForm.getByLabel('启用 SIXEL / iTerm 图片序列').check();
    await profileForm.getByRole('button', { name: '保存终端配置' }).click();
    await expect(
      page.locator('.surface.list .list-row strong').getByText('Desktop profile', { exact: true }),
    ).toBeVisible();
    await page.getByLabel('全局默认终端配置').selectOption({ label: 'Desktop profile' });
    await expect(page.getByLabel('全局默认终端配置')).toHaveValue(/.+/);

    await page.getByRole('button', { name: '关闭设置并返回工作区' }).click();
    await page.getByTitle('新建会话菜单', { exact: true }).click();
    const sessionMenu = page.locator('.session-menu');
    await expect(sessionMenu.getByLabel('终端配置').locator('option:checked')).toHaveText(
      '全局默认（Desktop profile）',
    );
    await sessionMenu.getByRole('button', { name: /本地终端/ }).click();
    const terminalHost = page.locator('.terminal-session-layer:not([hidden]) .terminal-host');
    await expect(terminalHost).toHaveAttribute('data-connection-state', 'connected');
    await expect(terminalHost).toHaveAttribute('data-font-family', 'Iosevka, monospace');
    await expect(terminalHost).toHaveAttribute('data-font-size', '18');
    await expect(terminalHost).toHaveAttribute('data-line-height', '1.3');
    await expect(terminalHost).toHaveAttribute('data-cursor-style', 'bar');
    await expect(terminalHost).toHaveAttribute('data-cursor-blink', 'true');
    await expect(terminalHost).toHaveAttribute('data-scrollback', '4200');
    await expect(terminalHost).toHaveAttribute('data-capabilities-ready', 'true');
    await expect(terminalHost).toHaveAttribute('data-renderer-preference', 'webgl');
    await expect(terminalHost).toHaveAttribute('data-word-separator', ' :');
    await expect(terminalHost).toHaveAttribute('data-backspace-mode', '^H');
    await expect(terminalHost).toHaveAttribute('data-shift-enter-mode', '\\n');
    await expect(terminalHost).toHaveAttribute('data-encoding', 'gb18030');
    await expect(terminalHost).toHaveAttribute('data-display-raw', 'false');
    await expect(terminalHost).toHaveAttribute('data-log-timestamps', 'true');
    expect(['dom', 'webgl']).toContain(await terminalHost.getAttribute('data-renderer'));
    if ((await terminalHost.getAttribute('data-renderer')) === 'dom')
      await expect(terminalHost).toHaveAttribute('data-renderer-fallback', 'true');
    await expect(terminalHost).toHaveAttribute('data-unicode-version', '11');
    await expect(terminalHost).toHaveAttribute('data-ligatures', 'active');
    await expect(terminalHost).toHaveAttribute('data-image-sequences', 'active');

    const input = page.locator('.terminal-session-layer:not([hidden]) .xterm-helper-textarea');
    const keyInputEvidence = resolve(userData, 'terminal-key-input.txt');
    await input.pressSequentially("stty erase '^H'");
    await input.press('Enter');
    await input.pressSequentially('printf BACKSPACE_SEQUENCE_%s OX');
    await input.press('Backspace');
    await input.pressSequentially(`K > '${keyInputEvidence}'`);
    await input.press('Shift+Enter');
    await expect
      .poll(async () => readFile(keyInputEvidence, 'utf8').catch(() => ''))
      .toBe('BACKSPACE_SEQUENCE_OK');
    await input.pressSequentially(
      `printf '\\nPROFILE_UI_OK:%s:%s:%s:%s\\n' "$PROFILE_MARKER" "$LANG" "$TERM" "$PWD"`,
    );
    await input.press('Enter');
    await input.pressSequentially("printf '\\nENCODING_GBK:\\326\\320\\316\\304\\n'");
    await input.press('Enter');
    await input.pressSequentially("printf '\\nTERMINAL_UNICODE_11:\\224\\070\\341\\064:=>\\n'");
    await input.press('Enter');
    const inlinePng =
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
    await input.pressSequentially(
      `printf '\\033]1337;File=size=68;inline=1;width=1;height=1:${inlinePng}\\a'`,
    );
    await input.press('Enter');
    await expect(
      page.locator('.terminal-session-layer:not([hidden]) .xterm-image-layer'),
    ).toHaveCount(1);
    await input.press(process.platform === 'darwin' ? 'Meta+f' : 'Control+f');
    const search = page
      .locator('.terminal-session-layer:not([hidden])')
      .getByPlaceholder('查找终端输出');
    await expect
      .poll(async () => {
        await search.fill('');
        await search.fill(`PROFILE_UI_OK:desktop:C.UTF-8:screen-256color:${userData}`);
        return page
          .locator('.terminal-session-layer:not([hidden]) .terminal-search-result')
          .textContent();
      })
      .toBe('已找到');
    await search.fill('TERMINAL_UNICODE_11:🀄:=>');
    await expect(
      page.locator('.terminal-session-layer:not([hidden]) .terminal-search-result'),
    ).toHaveText('已找到');
    await search.fill('ENCODING_GBK:中文');
    await expect(
      page.locator('.terminal-session-layer:not([hidden]) .terminal-search-result'),
    ).toHaveText('已找到');
    await page.keyboard.press('Escape');
    await page.getByLabel('当前终端输出编码').selectOption('utf-8');
    await expect(terminalHost).toHaveAttribute('data-encoding', 'utf-8');
    await input.pressSequentially("printf '\\nENCODING_SWITCH_UTF8:\\360\\237\\200\\204\\n'");
    await input.press('Enter');
    await input.press(process.platform === 'darwin' ? 'Meta+f' : 'Control+f');
    const switchedSearch = page
      .locator('.terminal-session-layer:not([hidden])')
      .getByPlaceholder('查找终端输出');
    await switchedSearch.fill('ENCODING_SWITCH_UTF8:🀄');
    await expect(
      page.locator('.terminal-session-layer:not([hidden]) .terminal-search-result'),
    ).toHaveText('已找到');
    await page.keyboard.press('Escape');

    const activeTab = page.locator('.pane-tabbar .terminal-tab.active');
    await activeTab.click({ button: 'right' });
    await page.locator('.tab-context-menu').getByRole('button', { name: '复制标签' }).click();
    await expect(
      page.locator('.terminal-session-layer:not([hidden]) .terminal-host'),
    ).toHaveAttribute('data-font-family', 'Iosevka, monospace');
    await expect(
      page.locator('.terminal-session-layer:not([hidden]) .terminal-host'),
    ).toHaveAttribute('data-backspace-mode', '^H');

    await page.locator('[data-activity-item="setting"]').click();
    await page.locator('[data-settings-category="terminal"]').click();
    const savedProfile = page
      .locator('.surface.list .list-row')
      .filter({ hasText: 'Desktop profile' });
    await savedProfile.getByRole('button', { name: '编辑' }).click();
    await profileForm.getByLabel('显示原始转义序列').check();
    await profileForm.getByRole('button', { name: '更新配置' }).click();
    await page.getByRole('button', { name: '关闭设置并返回工作区' }).click();
    await expect(
      page.locator('.terminal-session-layer:not([hidden]) .terminal-host'),
    ).toHaveAttribute('data-display-raw', 'false');

    await page.getByTitle('新建会话菜单', { exact: true }).click();
    await page
      .locator('.session-menu')
      .getByLabel('终端配置')
      .selectOption({ label: 'Desktop profile' });
    await page
      .locator('.session-menu')
      .getByRole('button', { name: /本地终端/ })
      .click();
    const rawTerminal = page.locator('.terminal-session-layer:not([hidden])');
    await expect(rawTerminal.locator('.terminal-host')).toHaveAttribute('data-display-raw', 'true');
    const rawInput = rawTerminal.locator('.xterm-helper-textarea');
    await rawInput.pressSequentially(`sh '${rawOutputScript}'`);
    await rawInput.press('Enter');
    await rawInput.press(process.platform === 'darwin' ? 'Meta+f' : 'Control+f');
    const rawSearch = rawTerminal.getByPlaceholder('查找终端输出');
    await rawSearch.fill('\\033[31mRAW_ESCAPE\\033[0m');
    await expect(rawTerminal.locator('.terminal-search-result')).toHaveText('已找到');
  } finally {
    await app.close();
    await rm(userData, { recursive: true, force: true });
  }
});

test('terminal session logs use grants, append safely and expose recording state', async () => {
  test.skip(process.platform === 'win32', 'This assertion uses a POSIX shell fixture.');
  const userData = await mkdtemp(resolve(tmpdir(), 'axterm-terminal-log-e2e-'));
  const recordingLog = resolve(userData, 'recording.log');
  const savedLog = resolve(userData, 'saved-terminal.log');
  await Promise.all([
    writeFile(recordingLog, 'RECORDING_PREFIX\n'),
    writeFile(savedLog, 'SAVED_PREFIX\n'),
  ]);
  const app = await electron.launch({
    executablePath,
    args: [resolve('apps/desktop'), `--user-data-dir=${userData}`],
    env: { ...process.env, ELECTRON_RENDERER_URL: '' },
  });
  try {
    await app.evaluate(
      ({ dialog }, paths) => {
        const queue = [...paths];
        dialog.showSaveDialog = (() =>
          Promise.resolve({
            canceled: false,
            filePath: queue.shift()!,
          })) as typeof dialog.showSaveDialog;
      },
      [recordingLog, savedLog],
    );
    const page = await app.firstWindow();
    const pageErrors: string[] = [];
    const revokedGrants: string[] = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));
    page.on('request', (request) => {
      if (request.method() === 'DELETE' && request.url().includes('/api/v1/file-grants/'))
        revokedGrants.push(request.url());
    });
    await expect(page.getByTestId('runtime-state')).toHaveAttribute('data-state', 'ready');
    const layer = page.locator('.terminal-session-layer:not([hidden])');
    const terminalSurface = layer.locator('.terminal-surface');
    const terminalHost = layer.locator('.terminal-host');
    const input = layer.locator('.xterm-helper-textarea');
    await expect(terminalHost).toHaveAttribute('data-connection-state', 'connected');

    await input.pressSequentially("printf '\\nBEFORE_RECORD\\n'");
    await input.press('Enter');
    await expect.poll(() => layer.locator('.xterm-rows').textContent()).toContain('BEFORE_RECORD');

    await terminalHost.click({ button: 'right', position: { x: 100, y: 90 } });
    let menu = page.getByRole('menu', { name: '终端菜单' });
    await expect(menu.getByRole('menuitem', { name: '保存终端日志' })).toBeVisible();
    await menu.getByRole('menuitem', { name: '录制', exact: true }).click();
    let indicator = page.getByRole('button', { name: '停止记录终端日志：recording.log' });
    await expect(indicator).toBeVisible();
    await expect(terminalSurface).toHaveAttribute('data-recording', 'true');
    await expect(layer.locator('.terminal-action-feedback')).not.toContainText(userData);

    await input.pressSequentially("printf '\\n\\033[31mSESSION_LOG_OK\\033[0m\\n'");
    await input.press('Enter');
    await expect.poll(() => layer.locator('.xterm-rows').textContent()).toContain('SESSION_LOG_OK');
    await terminalHost.click({ button: 'right', position: { x: 100, y: 90 } });
    menu = page.getByRole('menu', { name: '终端菜单' });
    await menu.getByRole('menuitem', { name: '停止录制' }).click();
    await expect(indicator).toHaveCount(0);
    await expect(terminalSurface).toHaveAttribute('data-recording', 'false');
    await expect
      .poll(async () => readFile(recordingLog, 'utf8').catch(() => ''))
      .toContain('SESSION_LOG_OK');
    const recorded = await readFile(recordingLog, 'utf8');
    expect(recorded.startsWith('RECORDING_PREFIX\n')).toBe(true);
    expect(recorded).not.toContain('BEFORE_RECORD');
    expect(recorded).not.toContain('\u001b');

    await terminalHost.click({ button: 'right', position: { x: 100, y: 90 } });
    menu = page.getByRole('menu', { name: '终端菜单' });
    await menu.getByRole('menuitem', { name: '保存终端日志' }).click();
    indicator = page.getByRole('button', { name: '停止记录终端日志：saved-terminal.log' });
    await expect(indicator).toBeVisible();
    await input.pressSequentially("printf '\\nAFTER_SAVE\\n'");
    await input.press('Enter');
    await expect.poll(() => layer.locator('.xterm-rows').textContent()).toContain('AFTER_SAVE');
    await indicator.click();
    await expect(indicator).toHaveCount(0);
    await expect
      .poll(async () => readFile(savedLog, 'utf8').catch(() => ''))
      .toContain('AFTER_SAVE');
    const saved = await readFile(savedLog, 'utf8');
    expect(saved.startsWith('SAVED_PREFIX\n')).toBe(true);
    expect(saved).toContain('BEFORE_RECORD');
    expect(saved).toContain('SESSION_LOG_OK');
    expect(saved).not.toContain('\u001b');
    await expect.poll(() => revokedGrants.length).toBe(2);
    expect(pageErrors).toEqual([]);
  } finally {
    await app.close();
    await rm(userData, { recursive: true, force: true });
  }
});

test('trusted desktop renderer can read and write the system clipboard', async () => {
  const userData = await mkdtemp(resolve(tmpdir(), 'axterm-system-clipboard-e2e-'));
  const app = await electron.launch({
    executablePath,
    args: [resolve('apps/desktop'), `--user-data-dir=${userData}`],
    env: { ...process.env, ELECTRON_RENDERER_URL: '' },
  });
  try {
    const page = await app.firstWindow();
    await page.bringToFront();
    await expect(page.getByTestId('runtime-state')).toHaveAttribute('data-state', 'ready');

    const pasteMarker = `AXTERM_NATIVE_PASTE_${Date.now()}`;
    await app.evaluate(({ clipboard }, text) => clipboard.writeText(text), pasteMarker);
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(pasteMarker);

    const copyMarker = `AXTERM_RENDERER_COPY_${Date.now()}`;
    await page.evaluate((text) => navigator.clipboard.writeText(text), copyMarker);
    await expect.poll(() => app.evaluate(({ clipboard }) => clipboard.readText())).toBe(copyMarker);
  } finally {
    await app.close();
    await rm(userData, { recursive: true, force: true });
  }
});

test('terminal action feedback expires after ten seconds and restarts for a new action', async () => {
  const userData = await mkdtemp(resolve(tmpdir(), 'axterm-terminal-feedback-e2e-'));
  const app = await electron.launch({
    executablePath,
    args: [resolve('apps/desktop'), `--user-data-dir=${userData}`],
    env: { ...process.env, ELECTRON_RENDERER_URL: '' },
  });
  try {
    const page = await app.firstWindow();
    await expect(page.getByTestId('runtime-state')).toHaveAttribute('data-state', 'ready');
    const layer = page.locator('.terminal-session-layer:not([hidden])');
    const terminalHost = layer.locator('.terminal-host');
    const notice = layer.locator('.terminal-action-feedback');
    await expect(terminalHost).toHaveAttribute('data-connection-state', 'connected');
    await page.evaluate(() => {
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: { readText: async () => 'x' },
      });
    });
    const paste = async () => {
      await terminalHost.click({ button: 'right', position: { x: 100, y: 90 } });
      await page
        .getByRole('menu', { name: '终端菜单' })
        .getByRole('menuitem', { name: '粘贴', exact: true })
        .click();
      await expect(notice).toHaveText('剪贴板内容已发送到终端。');
    };

    await paste();
    await page.waitForTimeout(6_000);
    await expect(notice).toBeVisible();
    await paste();
    await page.waitForTimeout(5_000);
    await expect(notice).toBeVisible();
    await expect(notice).toHaveCount(0, { timeout: 6_000 });
  } finally {
    await app.close();
    await rm(userData, { recursive: true, force: true });
  }
});

test('terminal search controls and context menu operate on a real Electron PTY', async () => {
  test.skip(process.platform === 'win32', 'This assertion uses a POSIX shell fixture.');
  const userData = await mkdtemp(resolve(tmpdir(), 'axterm-terminal-interaction-e2e-'));
  const app = await launchLocalOptimizationApp({
    executablePath,
    args: [resolve('apps/desktop'), `--user-data-dir=${userData}`],
    env: { ...process.env, ELECTRON_RENDERER_URL: '' },
  });
  try {
    const page = await app.firstWindow();
    const pageErrors: string[] = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));
    await expect(page.getByTestId('runtime-state')).toHaveAttribute('data-state', 'ready');
    const layer = page.locator('.terminal-session-layer:not([hidden])');
    const terminalHost = layer.locator('.terminal-host');
    const input = layer.locator('.xterm-helper-textarea');
    await expect(terminalHost).toHaveAttribute('data-connection-state', 'connected');

    await terminalHost.click({ button: 'right', position: { x: 90, y: 80 } });
    let menu = page.getByRole('menu', { name: '终端菜单' });
    await expect(menu).toBeVisible();
    await expect(menu.getByRole('menuitem', { name: /复制/ })).toBeDisabled();
    await expect(menu.getByRole('menuitem', { name: '粘贴选中内容', exact: true })).toBeDisabled();
    await expect(menu.getByRole('menuitem', { name: '使用 AI 解释', exact: true })).toBeDisabled();
    await page.keyboard.press('Escape');
    await expect(menu).toHaveCount(0);

    await input.pressSequentially(
      "printf '\\n%s %s %s\\n%s\\n' 'Al''pha' 'al''pha' 'Al''phaX' 'Al''pha'; printf '\\nTERMINAL_%s_READY\\n' 'SEARCH'",
    );
    await input.press('Enter');
    await input.press(process.platform === 'darwin' ? 'Meta+f' : 'Control+f');
    const search = layer.getByRole('textbox', { name: '查找终端输出' });
    const feedback = layer.locator('.terminal-search-result');
    const count = layer.locator('.terminal-search-count');
    const resultTotal = async () => {
      const value = await count.textContent();
      return Number(value?.split('/')[1]?.replace('+', '') ?? 0);
    };
    await search.fill('TERMINAL_SEARCH_READY');
    await expect(count).toHaveText(/\d+\/1/);
    await search.fill('Alpha');
    await expect(feedback).toHaveText('已找到');
    await expect.poll(resultTotal).toBe(4);
    const initialCount = await count.textContent();

    await layer.getByRole('button', { name: '下一个结果' }).click();
    await expect(count).not.toHaveText(initialCount!);
    await layer.getByRole('button', { name: '上一个结果' }).click();
    await expect(count).toHaveText(initialCount!);
    await search.press('Enter');
    await expect(count).not.toHaveText(initialCount!);
    await search.press('Shift+Enter');
    await expect(count).toHaveText(initialCount!);

    await layer.getByRole('button', { name: '区分大小写' }).click();
    await expect.poll(resultTotal).toBe(3);
    await layer.getByRole('button', { name: '全词匹配' }).click();
    await expect.poll(resultTotal).toBe(2);
    await layer.getByRole('button', { name: '使用正则表达式' }).click();
    await search.fill('Alpha(X)?');
    await expect.poll(resultTotal).toBe(3);
    await search.fill('[');
    await expect(feedback).toHaveText('正则表达式无效。');
    await expect(count).toHaveCount(0);
    await search.fill('NoTerminalMatch[0-9]+');
    await expect(feedback).toHaveText('无匹配');
    await expect(count).toHaveText('0/0');
    await search.press('Escape');
    await expect(search).toHaveCount(0);

    await terminalHost.click({ button: 'right', position: { x: 90, y: 80 } });
    menu = page.getByRole('menu', { name: '终端菜单' });
    await expect(menu).toBeVisible();
    await menu.getByRole('menuitem', { name: /全选/ }).click();
    await expect(layer.locator('.terminal-action-feedback')).toHaveText('已选择终端缓冲区。');

    await page.evaluate(() => {
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: {
          writeText: async (text: string) => {
            document.documentElement.dataset.clipboardWrite = text;
          },
          readText: async () => '',
        },
      });
    });
    await terminalHost.click({ button: 'right', position: { x: 100, y: 90 } });
    menu = page.getByRole('menu', { name: '终端菜单' });
    await expect(menu.getByRole('menuitem', { name: /复制/ })).toBeEnabled();
    await expect(menu.getByRole('menuitem', { name: '粘贴选中内容', exact: true })).toBeEnabled();
    await expect(menu.getByRole('menuitem', { name: '使用 AI 解释', exact: true })).toBeEnabled();
    await menu.getByRole('menuitem', { name: /复制/ }).click();
    await expect(layer.locator('.terminal-action-feedback')).toContainText('已复制');
    expect(
      await page.evaluate(() => document.documentElement.dataset.clipboardWrite?.length ?? 0),
    ).toBeGreaterThan(0);

    const pasteCommand =
      "printf '\\nAXTERM_CONTEXT_PASTE_OK\\n'; i=0; while [ $i -lt 80 ]; do printf 'line-%s\\n' \"$i\"; i=$((i+1)); done";
    await page.evaluate((text) => {
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: {
          writeText: async () => undefined,
          readText: async () => text,
        },
      });
    }, pasteCommand);
    await terminalHost.click({ button: 'right', position: { x: 110, y: 100 } });
    await page
      .getByRole('menu', { name: '终端菜单' })
      .getByRole('menuitem', { name: '粘贴', exact: true })
      .click();
    await expect(layer.locator('.terminal-action-feedback')).toHaveText('剪贴板内容已发送到终端。');
    await input.press('Enter');

    await terminalHost.click({ button: 'right', position: { x: 120, y: 110 } });
    await page
      .getByRole('menu', { name: '终端菜单' })
      .getByRole('menuitem', { name: /搜索/ })
      .click();
    const reopenedSearch = layer.getByRole('textbox', { name: '查找终端输出' });
    await reopenedSearch.fill('AXTERM_CONTEXT_PASTE_OK');
    await expect(feedback).toHaveText('已找到');
    await reopenedSearch.press('Escape');

    await terminalHost.click({ button: 'right', position: { x: 130, y: 120 } });
    await page
      .getByRole('menu', { name: '终端菜单' })
      .getByRole('menuitem', { name: /清除/ })
      .click();
    await expect(layer.locator('.terminal-action-feedback')).toHaveText('终端滚动区已清除。');
    await terminalHost.click({ button: 'right', position: { x: 140, y: 130 } });
    await page
      .getByRole('menu', { name: '终端菜单' })
      .getByRole('menuitem', { name: /搜索/ })
      .click();
    await expect(feedback).toHaveText('无匹配');
    await layer.getByRole('textbox', { name: '查找终端输出' }).press('Escape');

    await page.evaluate(() => {
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: {
          writeText: async () => undefined,
          readText: async () => {
            throw new DOMException('denied', 'NotAllowedError');
          },
        },
      });
    });
    await terminalHost.click({ button: 'right', position: { x: 150, y: 140 } });
    await page
      .getByRole('menu', { name: '终端菜单' })
      .getByRole('menuitem', { name: '粘贴', exact: true })
      .click();
    await expect(layer.locator('.terminal-action-feedback')).toHaveText(
      '无法读取剪贴板，请检查系统权限。',
    );
    expect(pageErrors).toEqual([]);
  } finally {
    await app.close();
    await rm(userData, { recursive: true, force: true });
  }
});

test('paste protection and policy-gated OSC 52 operate on a real Electron PTY', async () => {
  test.skip(process.platform === 'win32', 'This assertion uses a POSIX shell fixture.');
  const userData = await mkdtemp(resolve(tmpdir(), 'axterm-terminal-clipboard-e2e-'));
  const app = await electron.launch({
    executablePath,
    args: [resolve('apps/desktop'), `--user-data-dir=${userData}`],
    env: { ...process.env, ELECTRON_RENDERER_URL: '' },
  });
  try {
    const page = await app.firstWindow();
    const pageErrors: string[] = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));
    await expect(page.getByTestId('runtime-state')).toHaveAttribute('data-state', 'ready');

    await page.locator('[data-activity-item="setting"]').click();
    await page.locator('[data-settings-category="terminal"]').click();
    const profileForm = page
      .locator('form')
      .filter({ has: page.getByRole('heading', { name: '终端配置' }) });
    await profileForm.getByLabel('名称').fill('Clipboard policy');
    await profileForm.getByLabel('多行或超过 500 字符时确认粘贴').check();
    await profileForm.getByLabel('启用 OSC 52 剪贴板协议').check();
    await profileForm.getByLabel('OSC 52 读取本地剪贴板').selectOption('allow');
    await profileForm.getByLabel('OSC 52 写入本地剪贴板').selectOption('allow');
    await profileForm.getByRole('button', { name: '保存终端配置' }).click();
    await expect(
      page.locator('.list-row strong').getByText('Clipboard policy', { exact: true }),
    ).toBeVisible();

    await page.getByRole('button', { name: '关闭设置并返回工作区' }).click();
    await page.getByTitle('新建会话菜单', { exact: true }).click();
    const sessionMenu = page.locator('.session-menu');
    await sessionMenu.getByLabel('终端配置').selectOption({ label: 'Clipboard policy' });
    await sessionMenu.getByRole('button', { name: /本地终端/ }).click();
    const layer = page.locator('.terminal-session-layer:not([hidden])');
    const terminalHost = layer.locator('.terminal-host');
    const input = layer.locator('.xterm-helper-textarea');
    await expect(terminalHost).toHaveAttribute('data-connection-state', 'connected');
    await expect(terminalHost).toHaveAttribute('data-paste-protection', 'true');
    await expect(terminalHost).toHaveAttribute('data-osc52-enabled', 'true');
    await expect(terminalHost).toHaveAttribute('data-osc52-read-policy', 'allow');
    await expect(terminalHost).toHaveAttribute('data-osc52-write-policy', 'allow');

    await page.evaluate(() => {
      document.documentElement.dataset.clipboardRead =
        "printf '\\nAXTERM_PASTE_CANCELLED_SHOULD_NOT_EXIST\\n'\nprintf '\\nsecond line\\n'";
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: {
          writeText: async (text: string) => {
            document.documentElement.dataset.clipboardWrite = text;
          },
          readText: async () => document.documentElement.dataset.clipboardRead ?? '',
        },
      });
    });
    await terminalHost.click({ button: 'right', position: { x: 100, y: 90 } });
    await page
      .getByRole('menu', { name: '终端菜单' })
      .getByRole('menuitem', { name: '粘贴', exact: true })
      .click();
    let pasteDialog = page.getByRole('dialog', { name: '确认粘贴到终端' });
    await expect(pasteDialog).toBeVisible();
    await expect(pasteDialog.getByLabel('待粘贴内容预览')).toContainText(
      'AXTERM_PASTE_CANCELLED_SHOULD_NOT_EXIST',
    );
    await expect(pasteDialog).toContainText('2 行');
    await expect(pasteDialog.getByRole('button', { name: '确认粘贴' })).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(pasteDialog).toHaveCount(0);
    await expect(layer.locator('.terminal-action-feedback')).toHaveText('已取消粘贴。');

    await input.press(process.platform === 'darwin' ? 'Meta+f' : 'Control+f');
    let search = layer.getByRole('textbox', { name: '查找终端输出' });
    await search.fill('AXTERM_PASTE_CANCELLED_SHOULD_NOT_EXIST');
    await expect(layer.locator('.terminal-search-result')).toHaveText('无匹配');
    await search.press('Escape');

    const continuedPipeline = "docker info | sed -n '/Registry Mirrors/,+5p'";
    await page.evaluate(() => {
      document.documentElement.dataset.clipboardRead =
        "docker info |\n    sed -n '/Registry Mirrors/,+5p'";
    });
    await terminalHost.click({ button: 'right', position: { x: 110, y: 100 } });
    await page
      .getByRole('menu', { name: '终端菜单' })
      .getByRole('menuitem', { name: '粘贴', exact: true })
      .click();
    await expect(page.getByRole('dialog', { name: '确认粘贴到终端' })).toHaveCount(0);
    await expect(layer.locator('.terminal-action-feedback')).toHaveText('剪贴板内容已发送到终端。');
    await expect(
      layer.locator('.xterm-rows > div').filter({ hasText: continuedPipeline }),
    ).toHaveCount(1);
    await input.press('Control+c');

    const singleSqlStatement = 'CREATE TABLE users ( id INTEGER, username VARCHAR(50) );';
    await page.evaluate(() => {
      document.documentElement.dataset.clipboardRead =
        'CREATE TABLE users (\n  id INTEGER,\n  username VARCHAR(50)\n);';
    });
    await terminalHost.click({ button: 'right', position: { x: 110, y: 100 } });
    await page
      .getByRole('menu', { name: '终端菜单' })
      .getByRole('menuitem', { name: '粘贴', exact: true })
      .click();
    await expect(page.getByRole('dialog', { name: '确认粘贴到终端' })).toHaveCount(0);
    await expect(
      layer.locator('.xterm-rows > div').filter({ hasText: singleSqlStatement }),
    ).toHaveCount(1);
    await input.press('Control+c');

    await page.evaluate(() => {
      document.documentElement.dataset.clipboardRead =
        'docker exec \\\n  -it \\\n  opengauss \\\n  bash';
    });
    await terminalHost.click({ button: 'right', position: { x: 110, y: 100 } });
    await page
      .getByRole('menu', { name: '终端菜单' })
      .getByRole('menuitem', { name: '粘贴', exact: true })
      .click();
    pasteDialog = page.getByRole('dialog', { name: '确认粘贴到终端' });
    await expect(pasteDialog).toContainText('4 行');
    await expect(pasteDialog.getByLabel('待粘贴内容预览')).toContainText('docker exec \\');
    await pasteDialog.getByRole('button', { name: '取消' }).click();

    await page.evaluate(() => {
      document.documentElement.dataset.clipboardRead =
        "printf '\\nAXTERM_PASTE_CONFIRMED_ONE\\n'\nprintf '\\nAXTERM_PASTE_CONFIRMED_TWO\\n'";
    });
    await terminalHost.click({ button: 'right', position: { x: 110, y: 100 } });
    await page
      .getByRole('menu', { name: '终端菜单' })
      .getByRole('menuitem', { name: '粘贴', exact: true })
      .click();
    pasteDialog = page.getByRole('dialog', { name: '确认粘贴到终端' });
    await pasteDialog.getByRole('button', { name: '确认粘贴' }).click();
    await expect(layer.locator('.terminal-action-feedback')).toHaveText('剪贴板内容已发送到终端。');
    await input.press('Enter');
    await input.press(process.platform === 'darwin' ? 'Meta+f' : 'Control+f');
    search = layer.getByRole('textbox', { name: '查找终端输出' });
    await expect
      .poll(async () => {
        await search.fill('');
        await search.fill('AXTERM_PASTE_CONFIRMED_TWO');
        return layer.locator('.terminal-search-result').textContent();
      })
      .toBe('已找到');
    await search.press('Escape');

    const oscWriteText = 'OSC52_WRITE_你好';
    const oscWriteBase64 = Buffer.from(oscWriteText).toString('base64');
    await input.pressSequentially(`printf '\\033]52;c;${oscWriteBase64}\\007'`);
    await input.press('Enter');
    await expect
      .poll(() => page.evaluate(() => document.documentElement.dataset.clipboardWrite))
      .toBe(oscWriteText);
    await expect(layer.locator('.terminal-action-feedback')).toHaveText(
      '已允许终端通过 OSC 52 写入剪贴板。',
    );

    await input.pressSequentially("printf '\\033]52;c;not_base64!\\007'");
    await input.press('Enter');
    await expect(layer.locator('.terminal-action-feedback')).toHaveText(
      'OSC 52 载荷不是有效的 Base64。',
    );

    const oscReadText = 'OSC52_READ_OK';
    await page.evaluate((text) => {
      document.documentElement.dataset.clipboardRead = text;
    }, oscReadText);
    const response = `\u001b]52;c;${Buffer.from(oscReadText).toString('base64')}\u0007`;
    const responseHex = Buffer.from(response).toString('hex');
    const readCommand =
      `old=$(stty -g); stty -echo -icanon min 1 time 20; ` +
      `printf '\\033]52;c;?\\007'; ` +
      `reply=$(dd bs=1 count=${Buffer.byteLength(response)} 2>/dev/null | od -An -tx1 | tr -d ' \\n'); ` +
      `stty "$old"; if [ "$reply" = '${responseHex}' ]; then ` +
      `printf '\\n%s_%s\\n' AXTERM_OSC52_READ OK; else ` +
      `printf '\\n%s_%s:%s\\n' AXTERM_OSC52_READ MISMATCH "$reply"; fi`;
    await input.pressSequentially(readCommand);
    await input.press('Enter');
    await input.press(process.platform === 'darwin' ? 'Meta+f' : 'Control+f');
    search = layer.getByRole('textbox', { name: '查找终端输出' });
    await expect
      .poll(async () => {
        await search.fill('');
        await search.fill('AXTERM_OSC52_READ_OK');
        return layer.locator('.terminal-search-result').textContent();
      })
      .toBe('已找到');
    await search.press('Escape');
    expect(pageErrors).toEqual([]);
  } finally {
    await app.close();
    await rm(userData, { recursive: true, force: true });
  }
});

test('Unix timestamp selections show a bounded local-time tooltip and clean up across tabs', async () => {
  test.skip(process.platform === 'win32', 'This assertion uses a POSIX shell fixture.');
  const userData = await mkdtemp(resolve(tmpdir(), 'axterm-terminal-timestamp-e2e-'));
  const app = await electron.launch({
    executablePath,
    args: [resolve('apps/desktop'), `--user-data-dir=${userData}`],
    env: { ...process.env, ELECTRON_RENDERER_URL: '' },
  });
  try {
    const page = await app.firstWindow();
    const pageErrors: string[] = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));
    await expect(page.getByTestId('runtime-state')).toHaveAttribute('data-state', 'ready');

    const layer = page.locator('.terminal-session-layer:not([hidden])');
    const terminalHost = layer.locator('.terminal-host');
    const input = layer.locator('.xterm-helper-textarea');
    await expect(terminalHost).toHaveAttribute('data-connection-state', 'connected');
    await input.pressSequentially("printf '\\n1704067200\\n1704067200123\\n17040672001\\n'");
    await input.press('Enter');

    const selectExactOutput = async (value: string) => {
      const row = layer
        .locator('.xterm-rows > div')
        .filter({ hasText: new RegExp(`^${value}$`) })
        .last();
      await expect(row).toBeVisible();
      const bounds = await row.boundingBox();
      expect(bounds).not.toBeNull();
      const pointer = { x: bounds!.x + 6, y: bounds!.y + bounds!.height / 2 };
      await page.mouse.dblclick(pointer.x, pointer.y);
      return pointer;
    };

    const secondsPointer = await selectExactOutput('1704067200');
    const tooltip = page.locator('.terminal-unix-timestamp-tooltip');
    const expectedSeconds = await page.evaluate(() => new Date(1_704_067_200_000).toLocaleString());
    await expect(tooltip).toHaveText(expectedSeconds);
    await expect(tooltip).toHaveCSS('pointer-events', 'none');
    const tooltipBounds = await tooltip.boundingBox();
    const viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
    expect(tooltipBounds).not.toBeNull();
    expect(tooltipBounds!.x).toBeGreaterThanOrEqual(8);
    expect(tooltipBounds!.y).toBeGreaterThanOrEqual(8);
    expect(tooltipBounds!.x + tooltipBounds!.width).toBeLessThanOrEqual(viewport.width - 8);
    expect(tooltipBounds!.y + tooltipBounds!.height).toBeLessThanOrEqual(viewport.height - 8);
    expect(Math.abs(tooltipBounds!.y - (secondsPointer.y - 36))).toBeLessThanOrEqual(1);

    await selectExactOutput('1704067200123');
    const expectedMilliseconds = await page.evaluate(() =>
      new Date(1_704_067_200_123).toLocaleString(),
    );
    await expect(tooltip).toHaveText(expectedMilliseconds);

    await selectExactOutput('17040672001');
    await expect(tooltip).toHaveCount(0);

    await selectExactOutput('1704067200');
    await expect(tooltip).toBeVisible();
    await page.evaluate(() => window.dispatchEvent(new Event('blur')));
    await expect(tooltip).toHaveCount(0);

    await selectExactOutput('1704067200');
    await expect(tooltip).toBeVisible();
    await page.evaluate(() => window.dispatchEvent(new Event('resize')));
    await expect(tooltip).toHaveCount(0);

    const originalTab = page.locator('.pane-tabbar[data-pane-index="0"] .terminal-tab.active');
    const originalId = await originalTab.getAttribute('data-terminal-id');
    expect(originalId).toBeTruthy();
    await selectExactOutput('1704067200');
    await expect(tooltip).toBeVisible();
    await page.locator('.terminal-pane.active .tab-add').click();
    await expect(tooltip).toHaveCount(0);
    await page
      .locator(`.pane-tabbar[data-pane-index="0"] .terminal-tab[data-terminal-id="${originalId!}"]`)
      .click();
    await expect(page.locator(`[data-terminal-session="${originalId!}"]`)).toBeVisible();
    await expect(tooltip).toHaveCount(0);
    expect(pageErrors).toEqual([]);
  } finally {
    await app.close();
    await rm(userData, { recursive: true, force: true });
  }
});

test('safe OSC 633 command history searches, sorts and inserts without automatic execution', async () => {
  test.skip(process.platform === 'win32', 'This assertion uses a POSIX shell fixture.');
  const userData = await mkdtemp(resolve(tmpdir(), 'axterm-command-history-e2e-'));
  const app = await electron.launch({
    executablePath,
    args: [resolve('apps/desktop'), `--user-data-dir=${userData}`],
    env: { ...process.env, ELECTRON_RENDERER_URL: '', SHELL: '/bin/bash' },
  });
  try {
    const page = await app.firstWindow();
    const pageErrors: string[] = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));
    await expect(page.getByTestId('runtime-state')).toHaveAttribute('data-state', 'ready');
    await page.locator('[data-activity-item="setting"]').click();
    await page.locator('[data-settings-category="terminal"]').click();
    const profileForm = page
      .locator('form')
      .filter({ has: page.getByRole('heading', { name: '终端配置' }) });
    await profileForm.getByLabel('名称').fill('B07 Bash');
    await profileForm.getByLabel('Shell', { exact: true }).fill('/bin/bash');
    await profileForm.getByLabel('Shell 参数（每行一个）').fill('--noprofile\n--norc');
    await profileForm.getByRole('button', { name: '保存终端配置' }).click();
    await page.getByRole('button', { name: '关闭设置并返回工作区' }).click();
    await page.getByTitle('新建会话菜单', { exact: true }).click();
    const sessionMenu = page.locator('.session-menu');
    await sessionMenu.getByLabel('终端配置').selectOption({ label: 'B07 Bash' });
    await sessionMenu.getByRole('button', { name: /本地终端/ }).click();
    const layer = page.locator('.terminal-session-layer:not([hidden])');
    const surface = layer.locator('.terminal-surface');
    const terminalHost = layer.locator('.terminal-host');
    const input = layer.locator('.xterm-helper-textarea');
    await expect(terminalHost).toHaveAttribute('data-connection-state', 'connected');
    await expect(surface).toHaveAttribute('data-command-tracking', 'active');

    const historyButton = page.getByRole('button', { name: '命令历史', exact: true });
    await historyButton.click();
    const history = page.getByLabel('命令历史面板');
    await expect(history.getByText('命令历史默认关闭')).toBeVisible();
    await history.getByRole('button', { name: '开启命令历史' }).click();
    await expect(history.getByText('命令历史已开启。')).toBeVisible();
    await historyButton.click();

    const frequent = "printf '\\nB07_FREQUENT_%s\\n' OK";
    const recent = "printf '\\nB07_RECENT_%s\\n' OK";
    await input.pressSequentially(frequent);
    await input.press('Enter');
    await input.pressSequentially(frequent);
    await input.press('Enter');
    await page.waitForTimeout(100);
    await input.pressSequentially(recent);
    await input.press('Enter');
    await input.pressSequentially(' echo B07_LEADING_HIDDEN');
    await input.press('Enter');
    await input.pressSequentially('export B07_SECRET=credential-marker');
    await input.press('Enter');

    await historyButton.click();
    const items = history.locator('.command-history-item-text');
    await expect(items).toHaveCount(2);
    await expect(items.nth(0)).toHaveText(recent);
    await expect(items.nth(1)).toHaveText(frequent);
    await expect(history).not.toContainText('B07_LEADING_HIDDEN');
    await expect(history).not.toContainText('credential-marker');

    await history.getByLabel('搜索命令历史').fill('FREQUENT');
    await expect(items).toHaveCount(1);
    await expect(items.first()).toHaveText(frequent);
    await history.getByLabel('搜索命令历史').fill('');
    await history.getByText('按使用频次排序').click();
    await expect(items.first()).toHaveText(frequent);
    await expect(history.locator('.command-history-count').first()).toHaveAttribute(
      'title',
      '使用 2 次',
    );

    await items.first().click();
    await expect(history).toHaveCount(0);
    await historyButton.click();
    await expect(history.locator('.command-history-count').first()).toHaveAttribute(
      'title',
      '使用 2 次',
    );
    await historyButton.click();
    await input.press('Enter');
    await historyButton.click();
    await expect(history.locator('.command-history-count').first()).toHaveAttribute(
      'title',
      '使用 3 次',
    );

    await historyButton.click();
    const settingsNavigation = page.locator('[data-activity-item="setting"]');
    const workspaceSidebar = page.locator('.workspace-sidebar');
    await settingsNavigation.click();
    if (!(await workspaceSidebar.isVisible())) await settingsNavigation.click();
    await page.locator('[data-settings-category="shortcuts"]').click();
    const commandHistorySettings = page.locator(
      '[aria-labelledby="command-history-settings-title"]',
    );
    const recordingToggle = commandHistorySettings.getByRole('checkbox', {
      name: '记录安全命令历史',
    });
    await expect(recordingToggle).toBeChecked();
    await recordingToggle.click();
    await expect(recordingToggle).not.toBeChecked();
    await page.getByRole('button', { name: '关闭设置并返回工作区' }).click();
    await page.locator('.pane-tabbar-scroll .terminal-tab').last().click();
    await historyButton.click();
    await expect(history.getByText('命令历史默认关闭')).toBeVisible();
    await history.getByRole('button', { name: '开启命令历史' }).click();
    await expect(history.getByText('暂无安全命令历史。')).toBeVisible();
    expect(pageErrors).toEqual([]);
  } finally {
    await app.close();
    await rm(userData, { recursive: true, force: true });
  }
});

test('command history survives a cold desktop restart', async () => {
  test.skip(process.platform === 'win32', 'This assertion uses a POSIX shell fixture.');
  const userData = await mkdtemp(resolve(tmpdir(), 'axterm-command-history-restart-'));
  let app = await electron.launch({
    executablePath,
    args: [resolve('apps/desktop'), `--user-data-dir=${userData}`],
    env: { ...process.env, ELECTRON_RENDERER_URL: '', SHELL: '/bin/bash' },
  });
  try {
    let page = await app.firstWindow();
    await expect(page.getByTestId('runtime-state')).toHaveAttribute('data-state', 'ready');
    await page.locator('[data-activity-item="setting"]').click();
    await page.locator('[data-settings-category="terminal"]').click();
    const profileForm = page
      .locator('form')
      .filter({ has: page.getByRole('heading', { name: '终端配置' }) });
    await profileForm.getByLabel('名称').fill('B07 Restart Bash');
    await profileForm.getByLabel('Shell', { exact: true }).fill('/bin/bash');
    await profileForm.getByLabel('Shell 参数（每行一个）').fill('--noprofile\n--norc');
    await profileForm.getByRole('button', { name: '保存终端配置' }).click();
    await page.getByRole('button', { name: '关闭设置并返回工作区' }).click();
    await page.getByTitle('新建会话菜单', { exact: true }).click();
    const sessionMenu = page.locator('.session-menu');
    await sessionMenu.getByLabel('终端配置').selectOption({ label: 'B07 Restart Bash' });
    await sessionMenu.getByRole('button', { name: /本地终端/ }).click();
    const layer = page.locator('.terminal-session-layer:not([hidden])');
    await expect(layer.locator('.terminal-host')).toHaveAttribute(
      'data-connection-state',
      'connected',
    );
    await expect(layer.locator('.terminal-surface')).toHaveAttribute(
      'data-command-tracking',
      'active',
    );

    const historyButton = page.getByRole('button', { name: '命令历史', exact: true });
    await historyButton.click();
    let history = page.getByLabel('命令历史面板');
    await history.getByRole('button', { name: '开启命令历史' }).click();
    await historyButton.click();
    const persisted = "printf '\\nB07_RESTART_PERSISTED\\n'";
    const input = layer.locator('.xterm-helper-textarea');
    await input.pressSequentially(persisted);
    await input.press('Enter');
    await historyButton.click();
    await expect(history.locator('.command-history-item-text')).toHaveText(persisted);

    await app.close();
    app = await electron.launch({
      executablePath,
      args: [resolve('apps/desktop'), `--user-data-dir=${userData}`],
      env: { ...process.env, ELECTRON_RENDERER_URL: '', SHELL: '/bin/bash' },
    });
    page = await app.firstWindow();
    await expect(page.getByTestId('runtime-state')).toHaveAttribute('data-state', 'ready');
    await page.getByRole('button', { name: '命令历史', exact: true }).click();
    history = page.getByLabel('命令历史面板');
    await expect(history.locator('.command-history-item-text')).toHaveText(persisted);
  } finally {
    await app.close();
    await rm(userData, { recursive: true, force: true });
  }
});

test('touch shortcut bar edits, reorders and sends control bytes to the active PTY', async () => {
  test.skip(process.platform === 'win32', 'This assertion uses a POSIX cat fixture.');
  const userData = await mkdtemp(resolve(tmpdir(), 'axterm-shortcut-bar-e2e-'));
  const app = await electron.launch({
    executablePath,
    args: [resolve('apps/desktop'), `--user-data-dir=${userData}`],
    env: { ...process.env, ELECTRON_RENDERER_URL: '' },
  });
  try {
    const page = await app.firstWindow();
    const pageErrors: string[] = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));
    await expect(page.getByTestId('runtime-state')).toHaveAttribute('data-state', 'ready');
    const layer = page.locator('.terminal-session-layer:not([hidden])');
    const host = layer.locator('.terminal-host');
    const input = layer.locator('.xterm-helper-textarea');
    await expect(host).toHaveAttribute('data-connection-state', 'connected');
    await input.focus();

    await host.evaluate((element) => {
      element.dispatchEvent(
        new PointerEvent('pointerdown', { bubbles: true, pointerType: 'touch' }),
      );
      const viewport = window.visualViewport;
      if (!viewport) throw new Error('visualViewport unavailable');
      Object.defineProperty(viewport, 'height', {
        configurable: true,
        value: Math.max(240, viewport.height - 260),
      });
      viewport.dispatchEvent(new Event('resize'));
    });

    const bar = page.getByRole('toolbar', { name: '终端快捷键栏' });
    await expect(bar).toBeVisible();
    await expect(page.locator('body')).toHaveClass(/shortcut-bar-on/u);
    await input.pressSequentially("printf '\\nC13_SHORTCUT_ENTER_OK\\n'");

    await bar.getByRole('button', { name: '编辑快捷键栏' }).click();
    const editor = page.getByRole('dialog', { name: '编辑快捷键栏' });
    await expect(editor).toBeVisible();
    await editor.getByRole('button', { name: '向后移动 Esc' }).click();
    await expect(editor.locator('.terminal-shortcut-active-item > span').first()).toHaveText('Tab');
    await editor.getByLabel('搜索快捷键候选').fill('Space');
    await editor.getByRole('button', { name: 'Space', exact: true }).click();
    await editor.getByLabel('第一个修饰键').selectOption('shift');
    await editor.getByLabel('快捷键按键').selectOption('key-a');
    await editor.getByRole('button', { name: '添加', exact: true }).click();
    await editor.getByRole('button', { name: '关闭快捷键编辑器' }).click();

    await bar.getByRole('button', { name: 'Enter', exact: true }).click();
    await expect
      .poll(() => layer.locator('.xterm-rows').textContent())
      .toContain('C13_SHORTCUT_ENTER_OK');
    await bar.getByRole('button', { name: 'Shift+A', exact: true }).click();
    await expect(bar).toHaveAttribute('data-last-send', 'accepted');
    await expect.poll(() => layer.locator('.xterm-rows').textContent()).toContain('A');
    await bar.getByRole('button', { name: 'Ctrl+C', exact: true }).click();

    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.setSize(600, 700);
    });
    await expect
      .poll(() =>
        bar.locator('.terminal-shortcut-bar-scroll').evaluate((element) => ({
          client: element.clientWidth,
          scroll: element.scrollWidth,
        })),
      )
      .toEqual(expect.objectContaining({ client: expect.any(Number), scroll: expect.any(Number) }));
    const overflow = await bar
      .locator('.terminal-shortcut-bar-scroll')
      .evaluate((element) => element.scrollWidth > element.clientWidth);
    expect(overflow).toBe(true);

    await bar.getByRole('button', { name: '收起快捷键栏' }).click();
    await expect(bar).toHaveCount(0);
    await host.evaluate((element) =>
      element.dispatchEvent(
        new PointerEvent('pointerdown', { bubbles: true, pointerType: 'touch' }),
      ),
    );
    await expect(page.getByRole('toolbar', { name: '终端快捷键栏' })).toBeVisible();
    expect(pageErrors).toEqual([]);
  } finally {
    await app.close().catch(() => {});
    await rm(userData, { recursive: true, force: true });
  }
});

test('command suggestions rank history, support keyboard insertion and never execute selection', async () => {
  test.skip(process.platform === 'win32', 'This assertion uses a POSIX bash fixture.');
  const userData = await mkdtemp(resolve(tmpdir(), 'axterm-command-suggestions-e2e-'));
  const app = await electron.launch({
    executablePath,
    args: [resolve('apps/desktop'), `--user-data-dir=${userData}`],
    env: { ...process.env, ELECTRON_RENDERER_URL: '', SHELL: '/bin/bash' },
  });
  try {
    const page = await app.firstWindow();
    const pageErrors: string[] = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));
    await expect(page.getByTestId('runtime-state')).toHaveAttribute('data-state', 'ready');

    await page.locator('[data-activity-item="setting"]').click();
    await page.locator('[data-settings-category="terminal"]').click();
    const profileForm = page
      .locator('form')
      .filter({ has: page.getByRole('heading', { name: '终端配置' }) });
    await profileForm.getByLabel('名称').fill('C14 Bash');
    await profileForm.getByLabel('Shell', { exact: true }).fill('/bin/bash');
    await profileForm.getByLabel('Shell 参数（每行一个）').fill('--noprofile\n--norc');
    await profileForm.getByRole('button', { name: '保存终端配置' }).click();
    const suggestionsToggle = page.getByRole('checkbox', { name: '输入时显示命令建议' });
    await suggestionsToggle.click();
    await expect(suggestionsToggle).toBeChecked();
    await page.getByRole('button', { name: '关闭设置并返回工作区' }).click();
    await page.getByTitle('新建会话菜单', { exact: true }).click();
    const sessionMenu = page.locator('.session-menu');
    await sessionMenu.getByLabel('终端配置').selectOption({ label: 'C14 Bash' });
    await sessionMenu.getByRole('button', { name: /本地终端/ }).click();

    const layer = page.locator('.terminal-session-layer:not([hidden])');
    const surface = layer.locator('.terminal-surface');
    const input = layer.locator('.xterm-helper-textarea');
    await expect(layer.locator('.terminal-host')).toHaveAttribute(
      'data-connection-state',
      'connected',
    );
    await expect(surface).toHaveAttribute('data-command-tracking', 'active');

    const historyButton = page.getByRole('button', { name: '命令历史', exact: true });
    await historyButton.click();
    await page.getByLabel('命令历史面板').getByRole('button', { name: '开启命令历史' }).click();
    await historyButton.click();

    const alpha = `AXC14=$((AXC14+1)); printf '\\nC14_ALPHA_%s\\n' "$AXC14"`;
    const beta = `AXC14=$((AXC14+1)); printf '\\nC14_BETA_%s\\n' "$AXC14"`;
    for (const [index, command] of [alpha, beta, alpha].entries()) {
      await input.pressSequentially(command);
      await input.press('Enter');
      await expect
        .poll(() => layer.locator('.xterm-rows').textContent())
        .toContain(index === 1 ? 'C14_BETA_2' : `C14_ALPHA_${index === 0 ? 1 : 3}`);
    }
    await historyButton.click();
    await expect(page.getByLabel('命令历史面板').locator('.command-history-item-text')).toHaveCount(
      2,
    );
    await historyButton.click();
    await input.pressSequentially('AXC14=0');
    await input.press('Enter');
    await page.waitForTimeout(100);
    await input.pressSequentially('clear');
    await input.press('Enter');
    await page.waitForTimeout(100);

    const prefix = `AXC14=$((AXC14+1)); printf '\\nC14_`;
    await input.pressSequentially(prefix);
    const suggestions = page.getByLabel('终端命令建议');
    await expect(suggestions).toBeVisible();
    await expect(suggestions.getByRole('option').first()).toContainText('C14_ALPHA');
    await expect(suggestions.getByRole('option').first()).toContainText('H');

    await input.press('ArrowDown');
    await expect(suggestions.getByRole('option').first()).toHaveAttribute('aria-selected', 'true');
    await input.press('Enter');
    await expect(suggestions).toHaveCount(0);
    await expect
      .poll(() => layer.locator('.xterm-rows').textContent())
      .not.toContain('C14_ALPHA_1');
    await input.press('Enter');
    await expect.poll(() => layer.locator('.xterm-rows').textContent()).toContain('C14_ALPHA_1');

    await input.pressSequentially(prefix);
    await expect(suggestions).toBeVisible();
    await input.press('Escape');
    await expect(suggestions).toHaveCount(0);
    await input.press('Control+u');

    await input.pressSequentially(prefix);
    await expect(suggestions).toBeVisible();
    const firstSuggestion = suggestions.getByRole('option').first();
    const deleteSuggestion = firstSuggestion.locator('.terminal-suggestion-delete');
    await firstSuggestion.hover();
    await expect(deleteSuggestion).toBeVisible();
    await deleteSuggestion.click();
    await expect(suggestions.getByRole('option').first()).toContainText('C14_BETA');
    expect(pageErrors).toEqual([]);
  } finally {
    await app.close().catch(() => {});
    await rm(userData, { recursive: true, force: true });
  }
});

test('terminal file drop asks and native folders load full paths without executing', async () => {
  test.skip(process.platform === 'win32', 'This assertion uses a POSIX cat fixture.');
  const userData = await mkdtemp(resolve(tmpdir(), 'axterm-terminal-file-drop-e2e-'));
  const app = await launchLocalOptimizationApp({
    executablePath,
    args: [resolve('apps/desktop'), `--user-data-dir=${userData}`],
    env: { ...process.env, ELECTRON_RENDERER_URL: '', SHELL: '/bin/bash' },
  });
  try {
    const page = await app.firstWindow();
    const pageErrors: string[] = [];
    const imported: string[] = [];
    const revoked: string[] = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));
    page.on('request', (request) => {
      if (request.method() === 'POST' && request.url().endsWith('/api/v1/file-grants/import'))
        imported.push(request.url());
      if (request.method() === 'DELETE' && request.url().includes('/api/v1/file-grants/'))
        revoked.push(request.url());
    });
    await expect(page.getByTestId('runtime-state')).toHaveAttribute('data-state', 'ready');
    const settingsNavigation = page.locator('[data-activity-item="setting"]');
    await settingsNavigation.click();
    await page.locator('[data-settings-category="terminal"]').click();
    const profileForm = page
      .locator('form')
      .filter({ has: page.getByRole('heading', { name: '终端配置' }) });
    await profileForm.getByLabel('名称').fill('C15 Bash');
    await profileForm.getByLabel('Shell', { exact: true }).fill('/bin/bash');
    await profileForm.getByLabel('Shell 参数（每行一个）').fill('--noprofile\n--norc');
    await profileForm.getByRole('button', { name: '保存终端配置' }).click();
    await page.getByRole('button', { name: '关闭设置并返回工作区' }).click();
    await page.getByTitle('新建会话菜单', { exact: true }).click();
    const sessionMenu = page.locator('.session-menu');
    await sessionMenu.getByLabel('终端配置').selectOption({ label: 'C15 Bash' });
    await sessionMenu.getByRole('button', { name: /本地终端/ }).click();
    const layer = page.locator('.terminal-session-layer:not([hidden])');
    const surface = layer.locator('.terminal-surface');
    const input = layer.locator('.xterm-helper-textarea');
    await expect(layer.locator('.terminal-host')).toHaveAttribute(
      'data-connection-state',
      'connected',
    );
    await expect(surface).toHaveAttribute('data-command-tracking', 'active');

    const drop = (files: Array<{ name: string; content: string }>) =>
      surface.evaluate((element, entries) => {
        const transfer = new DataTransfer();
        for (const entry of entries)
          transfer.items.add(new File([entry.content], entry.name, { type: 'text/plain' }));
        element.dispatchEvent(
          new DragEvent('dragenter', { bubbles: true, cancelable: true, dataTransfer: transfer }),
        );
        element.dispatchEvent(
          new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer }),
        );
      }, files);

    await drop([{ name: 'c15-canceled.txt', content: 'C15_CANCELED_SHOULD_NOT_RUN' }]);
    let dialog = page.getByRole('dialog', { name: '如何处理拖放的文件？' });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText('c15-canceled.txt')).toBeVisible();
    await expect(dialog.getByRole('button', { name: '上传到当前目录' })).toBeDisabled();
    await dialog.getByRole('button', { name: '取消' }).click();
    await expect(dialog).toHaveCount(0);
    await expect.poll(() => revoked.length).toBe(1);

    await input.pressSequentially('cat ');
    await drop([{ name: 'c15 inserted.txt', content: 'C15_LOCAL_DROP_OK' }]);
    dialog = page.getByRole('dialog', { name: '如何处理拖放的文件？' });
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: '插入本地临时路径' }).click();
    await expect(page.getByText(/已插入 1 个本地临时路径/)).toBeVisible();
    await expect
      .poll(() => layer.locator('.xterm-rows').textContent())
      .not.toContain('C15_LOCAL_DROP_OK');
    await input.press('Enter');
    await expect
      .poll(() => layer.locator('.xterm-rows').textContent())
      .toContain('C15_LOCAL_DROP_OK');

    const folder = resolve(userData, '中文 folder "$`marker`');
    const replacementFolder = resolve(userData, 'replacement folder');
    await mkdir(folder);
    await mkdir(replacementFolder);
    await writeFile(resolve(folder, 'folder-content.txt'), 'DIRECTORY_CONTENT');
    await writeFile(resolve(replacementFolder, 'replacement-content.txt'), 'REPLACEMENT_CONTENT');
    const canonicalFolder = await realpath(folder);
    const nativeDrop = async (target: Locator, directory: string) => {
      const bounds = await target.boundingBox();
      expect(bounds).not.toBeNull();
      const session = await page.context().newCDPSession(page);
      try {
        const data = { items: [], files: [directory], dragOperationsMask: 1 };
        for (const type of ['dragEnter', 'dragOver', 'drop'] as const)
          await session.send('Input.dispatchDragEvent', {
            type,
            x: bounds!.x + bounds!.width / 2,
            y: bounds!.y + bounds!.height / 2,
            data,
          });
      } finally {
        await session.detach();
      }
    };
    await input.pressSequentially("printf 'FOLDER_DROP_PATH=%s\\n' ");
    await nativeDrop(surface, folder);
    await expect(layer.locator('.terminal-action-feedback')).toHaveText(
      '已填入 1 个文件夹完整路径，请检查后自行按 Enter。',
    );
    await expect.poll(() => revoked.length).toBe(2);
    await expect
      .poll(() => layer.locator('.xterm-rows').textContent())
      .not.toContain(`FOLDER_DROP_PATH=${canonicalFolder}`);
    await input.press('Enter');
    await expect
      .poll(() => layer.locator('.xterm-rows').textContent())
      .toContain(`FOLDER_DROP_PATH=${canonicalFolder}`);
    await expect(page.getByRole('dialog', { name: '如何处理拖放的文件？' })).toHaveCount(0);

    await page.screenshot({ path: test.info().outputPath('native-folder-terminal.png') });
    const modes = page.getByRole('tablist', { name: '会话工具' }).first();
    await modes.getByRole('tab', { name: '文件管理' }).click();
    const localPane = page.locator('.file-pane-local:visible');
    await expect(localPane.locator('.file-table-scroll')).toBeVisible();
    await nativeDrop(localPane, folder);
    await expect(localPane.locator('.file-address-bar input')).toHaveValue(canonicalFolder);
    await expect(localPane.getByText('folder-content.txt', { exact: true })).toBeVisible();
    await page.screenshot({ path: test.info().outputPath('native-folder-local-pane.png') });
    await nativeDrop(localPane, replacementFolder);
    await expect(localPane.locator('.file-address-bar input')).toHaveValue(
      await realpath(replacementFolder),
    );
    await expect(localPane.getByText('replacement-content.txt', { exact: true })).toBeVisible();
    await expect(localPane.getByText('folder-content.txt', { exact: true })).toHaveCount(0);
    await expect.poll(() => revoked.length).toBe(4);
    await modes.getByRole('tab', { name: '终端', exact: true }).click();

    await settingsNavigation.click();
    await page.locator('[data-settings-category="terminal"]').click();
    const behavior = page.getByLabel('拖放文件到终端');
    await behavior.selectOption('upload');
    await expect(behavior).toHaveValue('upload');
    await page.getByRole('button', { name: '关闭设置并返回工作区' }).click();
    await page.locator('.pane-tabbar-scroll .terminal-tab').last().click();
    await drop([{ name: 'c15-no-sftp.txt', content: 'C15_NO_SFTP' }]);
    await expect(layer.locator('.terminal-action-feedback')).toHaveText(
      '当前会话没有可用的 SSH/SFTP 连接。',
    );
    await expect(page.getByRole('dialog', { name: '如何处理拖放的文件？' })).toHaveCount(0);

    expect(imported).toHaveLength(2);
    expect(pageErrors).toEqual([]);
  } finally {
    await app.close().catch(() => {});
    await rm(userData, { recursive: true, force: true });
  }
});
