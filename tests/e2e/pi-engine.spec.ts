import { once } from 'node:events';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { createRequire } from 'node:module';
import { test, expect } from '@playwright/test';
import { launchLocalOptimizationApp } from '../fixtures/local-optimization-launch';
import { piSseText, piSseEnd } from '../fixtures/pi-sse';

const executablePath = createRequire(resolve('apps/desktop/package.json'))('electron') as string;

test('Pi catalog and models.json import use Vault credentials in the desktop Runtime', async () => {
  const userData = await mkdtemp(resolve(tmpdir(), 'axterm-pi-ui-'));
  let auth = '';
  let tenant = '';
  let payload = '';
  const server = createServer((request, response) => {
    auth = String(request.headers.authorization ?? '');
    tenant = String(request.headers['x-tenant-key'] ?? '');
    request.setEncoding('utf8');
    request.on('data', (chunk) => {
      payload += String(chunk);
    });
    request.on('end', () => {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end(piSseText('openai-chat', 'Pi desktop ready') + piSseEnd('openai-chat'));
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing Pi fixture listener');
  const app = await launchLocalOptimizationApp({
    executablePath,
    args: [resolve('apps/desktop'), `--user-data-dir=${userData}`],
    env: { ...process.env, ELECTRON_RENDERER_URL: '' },
  });
  try {
    const page = await app.firstWindow();
    await expect(page.getByTestId('runtime-state')).toHaveAttribute('data-state', 'ready');
    await page.getByRole('button', { name: 'AI 助手', exact: true }).click();
    await page.locator('.ai-inspector .ai-embedded-toolbar button').click();
    const form = page.locator('.ai-provider-form');
    await expect(
      form.getByLabel('Pi 厂商', { exact: true }).locator('option[value="deepseek"]'),
    ).toHaveCount(1);
    await form.getByLabel('Pi 厂商', { exact: true }).selectOption('deepseek');
    await expect(form.locator('[name="baseUrl"]')).toHaveValue('https://api.deepseek.com');
    await expect(form.locator('[name="model"]')).not.toHaveValue('');
    await form.locator('[name="piModelsJson"]').fill(
      JSON.stringify({
        providers: {
          fixture: {
            baseUrl: `http://127.0.0.1:${address.port}/v1`,
            api: 'openai-completions',
            apiKey: 'PI_KEY_CANARY',
            headers: { 'x-tenant-key': 'PI_HEADER_CANARY' },
            models: [
              { id: 'fixture-model', reasoning: true, compat: { supportsDeveloperRole: false } },
            ],
            modelOverrides: {
              'fixture-model': { maxTokens: 99, compat: { maxTokensField: 'max_tokens' } },
            },
          },
        },
      }),
    );
    await form.getByRole('button', { name: '保存配置' }).click();
    await expect(page.getByRole('dialog', { name: 'AI 配置' })).toBeHidden();
    await page.locator('.ai-inspector .ai-embedded-toolbar button').click();
    await page.getByRole('button', { name: '测试连接', exact: true }).click();
    await expect(page.getByText(/连接成功/u)).toBeVisible();
    expect(auth).toBe('Bearer PI_KEY_CANARY');
    expect(tenant).toBe('PI_HEADER_CANARY');
    expect(payload).toContain('fixture-model');
    expect(JSON.parse(payload)).toMatchObject({
      max_tokens: 99,
      messages: [{ role: 'system' }, { role: 'user' }],
    });
    expect(payload).not.toMatch(/PI_KEY_CANARY|PI_HEADER_CANARY/u);
    expect(await page.locator('body').innerText()).not.toMatch(/PI_KEY_CANARY|PI_HEADER_CANARY/u);
  } finally {
    await app.close();
    server.close();
    server.closeAllConnections();
    await once(server, 'close');
    await rm(userData, { recursive: true, force: true });
  }
});
