import { createHash } from 'node:crypto';
import type * as Ssh2 from 'ssh2';
import {
  startReconnectSshFixture,
  seedOwnedSshPasteFixtures,
} from '../fixtures/level3-reconnect-ssh';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { createRequire } from 'node:module';
import { expect, test } from '@playwright/test';
import { launchLevel3Desktop, closeLevel3Desktop } from '../fixtures/level3-desktop-launch';
import { setLevel3NativeSelection } from '../support/level3-native-selection';
const executablePath = createRequire(resolve('apps/desktop/package.json'))('electron') as string;
// Native Windows paths retained; macOS discovery is not Windows execution evidence.
test.beforeEach(({ browserName: _browserName }, info) => {
  test.skip(
    info.project.name === 'packaged' && !process.env.AXTERM_LEVEL3_PACKAGE_RESULT,
    'An explicit new-architecture package result is required.',
  );
});

test('Windows unconfigured local terminal starts with PowerShell 7', async () => {
  test.skip(process.platform !== 'win32', 'PowerShell 7 is the Windows platform default.');
  const userData = await mkdtemp(resolve(tmpdir(), 'axterm-pwsh-default-'));
  const app = await launchLevel3Desktop({
    executablePath,
    args: [`--user-data-dir=${userData}`],
    env: { ...process.env },
  });
  try {
    const page = await app.firstWindow();
    await expect(page.getByTestId('runtime-state')).toHaveAttribute('data-state', 'ready');
    const layer = page.locator('[data-terminal-id]:visible');
    await expect(layer).toHaveAttribute('data-terminal-channel', 'ready');
    const input = layer.locator('.xterm-helper-textarea');
    await input.pressSequentially(
      "Write-Output ('AXTERM_PWSH_MAJOR=' + $PSVersionTable.PSVersion.Major)",
    );
    await input.press('Enter');
    await expect
      .poll(() => layer.locator('.xterm-rows').textContent())
      .toContain('AXTERM_PWSH_MAJOR=7');
  } finally {
    await closeLevel3Desktop(app);
    await rm(userData, { recursive: true, force: true });
  }
});

test('Windows paste confirmation and 80-file browser use available space', async () => {
  test.skip(process.platform !== 'win32', 'The Windows native interface is under test.');
  const userData = await mkdtemp(resolve(tmpdir(), 'axterm-windows-file-layout-'));
  const browseDirectory = resolve(userData, 'browse');
  await mkdir(browseDirectory);
  await Promise.all(
    Array.from({ length: 80 }, (_, index) =>
      writeFile(resolve(browseDirectory, `file-${String(index).padStart(3, '0')}.txt`), ''),
    ),
  );
  const app = await launchLevel3Desktop({
    executablePath,
    args: [`--user-data-dir=${userData}`],
    env: { ...process.env },
  });
  try {
    await setLevel3NativeSelection(app, browseDirectory, 'open-directory');
    const page = await app.firstWindow();
    await expect(page.getByTestId('runtime-state')).toHaveAttribute('data-state', 'ready');
    const layer = page.locator('[data-terminal-id]:visible');
    await expect(layer).toHaveAttribute('data-terminal-channel', 'ready');
    await app.evaluate(({ clipboard }) =>
      clipboard.writeText("Write-Output 'PACKAGED_PASTE_ONE'\nWrite-Output 'PACKAGED_PASTE_TWO'"),
    );
    await layer.locator('.xterm-helper-textarea').press('Control+v');
    const pasteDialog = page.getByRole('dialog', { name: '确认粘贴到终端' });
    await expect(pasteDialog.getByRole('button', { name: '确认粘贴' })).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(pasteDialog).toHaveCount(0);
    await expect(layer.locator('.terminal-action-feedback')).toHaveText('剪贴板内容已发送到终端。');
    await page
      .getByRole('tablist', { name: '会话工具' })
      .getByRole('tab', { name: '文件管理', exact: true })
      .click();
    const pane = page.locator('[data-files-workspace]:visible .file-pane-local');
    await pane.getByRole('button', { name: '更换目录', exact: true }).click();
    await expect(pane.getByLabel('本地绝对路径')).toHaveValue(browseDirectory);
    await expect.poll(() => pane.locator('.file-data-row').count()).toBeGreaterThan(20);
    const bottomGap = await pane.evaluate((element) => {
      const scroll = element.querySelector('.file-table-scroll')!.getBoundingClientRect();
      return element.getBoundingClientRect().bottom - scroll.bottom;
    });
    expect(bottomGap).toBeLessThan(50);
  } finally {
    await closeLevel3Desktop(app);
    await rm(userData, { recursive: true, force: true });
  }
});

test('Windows Ctrl+C copies a selection, interrupts without one, and double press interrupts', async () => {
  test.skip(process.platform !== 'win32', 'The Windows terminal keyboard behavior is under test.');
  const userData = await mkdtemp(resolve(tmpdir(), 'axterm-ctrl-c-e2e-'));
  const app = await launchLevel3Desktop({
    executablePath,
    args: [resolve('apps/desktop'), `--user-data-dir=${userData}`],
    env: { ...process.env, ELECTRON_RENDERER_URL: '' },
  });
  try {
    const page = await app.firstWindow();
    await expect(page.getByTestId('runtime-state')).toHaveAttribute('data-state', 'ready');
    await page.locator('[data-terminal-channel=ready]').waitFor();
    const layer = page.locator('[data-terminal-id]:visible');
    await expect(layer).toHaveAttribute('data-terminal-channel', 'ready');
    const input = layer.locator('.xterm-helper-textarea');
    const rows = layer.locator('.xterm-rows');
    await input.pressSequentially("Write-Output 'AXTERM_CTRL_C_COPY_MARKER'");
    await input.press('Enter');
    await expect.poll(() => rows.textContent()).toContain('AXTERM_CTRL_C_COPY_MARKER');
    await layer.click({ button: 'right', position: { x: 100, y: 100 } });
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
    await layer.click({ button: 'right', position: { x: 100, y: 100 } });
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
    await closeLevel3Desktop(app);
    await rm(userData, { recursive: true, force: true });
  }
});

test('Windows terminal pastes with Ctrl+V and keeps Ctrl+Shift+V working', async () => {
  test.skip(process.platform !== 'win32', 'The Windows terminal keyboard behavior is under test.');
  const userData = await mkdtemp(resolve(tmpdir(), 'axterm-ctrl-v-e2e-'));
  const app = await launchLevel3Desktop({
    executablePath,
    args: [resolve('apps/desktop'), `--user-data-dir=${userData}`],
    env: { ...process.env, ELECTRON_RENDERER_URL: '' },
  });
  try {
    const page = await app.firstWindow();
    await expect(page.getByTestId('runtime-state')).toHaveAttribute('data-state', 'ready');
    await page.locator('[data-terminal-channel=ready]').waitFor();
    const layer = page.locator('[data-terminal-id]:visible');
    await expect(layer).toHaveAttribute('data-terminal-channel', 'ready');
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
    await closeLevel3Desktop(app);
    await rm(userData, { recursive: true, force: true });
  }
});

test('Windows paste confirmation focuses Confirm so Enter pastes and Escape still cancels', async () => {
  test.skip(process.platform !== 'win32', 'The Windows paste dialog behavior is under test.');
  const userData = await mkdtemp(resolve(tmpdir(), 'axterm-paste-confirm-focus-e2e-'));
  const app = await launchLevel3Desktop({
    executablePath,
    args: [resolve('apps/desktop'), `--user-data-dir=${userData}`],
    env: { ...process.env, ELECTRON_RENDERER_URL: '' },
  });
  try {
    const page = await app.firstWindow();
    await expect(page.getByTestId('runtime-state')).toHaveAttribute('data-state', 'ready');
    await page.locator('[data-terminal-channel=ready]').waitFor();
    const layer = page.locator('[data-terminal-id]:visible');
    await expect(layer).toHaveAttribute('data-terminal-channel', 'ready');
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
    await closeLevel3Desktop(app);
    await rm(userData, { recursive: true, force: true });
  }
});

test('first and later multiline pastes in a new PowerShell tab wait for Enter', async () => {
  test.skip(process.platform !== 'win32', 'The Windows PowerShell startup behavior is under test.');
  const userData = await mkdtemp(resolve(tmpdir(), 'axterm-first-multiline-paste-e2e-'));
  const app = await launchLevel3Desktop({
    executablePath,
    args: [resolve('apps/desktop'), `--user-data-dir=${userData}`],
    env: { ...process.env, ELECTRON_RENDERER_URL: '' },
  });
  try {
    const page = await app.firstWindow();
    await expect(page.getByTestId('runtime-state')).toHaveAttribute('data-state', 'ready');
    await page.locator('[data-terminal-channel=ready]').waitFor();
    const first = resolve(userData, 'first-paste-line.txt');
    const second = resolve(userData, 'second-paste-line.txt');
    await app.evaluate(
      ({ clipboard }, value) => clipboard.writeText(value),
      `Set-Content -LiteralPath '${first}' -Value 'first'\r\nSet-Content -LiteralPath '${second}' -Value 'second'`,
    );
    const previousTerminalId = await page
      .locator('[data-terminal-id]:visible')
      .getAttribute('data-terminal-id');
    await page.locator('[data-terminal-new]').click();
    await expect(page.locator('.workspace-tab-entry')).toHaveCount(2);
    const layer = page.locator('[data-terminal-id]:visible');
    await expect(layer).not.toHaveAttribute('data-terminal-id', previousTerminalId!);
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
    await closeLevel3Desktop(app);
    await rm(userData, { recursive: true, force: true });
  }
});

test('Windows CMD profile still accepts multiline paste without bracketed-paste support', async () => {
  test.skip(process.platform !== 'win32', 'The Windows CMD fallback is under test.');
  const userData = await mkdtemp(resolve(tmpdir(), 'axterm-cmd-multiline-paste-e2e-'));
  const app = await launchLevel3Desktop({
    executablePath,
    args: [resolve('apps/desktop'), `--user-data-dir=${userData}`],
    env: { ...process.env, ELECTRON_RENDERER_URL: '' },
  });
  try {
    const page = await app.firstWindow();
    await expect(page.getByTestId('runtime-state')).toHaveAttribute('data-state', 'ready');
    await page.locator('[data-terminal-channel=ready]').waitFor();
    await expect(page.locator('[data-terminal-id]:visible')).toHaveAttribute(
      'data-terminal-channel',
      'ready',
    );
    await page.locator('[data-activity-item="setting"]').click();
    await page.locator('[data-settings-category="terminal"]').click();
    const profileForm = page.locator('[data-terminal-profile-form]');
    await profileForm.getByLabel('名称').fill('CMD paste test');
    await profileForm.getByLabel('Shell', { exact: true }).fill('cmd.exe');
    await profileForm.locator('button.primary').click();
    await page
      .locator('.terminal-default-profile-settings select')
      .selectOption({ label: 'CMD paste test' });
    await page.locator('[data-section-close=left]').click();

    const previousId = await page
      .locator('[data-terminal-id]:visible')
      .getAttribute('data-terminal-id');
    await page.locator('[data-catalog-new-session]').click();
    await page
      .locator('[data-catalog-session-menu]')
      .getByRole('button', { name: /本地终端/ })
      .click();
    await expect(page.locator('.workspace-tab-entry')).toHaveCount(2);
    const layer = page.locator('[data-terminal-id]:visible');
    await expect(layer).not.toHaveAttribute('data-terminal-id', previousId!);
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
    await closeLevel3Desktop(app);
    await rm(userData, { recursive: true, force: true });
  }
});

const { utils } = createRequire(resolve('packages/plugins/connections/package.json'))(
  'ssh2',
) as typeof Ssh2;

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
  let app: Awaited<ReturnType<typeof launchLevel3Desktop>> | undefined;
  const fixtures: Awaited<ReturnType<typeof startReconnectSshFixture>>[] = [];
  try {
    const fixture = await startReconnectSshFixture(hostKey);
    fixtures.push(fixture);
    const bracketedFixture = await startReconnectSshFixture(hostKey, 0, true);
    fixtures.push(bracketedFixture);
    await seedOwnedSshPasteFixtures(
      userData,
      [
        ['SSH paste startup', bracketedFixture.port],
        ['SSH paste fallback', fixture.port],
      ],
      { algorithm: parsedHostKey.type, fingerprint, publicKey: publicKey.toString('base64') },
    );
    app = await launchLevel3Desktop({
      executablePath,
      args: [resolve('apps/desktop'), `--user-data-dir=${userData}`],
      env: { ...process.env },
    });
    const page = await app.firstWindow();
    await expect(page.getByTestId('runtime-state')).toHaveAttribute('data-state', 'ready');
    await page.locator('[data-terminal-channel=ready]').waitFor();
    await page.locator('[data-activity-item="bookmarks"]').click();
    await page.locator('[data-bookmark-title="SSH paste startup"]:visible').dblclick();
    await expect(page.locator('.workspace-tab.active .tab-title')).toHaveText('SSH paste startup');
    let layer = page.locator('[data-terminal-id]:visible');
    await expect(layer).toHaveAttribute('data-terminal-channel', 'ready');
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
    await expect(layer.locator('[data-shell-integration]')).toHaveAttribute(
      'data-shell-integration',
      'active',
    );
    expect(bracketedFixture.receivedText()).toContain('\u001b[200~echo SSH_FIRST_BLOCK');
    expect(bracketedFixture.receivedText()).toContain('SSH_SECOND_BLOCK\u001b[201~');

    await page.locator('[data-bookmark-title="SSH paste fallback"]:visible').dblclick();
    await expect(page.locator('.workspace-tab.active .tab-title')).toHaveText('SSH paste fallback');
    layer = page.locator('[data-terminal-id]:visible');
    await expect(layer).toHaveAttribute('data-terminal-channel', 'ready');
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
    if (app) await closeLevel3Desktop(app);
    for (const fixture of fixtures.reverse()) await fixture.stop();
    await rm(userData, { recursive: true, force: true });
  }
});
