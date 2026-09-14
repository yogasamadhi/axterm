import { createHash, generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { once } from 'node:events';
import { cp, mkdtemp, rm, access, realpath, mkdir, readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { _electron as electron, expect, test } from '@playwright/test';
import { CredentialVault } from '../../apps/desktop/src/main/host-capabilities/credential-vault';
import { ProductDatabase } from '../../packages/runtime/src/adapters/sqlite/database';
import { ProductRepository } from '../../packages/runtime/src/adapters/sqlite/product-repository';
import { QuickCommandRepository } from '../../packages/runtime/src/adapters/sqlite/quick-command-repository';

const defaultArtifact =
  process.platform === 'darwin'
    ? `release/mac${process.arch === 'arm64' ? '-arm64' : ''}/Axterm.app`
    : process.platform === 'win32'
      ? 'release/win-unpacked'
      : 'release/linux-unpacked';
const source = process.env.AXTERM_PACKAGED_APP ?? defaultArtifact;
const sshFixturePort = Number(process.env.AXTERM_SSH_FIXTURE_PORT ?? 0);
const packagedEvidenceDirectory = 'tests/parity/screenshots/axterm/packaged';

test('packaged app runs the signed updater without exposing its installer path', async () => {
  test.setTimeout(90_000);
  await access(source);
  await mkdir(packagedEvidenceDirectory, { recursive: true });
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'axterm-packaged-updater-')));
  const artifact = join(directory, process.platform === 'darwin' ? 'Axterm.app' : 'app');
  await cp(source, artifact, { recursive: true, verbatimSymlinks: true });
  const executablePath =
    process.platform === 'darwin'
      ? join(artifact, 'Contents/MacOS/Axterm')
      : join(artifact, process.platform === 'win32' ? 'Axterm.exe' : 'axterm');
  const userData = join(directory, 'user-data');
  const updateArtifact = Buffer.alloc(512 * 1024, 0x5a);
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
        'Content-Length': updateArtifact.byteLength,
      });
      response.end(updateArtifact);
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
    notes: 'Packaged signed update fixture',
    artifact: {
      url: `${origin}/axterm-0.11.0.zip`,
      fileName: 'axterm-0.11.0.zip',
      size: updateArtifact.byteLength,
      sha256: createHash('sha256').update(updateArtifact).digest('hex'),
      signature: Buffer.alloc(64).toString('base64'),
    },
  };
  const canonical = [
    unsigned.version,
    unsigned.publishedAt,
    unsigned.artifact.fileName,
    String(unsigned.artifact.size),
    unsigned.artifact.sha256,
    unsigned.artifact.url,
  ].join('\n');
  fixtureState.manifest = {
    ...unsigned,
    artifact: {
      ...unsigned.artifact,
      signature: sign(null, Buffer.from(canonical), privateKey).toString('base64'),
    },
  };
  let launchedApp: Awaited<ReturnType<typeof electron.launch>> | undefined;
  try {
    const app = await electron.launch({
      executablePath,
      args: [`--user-data-dir=${userData}`],
      cwd: directory,
      env: {
        ...process.env,
        ELECTRON_RENDERER_URL: '',
        PATH: process.platform === 'win32' ? (process.env.SystemRoot ?? '') : '/usr/bin:/bin',
        AXTERM_UPDATE_MANIFEST_URL: `${origin}/manifest.json`,
        AXTERM_UPDATE_PUBLIC_KEY_BASE64: publicKey
          .export({ format: 'der', type: 'spki' })
          .toString('base64'),
      },
    });
    launchedApp = app;
    await app.evaluate(({ shell }) => {
      (globalThis as unknown as { openedInstallers: string[] }).openedInstallers = [];
      shell.openPath = (async (path: string) => {
        (globalThis as unknown as { openedInstallers: string[] }).openedInstallers.push(path);
        return '';
      }) as typeof shell.openPath;
    });
    const page = await app.firstWindow();
    await expect(page.getByTestId('runtime-state')).toHaveAttribute('data-state', 'ready');
    expect(await app.evaluate(({ app }) => app.isPackaged)).toBe(true);
    await page.locator('[data-activity-item="setting"]').click();
    await page.locator('[data-settings-category="common"]').click();
    const updater = page.locator('.updater-panel');
    await updater.getByRole('button', { name: /Check for updates|检查更新/ }).click();
    await expect(updater).toContainText(/Update available|发现新版本/);
    await updater.getByRole('button', { name: /Download|下载/ }).click();
    await expect(updater).toContainText(/Ready to install|可以安装/);
    expect(await page.locator('body').innerText()).not.toContain(join(userData, 'updates'));
    await page.screenshot({ path: join(packagedEvidenceDirectory, 'updater-ready.png') });
    await updater.getByRole('button', { name: /Open installer|打开安装包/ }).click();
    await expect
      .poll(() =>
        app.evaluate(
          () => (globalThis as unknown as { openedInstallers: string[] }).openedInstallers,
        ),
      )
      .toEqual([join(userData, 'updates', 'axterm-0.11.0.zip')]);
  } finally {
    await launchedApp?.close().catch(() => {});
    fixture.closeAllConnections();
    await new Promise<void>((resolveClose) => fixture.close(() => resolveClose()));
    await rm(directory, { recursive: true, force: true });
  }
});

test('packaged app starts independently of checkout and system Node', async () => {
  await access(source);
  await mkdir(packagedEvidenceDirectory, { recursive: true });
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'axterm-packaged-')));
  try {
    const artifact = join(directory, process.platform === 'darwin' ? 'Axterm.app' : 'app');
    // Preserve framework symlinks; fs.cp otherwise rewrites them to source paths.
    await cp(source, artifact, { recursive: true, verbatimSymlinks: true });
    const executablePath =
      process.platform === 'darwin'
        ? join(artifact, 'Contents/MacOS/Axterm')
        : join(artifact, process.platform === 'win32' ? 'Axterm.exe' : 'axterm');
    let app = await electron.launch({
      executablePath,
      args: [`--user-data-dir=${join(directory, 'user-data')}`],
      cwd: directory,
      env: {
        ...process.env,
        ELECTRON_RENDERER_URL: '',
        PATH: process.platform === 'win32' ? (process.env.SystemRoot ?? '') : '/usr/bin:/bin',
      },
    });
    try {
      const page = await app.firstWindow();
      await expect(page.getByTestId('runtime-state')).toHaveAttribute('data-state', 'ready');
      expect(page.url()).toMatch(/^http:\/\/127\.0\.0\.1:\d+\//);
      const layout = await app.evaluate(({ app }) => ({
        packaged: app.isPackaged,
        path: app.getAppPath(),
      }));
      expect(layout.packaged).toBe(true);
      expect(layout.path).toContain('app.asar');
      expect(layout.path.startsWith(resolve(directory))).toBe(true);
      await expect
        .poll(() =>
          app.evaluate(({ BrowserWindow }) => {
            const bounds = BrowserWindow.getAllWindows()[0]!.getBounds();
            return { width: bounds.width, height: bounds.height };
          }),
        )
        .toEqual({ width: 1440, height: 900 });
      const activeTab = page.locator('.pane-tabbar .terminal-tab.active');
      await expect(activeTab).toHaveCount(1);
      const initialTerminalId = await activeTab.getAttribute('data-terminal-id');
      await page.getByTitle('新建本地终端').click();
      await expect
        .poll(() => activeTab.getAttribute('data-terminal-id'))
        .not.toBe(initialTerminalId);
      const terminalLayer = page.locator('.terminal-session-layer:not([hidden])');
      const terminalInput = terminalLayer.locator('.xterm-helper-textarea');
      await expect(terminalLayer.locator('.terminal-host')).toHaveAttribute(
        'data-connection-state',
        'connected',
      );
      await terminalInput.pressSequentially("printf '\\nAXTERM_PACKAGED_PTY_OK\\n'");
      await terminalInput.press('Enter');
      await expect
        .poll(() => terminalLayer.locator('.xterm-rows').textContent())
        .toContain('AXTERM_PACKAGED_PTY_OK');
      await page.screenshot({ path: join(packagedEvidenceDirectory, 'terminal.png') });
      await terminalInput.press(process.platform === 'darwin' ? 'Meta+f' : 'Control+f');
      const search = terminalLayer.getByPlaceholder('查找终端输出');
      await expect
        .poll(async () => {
          await search.fill('');
          await search.fill('AXTERM_PACKAGED_PTY_OK');
          return terminalLayer.locator('.terminal-search-result').textContent();
        })
        .toBe('已找到');
      await page.locator('[data-activity-item="bookmarks"]').click();
      await page.locator('.workspace-sidebar').getByRole('button', { name: '管理' }).click();
      await page.getByRole('button', { name: '添加主机' }).click();
      await page.getByLabel('显示名称').fill('packaged-sqlite');
      await page.getByLabel('主机地址').fill('127.0.0.1');
      await page.getByLabel('用户名').fill('fixture');
      await page.getByLabel('认证方式').selectOption('agent');
      await page.getByRole('button', { name: '保存', exact: true }).click();
      await expect(
        page.locator('.host-card').getByText('packaged-sqlite', { exact: true }),
      ).toBeVisible();
      await page.getByRole('button', { name: '添加串口' }).click();
      await expect(page.getByTestId('serial-enumeration-ready')).toContainText(/已枚举 \d+ 个串口/);
      await page.getByRole('button', { name: '取消' }).click();
      await page.screenshot({ path: join(packagedEvidenceDirectory, 'hosts.png') });

      await page
        .locator('.app-sidebar nav')
        .getByRole('button', { name: /^快捷命令/ })
        .click();
      await page.locator('.workspace-sidebar').getByRole('button', { name: '打开工作区' }).click();
      const commands = page.getByTestId('quick-command-workspace');
      await commands
        .locator('.quick-command-toolbar')
        .getByRole('button', { name: '新建快捷命令', exact: true })
        .click();
      const editor = commands.locator('.quick-command-form');
      await editor.getByLabel('名称', { exact: true }).fill('Packaged health');
      await editor.getByLabel('步骤 1 命令').fill('uptime');
      await editor.getByRole('button', { name: '保存', exact: true }).click();
      await expect(
        commands.locator('.quick-command-tree-row').filter({ hasText: 'Packaged health' }),
      ).toBeVisible();
      await page.screenshot({ path: join(packagedEvidenceDirectory, 'commands.png') });

      await page.locator('[data-activity-item="setting"]').click();
      await expect(page.getByRole('tab', { name: 'UI主题' })).toBeVisible();
      await expect(page.getByRole('tab', { name: /组件/ })).toBeVisible();
      await page.screenshot({ path: join(packagedEvidenceDirectory, 'settings.png') });

      await app.close();
      app = await electron.launch({
        executablePath,
        args: [`--user-data-dir=${join(directory, 'user-data')}`],
        cwd: directory,
        env: {
          ...process.env,
          ELECTRON_RENDERER_URL: '',
          PATH: process.platform === 'win32' ? (process.env.SystemRoot ?? '') : '/usr/bin:/bin',
        },
      });
      const restored = await app.firstWindow();
      await expect(restored.getByTestId('runtime-state')).toHaveAttribute('data-state', 'ready');
      await restored.locator('[data-activity-item="bookmarks"]').click();
      await restored.locator('.workspace-sidebar').getByRole('button', { name: '管理' }).click();
      await expect(
        restored.locator('.host-card').getByText('packaged-sqlite', { exact: true }),
      ).toBeVisible();
      await restored
        .locator('.app-sidebar nav')
        .getByRole('button', { name: /^快捷命令/ })
        .click();
      await restored
        .locator('.workspace-sidebar')
        .getByRole('button', { name: '打开工作区' })
        .click();
      await expect(
        restored.locator('.quick-command-tree-row').filter({ hasText: 'Packaged health' }),
      ).toBeVisible();
      await restored.screenshot({ path: join(packagedEvidenceDirectory, 'restart.png') });
    } finally {
      await app.close().catch(() => {});
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('packaged Phase 12 shell preserves tab, pane, workspace and window behavior', async () => {
  test.setTimeout(120_000);
  await access(source);
  await mkdir(packagedEvidenceDirectory, { recursive: true });
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'axterm-packaged-phase12-')));
  const artifact = join(directory, process.platform === 'darwin' ? 'Axterm.app' : 'app');
  await cp(source, artifact, { recursive: true, verbatimSymlinks: true });
  const executablePath =
    process.platform === 'darwin'
      ? join(artifact, 'Contents/MacOS/Axterm')
      : join(artifact, process.platform === 'win32' ? 'Axterm.exe' : 'axterm');
  const userData = join(directory, 'user-data');
  const launch = () =>
    electron.launch({
      executablePath,
      args: [`--user-data-dir=${userData}`],
      cwd: directory,
      env: {
        ...process.env,
        ELECTRON_RENDERER_URL: '',
        PATH: process.platform === 'win32' ? (process.env.SystemRoot ?? '') : '/usr/bin:/bin',
      },
    });
  let app = await launch();
  try {
    let page = await app.firstWindow();
    await expect(page.getByTestId('runtime-state')).toHaveAttribute('data-state', 'ready');
    await expect
      .poll(() =>
        app.evaluate(({ BrowserWindow }) => {
          const bounds = BrowserWindow.getAllWindows()[0]!.getBounds();
          return { width: bounds.width, height: bounds.height };
        }),
      )
      .toEqual({ width: 1440, height: 900 });

    const rail = page.locator('.activity-bar');
    await expect(rail.locator('[data-activity-item]')).toHaveCount(7);
    await page.locator('[data-activity-item="bookmarks"]').click();
    await expect(page.locator('.workspace-sidebar')).toBeVisible();
    await page.getByTitle('收起侧栏').click();
    await expect(page.locator('.workspace-sidebar')).toBeHidden();
    await page.locator('[data-activity-item="bookmarks"]').click();
    await expect(page.locator('.workspace-sidebar')).toBeVisible();

    await page.getByTitle('新建会话', { exact: true }).click();
    const sessionMenu = page.locator('.session-menu');
    await expect(sessionMenu).toBeVisible();
    await sessionMenu.locator('#quick-connect').fill('invalid protocol://');
    await sessionMenu.locator('#quick-connect').press('Enter');
    await expect(sessionMenu.locator('.menu-error')).toBeVisible();
    await page.keyboard.press('Escape');

    for (let index = 0; index < 3; index++)
      await page.locator('.terminal-pane.active .tab-add').click();
    const paneTabs = page.locator('.pane-tabbar[data-pane-index="0"] .terminal-tab');
    await expect(paneTabs).toHaveCount(4);
    await expect(paneTabs.locator('.tab-number')).toHaveText(['1', '2', '3', '4']);
    const initialIds = await paneTabs.evaluateAll((elements) =>
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
      .toEqual([initialIds[1], initialIds[0], initialIds[2], initialIds[3]]);

    const renameCandidate = paneTabs.nth(1);
    const renameCandidateId = await renameCandidate.getAttribute('data-terminal-id');
    expect(renameCandidateId).toBeTruthy();
    const namedTab = page.locator(
      `.pane-tabbar[data-pane-index="0"] .terminal-tab[data-terminal-id="${renameCandidateId!}"]`,
    );
    await namedTab.click({ button: 'right' });
    const contextMenu = page.locator('.tab-context-menu');
    await expect(contextMenu.getByRole('button', { name: '复制标签' })).toBeVisible();
    await expect(contextMenu.getByRole('button', { name: '关闭其他标签' })).toBeVisible();
    await contextMenu.getByRole('button', { name: '固定标签' }).click();
    await namedTab.click({ button: 'right' });
    await contextMenu.getByRole('button', { name: '重命名' }).click();
    await namedTab.locator('.tab-rename').fill('打包四窗格');
    await namedTab.locator('.tab-rename').press('Enter');
    await expect(namedTab).toHaveClass(/pinned/);

    const tabIds = await paneTabs.evaluateAll((elements) =>
      elements
        .map((element) => element.getAttribute('data-terminal-id'))
        .filter((id): id is string => !!id),
    );
    const activeTerminalId = await page
      .locator('.pane-tabbar[data-pane-index="0"] .terminal-tab.active')
      .getAttribute('data-terminal-id');
    expect(activeTerminalId).toBeTruthy();

    await page.getByTitle('布局与工作区').click();
    await page.locator('[data-layout-choice="c2x2"]').click();
    await expect(page.locator('.terminal-pane')).toHaveCount(4);
    const assignable = tabIds.filter((id) => id !== activeTerminalId);
    for (let paneIndex = 1; paneIndex < 4; paneIndex++)
      await page
        .getByLabel(`为窗格 ${paneIndex + 1} 选择已有会话`)
        .selectOption(assignable[paneIndex - 1]!);
    await expect(page.locator('.terminal-host:visible')).toHaveCount(4);

    const firstPane = page.locator('.terminal-pane').first();
    const before = await firstPane.boundingBox();
    const divider = page.locator('.pane-resizer.vertical').first();
    const handle = await divider.boundingBox();
    expect(before).toBeTruthy();
    expect(handle).toBeTruthy();
    await page.mouse.move(handle!.x + 2, handle!.y + 20);
    await page.mouse.down();
    await page.mouse.move(handle!.x + 80, handle!.y + 20, { steps: 4 });
    await page.mouse.up();
    await expect
      .poll(async () => (await firstPane.boundingBox())!.width)
      .toBeGreaterThan(before!.width + 10);

    const secondPane = page.locator('.terminal-pane').nth(1);
    await secondPane.getByRole('button', { name: '最大化窗格 2' }).click();
    await expect(page.locator('.terminal-pane:visible')).toHaveCount(1);
    await page.getByRole('button', { name: '还原窗格 2' }).click();
    await expect(page.locator('.terminal-pane:visible')).toHaveCount(4);

    await page.getByTitle('布局与工作区').click();
    await page.locator('.layout-menu').getByRole('button', { name: '工作区' }).click();
    await page.getByPlaceholder('工作区名称').fill('打包 Phase 12');
    await page.locator('.workspace-menu form').getByRole('button', { name: '保存' }).click();
    await expect(page.locator('.workspace-list-menu').getByText('打包 Phase 12')).toBeVisible();
    await page.keyboard.press('Escape');

    const fullscreen = page.locator('[data-window-action="toggle-fullscreen"]');
    await fullscreen.click();
    await expect
      .poll(() =>
        app.evaluate(({ BrowserWindow }) => {
          const window = BrowserWindow.getAllWindows()[0]!;
          return window.isFullScreen() || window.isSimpleFullScreen();
        }),
      )
      .toBe(true);
    await fullscreen.click();
    await expect
      .poll(() =>
        app.evaluate(({ BrowserWindow }) => {
          const window = BrowserWindow.getAllWindows()[0]!;
          return window.isFullScreen() || window.isSimpleFullScreen();
        }),
      )
      .toBe(false);
    await page.screenshot({ path: join(packagedEvidenceDirectory, 'phase12-shell.png') });
    await page.waitForTimeout(700);

    await app.close();
    app = await launch();
    page = await app.firstWindow();
    await expect(page.getByTestId('runtime-state')).toHaveAttribute('data-state', 'ready');
    await expect(page.locator('.terminal-pane')).toHaveCount(4);
    await expect(page.locator('.pane-tabbar .terminal-tab')).toHaveCount(4);
    await expect(page.locator('.pane-tabbar .terminal-tab.disconnected')).toHaveCount(4);
    await expect(
      page.locator('.pane-tabbar .terminal-tab.pinned').filter({ hasText: '打包四窗格' }),
    ).toBeVisible();
    await page.getByTitle('布局与工作区').click();
    await page.locator('.layout-menu').getByRole('button', { name: '工作区' }).click();
    await expect(page.locator('.workspace-list-menu').getByText('打包 Phase 12')).toBeVisible();
    await page.keyboard.press('Escape');
    await page.screenshot({ path: join(packagedEvidenceDirectory, 'phase12-restart.png') });
  } finally {
    await app.close().catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
});

test('packaged H-11 localization switches immediately and survives a cold restart', async () => {
  test.setTimeout(90_000);
  await access(source);
  await mkdir(packagedEvidenceDirectory, { recursive: true });
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'axterm-packaged-h11-')));
  const artifact = join(directory, process.platform === 'darwin' ? 'Axterm.app' : 'app');
  await cp(source, artifact, { recursive: true, verbatimSymlinks: true });
  const executablePath =
    process.platform === 'darwin'
      ? join(artifact, 'Contents/MacOS/Axterm')
      : join(artifact, process.platform === 'win32' ? 'Axterm.exe' : 'axterm');
  const userData = join(directory, 'user-data');
  const launch = () =>
    electron.launch({
      executablePath,
      args: [`--user-data-dir=${userData}`],
      cwd: directory,
      env: {
        ...process.env,
        ELECTRON_RENDERER_URL: '',
        PATH: process.platform === 'win32' ? (process.env.SystemRoot ?? '') : '/usr/bin:/bin',
      },
    });
  let app = await launch();
  try {
    let page = await app.firstWindow();
    await expect(page.getByTestId('runtime-state')).toHaveAttribute('data-state', 'ready');
    await page.locator('[data-activity-item="setting"]').click();
    await page.locator('[data-settings-category="common"]').click();
    const language = page.getByTestId('application-language');
    await expect(language.locator('option')).toHaveCount(15);
    await language.selectOption('en');
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
    await expect(page.locator('html')).toHaveAttribute('dir', 'ltr');
    await expect(page.getByRole('heading', { name: 'Runtime status' })).toBeVisible();
    await page.screenshot({ path: join(packagedEvidenceDirectory, 'localization-en.png') });

    await app.close();
    app = await launch();
    page = await app.firstWindow();
    await expect(page.getByTestId('runtime-state')).toHaveAttribute('data-state', 'ready');
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
    await page.locator('[data-activity-item="setting"]').click();
    await page.locator('[data-settings-category="common"]').click();
    await expect(page.getByTestId('application-language')).toHaveValue('en');
    await page.getByTestId('application-language').selectOption('ar');
    await expect(page.locator('html')).toHaveAttribute('lang', 'ar');
    await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
    await expect(page.getByTestId('application-language')).toHaveValue('ar');
    const railBounds = await page.locator('.activity-bar').boundingBox();
    expect(railBounds).not.toBeNull();
    expect(railBounds!.x).toBeLessThanOrEqual(4);
    await page.screenshot({ path: join(packagedEvidenceDirectory, 'localization-ar.png') });
  } finally {
    await app.close().catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
});

test('packaged upgrade migrates a prior profile while preserving data and the local vault', async () => {
  await access(source);
  await mkdir(packagedEvidenceDirectory, { recursive: true });
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'axterm-packaged-upgrade-')));
  try {
    const artifact = join(directory, process.platform === 'darwin' ? 'Axterm.app' : 'app');
    await cp(source, artifact, { recursive: true, verbatimSymlinks: true });
    const executablePath =
      process.platform === 'darwin'
        ? join(artifact, 'Contents/MacOS/Axterm')
        : join(artifact, process.platform === 'win32' ? 'Axterm.exe' : 'axterm');
    const userData = join(directory, 'user-data');
    const dataDirectory = join(userData, 'data');
    const vaultDirectory = join(userData, 'vault');
    const databasePath = join(dataDirectory, 'axterm.sqlite');
    await mkdir(dataDirectory, { recursive: true });

    const vault = new CredentialVault(vaultDirectory);
    await vault.open();
    const secret = 'upgrade-fixture-password-value';
    const credential = await vault.put({
      kind: 'sshPassword',
      label: 'Upgrade fixture',
      secret,
    });
    vault.close();

    const database = await ProductDatabase.open(databasePath);
    database.recordAppVersion('0.9.0', '2026-09-12T00:00:00.000Z');
    new ProductRepository(database).createHost({
      name: 'upgrade-preserved-host',
      hostname: '127.0.0.1',
      username: 'fixture',
      authType: 'password',
      credentialRef: credential.ref,
    });
    const commands = new QuickCommandRepository(database);
    const commandTree = commands.snapshot();
    commands.createCommand(
      {
        groupId: null,
        name: 'Upgrade preserved command',
        command: 'uptime',
        commands: [{ id: randomUUID(), name: '', command: 'uptime', delayMs: 100 }],
        description: 'Created by the prior-version fixture',
        tags: ['upgrade'],
        shortcut: null,
        inputOnly: true,
        clickCount: 0,
      },
      commandTree.etag,
    );
    database.run('ALTER TABLE ai_messages DROP COLUMN attachments_json');
    database.run("DELETE FROM app_meta WHERE key='migration:32'");
    database.close();

    const app = await electron.launch({
      executablePath,
      args: [`--user-data-dir=${userData}`],
      cwd: directory,
      env: {
        ...process.env,
        ELECTRON_RENDERER_URL: '',
        PATH: process.platform === 'win32' ? (process.env.SystemRoot ?? '') : '/usr/bin:/bin',
      },
    });
    try {
      const page = await app.firstWindow();
      await expect(page.getByTestId('runtime-state')).toHaveAttribute('data-state', 'ready');
      await page.locator('[data-activity-item="bookmarks"]').click();
      await page.locator('.workspace-sidebar').getByRole('button', { name: '管理' }).click();
      await expect(
        page.locator('.host-card').getByText('upgrade-preserved-host', { exact: true }),
      ).toBeVisible();
      await page
        .locator('.app-sidebar nav')
        .getByRole('button', { name: /^快捷命令/ })
        .click();
      await page.locator('.workspace-sidebar').getByRole('button', { name: '打开工作区' }).click();
      await expect(
        page
          .getByTestId('quick-command-workspace')
          .locator('.quick-command-tree-row')
          .filter({ hasText: 'Upgrade preserved command' }),
      ).toBeVisible();
      await page.screenshot({ path: join(packagedEvidenceDirectory, 'upgrade.png') });
    } finally {
      await app.close();
    }

    const inspected = new DatabaseSync(databasePath, { readOnly: true });
    try {
      const meta = Object.fromEntries(
        (
          inspected
            .prepare(
              "SELECT key, value FROM app_meta WHERE key IN ('app:current-version','app:previous-version','migration:32')",
            )
            .all() as Array<{ key: string; value: string }>
        ).map(({ key, value }) => [key, value]),
      );
      expect(meta['app:current-version']).toBe('0.10.0');
      expect(meta['app:previous-version']).toBe('0.9.0');
      expect(meta['migration:32']).toMatch(/^[0-9a-f]{64}$/u);
      expect(
        (inspected.prepare('PRAGMA table_info(ai_messages)').all() as Array<{ name: string }>).map(
          ({ name }) => name,
        ),
      ).toContain('attachments_json');
    } finally {
      inspected.close();
    }
    expect((await readFile(databasePath)).toString('utf8')).not.toContain(secret);
    const restoredVault = new CredentialVault(vaultDirectory);
    await restoredVault.open();
    expect(await restoredVault.get(credential.ref)).toBe(secret);
    restoredVault.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test.describe('packaged SSH fixture', () => {
  test.skip(!sshFixturePort, 'Set AXTERM_SSH_FIXTURE_PORT through the fixture script');
  test('packaged SSH terminal authenticates and renders output', async () => {
    test.setTimeout(90_000);
    await access(source);
    await mkdir(packagedEvidenceDirectory, { recursive: true });
    const directory = await realpath(await mkdtemp(join(tmpdir(), 'axterm-packaged-ssh-')));
    try {
      const artifact = join(directory, process.platform === 'darwin' ? 'Axterm.app' : 'app');
      await cp(source, artifact, { recursive: true, verbatimSymlinks: true });
      const executablePath =
        process.platform === 'darwin'
          ? join(artifact, 'Contents/MacOS/Axterm')
          : join(artifact, process.platform === 'win32' ? 'Axterm.exe' : 'axterm');
      const userData = join(directory, 'user-data');
      const launch = () =>
        electron.launch({
          executablePath,
          args: [`--user-data-dir=${userData}`],
          cwd: directory,
          env: {
            ...process.env,
            ELECTRON_RENDERER_URL: '',
            PATH: process.platform === 'win32' ? (process.env.SystemRoot ?? '') : '/usr/bin:/bin',
          },
        });
      let app = await launch();
      try {
        let page = await app.firstWindow();
        await expect(page.getByTestId('runtime-state')).toHaveAttribute('data-state', 'ready');
        await page.locator('[data-activity-item="bookmarks"]').click();
        await page.locator('.workspace-sidebar').getByRole('button', { name: '管理' }).click();
        await page.getByRole('button', { name: '添加主机' }).click();
        await page.getByLabel('显示名称').fill('packaged-ssh');
        await page.getByLabel('主机地址').fill('127.0.0.1');
        await page.getByLabel('用户名').fill('fixture');
        await page.getByLabel('端口').fill(String(sshFixturePort));
        await page.getByLabel('认证方式').selectOption('password');
        await page.getByLabel('密码', { exact: true }).fill('axterm-fixture-password');
        await page.getByRole('button', { name: '保存并连接' }).click();
        await expect(page.getByRole('heading', { name: '首次连接此主机' })).toBeVisible();
        await page.getByLabel('保存并记住此主机密钥').check();
        await page.getByRole('button', { name: '信任并连接', exact: true }).click();
        const terminalLayer = page.locator('.terminal-session-layer:not([hidden])');
        const terminalInput = terminalLayer.locator('.xterm-helper-textarea');
        await expect(page.locator('.pane-tabbar .terminal-tab.active .tab-title')).toHaveText(
          'packaged-ssh',
        );
        await expect(terminalLayer.locator('.terminal-host')).toHaveAttribute(
          'data-connection-state',
          'connected',
        );
        await expect
          .poll(() => terminalLayer.locator('.xterm-rows').textContent())
          .toContain('Welcome to OpenSSH Server');
        await terminalInput.pressSequentially("printf '\\nAXTERM_PACKAGED_SSH_OK\\n'");
        await terminalInput.press('Enter');
        await terminalInput.press(process.platform === 'darwin' ? 'Meta+f' : 'Control+f');
        const search = terminalLayer.getByPlaceholder('查找终端输出');
        await expect
          .poll(async () => {
            await search.fill('');
            await search.fill('AXTERM_PACKAGED_SSH_OK');
            return terminalLayer.locator('.terminal-search-result').textContent();
          })
          .toBe('已找到');

        await search.press('Escape');
        await terminalInput.pressSequentially(
          "cd /tmp && printf 'AXTERM_PACKAGED_SFTP_OK' > packaged-sftp.txt && printf '\\nAXTERM_PACKAGED_SFTP_READY\\n'",
        );
        await terminalInput.press('Enter');
        await expect
          .poll(() => terminalLayer.locator('.xterm-rows').textContent())
          .toContain('AXTERM_PACKAGED_SFTP_READY');

        await page.locator('.app-sidebar nav').getByRole('button', { name: /^文件/ }).click();
        await page
          .locator('.workspace-sidebar .explorer-hosts')
          .getByRole('button', { name: /packaged-ssh/u })
          .click();
        const remotePane = page.getByRole('region', { name: '远端文件' });
        await remotePane.getByRole('button', { name: '当前终端目录' }).click();
        await expect(remotePane.getByRole('textbox', { name: '远端路径' })).toHaveValue('/tmp');
        await expect(
          remotePane.getByRole('button', { name: 'packaged-sftp.txt', exact: true }),
        ).toBeVisible();
        await page.screenshot({ path: join(packagedEvidenceDirectory, 'sftp.png') });

        const sidebar = page.locator('.workspace-sidebar');
        await page.locator('[data-activity-item="bookmarks"]').click();
        await sidebar.getByRole('tab', { name: '历史' }).click();
        const historyRow = sidebar.locator('.connection-history-row').filter({
          hasText: 'packaged-ssh',
        });
        await expect(historyRow).toHaveCount(1);
        await historyRow.hover();
        await historyRow.getByRole('button', { name: '将 packaged-ssh 保存为书签' }).click();
        await sidebar.getByRole('tab', { name: '书签' }).click();
        await expect(sidebar.locator('[data-bookmark-title="packaged-ssh"]')).toHaveCount(2);

        await app.close();
        app = await launch();
        page = await app.firstWindow();
        await expect(page.getByTestId('runtime-state')).toHaveAttribute('data-state', 'ready');
        const restoredSidebar = page.locator('.workspace-sidebar');
        const restoredBookmarkTab = restoredSidebar.getByRole('tab', { name: '书签' });
        if (!(await restoredBookmarkTab.isVisible()))
          await page.locator('[data-activity-item="bookmarks"]').click();
        await restoredSidebar.getByRole('tab', { name: '书签' }).click();
        await expect(restoredSidebar.locator('[data-bookmark-title="packaged-ssh"]')).toHaveCount(
          2,
        );
        await restoredSidebar.getByRole('tab', { name: '历史' }).click();
        const restoredHistory = restoredSidebar.locator('.connection-history-row').filter({
          hasText: 'packaged-ssh',
        });
        await expect(restoredHistory).toHaveCount(1);
        await restoredHistory.locator('.connection-history-main').click();
        await expect(page.locator('.pane-tabbar .terminal-tab.active .tab-title')).toHaveText(
          'packaged-ssh',
        );
        await expect(
          page.locator('.terminal-session-layer:not([hidden]) .terminal-host'),
        ).toHaveAttribute('data-connection-state', 'connected');

        const reconnectedHistoryTab = restoredSidebar.getByRole('tab', { name: '历史' });
        if (!(await reconnectedHistoryTab.isVisible()))
          await page.locator('[data-activity-item="bookmarks"]').click();
        await reconnectedHistoryTab.click();
        const reconnectedHistory = restoredSidebar.locator('.connection-history-row').filter({
          hasText: 'packaged-ssh',
        });
        await page.screenshot({ path: join(packagedEvidenceDirectory, 'history.png') });
        await reconnectedHistory.hover();
        await reconnectedHistory
          .getByRole('button', { name: '删除 packaged-ssh 的连接历史' })
          .click();
        await expect(reconnectedHistory).toHaveCount(0);

        await app.close();
        app = await launch();
        page = await app.firstWindow();
        await expect(page.getByTestId('runtime-state')).toHaveAttribute('data-state', 'ready');
        const finalSidebar = page.locator('.workspace-sidebar');
        const finalHistoryTab = finalSidebar.getByRole('tab', { name: '历史' });
        if (!(await finalHistoryTab.isVisible()))
          await page.locator('[data-activity-item="bookmarks"]').click();
        await finalHistoryTab.click();
        await expect(
          page.locator('.workspace-sidebar .connection-history-row').filter({
            hasText: 'packaged-ssh',
          }),
        ).toHaveCount(0);
      } finally {
        await app.close().catch(() => {});
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
