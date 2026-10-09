import { createServer } from 'node:http';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AiModelInput, AiProvider, AiProviderInput } from '@workspace/contracts';
import { ProductDatabase } from '../adapters/sqlite/database';
import { ProductRepository, etagFor } from '../adapters/sqlite/product-repository';
import { AiService } from './ai-service';
import { RealtimeHub } from './realtime-hub';

async function fixture() {
  const database = await ProductDatabase.open();
  const repository = new ProductRepository(database);
  const provider = repository.createJson<AiProviderInput>(
    'ai_providers',
    {
      name: 'review fixture',
      baseUrl: 'http://127.0.0.1:1/v1/',
      apiPath: '/chat/completions',
      protocol: 'openai-chat',
      auth: 'bearer',
      role: 'token=role-canary',
      proxy: null,
      timeoutMs: 1_000,
      credentialRef: 'fixture-vault-reference',
      enabled: true,
    },
    'ai-provider',
  );
  const model = repository.createJson<AiModelInput>(
    'ai_models',
    { name: 'fixture model', model: 'fixture', providerId: provider.id, capabilities: ['chat'] },
    'ai-model',
  );
  const service = new AiService(repository, undefined, new RealtimeHub(), {} as never);
  const input = {
    modelId: model.id,
    useCase: 'diagnose' as const,
    prompt: 'password=prompt-canary',
    context: 'Bearer context-canary-long',
    terminalId: randomUUID(),
  };
  return {
    database,
    repository,
    provider,
    model,
    service,
    input,
    close: async () => {
      await service.close();
      database.close();
    },
  };
}
afterEach(() => vi.useRealTimers());

describe('Runtime context review binding', () => {
  it('redacts Vault-resolved Pi header credentials in the reviewed request', async () => {
    const f = await fixture();
    f.repository.updateJson<AiProvider>(
      'ai_providers',
      f.provider.id,
      {
        pi: {
          id: 'fixture',
          api: 'openai-completions',
          models: [],
          modelOverrides: {},
          headerCredentialRefs: { 'X-Tenant': 'header-vault-ref' },
        },
      },
      etagFor(f.provider.version),
      'ai-provider',
    );
    const host = {
      resolveCredential: vi.fn(async (ref: string) =>
        ref === 'header-vault-ref' ? 'header-private-canary' : 'primary-private-canary',
      ),
    };
    const service = new AiService(f.repository, host as never, new RealtimeHub(), {} as never);
    try {
      const preview = await service.previewContext({
        ...f.input,
        prompt: 'header-private-canary primary-private-canary',
      });
      expect(JSON.stringify(preview)).not.toMatch(/header-private-canary|primary-private-canary/u);
      expect(host.resolveCredential.mock.calls.flat()).toContain('header-vault-ref');
    } finally {
      await service.close();
      await f.close();
    }
  });
  it('previews without creating work and stores the reviewed body without the receipt', async () => {
    const f = await fixture();
    try {
      const preview = await f.service.previewContext(f.input);
      expect(f.service.list()).toEqual([]);
      expect(JSON.stringify(preview)).not.toMatch(
        /role-canary|prompt-canary|context-canary-long|fixture-vault-reference/u,
      );
      const run = await f.service.start(
        {
          ...preview.request,
          reviewReceipt: preview.reviewReceipt,
          reviewExpiresAt: preview.reviewExpiresAt,
        },
        randomUUID(),
      );
      const row = f.database.get<{ request: string }>(
        'SELECT request FROM ai_runs WHERE id=?',
        run.id,
      )!;
      const request = JSON.parse(row.request) as { prompt: string; context: string };
      expect(request.prompt).toBe(preview.prompt);
      expect(request.context).toBe(preview.context);
      expect(row.request).not.toMatch(/reviewReceipt|reviewExpiresAt|canary/u);
    } finally {
      await f.close();
    }
  });
  it('rejects prompt, target, history selection and configured role changes before creating a run', async () => {
    const f = await fixture();
    try {
      const preview = await f.service.previewContext(f.input);
      const reviewed = {
        ...preview.request,
        reviewReceipt: preview.reviewReceipt,
        reviewExpiresAt: preview.reviewExpiresAt,
      };
      for (const change of [
        { prompt: 'changed' },
        { terminalId: randomUUID() },
        { includeConversationHistory: false },
        { mode: 'work' as const },
      ])
        await expect(f.service.start({ ...reviewed, ...change }, randomUUID())).rejects.toThrow(
          /changed/u,
        );
      f.repository.updateJson<AiProvider>(
        'ai_providers',
        f.provider.id,
        { role: 'changed role' },
        etagFor(f.provider.version),
        'ai-provider',
      );
      await expect(f.service.start(reviewed, randomUUID())).rejects.toThrow(/changed/u);
      expect(f.service.list()).toEqual([]);
    } finally {
      await f.close();
    }
  });
  it('rejects more than 32 known credential scopes before resolving any secret', async () => {
    const f = await fixture();
    const host = { resolveCredential: vi.fn(async () => 'bounded secret') };
    const service = new AiService(f.repository, host as never, new RealtimeHub(), {} as never);
    try {
      for (let index = 0; index < 32; index++)
        f.repository.createJson(
          'ai_providers',
          { ...f.provider, id: randomUUID(), credentialRef: `extra-ref-${index}` },
          'ai-provider',
        );
      await expect(service.previewContext(f.input)).rejects.toThrow(
        /Too many AI credential scopes/u,
      );
      expect(host.resolveCredential).not.toHaveBeenCalled();
      expect(service.list()).toEqual([]);
    } finally {
      await service.close();
      await f.close();
    }
  });
  it('rejects a credential scope changed during an owned Vault read', async () => {
    const f = await fixture();
    let release!: (value: string) => void;
    const host = {
      resolveCredential: vi.fn(
        () =>
          new Promise<string>((resolve) => {
            release = resolve;
          }),
      ),
    };
    const service = new AiService(f.repository, host as never, new RealtimeHub(), {} as never);
    try {
      const preview = service.previewContext(f.input);
      const rejected = expect(preview).rejects.toThrow(/configuration changed/u);
      f.repository.updateJson<AiProvider>(
        'ai_providers',
        f.provider.id,
        { credentialRef: 'replacement-ref' },
        etagFor(f.provider.version),
        'ai-provider',
      );
      release('ephemeral-known-value');
      await rejected;
      expect(service.list()).toEqual([]);
    } finally {
      await service.close();
      await f.close();
    }
  });
  it('requires a fresh preview after a new history message is committed', async () => {
    const f = await fixture();
    try {
      const conversation = f.service.createConversation({
        name: 'history',
        modelId: f.model.id,
        useCase: 'diagnose',
      });
      const preview = await f.service.previewContext({
        ...f.input,
        conversationId: conversation.id,
      });
      f.repository.createAiRun({
        useCase: 'diagnose',
        request: {},
        conversation: { id: conversation.id, prompt: 'new message', attachments: [] },
      });
      await expect(
        f.service.start(
          {
            ...preview.request,
            reviewReceipt: preview.reviewReceipt,
            reviewExpiresAt: preview.reviewExpiresAt,
          },
          randomUUID(),
        ),
      ).rejects.toThrow(/changed/u);
      expect(f.service.list()).toHaveLength(1);
    } finally {
      await f.close();
    }
  });
  it('rejects expired, tampered and previous Runtime receipts', async () => {
    const f = await fixture();
    try {
      const preview = await f.service.previewContext(f.input);
      const reviewed = {
        ...preview.request,
        reviewReceipt: preview.reviewReceipt,
        reviewExpiresAt: preview.reviewExpiresAt,
      };
      await expect(
        f.service.start({ ...reviewed, reviewReceipt: '0'.repeat(64) }, randomUUID()),
      ).rejects.toThrow(/changed/u);
      vi.useFakeTimers();
      vi.setSystemTime(Date.parse(preview.reviewExpiresAt) + 1);
      await expect(f.service.start(reviewed, randomUUID())).rejects.toThrow(/expired/u);
      vi.useRealTimers();
      const nextRuntime = new AiService(f.repository, undefined, new RealtimeHub(), {} as never);
      try {
        await expect(nextRuntime.start(reviewed, randomUUID())).rejects.toThrow(/changed/u);
      } finally {
        await nextRuntime.close();
      }
      expect(f.service.list()).toEqual([]);
    } finally {
      await f.close();
    }
  });
  it('redacts known vault values in files and matches the actual loopback model payload to its preview', async () => {
    const f = await fixture();
    const secret = 'known-unlabeled-vault-value-3187';
    let captured: { messages: Array<{ role: string; content: string }> } | undefined;
    const server = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      captured = JSON.parse(Buffer.concat(chunks).toString('utf8')) as typeof captured;
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      response.end(
        'data: {"choices":[{"delta":{"content":"reviewed safely"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
      );
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Review fixture did not listen');
    const content = `raw unlabeled ${secret} data`;
    const host = {
      resolveCredential: vi.fn(async (_ref: string) => secret),
      readGrantedTextPrefix: vi.fn(async () => ({
        name: `${secret}.txt`,
        content,
        size: Buffer.byteLength(content),
        includedBytes: Buffer.byteLength(content),
        truncated: false,
      })),
      revokeGrant: vi.fn(async (_id: string) => {}),
    };
    f.repository.updateJson<AiProvider>(
      'ai_providers',
      f.provider.id,
      { baseUrl: `http://127.0.0.1:${address.port}/v1/`, role: `expert ${secret}` },
      etagFor(f.provider.version),
      'ai-provider',
    );
    const service = new AiService(f.repository, host as never, new RealtimeHub(), {} as never);
    try {
      const attachment = await service.prepareAttachment('file-grant');
      expect(JSON.stringify(attachment)).not.toContain(secret);
      const preview = await service.previewContext({
        ...f.input,
        prompt: `inspect ${secret}`,
        context: `context ${secret}`,
        attachmentIds: [attachment.id],
      });
      expect(JSON.stringify(preview)).not.toContain(secret);
      const run = await service.start(
        {
          ...preview.request,
          reviewReceipt: preview.reviewReceipt,
          reviewExpiresAt: preview.reviewExpiresAt,
        },
        randomUUID(),
      );
      await vi.waitFor(() => expect(service.get(run.id).state).toBe('succeeded'));
      expect(captured?.messages[0]?.content).toBe(preview.system);
      expect(captured?.messages[1]?.content).toContain(preview.prompt);
      expect(captured?.messages[1]?.content).toContain(preview.context);
      expect(JSON.stringify(captured)).not.toContain(secret);
      const row = f.database.get<{ request: string }>(
        'SELECT request FROM ai_runs WHERE id=?',
        run.id,
      )!;
      expect(row.request).not.toMatch(/known-unlabeled|reviewReceipt|reviewExpiresAt/u);
      expect(host.revokeGrant).toHaveBeenCalledExactlyOnceWith('file-grant');
    } finally {
      await service.close();
      server.close();
      server.closeAllConnections();
      await once(server, 'close');
      await f.close();
    }
  });

  it('aborts owned vault reads on shutdown without publishing a late preview or file draft', async () => {
    const f = await fixture();
    const host = {
      resolveCredential: vi.fn(
        (_ref: string, signal: AbortSignal) =>
          new Promise<string>((_resolve, reject) => {
            signal.addEventListener('abort', () => reject(new Error('owned read canceled')), {
              once: true,
            });
          }),
      ),
      readGrantedTextPrefix: vi.fn(),
      revokeGrant: vi.fn(async (_id: string) => {}),
    };
    const service = new AiService(f.repository, host as never, new RealtimeHub(), {} as never);
    try {
      const preview = service.previewContext(f.input);
      const previewAssertion = expect(preview).rejects.toThrow('owned read canceled');
      const attachment = service.prepareAttachment('late-grant');
      const attachmentAssertion = expect(attachment).rejects.toThrow('owned read canceled');
      await service.close();
      await Promise.all([previewAssertion, attachmentAssertion]);
      expect(host.readGrantedTextPrefix).not.toHaveBeenCalled();
      expect(host.revokeGrant).toHaveBeenCalledExactlyOnceWith('late-grant');
      expect(service.list()).toEqual([]);
    } finally {
      await service.close();
      await f.close();
    }
  });

  it('keeps a model review distinct from tool execution and refuses closed Runtime work', async () => {
    const f = await fixture();
    try {
      const preview = await f.service.previewContext(f.input);
      const reviewed = {
        ...preview.request,
        reviewReceipt: preview.reviewReceipt,
        reviewExpiresAt: preview.reviewExpiresAt,
      };
      await expect(
        f.service.start(
          {
            ...reviewed,
            tool: { name: 'terminal.exec', args: { command: 'never' }, target: f.input.terminalId },
          },
          randomUUID(),
        ),
      ).rejects.toThrow(/receipt/u);
      await f.service.close();
      await expect(f.service.previewContext(f.input)).rejects.toThrow(/closed/u);
      await expect(f.service.start(reviewed, randomUUID())).rejects.toThrow(/closed/u);
      expect(f.service.list()).toEqual([]);
    } finally {
      await f.close();
    }
  });
});
