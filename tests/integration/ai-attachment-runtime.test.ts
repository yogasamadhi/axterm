import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createRuntimeClient } from '../../packages/client/src/api-client';
import { startRuntime } from '../../packages/runtime/src/bootstrap/runtime';

const cleanup: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.allSettled(cleanup.splice(0).map((close) => close()));
});

async function listen(handler: (request: IncomingMessage, response: ServerResponse) => void) {
  const server = createServer(handler);
  const sockets = new Set<Socket>();
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Fixture did not listen');
  cleanup.push(async () => {
    for (const socket of sockets) socket.destroy();
    server.close();
    await once(server, 'close').catch(() => undefined);
  });
  return `http://127.0.0.1:${address.port}`;
}

async function waitForRun(client: ReturnType<typeof createRuntimeClient>, runId: string) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const run = await client.aiRun(runId);
    if (run.state === 'succeeded') return run;
    if (['failed', 'canceled'].includes(run.state)) throw new Error(`Run entered ${run.state}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('AI attachment run did not finish');
}

describe('AI attachment Runtime boundary', () => {
  it('previews explicit grants, rejects binary/oversize input and persists metadata without content', async () => {
    const dataDirectory = await mkdtemp(join(tmpdir(), 'axterm-ai-attachment-'));
    cleanup.push(() => rm(dataDirectory, { recursive: true, force: true }));
    const filesDirectory = await mkdtemp(join(tmpdir(), 'axterm-ai-attachment-files-'));
    cleanup.push(() => rm(filesDirectory, { recursive: true, force: true }));
    const files = new Map<string, { name: string; path: string }>();
    const validContent = `password=integration-secret\n${'diagnostic line\n'.repeat(4_000)}`;
    for (const [id, name, content] of [
      ['valid', 'diagnostic.txt', Buffer.from(validContent)],
      ['binary', 'archive.bin', Buffer.from([0x61, 0, 0x62])],
      ['oversize', 'huge.txt', Buffer.alloc(100 * 1024 + 1, 65)],
    ] as const) {
      const path = join(filesDirectory, name);
      await writeFile(path, content);
      files.set(id, { name, path });
    }

    const hostToken = randomUUID();
    const revoked = new Set<string>();
    const hostUrl = await listen((request, response) => {
      if (request.headers.authorization !== `Bearer ${hostToken}`) {
        response.writeHead(401).end();
        return;
      }
      if (request.method === 'POST' && request.url?.startsWith('/host/v1/credentials/')) {
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ secret: 'application-local-ai-secret' }));
        return;
      }
      const match = /^\/host\/v1\/grants\/([^/]+)(?:\/resolve)?$/.exec(request.url ?? '');
      if (match?.[1] && request.method === 'POST' && request.url?.endsWith('/resolve')) {
        const id = decodeURIComponent(match[1]);
        const file = files.get(id);
        if (!file || revoked.has(id)) {
          response.writeHead(404, { 'Content-Type': 'application/json' });
          response.end(JSON.stringify({ code: 'GRANT_NOT_FOUND' }));
          return;
        }
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(
          JSON.stringify({
            grantId: id,
            kind: 'file',
            name: file.name,
            permissions: ['read'],
            createdAt: new Date(0).toISOString(),
            path: file.path,
          }),
        );
        return;
      }
      if (match?.[1] && request.method === 'DELETE') {
        revoked.add(decodeURIComponent(match[1]));
        response.writeHead(204).end();
        return;
      }
      response.writeHead(404).end();
    });

    const providerRequests: string[] = [];
    const providerUrl = await listen((request, response) => {
      let body = '';
      request.setEncoding('utf8');
      request.on('data', (chunk) => (body += String(chunk)));
      request.on('end', () => {
        providerRequests.push(body);
        response.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
        });
        response.write(
          `data: ${JSON.stringify({ choices: [{ delta: { content: 'reviewed' } }] })}\n\n`,
        );
        response.end('data: [DONE]\n\n');
      });
    });

    const start = () =>
      startRuntime({
        generation: randomUUID(),
        appVersion: '0.10.0',
        mode: 'headless',
        dataDirectory,
        hostCapabilityUrl: hostUrl,
        hostCapabilityToken: hostToken,
      });
    let runtime = await start();
    let client = createRuntimeClient({ resolve: async () => runtime.bootstrap() });
    const provider = await client.createAiProvider({
      name: 'Attachment fixture',
      baseUrl: `${providerUrl}/v1/`,
      apiPath: '/chat/completions',
      protocol: 'openai-chat',
      auth: 'bearer',
      role: 'Terminal expert',
      proxy: null,
      timeoutMs: 5_000,
      credentialRef: 'ai-key',
      enabled: true,
    });
    const model = await client.createAiModel({
      providerId: provider.id,
      name: 'Fixture',
      model: 'fixture-model',
      capabilities: ['chat'],
    });
    const conversation = await client.createAiConversation({
      name: 'Attachment session',
      modelId: model.id,
      useCase: 'diagnose',
    });

    await expect(client.prepareAiAttachment('binary')).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
    });
    await expect(client.prepareAiAttachment('oversize')).rejects.toMatchObject({
      code: 'PAYLOAD_TOO_LARGE',
    });
    expect(revoked).toEqual(new Set(['binary', 'oversize']));

    const attachment = await client.prepareAiAttachment('valid');
    expect(attachment).toMatchObject({
      name: 'diagnostic.txt',
      size: Buffer.byteLength(validContent),
      includedBytes: 50 * 1024,
      truncated: true,
      redacted: true,
    });
    expect(attachment.preview).not.toContain('integration-secret');
    expect(revoked.has('valid')).toBe(true);
    const run = await client.startAi({
      modelId: model.id,
      conversationId: conversation.id,
      useCase: 'diagnose',
      prompt: 'Review the attached log',
      context: '',
      attachmentIds: [attachment.id],
    });
    await waitForRun(client, run.id);
    expect(providerRequests[0]).toContain('<file name=\\"diagnostic.txt\\" truncated=\\"true\\">');
    expect(providerRequests[0]).toContain('password=[REDACTED]');
    expect(providerRequests[0]).not.toContain('integration-secret');
    const message = (await client.aiConversation(conversation.id)).messages[0]!;
    expect(message).toMatchObject({
      role: 'user',
      content: 'Review the attached log',
      attachments: [
        {
          name: 'diagnostic.txt',
          size: Buffer.byteLength(validContent),
          includedBytes: 50 * 1024,
          truncated: true,
        },
      ],
    });

    client.dispose();
    await runtime.close();
    runtime = await start();
    client = createRuntimeClient({ resolve: async () => runtime.bootstrap() });
    expect((await client.aiConversation(conversation.id)).messages[0]?.attachments).toEqual(
      message.attachments,
    );
    client.dispose();
    await runtime.close();
  });
});
