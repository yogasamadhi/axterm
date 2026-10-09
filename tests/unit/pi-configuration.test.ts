import { describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { aiProviderSchema, piModelsFileSchema } from '../../packages/contracts/src';
import { importPiModels } from '../../apps/desktop/src/renderer/src/app/ai/pi-configuration';

function fixture() {
  const client = {
    createCredential: vi.fn(async (_input: unknown) => ({ ref: randomUUID() })),
    createAiProvider: vi.fn(async (input: object) =>
      aiProviderSchema.parse({
        ...input,
        id: randomUUID(),
        version: 1,
        createdAt: '2026-10-05T00:00:00.000Z',
        updatedAt: '2026-10-05T00:00:00.000Z',
      }),
    ),
    createAiModel: vi.fn(async (input: object) => ({ ...input, id: randomUUID(), version: 1 })),
    deleteAiModel: vi.fn(async (_input: unknown) => {}),
    deleteAiProvider: vi.fn(async (_input: unknown) => {}),
    deleteCredential: vi.fn(async (_input: unknown) => {}),
  };
  return client;
}
const custom = JSON.stringify({
  providers: {
    ollama: {
      baseUrl: 'http://localhost:11434/v1',
      api: 'openai-completions',
      apiKey: 'API_SECRET_CANARY',
      headers: { 'X-Tenant': 'HEADER_SECRET_CANARY' },
      models: [{ id: 'qwen', contextWindow: 8192, maxTokens: 1024 }],
    },
  },
});

describe('Pi models.json Vault import', () => {
  it('imports literal credentials into the Vault and stores only references', async () => {
    const client = fixture();
    const imported = await importPiModels(client as never, custom, '', []);
    expect(client.createCredential.mock.calls.map(([input]) => input)).toEqual([
      { kind: 'aiApiKey', label: 'ollama API Key', secret: 'API_SECRET_CANARY' },
      { kind: 'aiApiKey', label: 'ollama X-Tenant', secret: 'HEADER_SECRET_CANARY' },
    ]);
    expect(imported[0]?.pi).toMatchObject({
      id: 'ollama',
      api: 'openai-completions',
      models: [{ id: 'qwen' }],
    });
    expect(client.createAiModel).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(client.createAiProvider.mock.calls)).not.toMatch(
      /API_SECRET_CANARY|HEADER_SECRET_CANARY/u,
    );
    expect(JSON.stringify(imported)).not.toMatch(/API_SECRET_CANARY|HEADER_SECRET_CANARY/u);
  });
  it('rejects credential commands, environment expressions and unsupported configuration before writes', async () => {
    for (const apiKey of ['!echo secret', '$DEEPSEEK_API_KEY', '${DEEPSEEK_API_KEY}']) {
      expect(() => piModelsFileSchema.parse({ providers: { deepseek: { apiKey } } })).toThrow();
    }
    const client = fixture();
    await expect(
      importPiModels(client as never, '{"providers":{"unknown":{"apiKey":"key"}}}', '', []),
    ).rejects.toThrow();
    expect(client.createCredential).not.toHaveBeenCalled();
    expect(() =>
      piModelsFileSchema.parse({ providers: { unknown: { api: 'wrong-api' } } }),
    ).toThrow();
  });
  it('compensates created models, providers and credentials after an interrupted import', async () => {
    const client = fixture();
    client.createAiModel.mockRejectedValueOnce(new Error('model save failed'));
    await expect(importPiModels(client as never, custom, '', [])).rejects.toThrow(
      'model save failed',
    );
    expect(client.deleteAiProvider).toHaveBeenCalledTimes(1);
    expect(client.deleteCredential).toHaveBeenCalledTimes(2);
  });
  it('keeps Vault references usable if removing a created provider fails', async () => {
    const client = fixture();
    client.createAiModel.mockRejectedValueOnce(new Error('model save failed'));
    client.deleteAiProvider.mockRejectedValueOnce(new Error('cleanup failed'));
    await expect(importPiModels(client as never, custom, '', [])).rejects.toThrow(
      'model save failed',
    );
    expect(client.deleteCredential).not.toHaveBeenCalled();
  });
});
