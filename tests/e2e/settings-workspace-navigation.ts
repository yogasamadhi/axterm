import { expect, type Page } from '@playwright/test';

export async function openTerminalThemes(page: Page) {
  await page.locator('[data-activity-item="setting"]').click();
  await page.locator('.settings-workspace-tabs button').nth(2).click();
  await expect(page.locator('.terminal-theme-workspace')).toBeVisible();
}

export async function openQuickCommandsWorkspace(page: Page) {
  await page.locator('[data-activity-item="setting"]').click();
  await page.locator('.settings-workspace-tabs button').nth(3).click();
  await expect(page.getByTestId('quick-command-workspace')).toBeVisible();
}

export async function openSettingsSync(page: Page) {
  await page.locator('[data-activity-item="setting"]').click();
  await page.locator('[data-settings-category="sync"]').click();
  await expect(page.locator('.data-sync-panel')).toBeVisible();
}

export async function openWidgets(page: Page) {
  await page.locator('[data-activity-item="setting"]').click();
  await page.locator('.settings-workspace-tabs button').nth(6).click();
  await expect(page.locator('.widget-workspace')).toBeVisible();
}

export async function openTunnelsWorkspace(page: Page) {
  await page.locator('[data-activity-item="setting"]').click();
  await page.locator('[data-settings-destination="tunnels"]').click();
  await expect(page.locator('.app-shell')).toHaveClass(/section-tunnels/);
}

export async function openNewBookmark(page: Page) {
  await page.locator('[data-activity-item="newBookmark"]').click();
  await expect(page.locator('.host-bookmark-modal')).toBeVisible();
}

export async function openFilesWorkspace(page: Page) {
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+k' : 'Control+k');
  const palette = page.getByRole('dialog', { name: '命令面板', exact: true });
  await palette.getByRole('combobox').fill('文件');
  await palette.locator('[data-palette-id="section:files"]').click();
  await expect(page.locator('.file-workspace')).toBeVisible();
}
