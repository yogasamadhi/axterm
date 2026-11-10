import { expect, type Locator } from '@playwright/test';

export async function selectAiSkill(composer: Locator, id: string) {
  const prompt = composer.locator('textarea[name="prompt"]');
  await prompt.fill(`@${id}`);
  await expect(composer.page().getByRole('listbox').getByRole('option')).toHaveCount(1);
  await prompt.press('Enter');
  await expect(composer.locator('.ai-selected-skill')).toBeVisible();
  await expect(prompt).toHaveValue('');
}
