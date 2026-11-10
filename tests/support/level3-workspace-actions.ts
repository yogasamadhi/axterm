import type { Page, Locator } from '@playwright/test';

/** Use visible product controls; hidden contribution components are never force-clicked. */
export async function showLevel3ContextActions(page: Page): Promise<void> {
  await page.locator('[data-axterm-product-workspace]').waitFor();
  if (!(await page.locator('[data-workspace-more-actions]').isVisible()))
    await page.locator('[data-workspace-more-toggle]').click();
}
export async function openLevel3Settings(page: Page): Promise<void> {
  await page
    .locator('[data-axterm-product-workspace][data-workspace-presentation=ready]')
    .waitFor();
  if (await page.locator('[data-configuration-settings]').isVisible()) return;
  const rail = page.locator('[data-activity-item=setting]');
  if (await rail.isVisible()) await rail.click();
  else {
    await showLevel3ContextActions(page);
    await page.locator('[data-configuration-settings-trigger]').click();
  }
}
/** Catalog actions require explicit navigation after Settings restores the prior workspace. */
export async function showLevel3Hosts(page: Page): Promise<void> {
  const hosts = page.locator('[data-axterm-product-workspace].section-hosts[data-sidebar=open]');
  if (!(await hosts.isVisible())) await page.locator('[data-activity-item=bookmarks]').click();
  await hosts.waitFor();
}
export async function openLevel3Bookmark(page: Page): Promise<void> {
  await page.locator('[data-activity-item=newBookmark]').click();
}
export async function level3ContextAction(page: Page, selector: string): Promise<Locator> {
  await showLevel3ContextActions(page);
  return page.locator(selector);
}
export async function openLevel3AiWorkspace(page: Page): Promise<void> {
  await page.locator('[data-ai-sidebar-toggle]').click();
  await page.locator('[data-ai-open-workspace]').click();
}

export async function openLevel3Section(page: Page, section: string): Promise<void> {
  await showLevel3ContextActions(page);
  await page.locator('[data-workspace-section=' + JSON.stringify(section) + ']').click();
}
