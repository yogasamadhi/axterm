import type { PluginToolInput } from '@axterm/plugin-api/plugins';
import type { AiToolResourcesPort } from '../../packages/plugins/ai/src/ports/tool-resources.ts';
import { Context } from '@deepseek-ai/cordis';
import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import Storage from '@axterm/infra-storage';
import * as Schema from '@axterm/data-schema';
import * as Relational from '@axterm/infra-storage-relational';
import * as Domains from '@axterm/infra-storage-domain';
import Engines from '../../packages/infra/engines/src/index.ts';
import { AiRepository } from '../../packages/plugins/ai/src/adapters/repository.ts';
import { AiStorage } from '../../packages/plugins/ai/src/adapters/storage.ts';
import { AiRunJournal } from '../../packages/plugins/ai/src/adapters/run-journal.ts';
import { AiFacts } from '../../packages/plugins/ai/src/adapters/facts.ts';
import { AiService, redact } from '../../packages/plugins/ai/src/application/ai-service.ts';
import { AiModels } from '../../packages/plugins/ai/src/adapters/models.ts';
import { AiHostCapabilities } from '../../packages/plugins/ai/src/adapters/host-capabilities.ts';
import { commandReviewer } from '../../packages/plugins/ai/src/adapters/command-review.ts';
import { PiEngineProvider, piEngineConfigSchema } from '../../packages/engines/pi/src/index.ts';
import {
  aiProviderInputSchema,
  aiModelInputSchema,
  type AiProviderProtocol,
  type AiProvider,
  type AiModel,
} from '@axterm/plugin-api/ai';
import { encodeOpaqueCredentialRef } from '@axterm/plugin-api/credentials';
import { MemoryCredentials } from '../support/level3-memory-credentials.ts';
import { piSseStart, piSseText, piSseEnd, piSseHidden } from '../fixtures/pi-sse.ts';
import type { AiToolsPort } from '../../packages/plugins/ai/src/ports/tools.ts';
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
async function server(handler: (request: IncomingMessage, response: ServerResponse) => void) {
  const listener = createServer(handler);
  listener.listen(0, '127.0.0.1');
  await once(listener, 'listening');
  cleanup.push(async () => {
    const done = once(listener, 'close');
    listener.close();
    listener.closeAllConnections();
    await done;
  });
  const address = listener.address();
  if (!address || typeof address === 'string') throw new Error('missing fixture');
  return `http://127.0.0.1:${address.port}/v1`;
}
async function boot(
  baseUrl: string,
  protocol: AiProviderProtocol = 'openai-chat',
  tools: AiToolsPort = {
    risk: () => 'mutating',
    execute: async () => {
      throw new Error('unselected tool');
    },
  },
) {
  const ctx = new Context();
  cleanup.push(() => ctx.fiber.dispose());
  await ctx.plugin(Storage);
  await ctx.plugin(Schema);
  await ctx.plugin(Relational, { path: ':memory:', schema: 'productSchema' });
  await ctx.plugin(Domains, { backend: 'relational' });
  const domain = await ctx.storage.domain.open(Schema.productDomains.ai);
  cleanup.push(() => domain.close());
  const repository = new AiRepository(new AiStorage(domain));
  const owner = { profile: 'desktop', generation: randomUUID(), pid: process.pid };
  const journal = new AiRunJournal(domain, repository, owner, redact);
  const facts = new AiFacts(domain, repository, journal, owner.generation);
  const ref = 'cred_' + randomUUID();
  await ctx.plugin(MemoryCredentials, {
    [encodeOpaqueCredentialRef(ref)]: 'APPLICATION_KEY_CANARY',
  });
  await ctx.plugin(Engines);
  const unregisterEngine = ctx.engines.register(
    'pi',
    new PiEngineProvider(ctx, piEngineConfigSchema.parse({ providers: {} })),
  );
  const models = new AiModels(ctx);
  cleanup.push(() => models.close());
  const host = new AiHostCapabilities(ctx);
  cleanup.push(() => host.close());
  const events: { type: string; payload: unknown }[] = [];
  const service = new AiService(
    repository,
    facts,
    host,
    { publish: (type, payload) => events.push({ type, payload }) },
    tools,
    models,
    commandReviewer,
    undefined,
    owner.generation,
  );
  cleanup.push(() => service.close());
  const provider = repository.createJson(
    'ai_providers',
    aiProviderInputSchema.parse({
      name: 'Saved',
      baseUrl,
      credentialRef: ref,
      protocol,
      auth: protocol === 'anthropic' ? 'x-api-key' : 'bearer',
      apiPath:
        protocol === 'anthropic'
          ? '/messages'
          : protocol === 'openai-responses'
            ? '/responses'
            : '/chat/completions',
      enabled: true,
      timeoutMs: 5000,
    }),
    'ai-provider.created',
  ) as AiProvider;
  const model = repository.createJson(
    'ai_models',
    aiModelInputSchema.parse({
      name: 'Selected',
      providerId: provider.id,
      model: 'application-model',
      capabilities: ['chat', 'tools'],
    }),
    'ai-model.created',
  ) as AiModel;
  return {
    ctx,
    unregisterEngine,
    domain,
    repository,
    owner,
    journal,
    facts,
    models,
    host,
    events,
    service,
    provider,
    model,
  };
}
async function finished(service: AiService, id: string) {
  await vi.waitFor(() => expect(service.get(id).state).toMatch(/^(succeeded|failed|canceled)$/), {
    timeout: 5000,
  });
  return service.get(id);
}
describe.each<AiProviderProtocol>(['openai-chat', 'openai-responses', 'anthropic'])(
  '%s owned AI application',
  (protocol) => {
    it('commits safe visible output before publication, preserves conversation and never repeats a retried execution', async () => {
      let requests = 0;
      const bodies: string[] = [];
      const endpoint = await server((request, response) => {
        let body = '';
        request.on('data', (chunk) => (body += String(chunk)));
        request.on('end', () => {
          requests++;
          bodies.push(body);
          response.writeHead(200, { 'content-type': 'text/event-stream' });
          response.end(
            piSseStart(protocol) +
              piSseHidden(protocol) +
              piSseText(protocol, 'Visible APPLICATION_') +
              piSseText(protocol, 'KEY_CANARY password="PRIVATE\n') +
              piSseText(protocol, 'MULTILINE" done') +
              piSseEnd(protocol),
          );
        });
      });
      const f = await boot(endpoint, protocol);
      const conversation = f.service.createConversation({ name: 'Chat', modelId: f.model.id });
      const input = {
        modelId: f.model.id,
        conversationId: conversation.id,
        useCase: 'chat' as const,
        prompt: 'hello APPLICATION_KEY_CANARY',
        context: '',
      };
      const key = randomUUID();
      const [first, retry] = await Promise.all([
        f.service.start(input, key),
        f.service.start({ ...input }, key),
      ]);
      expect(first.id).toBe(retry.id);
      const run = await finished(f.service, first.id);
      expect(run.state, JSON.stringify(run)).toBe('succeeded');
      expect(run.engineId).toBe('pi');
      expect(run.result).toBe('Visible [REDACTED_KNOWN_SECRET] password=[REDACTED] done');
      expect(requests).toBe(1);
      expect(await f.service.start(input, key)).toEqual(run);
      expect(requests).toBe(1);
      await expect(f.service.start({ ...input, context: 'changed' }, key)).rejects.toThrow(
        'CONFLICT',
      );
      expect(bodies.join('')).not.toContain('APPLICATION_KEY_CANARY');
      const stored =
        JSON.stringify(f.domain.all('SELECT * FROM axterm_ai_run_log')) +
        JSON.stringify(f.domain.all('SELECT * FROM ai_messages')) +
        JSON.stringify(f.events);
      expect(stored).not.toContain('APPLICATION_KEY_CANARY');
      expect(stored).not.toContain('PRIVATE');
      expect(stored).not.toContain('MULTILINE');
      expect(stored).not.toContain('HIDDEN_REASONING');
      expect(f.repository.listAiMessages(conversation.id).map((message) => message.role)).toEqual([
        'user',
        'assistant',
      ]);
      const request = f.domain.get<{ request: string }>(
        'SELECT request FROM ai_runs WHERE id=?',
        run.id,
      )!.request;
      expect(JSON.parse(request)).toMatchObject({
        selection: {
          providerId: f.provider.id,
          providerVersion: 1,
          modelId: f.model.id,
          modelVersion: 1,
        },
      });
      expect(
        f.journal.read(run.id, 0, 200).entries.some((entry) => entry.payload.kind === 'output'),
      ).toBe(true);
    });
  },
);
it('stops accepted setup reentrantly on admission and never allocates model IO afterwards', async () => {
  let requests = 0;
  const endpoint = await server((_request, response) => {
    requests++;
    response.end();
  });
  const f = await boot(endpoint);
  let closing: Promise<void> | undefined;
  const dispose = f.domain.subscribe((batch) => {
    if (batch.some((event) => event.type === 'ai-run.created')) closing = f.service.close();
  });
  const run = await f.service.start(
    { modelId: f.model.id, useCase: 'chat', prompt: 'hello', context: '' },
    randomUUID(),
  );
  await closing;
  expect(f.service.get(run.id).state).toBe('canceled');
  expect(requests).toBe(0);
  expect(f.models.resourceCount()).toBe(0);
  dispose();
});
it('requires one-shot approval for a mutating MCP tool, binds arguments and never executes on retry', async () => {
  const execute = vi.fn(async () => ({ inserted: true }));
  const f = await boot('http://127.0.0.1:1/v1', 'openai-chat', { risk: () => 'mutating', execute });
  const key = randomUUID();
  const source = randomUUID();
  const target = randomUUID();
  const proposal = { name: 'terminal.exec', args: { command: 'echo approved' }, target };
  const invocation = await f.service.invokeRegisteredTool(proposal, key, source);
  expect(invocation.state).toBe('waiting_approval');
  expect(execute).not.toHaveBeenCalled();
  await expect(
    f.service.decideApproval(
      invocation.approvalId!,
      { decision: 'approve_once', argsHash: 'a'.repeat(64) },
      randomUUID(),
    ),
  ).rejects.toThrow('no longer matches');
  const approvalKey = randomUUID();
  await f.service.decideApproval(
    invocation.approvalId!,
    { decision: 'approve_once', argsHash: invocation.argsHash! },
    approvalKey,
  );
  expect(
    (
      await f.service.decideApproval(
        invocation.approvalId!,
        { decision: 'approve_once', argsHash: invocation.argsHash! },
        approvalKey,
      )
    ).state,
  ).toBe('succeeded');
  expect(execute).toHaveBeenCalledTimes(1);
  expect((await f.service.invokeRegisteredTool(proposal, key, source)).state).toBe('succeeded');
  expect(execute).toHaveBeenCalledTimes(1);
  await expect(
    f.service.decideApproval(
      invocation.approvalId!,
      { decision: 'approve_once', argsHash: invocation.argsHash! },
      randomUUID(),
    ),
  ).rejects.toThrow('no longer matches');
  expect(
    f.domain.get<{ operation: string }>(
      'SELECT operation FROM axterm_ai_run_intents WHERE command_id=?',
      key,
    )?.operation,
  ).toBe('mcp-tool');
});
it('stops a source by canceling and joining its actual readonly task without creating human approval', async () => {
  let release!: () => void;
  let entered!: () => void;
  const started = new Promise<void>((resolve) => (entered = resolve));
  const drained = new Promise<void>((resolve) => (release = resolve));
  const execute = vi.fn(async (_name, _args, _target, signal?: AbortSignal) => {
    entered();
    await new Promise<void>((resolve) => {
      signal!.addEventListener('abort', () => resolve(), { once: true });
      if (signal!.aborted) resolve();
    });
    await drained;
    signal!.throwIfAborted();
  });
  const f = await boot('http://127.0.0.1:1/v1', 'openai-chat', {
    risk: () => 'read_only',
    execute,
  });
  const source = randomUUID();
  const running = f.service.invokeRegisteredTool(
    { name: 'terminal.getRecentOutput', args: {}, target: randomUUID() },
    randomUUID(),
    source,
  );
  await started;
  let stopped = false;
  const stop = f.service.stopMcpSource(source).then(() => (stopped = true));
  const runId = f.domain.get<{ id: string }>('SELECT id FROM ai_runs')!.id;
  let executionDrained = false;
  const barrier = f.service.drainRun(runId).then(() => {
    executionDrained = true;
  });
  await Promise.resolve();
  expect(f.service.get(runId).state).toBe('canceled');
  expect(stopped).toBe(false);
  expect(executionDrained).toBe(false);
  release();
  await Promise.all([stop, barrier]);
  expect(executionDrained).toBe(true);
  const result = await running;
  expect(result.state).toBe('canceled');
  expect(f.repository.listApprovals()).toEqual([]);
  expect(execute).toHaveBeenCalledTimes(1);
  await expect(
    f.service.invokeRegisteredTool(
      { name: 'terminal.getRecentOutput', args: {}, target: randomUUID() },
      randomUUID(),
      source,
    ),
  ).rejects.toThrow('stopped');
});

it.skipIf(process.platform === 'win32')(
  'executes reviewed workspace commands through the actual subprocess owner and requires human approval for its temporary-file mutation',
  async () => {
    const { mkdtemp, rm, writeFile, stat } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { default: LocalSubprocess } =
      await import('../../packages/infra/subprocess-local/src/index.ts');
    const { OwnedWorkspaceCommands } =
      await import('../../packages/plugins/ai/src/adapters/workspace-command.ts');
    const { AiWorkspaceService } =
      await import('../../packages/plugins/ai/src/application/ai-workspace-service.ts');
    const { terminalSessionSchema } = await import('@axterm/plugin-api/terminals');
    const directory = await mkdtemp(join(tmpdir(), 'axterm-ai-workflow-'));
    cleanup.push(() => rm(directory, { recursive: true, force: true }));
    const processes = new Context();
    cleanup.push(() => processes.fiber.dispose());
    await processes.plugin(LocalSubprocess);
    const commands = new OwnedWorkspaceCommands(processes.subprocess);
    cleanup.push(() => commands.close());
    const terminal = terminalSessionSchema.parse({
      id: randomUUID(),
      kind: 'local',
      title: 'Selected',
      state: 'ready',
      createdAt: new Date().toISOString(),
    });
    const workspace = new AiWorkspaceService(
      { get: () => ({ ...terminal }), workingDirectory: () => directory },
      {
        get: () => {
          throw new Error('No SSH target');
        },
        executionTarget: () => {
          throw new Error('No SSH target');
        },
        exec: () => {
          throw new Error('No SSH target');
        },
      },
      commands,
      { localHome: directory, remoteWorkspace: directory },
    );
    const f = await boot('http://127.0.0.1:1/v1');
    const service = new AiService(
      f.repository,
      f.facts,
      f.host,
      { publish: () => {} },
      {
        risk: () => 'mutating',
        execute: (_name, args, target, signal) => workspace.execute(target, args, signal),
      },
      f.models,
      commandReviewer,
      workspace,
      f.owner.generation,
    );
    cleanup.push(() => service.close());
    const base = {
      modelId: f.model.id,
      useCase: 'chat' as const,
      mode: 'work' as const,
      prompt: 'Work on the selected temporary directory',
      context: '',
      terminalId: terminal.id,
    };
    const observation = await service.start(
      { ...base, tool: { name: 'workspace.exec', args: { command: 'pwd' }, target: terminal.id } },
      randomUUID(),
    );
    const observed = await finished(service, observation.id);
    expect(observed.state, JSON.stringify(observed)).toBe('succeeded');
    expect(observed.result).toContain(directory);
    expect(f.repository.listToolCalls(observation.id)[0]).toMatchObject({
      state: 'succeeded',
      approvalSource: 'automatic',
    });
    expect(f.repository.listApprovals()).toEqual([]);
    await writeFile(join(directory, 'owned.txt'), 'fixture');
    const mutation = await service.start(
      {
        ...base,
        prompt: 'Remove owned.txt from this temporary directory',
        tool: { name: 'workspace.exec', args: { command: 'rm owned.txt' }, target: terminal.id },
      },
      randomUUID(),
    );
    await vi.waitFor(() => expect(service.get(mutation.id).state).toBe('waiting_approval'));
    expect((await stat(join(directory, 'owned.txt'))).isFile()).toBe(true);
    const approval = f.repository.listApprovals().find((item) => item.runId === mutation.id)!;
    await service.decideApproval(
      approval.id,
      { decision: 'approve_once', argsHash: approval.argsHash },
      randomUUID(),
    );
    expect((await finished(service, mutation.id)).state).toBe('succeeded');
    await expect(stat(join(directory, 'owned.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(f.repository.listToolCalls(mutation.id)[0]).toMatchObject({
      state: 'succeeded',
      approvalSource: 'user',
    });
    await service.close();
    expect(commands.resourceCount()).toBe(0);
    expect(service.activeTaskCount()).toBe(0);
  },
);

it('previews context without model IO, binds its receipt to versions and captures request data before the caller can mutate it', async () => {
  let requests = 0;
  const bodies: string[] = [];
  const endpoint = await server((request, response) => {
    let body = '';
    request.on('data', (chunk) => (body += String(chunk)));
    request.on('end', () => {
      requests++;
      bodies.push(body);
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end(
        piSseStart('openai-chat') + piSseText('openai-chat', 'safe') + piSseEnd('openai-chat'),
      );
    });
  });
  const f = await boot(endpoint);
  const preview = await f.service.previewContext({
    modelId: f.model.id,
    useCase: 'chat',
    prompt: 'hello APPLICATION_KEY_CANARY',
    context: 'token=PRIVATE_INPUT',
  });
  expect(requests).toBe(0);
  expect(JSON.stringify(preview)).not.toContain('APPLICATION_KEY_CANARY');
  expect(JSON.stringify(preview)).not.toContain('PRIVATE_INPUT');
  f.repository.updateJson<AiProvider>(
    'ai_providers',
    f.provider.id,
    { role: 'Changed role' },
    '"v1"',
    'ai-provider.updated',
  );
  await expect(
    f.service.start(
      {
        ...preview.request,
        reviewReceipt: preview.reviewReceipt,
        reviewExpiresAt: preview.reviewExpiresAt,
      },
      randomUUID(),
    ),
  ).rejects.toThrow('review again');
  expect(requests).toBe(0);
  const input = {
    modelId: f.model.id,
    useCase: 'chat' as const,
    prompt: 'original request',
    context: '',
  };
  const running = f.service.start(input, randomUUID());
  input.prompt = 'caller mutation';
  const run = await running;
  expect((await finished(f.service, run.id)).state).toBe('succeeded');
  expect(bodies.join('')).toContain('original request');
  expect(bodies.join('')).not.toContain('caller mutation');
});

it('aborts and joins accepted provider metadata discovery on close and refuses every later mutation/probe', async () => {
  let entered!: () => void;
  const start = new Promise<void>((resolve) => (entered = resolve));
  let canceled = false;
  const endpoint = await server((request, response) => {
    request.resume();
    request.on('end', () => {
      entered();
      response.writeHead(200, { 'content-type': 'application/json' });
      response.write('{"data":[');
      response.once('close', () => (canceled = true));
    });
  });
  const f = await boot(endpoint);
  const probe = f.service.testProvider(f.provider.id);
  void probe.catch(() => {});
  await start;
  await f.service.close();
  await expect(probe).rejects.toMatchObject({ code: 'REQUEST_CANCELED' });
  await vi.waitFor(() => expect(canceled).toBe(true));
  expect(f.models.resourceCount()).toBe(0);
  await expect(f.service.testProvider(f.provider.id)).rejects.toThrow('closed');
  expect(() => f.service.createConversation({ name: 'Late', modelId: f.model.id })).toThrow(
    'closed',
  );
  expect(f.service.activeTaskCount()).toBe(0);
});

function pluginToolFrame(request: unknown, id = 'call_plugin') {
  const data = (value: unknown) => 'data: ' + JSON.stringify(value) + '\n\n';
  return (
    piSseStart('openai-chat') +
    piSseHidden('openai-chat') +
    data({
      choices: [
        {
          delta: {
            tool_calls: [
              {
                index: 0,
                id,
                type: 'function',
                function: { name: 'plugin_manager', arguments: JSON.stringify({ request }) },
              },
            ],
          },
        },
      ],
    }) +
    data({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }) +
    'data: [DONE]\n\n'
  );
}
async function modelPluginFixture(secondBuild = false) {
  const { AiToolService } =
    await import('../../packages/plugins/ai/src/application/ai-tool-service.ts');
  const bodies: Record<string, unknown>[] = [];
  const install = {
    action: 'command' as const,
    request: {
      operation: 'install' as const,
      spec: '@fixture/model-plugin@1.0.0',
      replace: false,
      enabled: true,
    },
  };
  const invoke = vi.fn(
    async (id: string, generation: string, input: PluginToolInput, _signal?: AbortSignal) => {
      const now = new Date().toISOString();
      return {
        id,
        generation,
        operation: input.action === 'command' ? input.request.operation : 'install',
        status: 'running',
        createdAt: now,
        updatedAt: now,
      };
    },
  );
  const tools = new AiToolService({} as AiToolResourcesPort, undefined, {
    target: 'Profile desktop',
    available: () => true,
    invoke,
  });
  const endpoint = await server((request, response) => {
    let raw = '';
    request.on('data', (chunk) => (raw += String(chunk)));
    request.on('end', () => {
      bodies.push(JSON.parse(raw));
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end(
        bodies.length === 1
          ? pluginToolFrame(install)
          : secondBuild && bodies.length === 2
            ? pluginToolFrame(
                {
                  action: 'command',
                  request: { operation: 'build', ids: ['a'.repeat(64)], confirmed: true },
                },
                'call_build',
              )
            : piSseStart('openai-chat') +
              piSseText(
                'openai-chat',
                'Admission recorded; installation completion must be checked separately.',
              ) +
              piSseEnd('openai-chat'),
      );
    });
  });
  const f = await boot(endpoint, 'openai-chat', tools);
  const run = await f.service.start(
    {
      modelId: f.model.id,
      useCase: 'chat',
      prompt: 'Manage the requested plugin with approval',
      context: '',
    },
    randomUUID(),
  );
  const waiting = async () => {
    await vi.waitFor(
      () =>
        expect(
          f.service.get(run.id).state,
          JSON.stringify({
            run: f.service.get(run.id),
            calls: f.repository.listToolCalls(run.id),
            approvals: f.repository.listApprovals(),
            tools: bodies.map((body) => body.tools),
          }),
        ).toBe('waiting_approval'),
      {
        timeout: 5000,
      },
    );
    return f.repository
      .listApprovals()
      .find((row) => row.runId === run.id && row.state === 'pending')!;
  };
  return { ...f, run, invoke, bodies, waiting };
}
it('requires a real per-call approval through Pi, binds admission identity and never applies workspace automatic review', async () => {
  const f = await modelPluginFixture();
  const approval = await f.waiting();
  expect(f.invoke).not.toHaveBeenCalled();
  const declarations = f.bodies[0]!.tools as { function: { name: string } }[];
  expect(declarations.map((row) => row.function.name)).toEqual(['plugin_manager']);
  expect(JSON.stringify(declarations)).not.toMatch(/~standard|~unsafe/);
  const call = f.repository.getToolCall(approval.toolCallId);
  expect(call).toMatchObject({
    toolName: 'plugins.manage',
    risk: 'privileged',
    state: 'waiting_approval',
  });
  expect(call.review).toBeUndefined();
  await expect(
    f.service.decideApproval(
      approval.id,
      { decision: 'approve_once', argsHash: '0'.repeat(64) },
      randomUUID(),
    ),
  ).rejects.toThrow();
  expect(f.invoke).not.toHaveBeenCalled();
  const vote = randomUUID();
  await f.service.decideApproval(
    approval.id,
    { decision: 'approve_once', argsHash: approval.argsHash },
    vote,
  );
  expect((await finished(f.service, f.run.id)).state).toBe('succeeded');
  await f.service.decideApproval(
    approval.id,
    { decision: 'approve_once', argsHash: approval.argsHash },
    vote,
  );
  expect(f.invoke).toHaveBeenCalledTimes(1);
  expect(f.invoke.mock.calls[0]![0]).toBe(call.id);
  expect(f.invoke.mock.calls[0]![1]).toBe(f.owner.generation);
  expect(f.repository.getToolCall(call.id).resultMetadata).toMatchObject({
    id: call.id,
    status: 'running',
  });
  expect(JSON.stringify(f.domain.all('SELECT * FROM axterm_ai_run_log'))).not.toMatch(
    /APPLICATION_KEY_CANARY|HIDDEN_REASONING/,
  );
});
it('never invokes plugin management when the user rejects the model request', async () => {
  const f = await modelPluginFixture();
  const approval = await f.waiting();
  await f.service.decideApproval(
    approval.id,
    { decision: 'reject', argsHash: approval.argsHash },
    randomUUID(),
  );
  expect((await finished(f.service, f.run.id)).state).toBe('canceled');
  expect(f.invoke).not.toHaveBeenCalled();
  await f.service.close();
  expect(f.models.resourceCount()).toBe(0);
});
it('cancels and drains a model waiting for approval without starting a package operation', async () => {
  const f = await modelPluginFixture();
  await f.waiting();
  await f.service.close();
  expect(f.service.get(f.run.id).state).toBe('canceled');
  expect(f.invoke).not.toHaveBeenCalled();
  expect(f.models.resourceCount()).toBe(0);
});
it('expires model approval without executing and requires separate approval for dependency builds', async () => {
  const f = await modelPluginFixture(true);
  let approval = await f.waiting();
  await f.service.decideApproval(
    approval.id,
    { decision: 'approve_once', argsHash: approval.argsHash },
    randomUUID(),
  );
  await vi.waitFor(
    () =>
      expect(f.repository.listApprovals().filter((row) => row.runId === f.run.id)).toHaveLength(2),
    { timeout: 5000 },
  );
  approval = await f.waiting();
  expect(f.invoke).toHaveBeenCalledTimes(1);
  expect(f.repository.getToolCall(approval.toolCallId).args).toMatchObject({
    action: 'command',
    request: { operation: 'build' },
  });
  vi.useFakeTimers({ toFake: ['Date'] });
  try {
    vi.setSystemTime(Date.parse(approval.expiresAt) + 1);
    await expect(
      f.service.decideApproval(
        approval.id,
        { decision: 'approve_once', argsHash: approval.argsHash },
        randomUUID(),
      ),
    ).rejects.toThrow('expired');
  } finally {
    vi.useRealTimers();
  }
  expect((await finished(f.service, f.run.id)).state).toBe('canceled');
  expect(f.invoke).toHaveBeenCalledTimes(1);
  expect(f.repository.getApproval(approval.id).state).toBe('expired');
});
it('withdraws an Engine waiting for plugin approval as canceled and performs no package operation', async () => {
  const f = await modelPluginFixture();
  await f.waiting();
  await f.unregisterEngine();
  const run = await finished(f.service, f.run.id);
  expect(run.state).toBe('canceled');
  expect(run.errorCode).toBe('AI_ENGINE_CANCELLED');
  expect(f.invoke).not.toHaveBeenCalled();
  expect(f.models.resourceCount()).toBe(0);
});
it('does not advertise or admit model management without its application owner', async () => {
  const { AiToolService } =
    await import('../../packages/plugins/ai/src/application/ai-tool-service.ts');
  const tools = new AiToolService({} as AiToolResourcesPort);
  expect(tools.modelTools()).toEqual([]);
  expect(tools.mcpTools().some((row) => row.name === 'plugins.manage')).toBe(false);
  expect(() => tools.mcpProposal('plugins.manage', { request: { action: 'snapshot' } })).toThrow(
    'unavailable',
  );
  await expect(
    tools.execute('plugins.manage', { action: 'snapshot' }, 'Profile desktop', undefined, {
      id: randomUUID(),
      generation: randomUUID(),
    }),
  ).rejects.toThrow();
});
it('gives a manager query its own MCP approval and never reuses an installation approval', async () => {
  const { AiToolService } =
    await import('../../packages/plugins/ai/src/application/ai-tool-service.ts');
  const invoke = vi.fn(async () => ({ inventory: null, commands: [] }));
  const tools = new AiToolService({} as AiToolResourcesPort, undefined, {
    target: 'Profile desktop',
    available: () => true,
    invoke,
  });
  const f = await boot('http://127.0.0.1:1/v1', 'openai-chat', tools);
  const proposal = tools.mcpProposal('plugins.manage', { request: { action: 'snapshot' } });
  const invocation = await f.service.invokeRegisteredTool(proposal, randomUUID(), randomUUID());
  expect(invocation.state).toBe('waiting_approval');
  expect(invoke).not.toHaveBeenCalled();
  await f.service.decideApproval(
    invocation.approvalId!,
    { decision: 'approve_once', argsHash: invocation.argsHash! },
    randomUUID(),
  );
  expect(invoke).toHaveBeenCalledTimes(1);
});
