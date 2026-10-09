import { describe, expect, it } from 'vitest';
import {
  DEFAULT_AI_ROLE,
  aiAttachmentPreviewSchema,
  aiConversationDetailSchema,
  aiProviderInputSchema,
  aiProviderSchema,
  aiProviderTestResultSchema,
  aiRequestSchema,
} from './resources';

describe('AI provider contracts', () => {
  it('keeps legacy OpenAI-compatible inputs valid with bounded defaults', () => {
    expect(
      aiProviderInputSchema.parse({
        name: 'Local model',
        baseUrl: 'http://127.0.0.1:11434/v1/',
        credentialRef: 'local-vault:ai',
        enabled: true,
      }),
    ).toEqual({
      name: 'Local model',
      baseUrl: 'http://127.0.0.1:11434/v1/',
      apiPath: '/chat/completions',
      protocol: 'openai-chat',
      auth: 'bearer',
      role: DEFAULT_AI_ROLE,
      proxy: null,
      timeoutMs: 60_000,
      credentialRef: 'local-vault:ai',
      enabled: true,
    });
  });

  it('accepts Anthropic with an application-local proxy credential reference', () => {
    const value = aiProviderSchema.parse({
      id: 'c327bcc2-742f-49e4-9c0a-d763b83b0897',
      createdAt: '2026-09-13T00:00:00.000Z',
      updatedAt: '2026-09-13T00:00:00.000Z',
      version: 1,
      name: 'Claude',
      baseUrl: 'https://api.anthropic.com/v1/',
      apiPath: '/messages',
      protocol: 'anthropic',
      auth: 'x-api-key',
      role: 'Terminal expert',
      proxy: {
        url: 'socks5://127.0.0.1:1080',
        username: 'operator',
        credentialRef: 'local-vault:proxy',
      },
      timeoutMs: 45_000,
      credentialRef: 'local-vault:anthropic',
      enabled: true,
    });
    expect(value.proxy).toMatchObject({
      url: 'socks5://127.0.0.1:1080',
      credentialRef: 'local-vault:proxy',
    });
  });

  it('rejects credential-bearing endpoints and validates connection evidence', () => {
    expect(() =>
      aiProviderInputSchema.parse({
        name: 'Unsafe',
        baseUrl: 'https://token@example.test/v1',
        credentialRef: 'local-vault:ai',
        enabled: true,
      }),
    ).toThrow();
    expect(
      aiProviderTestResultSchema.parse({
        providerId: 'c327bcc2-742f-49e4-9c0a-d763b83b0897',
        protocol: 'openai-responses',
        ok: true,
        latencyMs: 12,
        models: ['gpt-test'],
      }),
    ).toMatchObject({ ok: true, models: ['gpt-test'] });
  });

  it('bounds persisted conversation history and exposes no hidden provider state', () => {
    const conversationId = 'c327bcc2-742f-49e4-9c0a-d763b83b0897';
    const runId = '6f6c859f-2ac3-4bd7-9e6f-33c6c08ca10b';
    expect(
      aiConversationDetailSchema.parse({
        conversation: {
          id: conversationId,
          name: 'Troubleshoot SSH',
          modelId: runId,
          useCase: 'diagnose',
          messageCount: 2,
          lastMessageAt: '2026-09-13T00:01:00.000Z',
          createdAt: '2026-09-13T00:00:00.000Z',
          updatedAt: '2026-09-13T00:01:00.000Z',
          version: 3,
        },
        messages: [
          {
            id: '33483d2e-5ad4-499e-8da2-f1d64ca56436',
            conversationId,
            runId,
            role: 'user',
            content: 'Why did this fail?',
            state: 'complete',
            createdAt: '2026-09-13T00:00:00.000Z',
            updatedAt: '2026-09-13T00:00:00.000Z',
            version: 1,
          },
        ],
      }).messages[0],
    ).toMatchObject({ role: 'user', state: 'complete' });
  });

  it('bounds AI attachment previews and message metadata', () => {
    const id = 'c327bcc2-742f-49e4-9c0a-d763b83b0897';
    expect(
      aiAttachmentPreviewSchema.parse({
        id,
        name: 'notes.txt',
        size: 60 * 1024,
        includedBytes: 50 * 1024,
        truncated: true,
        preview: 'safe preview',
        redacted: true,
        expiresAt: '2026-09-13T00:15:00.000Z',
      }),
    ).toMatchObject({ name: 'notes.txt', truncated: true, redacted: true });
    expect(
      aiRequestSchema.parse({
        modelId: id,
        useCase: 'diagnose',
        prompt: '',
        attachmentIds: [id],
      }),
    ).toMatchObject({ prompt: '', context: '', attachmentIds: [id] });
    expect(() =>
      aiAttachmentPreviewSchema.parse({
        id,
        name: 'too-large.txt',
        size: 100 * 1024 + 1,
        includedBytes: 50 * 1024,
        truncated: true,
        preview: '',
        redacted: false,
        expiresAt: '2026-09-13T00:15:00.000Z',
      }),
    ).toThrow();
  });
});
