import fileRemote from '../../packages/plugins/files/lib/typert.remote-client.js';
import { FileGrantsModel } from '../../packages/plugins/files/src/client/index.ts';
import * as Terminals from '../../packages/plugins/terminals/src/client/index.ts';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { aiRemoteProfile } from '../fixtures/level3-ai-remote-profile.ts';
import { piSseText, piSseEnd, piSseHidden, piSseStart } from '../fixtures/pi-sse.ts';
import type { AiRunModel } from '../../packages/plugins/ai/src/client/index.ts';
const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
});
async function fixture(handler: (request: IncomingMessage, response: ServerResponse) => void) {
  const home = await mkdtemp(join(tmpdir(), 'axterm-retained-ai-remote-'));
  cleanups.push(() => rm(home, { recursive: true, force: true }));
  const listener = createServer(handler);
  listener.listen(0, '127.0.0.1');
  await once(listener, 'listening');
  cleanups.push(async () => {
    const closed = once(listener, 'close');
    listener.close();
    listener.closeAllConnections();
    await closed;
  });
  const address = listener.address();
  if (!address || typeof address === 'string') throw Error('Missing model listener');
  const profile = await aiRemoteProfile(home);
  cleanups.push(profile.close);
  return { ...profile, home, baseUrl: `http://127.0.0.1:${address.port}/v1` };
}
it('streams Pi text before completion, resumes from durable owned logs, and retains canceled partial text', async () => {
  let response: ServerResponse | undefined;
  const f = await fixture((request, outgoing) => {
    request.resume();
    request.on('end', () => {
      response = outgoing;
      outgoing.writeHead(200, { 'content-type': 'text/event-stream' });
      outgoing.write(piSseText('openai-chat', '第一段🙂'));
    });
  });
  const selected = await f.selection(f.baseUrl);
  const conversation = await f.model.createConversation(randomUUID(), {
    name: 'Stream fixture',
    modelId: selected.modelId,
    useCase: 'chat',
  });
  const start = () =>
    f.model.startRun(randomUUID(), {
      modelId: selected.modelId,
      conversationId: conversation.ids[0]!,
      mode: 'chat',
      useCase: 'chat',
      prompt: 'hello',
      context: '',
    });
  const run = await start();
  let view: AiRunModel | undefined;
  try {
    await vi.waitFor(async () => expect((await f.model.getRun(run.id)).result).toBe('第一段🙂'));
    expect((await f.model.getRun(run.id)).state).toBe('running');
    view = await f.model.openRun(run.id);
    await vi.waitFor(() => expect(view!.getSnapshot().visible.output).toBe('第一段🙂'));
    response!.write(piSseText('openai-chat', '，第二段'));
    await vi.waitFor(() => expect(view!.getSnapshot().visible.output).toBe('第一段🙂，第二段'));
    const cursor = view.getSnapshot().visible.cursor;
    await view.retry();
    expect(view.getSnapshot().visible.output).toBe('第一段🙂，第二段');
    expect(view.getSnapshot().visible.cursor).toBeGreaterThanOrEqual(cursor);
    await view.dispose();
    expect((await f.model.getRun(run.id)).state).toBe('running');
    view = await f.model.openRun(run.id);
    await vi.waitFor(() => expect(view!.getSnapshot().visible.output).toBe('第一段🙂，第二段'));
    await vi.waitFor(() =>
      expect(view!.getSnapshot().visible.cursor).toBeGreaterThanOrEqual(cursor),
    );
    response!.end(piSseText('openai-chat', '，结尾') + piSseEnd('openai-chat'));
    await vi.waitFor(() => expect(view!.getSnapshot().visible.run.state).toBe('succeeded'));
    expect(view.getSnapshot().visible.output).toBe('第一段🙂，第二段，结尾');
    const messages = await f.model.getMessages(conversation.ids[0]!, { limit: 50 });
    expect(messages.messages.filter((item) => item.role === 'assistant')).toMatchObject([
      { content: '第一段🙂，第二段，结尾' },
    ]);
    await view.dispose();
    view = await f.model.openRun(run.id);
    await vi.waitFor(() => expect(view!.getSnapshot().visible.run.state).toBe('succeeded'));
    expect(view.getSnapshot().visible.output).toBe('第一段🙂，第二段，结尾');
    await view.dispose();
    view = undefined;
    const canceled = await start();
    await vi.waitFor(async () =>
      expect((await f.model.getRun(canceled.id)).result).toBe('第一段🙂'),
    );
    await f.model.cancelRun(randomUUID(), canceled.id);
    await vi.waitFor(async () =>
      expect((await f.model.getRun(canceled.id)).state).toBe('canceled'),
    );
    expect((await f.model.getRun(canceled.id)).result).toBe('第一段🙂');
    expect(
      (await f.model.getMessages(conversation.ids[0]!, { limit: 50 })).messages.at(-1),
    ).toMatchObject({ role: 'assistant', state: 'canceled', content: '第一段🙂' });
  } finally {
    await view?.dispose();
  }
}, 20_000);
it('persists, resumes, cancels and deletes a versioned chat session across an actual Host and Vault restart', async () => {
  const requests: string[] = [];
  const f = await fixture((request, response) => {
    if (request.method !== 'POST' || request.url !== '/v1/chat/completions') {
      response.writeHead(404).end();
      return;
    }
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk) => {
      body += String(chunk);
    });
    request.on('end', () => {
      requests.push(body);
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      if (requests.length === 3) return;
      response.end(
        piSseText('openai-chat', requests.length === 1 ? 'first answer' : 'second answer') +
          piSseEnd('openai-chat'),
      );
    });
  });
  const selected = await f.selection(f.baseUrl);
  const conversation = await f.model.createConversation(randomUUID(), {
    name: 'Persistent session',
    modelId: selected.modelId,
    useCase: 'diagnose',
  });
  const id = conversation.ids[0]!;
  const input = {
    conversationId: id,
    modelId: selected.modelId,
    useCase: 'diagnose' as const,
    prompt: 'first question',
    context: '',
  };
  const first = await f.model.startRun(randomUUID(), input);
  await vi.waitFor(async () => expect((await f.model.getRun(first.id)).state).toBe('succeeded'));
  expect((await f.model.getMessages(id, { limit: 50 })).messages).toMatchObject([
    { role: 'user', content: 'first question', state: 'complete' },
    { role: 'assistant', content: 'first answer', state: 'complete' },
  ]);
  await f.close();
  const restarted = await aiRemoteProfile(f.home);
  cleanups.push(restarted.close);
  expect(await restarted.model.getConversation(id)).toMatchObject({ id, messageCount: 2 });
  const second = await restarted.model.startRun(randomUUID(), {
    ...input,
    prompt: 'second question',
  });
  await vi.waitFor(async () =>
    expect((await restarted.model.getRun(second.id)).state).toBe('succeeded'),
  );
  expect(requests[1]).toContain('Assistant: first answer');
  expect((await restarted.model.getMessages(id, { limit: 50 })).messages).toHaveLength(4);
  const third = await restarted.model.startRun(randomUUID(), {
    ...input,
    prompt: 'cancel this request',
  });
  await restarted.model.cancelRun(randomUUID(), third.id);
  await vi.waitFor(async () =>
    expect((await restarted.model.getRun(third.id)).state).toBe('canceled'),
  );
  expect((await restarted.model.getMessages(id, { limit: 50 })).messages.at(-1)).toMatchObject({
    role: 'assistant',
    state: 'canceled',
  });
  const latest = await restarted.model.getConversation(id);
  await restarted.model.deleteConversation(randomUUID(), id, '"v' + latest.version + '"');
  await expect(restarted.model.getConversation(id)).rejects.toMatchObject({
    code: 'ai/failure',
    details: { reason: 'not-found' },
  });
  const state = restarted.model.getSnapshot();
  expect(
    state.status === 'ready' && state.baseline.conversations.some((row) => row.id === id),
  ).toBe(false);
}, 20_000);
it('saves a redacted protocol configuration and tests it using the actual application-local Vault and Pi discovery', async () => {
  const seen: { authorization?: string; path?: string } = {};
  const f = await fixture((request, response) => {
    seen.authorization = String(request.headers.authorization ?? '');
    seen.path = request.url ?? '';
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ data: [{ id: 'fixture-model' }] }));
  });
  const key = 'LOCAL_RESPONSES_DISCOVERY_CANARY';
  const selected = await f.selection(f.baseUrl, 'openai-responses', key);
  expect(JSON.stringify(selected.provider)).not.toContain(key);
  await expect(f.model.testProvider(selected.provider.id)).resolves.toMatchObject({
    providerId: selected.provider.id,
    protocol: 'openai-responses',
    ok: true,
    models: ['fixture-model'],
  });
  expect(seen).toEqual({ authorization: 'Bearer ' + key, path: '/v1/models' });
}, 15_000);

const palette = {
  name: 'Runtime Ocean',
  terminal: {
    foreground: '#f2f7fa',
    background: '#101820',
    cursor: '#ffffff',
    cursorAccent: '#101820',
    selectionBackground: 'rgba(70, 140, 180, 0.45)',
    black: '#101820',
    red: '#ff6b6b',
    green: '#6bdb9a',
    yellow: '#ffd166',
    blue: '#63a4ff',
    magenta: '#c792ea',
    cyan: '#5eead4',
    white: '#dce7ec',
    brightBlack: '#536471',
    brightRed: '#ff8f8f',
    brightGreen: '#8ce8b2',
    brightYellow: '#ffe29a',
    brightBlue: '#8ebcff',
    brightMagenta: '#dab0f0',
    brightCyan: '#8af3e4',
    brightWhite: '#ffffff',
  },
  ui: {
    main: '#101820',
    'main-dark': '#0a1015',
    'main-light': '#1c2a34',
    text: '#f2f7fa',
    'text-light': '#ffffff',
    'text-dark': '#b7c7d0',
    'text-disabled': '#71818a',
    primary: '#4ea8de',
    info: '#63a4ff',
    success: '#6bdb9a',
    error: '#ff6b6b',
    warn: '#ffd166',
  },
} as const;

it('normalizes a safe bookmark draft and never persists secret-bearing invalid output through actual Remote', async () => {
  let count = 0;
  const f = await fixture((request, response) => {
    request.resume();
    request.on('end', () => {
      const result =
        ++count === 1
          ? {
              name: 'Staging API',
              title: 'API staging',
              hostname: 'staging.example.com',
              port: 2222,
              username: 'deploy',
              authType: 'privateKey',
              description: 'Staging application server',
              favorite: true,
            }
          : {
              name: 'Unsafe',
              title: 'Unsafe',
              hostname: 'unsafe.example.com',
              port: 22,
              username: 'root',
              authType: 'password',
              description: '',
              favorite: false,
              password: 'model-invented-secret',
            };
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end(piSseText('openai-chat', JSON.stringify(result)) + piSseEnd('openai-chat'));
    });
  });
  const selected = await f.selection(f.baseUrl);
  const first = await f.model.startRun(randomUUID(), {
    modelId: selected.modelId,
    useCase: 'createBookmark',
    prompt: 'Create the staging bookmark',
    context: '',
  });
  await vi.waitFor(async () => expect((await f.model.getRun(first.id)).state).toBe('succeeded'));
  const safe = await f.model.getRun(first.id);
  expect(safe).toMatchObject({ state: 'succeeded', useCase: 'createBookmark' });
  expect(JSON.parse(safe.result!)).toMatchObject({
    hostname: 'staging.example.com',
    port: 2222,
    authType: 'privateKey',
  });
  const second = await f.model.startRun(randomUUID(), {
    modelId: selected.modelId,
    useCase: 'createBookmark',
    prompt: 'Create another bookmark',
    context: '',
  });
  await vi.waitFor(async () => expect((await f.model.getRun(second.id)).state).toBe('failed'));
  const unsafe = await f.model.getRun(second.id);
  expect(unsafe).toMatchObject({ state: 'failed', errorCode: 'AI_OUTPUT_INVALID' });
  expect(unsafe.result).toBeUndefined();
  expect(JSON.stringify(await f.model.getLog(second.id, { limit: 50 }))).not.toContain(
    'model-invented-secret',
  );
  const state = f.model.getSnapshot();
  expect(state.status === 'ready' && JSON.stringify(state.baseline.runs)).not.toContain(
    'model-invented-secret',
  );
}, 15_000);
it('persists only a complete readable theme palette and drops invalid partial output through actual Remote', async () => {
  let count = 0;
  const f = await fixture((request, response) => {
    request.resume();
    request.on('end', () => {
      const result =
        ++count === 1
          ? palette
          : {
              ...palette,
              terminal: { ...palette.terminal, foreground: '#111111', background: '#101010' },
              injectedCss: 'body { display: none }',
            };
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end(piSseText('openai-chat', JSON.stringify(result)) + piSseEnd('openai-chat'));
    });
  });
  const selected = await f.selection(f.baseUrl);
  const first = await f.model.startRun(randomUUID(), {
    modelId: selected.modelId,
    useCase: 'createTheme',
    prompt: 'Create an ocean palette',
    context: '',
  });
  await vi.waitFor(async () => expect((await f.model.getRun(first.id)).state).toBe('succeeded'));
  const valid = await f.model.getRun(first.id);
  expect(valid).toMatchObject({ state: 'succeeded', useCase: 'createTheme' });
  expect(JSON.parse(valid.result!)).toEqual(palette);
  const second = await f.model.startRun(randomUUID(), {
    modelId: selected.modelId,
    useCase: 'createTheme',
    prompt: 'Create another palette',
    context: '',
  });
  await vi.waitFor(async () => expect((await f.model.getRun(second.id)).state).toBe('failed'));
  const invalid = await f.model.getRun(second.id);
  expect(invalid).toMatchObject({ state: 'failed', errorCode: 'AI_OUTPUT_INVALID' });
  expect(invalid.result).toBeUndefined();
  expect(JSON.stringify(await f.model.getLog(second.id, { limit: 50 }))).not.toContain(
    'injectedCss',
  );
  const state = f.model.getSnapshot();
  expect(state.status === 'ready' && JSON.stringify(state.baseline.runs)).not.toContain(
    'injectedCss',
  );
}, 15_000);

it('previews actual imported file authority, rejects binary and oversized sources and persists attachment metadata without bodies', async () => {
  const requests: string[] = [];
  const f = await fixture((request, response) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk) => {
      body += String(chunk);
    });
    request.on('end', () => {
      requests.push(body);
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end(piSseText('openai-chat', 'reviewed') + piSseEnd('openai-chat'));
    });
  });
  const selected = await f.selection(f.baseUrl);
  const unmount = await f.client.remote.$mount(fileRemote);
  cleanups.push(async () => unmount());
  const files = new FileGrantsModel(f.client, f.request);
  cleanups.push(() => files.dispose());
  await vi.waitFor(() => expect(files.getSnapshot().status).toBe('ready'));
  const content = `password=integration-secret\n${'diagnostic line\n'.repeat(4_000)}`;
  const grants: string[] = [];
  for (const [name, bytes, reason] of [
    ['archive.bin', Buffer.from([0x61, 0, 0x62]), 'invalid'],
    ['huge.txt', Buffer.alloc(100 * 1024 + 1, 65), 'capacity'],
  ] as const) {
    const grant = await files.importFile(new File([new Uint8Array(bytes).buffer], name));
    grants.push(grant.grantId);
    await expect(f.model.prepareAttachment(grant.grantId)).rejects.toMatchObject({
      code: 'ai/failure',
      details: { reason },
    });
  }
  const grant = await files.importFile(new File([content], 'diagnostic.txt'));
  grants.push(grant.grantId);
  const attachment = await f.model.prepareAttachment(grant.grantId);
  expect(attachment).toMatchObject({
    name: 'diagnostic.txt',
    size: Buffer.byteLength(content),
    includedBytes: 50 * 1024,
    truncated: true,
    redacted: true,
  });
  expect(attachment.preview).not.toContain('integration-secret');
  await vi.waitFor(() => {
    const state = files.getSnapshot();
    expect(
      state.status === 'ready' &&
        state.baseline.grants.every((entry) => !grants.includes(entry.grantId)),
    ).toBe(true);
  });
  const conversation = await f.model.createConversation(randomUUID(), {
    name: 'Attachment session',
    modelId: selected.modelId,
    useCase: 'diagnose',
  });
  const run = await f.model.startRun(randomUUID(), {
    modelId: selected.modelId,
    conversationId: conversation.ids[0]!,
    useCase: 'diagnose',
    prompt: 'Review the attached log',
    context: '',
    attachmentIds: [attachment.id],
  });
  await vi.waitFor(async () => expect((await f.model.getRun(run.id)).state).toBe('succeeded'));
  expect(requests[0]).toContain('<file name=\\"diagnostic.txt\\" truncated=\\"true\\">');
  expect(requests[0]).toContain('password=[REDACTED]');
  expect(requests[0]).not.toContain('integration-secret');
  const messages = (await f.model.getMessages(conversation.ids[0]!, { limit: 50 })).messages;
  expect(messages[0]).toMatchObject({
    role: 'user',
    content: 'Review the attached log',
    attachments: [
      {
        name: 'diagnostic.txt',
        size: Buffer.byteLength(content),
        includedBytes: 50 * 1024,
        truncated: true,
      },
    ],
  });
  expect(JSON.stringify(messages)).not.toContain('diagnostic line');
  expect(JSON.stringify(await f.model.getLog(run.id, { limit: 50 }))).not.toContain(
    'integration-secret',
  );
}, 20_000);
describe.each(['openai-chat', 'openai-responses', 'anthropic'] as const)(
  'reviewed %s authenticated Remote lifecycle',
  (protocol) => {
    it('previews context without model work, binds sending, cancels an actual partial stream and masks provider failures', async () => {
      const bodies: string[] = [];
      let canceledConnection = false;
      const f = await fixture((request, response) => {
        let body = '';
        request.setEncoding('utf8');
        request.on('data', (chunk) => {
          body += String(chunk);
        });
        request.on('end', () => {
          bodies.push(body);
          if (bodies.length === 3) {
            response.writeHead(401, { 'content-type': 'application/json' });
            response.end(
              JSON.stringify({
                error: { message: 'PRIVATE_PROVIDER_FAILURE known-runtime-context-canary' },
              }),
            );
            return;
          }
          response.writeHead(200, { 'content-type': 'text/event-stream' });
          response.write(
            piSseStart(protocol) +
              piSseHidden(protocol) +
              piSseText(protocol, bodies.length === 1 ? 'reviewed safely' : 'partial visible'),
          );
          if (bodies.length === 1) response.end(piSseEnd(protocol));
          else
            response.on('close', () => {
              canceledConnection = true;
            });
        });
      });
      const selected = await f.selection(
        f.baseUrl,
        protocol,
        'known-runtime-context-canary',
        'expert known-runtime-context-canary',
      );
      await f.client.plugin(Terminals);
      await vi.waitFor(() => expect(f.client.terminalsModel.getSnapshot().status).toBe('ready'));
      const terminal = await f.client.terminalsModel.create({ kind: 'local', cols: 80, rows: 24 });
      const input = {
        modelId: selected.modelId,
        useCase: 'diagnose' as const,
        terminalId: terminal.id,
        prompt: 'password=prompt-canary known-runtime-context-canary',
        context: 'token=context-canary known-runtime-context-canary',
      };
      const preview = await f.model.previewContext(input);
      expect(bodies).toEqual([]);
      const initial = f.model.getSnapshot();
      expect(initial.status === 'ready' && initial.baseline.runs).toEqual([]);
      expect(JSON.stringify(preview)).not.toMatch(
        /prompt-canary|context-canary|known-runtime-context-canary/u,
      );
      const reviewed = {
        ...preview.request,
        reviewReceipt: preview.reviewReceipt,
        reviewExpiresAt: preview.reviewExpiresAt,
      };
      await expect(
        f.model.startRun(randomUUID(), { ...reviewed, terminalId: randomUUID() }),
      ).rejects.toMatchObject({ code: 'ai/failure', details: { reason: 'precondition' } });
      expect(bodies).toEqual([]);
      const run = await f.model.startRun(randomUUID(), reviewed);
      await vi.waitFor(async () => expect((await f.model.getRun(run.id)).state).toBe('succeeded'));
      expect(bodies).toHaveLength(1);
      expect(bodies[0]).toContain(preview.prompt);
      expect(bodies[0]).not.toMatch(/known-runtime-context-canary|context-canary/u);
      expect(JSON.stringify(await f.model.getRun(run.id))).not.toContain('HIDDEN_REASONING_CANARY');
      const partial = await f.model.startRun(randomUUID(), { ...input, prompt: 'second request' });
      const view = await f.model.openRun(partial.id);
      try {
        await vi.waitFor(() => expect(view.getSnapshot().visible.output).toBe('partial visible'));
        await f.model.cancelRun(randomUUID(), partial.id);
        await vi.waitFor(async () =>
          expect((await f.model.getRun(partial.id)).state).toBe('canceled'),
        );
        await vi.waitFor(() => expect(canceledConnection).toBe(true));
        expect(JSON.stringify(await f.model.getLog(partial.id, { limit: 50 }))).not.toContain(
          'HIDDEN_REASONING_CANARY',
        );
      } finally {
        await view.dispose();
      }
      const rejected = await f.model.startRun(randomUUID(), {
        ...input,
        prompt: 'provider failure',
      });
      await vi.waitFor(async () =>
        expect((await f.model.getRun(rejected.id)).state).toBe('failed'),
      );
      expect(JSON.stringify(await f.model.getRun(rejected.id))).not.toMatch(
        /PRIVATE_PROVIDER_FAILURE|known-runtime-context-canary/u,
      );
      await f.client.terminalsModel.close(terminal.id);
    }, 20_000);
  },
);
