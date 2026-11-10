import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { expect, test } from '@playwright/test';
import { createHostSchema } from '@axterm/plugin-api/catalog';
import { launchLevel3Desktop, closeLevel3Desktop } from '../fixtures/level3-desktop-launch';
import { withLevel3CatalogSeed } from '../fixtures/level3-product-seed';
import { CatalogStorage } from '../../packages/plugins/catalog/src/adapters/catalog-storage';
import { HostRepository } from '../../packages/plugins/catalog/src/adapters/host-repository';
import { ConnectionHistoryRepository } from '../../packages/plugins/catalog/src/adapters/connection-history-repository';
const executablePath = createRequire(resolve('apps/desktop/package.json'))('electron') as string;
async function seedHistory(home: string, empty: boolean) {
  await withLevel3CatalogSeed(home, (domain) => {
    const storage = new CatalogStorage(domain),
      hosts = new HostRepository(storage, () => []),
      history = new ConnectionHistoryRepository(storage);
    const frequent = hosts.createHost(
      createHostSchema.parse({
        name: empty ? '空页面历史' : '频繁目标',
        hostname: 'frequent.example',
        username: 'operator',
        authType: 'agent',
      }),
    );
    if (empty) {
      history.record({ host: frequent, persistedHostId: null });
      hosts.deleteHost(frequent.id, '"v' + frequent.version + '"');
      expect(history.list({ sort: 'recent', limit: 25 }).items).toHaveLength(1);
      return;
    }
    const recent = hosts.createHost(
      createHostSchema.parse({
        name: '最近目标',
        hostname: 'recent.example',
        username: 'operator',
        authType: 'agent',
      }),
    );
    history.record({ host: frequent, persistedHostId: frequent.id });
    history.record({ host: frequent, persistedHostId: frequent.id });
    history.record({ host: recent, persistedHostId: recent.id });
    history.record({
      host: {
        ...frequent,
        id: randomUUID(),
        name: '临时密码目标',
        hostname: 'password.example',
        authType: 'password',
      },
      persistedHostId: null,
    });
    history.record({
      host: {
        ...frequent,
        id: randomUUID(),
        name: '临时私钥目标',
        hostname: 'key.example',
        authType: 'privateKey',
      },
      persistedHostId: null,
    });
  });
}

test('no-session actions and connection history work from the keyboard', async () => {
  const userData = await mkdtemp(resolve(tmpdir(), 'axterm-no-session-keyboard-'));
  await seedHistory(userData, true);
  const app = await launchLevel3Desktop({
    executablePath,
    args: [resolve('apps/desktop'), `--user-data-dir=${userData}`],
    env: { ...process.env, ELECTRON_RENDERER_URL: '' },
  });
  try {
    const page = await app.firstWindow();
    await expect(page.getByTestId('runtime-state')).toHaveAttribute('data-state', 'ready');
    await page.locator('[data-terminal-channel=ready]').waitFor();
    await page.locator('.terminal-tab').first().click({ button: 'right' });
    await page.getByRole('menuitem', { name: '关闭全部标签', exact: true }).click();
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
    await expect(page.locator('[data-terminal-channel]:visible')).toHaveAttribute(
      'data-terminal-channel',
      'ready',
    );
    await page.locator('.terminal-tab').first().click({ button: 'right' });
    await page.getByRole('menuitem', { name: '关闭全部标签', exact: true }).click();
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
    await expect(
      page.getByRole('dialog', { name: '使用 AI 创建 SSH 书签', exact: true }),
    ).toBeVisible();
  } finally {
    await closeLevel3Desktop(app);
    await rm(userData, { recursive: true, force: true });
  }
});

test('connection history is reachable from the bookmark sidebar and honors privacy settings', async () => {
  const userData = await mkdtemp(resolve(tmpdir(), 'axterm-connection-history-ui-'));
  await seedHistory(userData, false);
  const app = await launchLevel3Desktop({
    executablePath,
    args: [resolve('apps/desktop'), `--user-data-dir=${userData}`],
    env: { ...process.env, ELECTRON_RENDERER_URL: '' },
  });
  try {
    const page = await app.firstWindow();
    const pageErrors: string[] = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));
    await expect(page.getByTestId('runtime-state')).toHaveAttribute('data-state', 'ready');
    await page.locator('[data-terminal-channel=ready]').waitFor();
    await page.locator('[data-activity-item="bookmarks"]').click();
    const sidebar = page.locator('.workspace-sidebar');
    await sidebar.getByRole('button', { name: '历史', exact: true }).click();
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
    await sidebar.getByRole('button', { name: '书签', exact: true }).click();
    await expect(sidebar.locator('[data-bookmark-title="最近目标"]')).toBeVisible();
    await sidebar.getByRole('button', { name: '历史', exact: true }).click();

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
    await expect(page.locator('[data-terminal-id]')).toHaveCount(1);
    if (await page.locator('.workspace-sidebar').isHidden())
      await page.locator('[data-activity-item="bookmarks"]').click();
    const restoredSidebar = page.locator('.workspace-sidebar');
    await expect(restoredSidebar).toBeVisible();
    await restoredSidebar.getByRole('button', { name: '历史', exact: true }).click();
    await expect(restoredSidebar.getByRole('checkbox', { name: '记录连接历史' })).not.toBeChecked();
    await restoredSidebar.getByRole('button', { name: '启用连接历史' }).click();
    await expect(restoredSidebar.getByRole('checkbox', { name: '记录连接历史' })).toBeChecked();
    await expect(restoredSidebar.getByText('成功连接 SSH 主机后会显示在这里')).toBeVisible();
    expect(pageErrors).toEqual([]);
  } finally {
    await closeLevel3Desktop(app);
    await rm(userData, { recursive: true, force: true });
  }
});
