import { expect, type Page } from '@playwright/test';
/** Exercise the public Radix control and wait for the owner's accepted preference. */
export async function selectLevel3Language(page: Page, id: string): Promise<void> {
  const labels: Record<string, string> = {
    en: 'English',
    ja: '日本語',
    'zh-CN': '简体中文',
    'zh-TW': '繁體中文',
  };
  const label = labels[id];
  if (!label) throw Error('Unknown retained language');
  const control = page.getByTestId('application-language');
  await control.click();
  await page.getByRole('option', { name: label, exact: true }).click();
}
export async function expectLevel3Language(page: Page, id: string): Promise<void> {
  await expect(page.getByTestId('application-language')).toHaveAttribute('data-language-id', id);
}
