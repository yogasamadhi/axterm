import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import { Context } from '@deepseek-ai/cordis';
import { afterEach, expect, it, vi } from 'vitest';
import Engines from '../../packages/infra/engines/src/index.ts';
import {
  PiEngineProvider,
  Config,
  piEngineConfigSchema,
} from '../../packages/engines/pi/src/index.ts';
import {
  engineExecutionOptionsSchema,
  engineRunInputSchema,
  type EngineEvent,
  type EngineToolRequest,
} from '@axterm/engine-api';
import { MemoryCredentials } from '../support/level3-memory-credentials.ts';
import { piSseStart, piSseText, piSseEnd, piSseHidden, piSseCommand } from '../fixtures/pi-sse.ts';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const dispose of cleanup.splice(0).reverse()) await dispose();
});
async function server(handler: (request: IncomingMessage, response: ServerResponse) => void) {
  const listener = createServer(handler);
  listener.listen(0, '127.0.0.1');
  await once(listener, 'listening');
  const address = listener.address();
  if (!address || typeof address === 'string') throw new Error('Fixture listener missing');
  cleanup.push(async () => {
    const done = once(listener, 'close');
    listener.close();
    listener.closeAllConnections();
    await done;
  });
  return `http://127.0.0.1:${address.port}/v1`;
}
function config(baseUrl: string, api = 'openai-completions', timeoutMs = 1000) {
  return piEngineConfigSchema.parse({
    providers: {
      configured: {
        provider: 'axterm-fixture',
        api,
        baseUrl,
        credentialRef: 'PI_KEY',
        headerCredentialRefs: { 'x-tenant-key': 'TENANT_KEY' },
        models: [{ id: 'fixture-model' }],
        timeoutMs,
      },
    },
  });
}
async function boot(settings: ReturnType<typeof config>) {
  const root = new Context();
  cleanup.push(async () => {
    await root.fiber.dispose();
  });
  await root.plugin(MemoryCredentials, {
    PI_KEY: 'PRIVATE_API_KEY',
    TENANT_KEY: 'PRIVATE_TENANT_KEY',
  });
  await root.plugin(Engines);
  root.engines.register('pi', new PiEngineProvider(root, settings));
  return { root, session: await root.engines.openSession('pi', { sessionId: 'app-session' }) };
}
const input = (runId = 'run') =>
  engineRunInputSchema.parse({
    runId,
    providerId: 'configured',
    model: 'fixture-model',
    system: 'Visible system',
    prompt: 'Visible prompt',
    context: 'Reviewed context',
  });
for (const [protocol, api] of [
  ['openai-chat', 'openai-completions'],
  ['openai-responses', 'openai-responses'],
  ['anthropic', 'anthropic-messages'],
] as const)
  it(`executes the actual pinned Pi ${api} stream through ctx.engines without emitting private reasoning`, async () => {
    let body = '';
    let key = '';
    let tenant = '';
    let requests = 0;
    const endpoint = await server((req, res) => {
      requests++;
      key = String(req.headers[protocol === 'anthropic' ? 'x-api-key' : 'authorization']);
      tenant = String(req.headers['x-tenant-key']);
      req.setEncoding('utf8');
      req.on('data', (chunk) => {
        body += chunk;
      });
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.end(
          piSseStart(protocol) +
            piSseHidden(protocol) +
            piSseText(protocol, 'Visible result') +
            piSseEnd(protocol),
        );
      });
    });
    const { session } = await boot(config(endpoint, api));
    const events: EngineEvent[] = [];
    expect(
      await session.run(input(), {
        event: async (event) => {
          events.push(event);
        },
      }).done,
    ).toEqual({ status: 'completed' });
    expect(events).toContainEqual({ type: 'delta', text: 'Visible result' });
    expect(events.at(-1)).toEqual({ type: 'completed' });
    expect(JSON.stringify(events)).not.toMatch(
      /HIDDEN_REASONING_CANARY|PRIVATE_API_KEY|PRIVATE_TENANT_KEY/,
    );
    expect(body).toContain('Reviewed context');
    expect(body).not.toMatch(/"tools"|"execute"/);
    expect(key).toContain('PRIVATE_API_KEY');
    expect(tenant).toBe('PRIVATE_TENANT_KEY');
    expect(requests).toBe(1);
    await session.close();
  });

it('resolves changed Vault references for each operation and explicitly reports missing model/provider/credential', async () => {
  const keys: string[] = [];
  const endpoint = await server((req, res) => {
    keys.push(String(req.headers.authorization));
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(piSseText('openai-chat', 'ok') + piSseEnd('openai-chat'));
    });
  });
  const { root, session } = await boot(config(endpoint));
  expect(await session.run(input('first'), { event: async () => {} }).done).toEqual({
    status: 'completed',
  });
  const { credentialRef } = await import('@axterm/plugin-api/credentials');
  await root.credentials.set(credentialRef('PI_KEY'), 'CHANGED_PRIVATE_KEY');
  expect(await session.run(input('second'), { event: async () => {} }).done).toEqual({
    status: 'completed',
  });
  expect(keys).toEqual(['Bearer PRIVATE_API_KEY', 'Bearer CHANGED_PRIVATE_KEY']);
  expect(
    await session.run({ ...input('missing-model'), model: 'absent' }, { event: async () => {} })
      .done,
  ).toEqual({ status: 'failed', code: 'missing' });
  expect(
    await session.run(
      { ...input('missing-provider'), providerId: 'absent' },
      { event: async () => {} },
    ).done,
  ).toEqual({ status: 'failed', code: 'missing' });
  await root.credentials.unset(credentialRef('PI_KEY'));
  expect(await session.run(input('missing-key'), { event: async () => {} }).done).toEqual({
    status: 'failed',
    code: 'missing',
  });
  expect(keys).toHaveLength(2);
  await session.close();
});

it('returns a command proposal without executing and uses only the application tool callback for a real Pi work loop', async () => {
  let requests = 0;
  const bodies: string[] = [];
  const endpoint = await server((req, res) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      bodies.push(body);
      requests++;
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(
        requests === 3
          ? piSseText('openai-chat', 'Actual completed work') + piSseEnd('openai-chat')
          : piSseCommand('pwd'),
      );
    });
  });
  const { session } = await boot(config(endpoint));
  const tool = vi.fn(async (_request: EngineToolRequest, _signal: AbortSignal) => ({
    text: 'APPROVED_ACTUAL_RESULT',
    isError: false,
  }));
  const events: EngineEvent[] = [];
  expect(
    await session.run(
      { ...input('proposal'), allowCommandProposal: true },
      {
        event: async (event) => {
          events.push(event);
        },
        tool,
      },
    ).done,
  ).toEqual({ status: 'completed' });
  expect(tool).not.toHaveBeenCalled();
  expect(events).toContainEqual({ type: 'commandProposal', command: 'pwd' });
  expect(
    await session.run({ ...input('work'), tools: true }, { event: async () => {}, tool }).done,
  ).toEqual({ status: 'completed' });
  expect(tool).toHaveBeenCalledOnce();
  expect(tool.mock.calls[0]![0]).toEqual({
    callId: 'call_workspace',
    name: 'workspace.exec',
    arguments: { command: 'pwd' },
  });
  expect(bodies[2]).toContain('APPROVED_ACTUAL_RESULT');
  expect(requests).toBe(3);
  await session.close();
});

it('does not authorize or continue a Pi tool when application approval rejects', async () => {
  let requests = 0;
  const endpoint = await server((req, res) => {
    requests++;
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(piSseCommand('rm -rf /unapproved-target'));
    });
  });
  const { session } = await boot(config(endpoint));
  const deny = vi.fn(async () => {
    throw new Error('PRIVATE_APPROVAL_DETAIL');
  });
  expect(
    await session.run({ ...input(), tools: true }, { event: async () => {}, tool: deny }).done,
  ).toEqual({ status: 'failed', code: 'tool-unavailable' });
  expect(deny).toHaveBeenCalledOnce();
  expect(requests).toBe(1);
  await session.close();
});

it('cancels a stalled real provider request, joins it on unload and redacts HTTP failures without retry', async () => {
  const entered = Promise.withResolvers<void>();
  const socketClosed = Promise.withResolvers<void>();
  let attempts = 0;
  const endpoint = await server((req, res) => {
    attempts++;
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(piSseText('openai-chat', 'partial'));
      entered.resolve();
      res.once('close', () => socketClosed.resolve());
    });
  });
  const { root, session } = await boot(config(endpoint));
  const run = session.run(input(), { event: async () => {} });
  await entered.promise;
  await run.cancel();
  expect(await run.done).toEqual({ status: 'cancelled' });
  await socketClosed.promise;
  await session.close();
  expect(attempts).toBe(1);
  const failure = await server((req, res) => {
    attempts++;
    req.resume();
    req.on('end', () => {
      res.writeHead(401);
      res.end('PRIVATE_HTTP_ERROR_BODY');
    });
  });
  root.engines.register('pi-error', new PiEngineProvider(root, config(failure)));
  const failed = await root.engines.openSession('pi-error', { sessionId: 'failed' });
  expect(await failed.run(input('error'), { event: async () => {} }).done).toEqual({
    status: 'failed',
    code: 'provider-failed',
  });
  expect(attempts).toBe(2);
  await failed.close();
});

it('validates strict bounded Schemastery Config and refuses ambient auth or file-session options', () => {
  expect(Config({ providers: {} })).toEqual({ providers: {} });
  for (const value of [
    { providers: {}, authFile: '/private/auth.json' },
    {
      providers: {
        configured: {
          ...config('http://127.0.0.1').providers.configured,
          apiKey: 'PRIVATE_INLINE_KEY',
        },
      },
    },
    {
      providers: {
        configured: { ...config('http://127.0.0.1').providers.configured, credentialRef: '$ENV' },
      },
    },
    {
      providers: {
        configured: {
          ...config('http://127.0.0.1').providers.configured,
          baseUrl: 'file:///private/model',
        },
      },
    },
  ]) {
    try {
      Reflect.apply(Config, undefined, [value]);
      throw new Error('Unexpected acceptance');
    } catch (error) {
      expect(String(error)).not.toContain('PRIVATE_INLINE_KEY');
      expect(String(error)).not.toContain('/private/');
      expect(String(error)).not.toBe('Error: Unexpected acceptance');
    }
  }
});

it('preserves existing Pi model ids, unknown-price sentinels and large model metadata', () => {
  const settings = config('http://127.0.0.1');
  const selected = settings.providers.configured!;
  const model = {
    id: 'm'.repeat(512),
    cost: { input: -1, output: -1000000, cacheRead: 0, cacheWrite: 0 },
    maxTokens: 10000000,
  };
  selected.models = [model];
  expect(Config(settings).providers.configured!.models).toEqual([model]);
  expect(engineRunInputSchema.parse({ ...input(), model: model.id }).model).toBe(model.id);
});

it('retains bounded non-ASCII contexts that fit the existing one-MiB model request limit', async () => {
  let received = '';
  const endpoint = await server((req, res) => {
    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      received += chunk;
    });
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(piSseText('openai-chat', 'context accepted') + piSseEnd('openai-chat'));
    });
  });
  const { session } = await boot(config(endpoint));
  const context = '中'.repeat(90000);
  expect(await session.run({ ...input(), context }, { event: async () => {} }).done).toEqual({
    status: 'completed',
  });
  expect(received).toContain(context);
  expect(Buffer.byteLength(received)).toBeGreaterThan(131072);
  expect(Buffer.byteLength(received)).toBeLessThan(1024 * 1024);
  await session.close();
});

it('preserves model ids that coincide with object properties without inheriting fake overrides', async () => {
  let body = '';
  const endpoint = await server((req, res) => {
    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(piSseText('openai-chat', 'property-name model') + piSseEnd('openai-chat'));
    });
  });
  const settings = config(endpoint);
  settings.providers.configured!.models = [{ id: 'constructor' }];
  const { session } = await boot(settings);
  expect(
    await session.run({ ...input(), model: 'constructor' }, { event: async () => {} }).done,
  ).toEqual({ status: 'completed' });
  expect(JSON.parse(body).model).toBe('constructor');
  await session.close();
});

it('executes concurrent application provider snapshots independently with no Profile write or shared provider mutation', async () => {
  const received: string[] = [];
  const endpoint = async (label: string) =>
    server((req, res) => {
      received.push(label);
      req.resume();
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.end(piSseText('openai-chat', label) + piSseEnd('openai-chat'));
      });
    });
  const alpha = await endpoint('alpha');
  const beta = await endpoint('beta');
  const { root, session } = await boot(piEngineConfigSchema.parse({}));
  const second = await root.engines.openSession('pi', { sessionId: 'second-binding' });
  const binding = (url: string) => ({
    configuration: {
      kind: 'pi-provider-v1',
      providerId: 'configured',
      provider: config(url).providers.configured!,
    },
  });
  const firstOptions = engineExecutionOptionsSchema.parse(binding(alpha));
  const secondOptions = engineExecutionOptionsSchema.parse(binding(beta));
  const outputs: string[][] = [[], []];
  const a = session.run(
    input('alpha'),
    {
      event: async (event) => {
        if (event.type === 'delta') outputs[0]!.push(event.text);
      },
    },
    firstOptions,
  );
  const b = second.run(
    input('beta'),
    {
      event: async (event) => {
        if (event.type === 'delta') outputs[1]!.push(event.text);
      },
    },
    secondOptions,
  );
  (firstOptions.configuration as { provider: { baseUrl: string } }).provider.baseUrl =
    'http://127.0.0.1:1';
  expect(await a.done).toEqual({ status: 'completed' });
  expect(await b.done).toEqual({ status: 'completed' });
  expect(outputs).toEqual([['alpha'], ['beta']]);
  expect(received.sort()).toEqual(['alpha', 'beta']);
  expect(await session.run(input('still-no-profile'), { event: async () => {} }).done).toEqual({
    status: 'failed',
    code: 'missing',
  });
  await session.close();
  await second.close();
});
it('rejects supplied Pi bindings with foreign formats, mismatched ids or literal secrets without falling back to a configured provider', async () => {
  let requests = 0;
  const endpoint = await server((req, res) => {
    requests++;
    req.resume();
    res.end();
  });
  const settings = config(endpoint);
  const { session } = await boot(settings);
  for (const [index, configuration] of [
    { kind: 'foreign', providerId: 'configured', provider: settings.providers.configured! },
    { kind: 'pi-provider-v1', providerId: 'other', provider: settings.providers.configured! },
    {
      kind: 'pi-provider-v1',
      providerId: 'configured',
      provider: { ...settings.providers.configured!, apiKey: 'MUST_NOT_RESOLVE_OR_SEND' },
    },
  ].entries()) {
    expect(
      await session.run(
        input('invalid-binding-' + index),
        { event: async () => {} },
        engineExecutionOptionsSchema.parse({ configuration }),
      ).done,
    ).toEqual({ status: 'failed', code: 'invalid' });
  }
  expect(requests).toBe(0);
  await session.close();
});

it('treats a legacy API path as path data and never redirects Vault authentication to an embedded origin', async () => {
  let foreignRequests = 0;
  let path = '';
  const foreign = await server((req, res) => {
    foreignRequests++;
    req.resume();
    res.end();
  });
  const endpoint = await server((req, res) => {
    path = req.url ?? '';
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(
        piSseStart('openai-chat') +
          piSseText('openai-chat', 'same origin') +
          piSseEnd('openai-chat'),
      );
    });
  });
  const settings = config(endpoint);
  const origin = new URL(foreign).origin;
  settings.providers.configured!.legacy = { apiPath: `/${origin}/steal`, auth: 'bearer' };
  const { session } = await boot(settings);
  expect(await session.run(input('path-data'), { event: async () => {} }).done).toEqual({
    status: 'completed',
  });
  expect(path).toBe(`/v1/${origin}/steal`);
  expect(foreignRequests).toBe(0);
  await session.close();
});

it('redacts the actual resolved API/header credentials across model event boundaries before acknowledging visible events', async () => {
  const endpoint = await server((req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(
        piSseStart('openai-chat') +
          piSseText('openai-chat', 'begin PRIVATE_') +
          piSseText('openai-chat', 'API_KEY and PRIVATE_TEN') +
          piSseText('openai-chat', 'ANT_KEY end') +
          piSseEnd('openai-chat'),
      );
    });
  });
  const { session } = await boot(config(endpoint));
  const events: EngineEvent[] = [];
  expect(
    await session.run(input('redacted-boundaries'), {
      event: async (event) => {
        events.push(event);
      },
    }).done,
  ).toEqual({ status: 'completed' });
  const text = events.flatMap((event) => (event.type === 'delta' ? [event.text] : [])).join('');
  expect(text).toBe('begin [REDACTED_KNOWN_SECRET] and [REDACTED_KNOWN_SECRET] end');
  expect(JSON.stringify(events)).not.toMatch(/PRIVATE_API_KEY|PRIVATE_TENANT_KEY|PRIVATE_/);
  await session.close();
});

it('rejects model commands containing resolved credentials before either proposals or application tools can observe them', async () => {
  let requests = 0;
  const endpoint = await server((req, res) => {
    requests++;
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(piSseCommand('printf PRIVATE_API_KEY'));
    });
  });
  const { session } = await boot(config(endpoint));
  const tool = vi.fn(async () => ({ text: 'never executed', isError: false }));
  for (const tools of [false, true]) {
    const events: EngineEvent[] = [];
    expect(
      await session.run(
        { ...input('secret-command-' + tools), allowCommandProposal: true, tools },
        {
          event: async (event) => {
            events.push(event);
          },
          tool,
        },
      ).done,
    ).toEqual({ status: 'failed', code: 'tool-unavailable' });
    expect(JSON.stringify(events)).not.toContain('PRIVATE_API_KEY');
  }
  expect(tool).not.toHaveBeenCalled();
  expect(requests).toBe(2);
  await session.close();
});
it('holds the Agent tool until the preceding Engine event is consumed without relaxing backpressure', async () => {
  let requests = 0;
  const endpoint = await server((req, res) => {
    req.resume();
    req.on('end', () => {
      requests++;
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(
        piSseStart('openai-chat') +
          (requests === 1
            ? piSseCommand('echo approved')
            : piSseText('openai-chat', 'Actual result observed') + piSseEnd('openai-chat')),
      );
    });
  });
  const { session } = await boot(config(endpoint));
  const reached = Promise.withResolvers<void>(),
    release = Promise.withResolvers<void>();
  const tool = vi.fn(async () => ({ text: 'approved result', isError: false }));
  let first = true;
  const running = session.run(
    { ...input(), tools: true },
    {
      event: async (event) => {
        if (event.type === 'usage' && first) {
          first = false;
          reached.resolve();
          await release.promise;
        }
      },
      tool,
    },
  ).done;
  try {
    await reached.promise;
    expect(requests).toBe(1);
    expect(tool).not.toHaveBeenCalled();
  } finally {
    release.resolve();
  }
  expect(await running).toEqual({ status: 'completed' });
  expect(tool).toHaveBeenCalledTimes(1);
  expect(requests).toBe(2);
});
