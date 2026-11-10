import type { Locator, Page } from '@playwright/test';

/** Use the visible native controls outside the accessible tablist. */
export async function closeLevel3Tab(page: Page, title?: Locator): Promise<void> {
  const tab =
    title ?? page.locator('[data-workspace-global-tabs]').getByRole('tab', { selected: true });
  const id = await tab.getAttribute('data-tab-id');
  if (!id) throw new Error('A live workspace tab is required');
  await tab.hover();
  await page
    .locator('[data-workspace-global-tabs]')
    .locator(`[data-close-tab-id=${JSON.stringify(id)}]`)
    .click();
}

export async function openLevel3TabMenu(page: Page, id: string): Promise<void> {
  const tabs = page.locator('[data-workspace-global-tabs]');
  await tabs.locator(`[data-tab-id=${JSON.stringify(id)}]`).hover();
  await tabs.locator(`[data-tab-controls-id=${JSON.stringify(id)}] .tab-actions`).click();
}
