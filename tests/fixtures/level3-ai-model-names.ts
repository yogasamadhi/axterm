import { expect, type Page } from '@playwright/test';
/** Actual public Provider/Pi import UI, Vault and generated commands; no model objects or REST responses injected. */
export async function configureLevel3ModelNames(page: Page, names: readonly string[]) {
  await page.locator('[data-ai-sidebar-toggle]').click();
  await page.locator('.ai-inspector .ai-embedded-toolbar button').click();
  const form = page.locator('.ai-provider-form:visible');
  await form.waitFor();
  await form.locator('[name=name]').fill('Model name fixture');
  await form.locator('[name=baseUrl]').fill('http://127.0.0.1:9/v1');
  await form.locator('[name=model]').fill(names[0]!);
  await form.locator('[name=apiKey]').fill('AI_MODEL_NAME_TEST_KEY');
  await form.locator('[name=piModelsJson]').fill(
    JSON.stringify({
      providers: {
        'model-name-fixture': {
          baseUrl: 'http://127.0.0.1:9/v1',
          api: 'openai-completions',
          models: names.map((name) => ({ id: name, name })),
        },
      },
    }),
  );
  await form.locator('button.primary').click();
  await expect(form).toHaveCount(0);
  const model = page.locator('.ai-inspector select[name=modelId]');
  await expect(model.locator('option')).toHaveCount(names.length);
  const options = await model.locator('option').evaluateAll((nodes) =>
    nodes.map((node) => ({
      id: (node as HTMLOptionElement).value,
      name: node.textContent?.trim(),
    })),
  );
  return names.map((name) => {
    const item = options.find((item) => item.name === name);
    if (!item) throw Error('Configured model was not observed');
    return { id: item.id, name };
  });
}
