import { expect, type Page } from '@playwright/test';

const locales = [
  {
    id: 'en',
    newGroup: 'New group',
    groupName: 'Group name',
    create: 'Create',
    bookmarkError: 'Bookmark tree update failed.',
    layoutWorkspace: 'Layout and workspace',
    workspaceName: 'Workspace name',
    workspaceError: 'Unable to save the workspace.',
  },
  {
    id: 'ja',
    newGroup: '新しいグループ',
    groupName: 'グループ名',
    create: '作成',
    bookmarkError: 'ブックマークツリーの更新に失敗しました。',
    layoutWorkspace: 'レイアウトとワークスペース',
    workspaceName: 'ワークスペース名',
    workspaceError: 'ワークスペースを保存できませんでした。',
  },
  {
    id: 'zh-CN',
    newGroup: '新建分组',
    groupName: '分组名称',
    create: '创建',
    bookmarkError: '书签树更新失败',
    layoutWorkspace: '布局与工作区',
    workspaceName: '工作区名称',
    workspaceError: '无法保存工作区',
  },
  {
    id: 'zh-TW',
    newGroup: '新增群組',
    groupName: '群組名稱',
    create: '建立',
    bookmarkError: '書籤樹更新失敗。',
    layoutWorkspace: '配置與工作區',
    workspaceName: '工作區名稱',
    workspaceError: '無法儲存工作區。',
  },
] as const;

const canary = 's5-shell-secret-canary-do-not-display';
const failedMutation = JSON.stringify({
  type: 'about:blank',
  title: canary,
  status: 500,
  detail: canary,
  code: 'S5_SYNTHETIC_MUTATION_FAILURE',
  traceId: '00000000-0000-4000-8000-000000000005',
});

async function assertToastWithinViewport(page: Page): Promise<void> {
  const toast = page.locator('.toast.error');
  await expect(toast).toBeInViewport();
  const bounds = await toast.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return { left: rect.left, right: rect.right, viewport: innerWidth };
  });
  expect(bounds.left).toBeGreaterThanOrEqual(-1);
  expect(bounds.right).toBeLessThanOrEqual(bounds.viewport + 1);
  await expect
    .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1))
    .toBe(true);
}

export async function verifyFourLocaleS5ShellJourney(page: Page): Promise<void> {
  let failBookmarks = false;
  let failWorkspace = false;
  for (const { path, failing, method } of [
    { path: '**/api/v1/bookmark-groups', failing: () => failBookmarks, method: 'POST' },
    { path: '**/api/v1/settings', failing: () => failWorkspace, method: 'PATCH' },
  ]) {
    await page.route(path, async (route) => {
      if (route.request().method() !== method || !failing()) {
        await route.continue();
        return;
      }
      await route.fulfill({
        status: 500,
        contentType: 'application/problem+json',
        body: failedMutation,
      });
    });
  }

  for (const locale of locales) {
    await page.locator('[data-activity-item="setting"]').click();
    await page.locator('.settings-workspace-tabs button').nth(1).click();
    await page.locator('[data-settings-category="common"]').click();
    await page.getByTestId('application-language').selectOption(locale.id);
    await expect(page.locator('html')).toHaveAttribute('lang', locale.id);

    failBookmarks = true;
    await page.locator('[data-activity-item="bookmarks"]').click();
    const shell = page.locator('.app-shell');
    if (await page.locator('.bookmark-manager-back').isVisible())
      await page.locator('.bookmark-manager-back').click();
    await page.locator('.workspace-sidebar .bookmark-explorer-title button').click();
    await expect(page.locator('.section-tab')).toHaveCount(0);
    const newGroup = page.locator('.host-manager-toolbar').getByRole('button', {
      name: locale.newGroup,
    });
    await newGroup.scrollIntoViewIfNeeded();
    await newGroup.click();
    const dialog = page.getByRole('dialog', { name: locale.newGroup });
    const groupName = `S5 ${locale.id} group`;
    await dialog.getByRole('textbox', { name: locale.groupName }).fill(groupName);
    await dialog.getByRole('button', { name: locale.create }).click();
    await expect(page.getByRole('alert')).toHaveText(locale.bookmarkError);
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('textbox', { name: locale.groupName })).toHaveValue(groupName);
    await expect(page.getByText(canary)).toHaveCount(0);
    await assertToastWithinViewport(page);
    failBookmarks = false;
    await dialog.getByRole('button', { name: locale.create }).click();
    await expect(dialog).toHaveCount(0);
    await expect(page.getByRole('alert')).toHaveCount(0);
    await expect(page.getByText(groupName).first()).toBeVisible();

    await page.locator('[data-activity-item="setting"]').focus();
    await page.keyboard.press('Alt+q');
    await expect(page.locator('.app-shell')).toHaveClass(/surface-terminal/u);
    if (!(await shell.getAttribute('class'))?.includes('sidebar-collapsed')) {
      await page.keyboard.press('Meta+b');
      await expect(shell).toHaveClass(/sidebar-collapsed/u);
    }
    await page.getByRole('button', { name: locale.layoutWorkspace }).click();
    const menu = page.locator('.layout-menu');
    await menu.locator('.menu-tabs button').nth(1).click();
    const workspaceName = menu.getByRole('textbox', { name: locale.workspaceName });
    const value = `S5 ${locale.id} workspace`;
    await workspaceName.fill(value);
    failWorkspace = true;
    await menu.locator('.workspace-menu button[type="submit"]').click();
    await expect(page.getByRole('alert')).toHaveText(locale.workspaceError);
    await expect(workspaceName).toHaveValue(value);
    await expect(page.getByText(canary)).toHaveCount(0);
    await assertToastWithinViewport(page);
    failWorkspace = false;
    await workspaceName.press('Enter');
    await expect(workspaceName).toHaveValue('');
    await expect(page.getByRole('alert')).toHaveCount(0);
    await expect(menu.getByText(value)).toBeVisible();
    await page.keyboard.press('Escape');
  }
}
