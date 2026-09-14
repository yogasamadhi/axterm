import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { createRuntimeClient } from '../../packages/client/src/api-client';
import { startRuntime } from '../../packages/runtime/src/bootstrap/runtime';

const runtimes: Awaited<ReturnType<typeof startRuntime>>[] = [];

afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.close()));
});

async function listen(handler: (request: IncomingMessage, response: ServerResponse) => void) {
  const server = createServer(handler);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Fixture did not listen');
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: async () => {
      server.close();
      await once(server, 'close');
    },
  };
}

describe('AI provider Runtime boundary', () => {
  it('saves a redacted protocol configuration and tests it with a local Vault secret', async () => {
    const apiKey = 'runtime-ai-secret';
    const hostToken = randomUUID();
    const seen = { authorization: '', path: '' };
    const model = await listen((request, response) => {
      seen.authorization = String(request.headers.authorization ?? '');
      seen.path = request.url ?? '';
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ data: [{ id: 'fixture-model' }] }));
    });
    const host = await listen((request, response) => {
      if (request.headers.authorization !== `Bearer ${hostToken}`) {
        response.writeHead(401).end();
        return;
      }
      if (request.method === 'POST' && request.url === '/host/v1/credentials/ai-key/resolve') {
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ secret: apiKey }));
        return;
      }
      response.writeHead(404, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ code: 'NOT_FOUND' }));
    });
    try {
      const runtime = await startRuntime({
        generation: randomUUID(),
        appVersion: '0.10.0',
        mode: 'headless',
        hostCapabilityUrl: host.baseUrl,
        hostCapabilityToken: hostToken,
      });
      runtimes.push(runtime);
      const client = createRuntimeClient({ resolve: async () => runtime.bootstrap() });
      const provider = await client.createAiProvider({
        name: 'Local Responses fixture',
        baseUrl: `${model.baseUrl}/v1/`,
        apiPath: '/responses',
        protocol: 'openai-responses',
        auth: 'bearer',
        role: 'Terminal expert',
        proxy: null,
        timeoutMs: 5_000,
        credentialRef: 'ai-key',
        enabled: true,
      });
      expect(JSON.stringify(provider)).not.toContain(apiKey);
      await client.createAiModel({
        providerId: provider.id,
        name: 'Fixture',
        model: 'fixture-model',
        capabilities: ['chat', 'tools'],
      });
      await expect(client.testAiProvider(provider.id)).resolves.toMatchObject({
        providerId: provider.id,
        protocol: 'openai-responses',
        ok: true,
        models: ['fixture-model'],
      });
      expect(seen).toEqual({
        authorization: `Bearer ${apiKey}`,
        path: '/v1/models',
      });
      client.dispose();
    } finally {
      await host.close();
      await model.close();
    }
  });
});
