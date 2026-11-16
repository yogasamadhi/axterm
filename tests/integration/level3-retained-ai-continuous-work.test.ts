import { ownedAiPolicy } from '../fixtures/level3-ai-policy.ts';
import { encodeOpaqueCredentialRef } from '@axterm/plugin-api/credentials';
import type { AiHostPort } from '../../packages/plugins/ai/src/ports/host.ts';
import LocalSubprocess from '../../packages/infra/subprocess-local/src/index.ts';
import { OwnedWorkspaceCommands } from '../../packages/plugins/ai/src/adapters/workspace-command.ts';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm, mkdir, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AiModel, AiWorkspace } from '@axterm/plugin-api/ai';
import { piSseCommand, piSseEnd, piSseText, piTestProvider } from '../fixtures/pi-sse.ts';
import type { AiToolsPort } from '../../packages/plugins/ai/src/ports/tools.ts';
import type { AiWorkspaceService } from '../../packages/plugins/ai/src/application/ai-workspace-service.ts';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
async function fixture(commands: string[], realProcess = false, stallReview = false) {
  const cwd = await mkdtemp(join(tmpdir(), 'axterm-auto-review-'));
  cleanup.push(() => rm(cwd, { recursive: true, force: true }));
  const requests: Array<{ messages: Array<{ role: string; content: string }>; tools?: unknown[] }> =
    [];
  let mainTurns = 0;
  let allowReview = true;
  let holding = false;
  const held: Array<() => void> = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => {
      body += String(chunk);
    });
    req.on('end', () => {
      const payload = JSON.parse(body) as (typeof requests)[number];
      requests.push(payload);
      const reviewing = payload.messages[0]?.content.startsWith('You review one command');
      if (reviewing && stallReview) return;
      const command = commands[mainTurns];
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const send = () =>
        res.end(
          reviewing
            ? piSseText(
                'openai-chat',
                JSON.stringify({
                  outcome: allowReview ? 'allow' : 'deny',
                  risk_level: allowReview ? 'medium' : 'critical',
                  user_authorization: 'high',
                  rationale: 'Requested bounded fixture change.',
                }),
              ) + piSseEnd('openai-chat')
            : command
              ? piSseCommand(command).replaceAll('call_workspace', `call_${++mainTurns}`)
              : piSseText('openai-chat', 'Task finished from actual results.') +
                piSseEnd('openai-chat'),
        );
      if (holding) held.push(send);
      else send();
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No server');
  cleanup.push(async () => {
    const closed = once(server, 'close');
    server.close();
    server.closeAllConnections();
    await closed;
  });
  const owned = await ownedAiPolicy();
  cleanup.push(owned.close);
  const database = owned.domain,
    repository = owned.repository;
  await owned.ctx.credentials.set(
    encodeOpaqueCredentialRef('vault-ref'),
    'MODEL_KEY_FIXTURE_CANARY',
  );
  await owned.ctx.plugin(LocalSubprocess);
  const workspaceCommands = new OwnedWorkspaceCommands(owned.ctx.subprocess);
  cleanup.push(() => workspaceCommands.close());
  owned.ctx.effect(() => () => workspaceCommands.close());
  const provider = repository.createJson(
    'ai_providers',
    { ...piTestProvider(`http://127.0.0.1:${address.port}`), timeoutMs: 1000 },
    'ai-provider',
  );
  const model = repository.createJson<
    Pick<AiModel, 'name' | 'providerId' | 'model' | 'capabilities'>
  >(
    'ai_models',
    {
      name: 'fixture',
      providerId: provider.id,
      model: 'fixture-model',
      capabilities: ['chat', 'tools'],
    },
    'ai-model',
  );
  const workspace: AiWorkspace = {
    terminalId: randomUUID(),
    terminalKind: 'local',
    workspaceDirectory: cwd,
    commandDirectory: cwd,
    execution: 'local',
  };
  let ready = true;
  const execute = vi.fn(
    async (_name: string, args: Record<string, unknown>, _target: string, signal: AbortSignal) =>
      realProcess
        ? workspaceCommands.execute(
            String(args.command),
            (args.workspace as AiWorkspace).commandDirectory!,
            signal,
          )
        : { stdout: `result:${String(args.command)}`, stderr: '', exitCode: 0 },
  );
  const tools = { execute } as unknown as AiToolsPort;
  const workspaces = {
    resolve: async (terminalId: string) => ({ ...workspace, terminalId }),
    targetReady: () => ready,
  } as unknown as AiWorkspaceService;
  const host = {
    resolveCredential: async () => 'MODEL_KEY_FIXTURE_CANARY',
  } as unknown as AiHostPort;
  const service = owned.createService(host, tools, workspaces);
  cleanup.push(() => service.close());
  const start = (terminalId = workspace.terminalId) =>
    service.start(
      {
        modelId: model.id,
        useCase: 'chat',
        mode: 'work',
        terminalId,
        prompt:
          'Inspect this workspace, write updated to marker.txt if needed, and finish the task.',
        context: '',
      },
      randomUUID(),
    );
  return {
    ctx: owned.ctx,
    service,
    start,
    execute,
    requests,
    repository,
    database,
    workspace,
    host,
    holdModel: () => {
      holding = true;
      return () => {
        holding = false;
        for (const send of held.splice(0)) send();
      };
    },
    denyReview: () => {
      allowReview = false;
    },
    closeTarget: () => {
      ready = false;
    },
  };
}
describe('native Pi continuous work and Runtime decisions', () => {
  it('executes successive commands in the selected terminal’s live local directory and records the actual paths', async () => {
    const f = await fixture(['node -p "process.cwd()"', 'node -p "process.cwd()"'], true);
    const original = f.workspace.commandDirectory!;
    const next = join(original, 'next folder');
    await mkdir(next);
    const execute = f.execute.getMockImplementation()!;
    f.execute.mockImplementationOnce(async (...args) => {
      const result = await execute(...args);
      f.workspace.commandDirectory = next;
      f.workspace.workspaceDirectory = next;
      return result;
    });
    const run = await f.start();
    await vi.waitFor(() => expect(f.service.get(run.id).state).toBe('succeeded'));
    const calls = f.service.toolCalls(run.id);
    expect(calls.map((call) => (call.args.workspace as AiWorkspace).commandDirectory)).toEqual([
      original,
      next,
    ]);
    expect(calls.map((call) => call.resultMetadata?.commandDirectory)).toEqual([original, next]);
    expect(String(calls[0]?.resultMetadata?.stdout).trim()).toBe(await realpath(original));
    expect(String(calls[1]?.resultMetadata?.stdout).trim()).toBe(await realpath(next));
    expect(JSON.stringify(f.requests[2])).toContain(next);
    const definition = JSON.stringify(f.requests[0]?.tools);
    expect(definition).toContain('current directory at dispatch');
    expect(definition).not.toContain('Runtime reviews safe commands');
  });
  it('refuses a reconnected SSH generation between commands instead of following a replacement connection', async () => {
    const f = await fixture(['hostname', 'whoami']);
    f.workspace.terminalKind = 'ssh';
    f.workspace.execution = 'ssh';
    f.workspace.connectionId = randomUUID();
    f.workspace.sshTarget = { hostname: 'fixture', port: 22, username: 'fixture', generation: 1 };
    f.execute.mockImplementationOnce(async () => {
      f.workspace.sshTarget = { ...f.workspace.sshTarget!, generation: 2 };
      return { stdout: 'first', stderr: '', exitCode: 0 };
    });
    const run = await f.start();
    await vi.waitFor(() =>
      expect(f.service.get(run.id)).toMatchObject({
        state: 'failed',
        errorCode: 'PRECONDITION_FAILED',
      }),
    );
    expect(f.execute).toHaveBeenCalledTimes(1);
  });
  it.skipIf(process.platform !== 'win32')(
    'runs transparent PowerShell observation and an authorized file write without approval',
    async () => {
      const f = await fixture(
        [
          'powershell -NoProfile -NonInteractive -Command "Get-Location"',
          "powershell -NoProfile -NonInteractive -Command \"Set-Content -LiteralPath 'marker.txt' -Value 'updated' -Encoding UTF8\"",
          'hostname',
        ],
        true,
      );
      const run = await f.start();
      await vi.waitFor(() => expect(f.service.get(run.id).state).toBe('succeeded'), {
        timeout: 10000,
      });
      expect(f.service.approvals()).toHaveLength(0);
      for (const call of f.service.toolCalls(run.id))
        expect(call.resultMetadata).toMatchObject({ exitCode: 0 });
      expect(f.service.toolCalls(run.id).map((call) => call.approvalSource)).toEqual([
        undefined,
        undefined,
        undefined,
      ]);
      expect(
        (await readFile(join(f.workspace.commandDirectory!, 'marker.txt'), 'utf8'))
          .replace(/^\uFEFF/u, '')
          .trim(),
      ).toBe('updated');
    },
  );
  it('executes three safe steps without approval and ends only on the final model reply', async () => {
    const f = await fixture(['whoami', 'hostname', 'node --version']);
    const run = await f.start();
    await vi.waitFor(() => expect(f.service.get(run.id).state).toBe('succeeded'));
    expect(f.execute).toHaveBeenCalledTimes(3);
    expect(f.service.approvals()).toHaveLength(0);
    expect(f.service.get(run.id).result).toBe('Task finished from actual results.');
    expect(
      f.service.toolCalls(run.id).map((call) => [call.step, call.approvalSource, call.state]),
    ).toEqual([
      [1, undefined, 'succeeded'],
      [2, undefined, 'succeeded'],
      [3, undefined, 'succeeded'],
    ]);
    expect(f.requests).toHaveLength(4);
    expect(f.requests[3]!.messages.filter((message) => message.role === 'tool')).toHaveLength(3);
    // Wall-clock correction must not reorder committed work steps or the latest-call lookup.
    const ordered = f.service.toolCalls(run.id);
    for (const call of ordered)
      f.database.run(
        'UPDATE ai_tool_calls SET created_at=? WHERE id=?',
        new Date((4 - call.step!) * 1000).toISOString(),
        call.id,
      );
    expect(f.service.toolCalls(run.id).map((call) => call.step)).toEqual([1, 2, 3]);
    expect(f.service.toolCalls(run.id).at(-1)?.step).toBe(3);
  });
  it('executes a bounded mutation directly without requesting or inventing review', async () => {
    const f = await fixture(['echo updated > marker.txt']);
    const run = await f.start();
    await vi.waitFor(() => expect(f.service.get(run.id).state).toBe('succeeded'));
    expect(f.execute).toHaveBeenCalledTimes(1);
    expect(f.service.toolCalls(run.id)[0]).toMatchObject({ risk: 'mutating', state: 'succeeded' });
    expect(f.service.toolCalls(run.id)[0]?.approvalSource).toBeUndefined();
    expect(f.service.toolCalls(run.id)[0]?.review).toBeUndefined();
    expect(f.service.approvals()).toEqual([]);
    expect(f.requests).toHaveLength(2);
  });
  it('does not invoke the former reviewer even when its fixture would refuse the command', async () => {
    const f = await fixture(['echo updated > marker.txt', 'hostname']);
    f.denyReview();
    const run = await f.start();
    await vi.waitFor(() => expect(f.service.get(run.id).state).toBe('succeeded'));
    expect(f.execute).toHaveBeenCalledTimes(2);
    expect(f.service.approvals()).toEqual([]);
    expect(f.service.toolCalls(run.id).every((call) => call.review === undefined)).toBe(true);
    expect(f.requests).toHaveLength(3);
    expect(
      f.requests.some((request) =>
        request.messages[0]?.content.startsWith('You review one command'),
      ),
    ).toBe(false);
  });
  it('continues through a destructive command without a per-command approval pause', async () => {
    const f = await fixture(['whoami', 'del marker.txt', 'hostname']);
    const run = await f.start();
    await vi.waitFor(() => expect(f.service.get(run.id).state).toBe('succeeded'));
    expect(f.execute).toHaveBeenCalledTimes(3);
    expect(f.service.approvals()).toEqual([]);
    expect(f.service.toolCalls(run.id).map((call) => call.state)).toEqual([
      'succeeded',
      'succeeded',
      'succeeded',
    ]);
    expect(f.requests).toHaveLength(4);
    expect(JSON.stringify(f.requests[3])).toContain('result:del marker.txt');
  });
  it.each(['cancel', 'shutdown', 'target', 'timeout'] as const)(
    'stops the entire loop on %s during model generation',
    async (action) => {
      const f = await fixture(['del marker.txt', 'hostname']);
      const release = f.holdModel();
      const run = await f.start();
      await vi.waitFor(() => expect(f.requests).toHaveLength(1));
      if (action === 'cancel') f.service.cancel(run.id);
      else if (action === 'shutdown') await f.service.close();
      else if (action === 'target') f.closeTarget();
      await vi.waitFor(
        () =>
          expect(f.service.get(run.id).state).toBe(action === 'timeout' ? 'failed' : 'canceled'),
        { timeout: 3000 },
      );
      if (action === 'target') expect(f.service.get(run.id).errorCode).toBe('PRECONDITION_FAILED');
      if (action === 'timeout') expect(f.service.get(run.id).errorCode).toBe('AI_PROVIDER_FAILED');
      release();
      await f.service.close();
      expect(f.execute).not.toHaveBeenCalled();
      expect(f.service.toolCalls(run.id)).toEqual([]);
      expect(f.requests).toHaveLength(1);
    },
  );
  it('keeps a nonzero exit result in the loop for diagnosis', async () => {
    const f = await fixture(['whoami', 'hostname']);
    f.execute.mockResolvedValueOnce({ stdout: '', stderr: 'failure to diagnose', exitCode: 1 });
    const run = await f.start();
    await vi.waitFor(() => expect(f.service.get(run.id).state).toBe('succeeded'));
    expect(f.service.toolCalls(run.id).map((call) => call.state)).toEqual(['failed', 'succeeded']);
    expect(JSON.stringify(f.requests[1])).toContain('failure to diagnose');
  });
  it('enforces the terminal reservation until cancellation', async () => {
    const f = await fixture(['del marker.txt']);
    f.holdModel();
    const run = await f.start();
    await vi.waitFor(() => expect(f.requests).toHaveLength(1));
    await expect(f.start()).rejects.toMatchObject({ code: 'CAPACITY_EXCEEDED' });
    f.service.cancel(run.id);
    await f.service.close();
    expect(f.execute).not.toHaveBeenCalled();
  });
  it('retains a work deadline failure instead of reporting it as a user cancellation', async () => {
    const f = await fixture(['hostname']);
    f.holdModel();
    const schedule = globalThis.setTimeout;
    const timer = vi
      .spyOn(globalThis, 'setTimeout')
      .mockImplementation((callback, delay, ...args) =>
        schedule(callback, delay === 30 * 60_000 ? 100 : delay, ...args),
      );
    try {
      const run = await f.start();
      await vi.waitFor(() =>
        expect(f.service.get(run.id)).toMatchObject({
          state: 'failed',
          errorCode: 'AI_RUNTIME_LIMIT',
        }),
      );
      expect(f.execute).not.toHaveBeenCalled();
    } finally {
      timer.mockRestore();
    }
  });
  it('rejects a fifth simultaneous work task', async () => {
    const f = await fixture(Array.from({ length: 4 }, () => 'del marker.txt'));
    f.holdModel();
    const runs = [];
    for (let i = 0; i < 4; i++) {
      const run = await f.start(randomUUID());
      runs.push(run);
      await vi.waitFor(() => expect(f.requests).toHaveLength(i + 1));
    }
    await expect(f.start(randomUUID())).rejects.toMatchObject({ code: 'CAPACITY_EXCEEDED' });
    for (const run of runs) f.service.cancel(run.id);
    await f.service.close();
    expect(f.execute).not.toHaveBeenCalled();
  });
  it('does not create reusable approval authority for direct execution', async () => {
    const f = await fixture(['del marker.txt']);
    const run = await f.start();
    await vi.waitFor(() => expect(f.service.get(run.id).state).toBe('succeeded'));
    expect(f.service.approvals()).toEqual([]);
    await expect(
      f.service.decideApproval(
        randomUUID(),
        {
          decision: 'approve_once',
          argsHash: f.service.toolCalls(run.id)[0]!.argsHash,
        },
        randomUUID(),
      ),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(f.execute).toHaveBeenCalledTimes(1);
  });
  it('does not execute command 51 or silently create another task', async () => {
    const f = await fixture(Array.from({ length: 51 }, () => 'hostname'));
    const run = await f.start();
    await vi.waitFor(() => expect(f.service.get(run.id).state).toBe('failed'), { timeout: 10000 });
    expect(f.service.get(run.id).errorCode).toBe('AI_ENGINE_CAPACITY');
    expect(f.execute).toHaveBeenCalledTimes(50);
    expect(f.service.toolCalls(run.id)).toHaveLength(50);
  });
  it('runs a real local command through the same loop in an isolated directory', async () => {
    const f = await fixture(['node --version'], true);
    const run = await f.start();
    await vi.waitFor(() => expect(f.service.get(run.id).state).toBe('succeeded'));
    expect(f.service.toolCalls(run.id)[0]?.resultMetadata).toMatchObject({
      exitCode: 0,
      stdout: expect.stringMatching(/^v\d+/u),
    });
  });
  it('cancels a model request and releases the task without executing', async () => {
    const f = await fixture(['echo updated > marker.txt']);
    f.holdModel();
    const run = await f.start();
    await vi.waitFor(() => expect(f.requests).toHaveLength(1));
    f.service.cancel(run.id);
    await f.service.close();
    expect(f.execute).not.toHaveBeenCalled();
    expect(f.service.get(run.id).state).toBe('canceled');
  });
  it('joins a canceled Engine credential request before closing the work task and performs no command', async () => {
    const f = await fixture(['hostname']);
    const release = Promise.withResolvers<{ value: string; source: string } | undefined>();
    const credentials = vi
      .spyOn(f.ctx.credentials, 'resolve')
      .mockImplementationOnce(() => release.promise);
    const run = await f.start();
    await vi.waitFor(() => expect(credentials).toHaveBeenCalledOnce());
    f.service.cancel(run.id);
    let closed = false;
    const closing = f.service.close().then(() => {
      closed = true;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(closed).toBe(false);
    release.resolve({ value: 'MODEL_KEY_FIXTURE_CANARY', source: 'memory' });
    await closing;
    expect(closed).toBe(true);
    expect(f.service.get(run.id).state).toBe('canceled');
    expect(f.execute).not.toHaveBeenCalled();
    expect(f.requests).toEqual([]);
  });
  it('never waits for a former reviewer endpoint that would time out', async () => {
    const f = await fixture(['echo updated > marker.txt'], false, true);
    const run = await f.start();
    await vi.waitFor(() => expect(f.service.get(run.id).state).toBe('succeeded'));
    expect(f.service.toolCalls(run.id)[0]?.review).toBeUndefined();
    expect(f.service.approvals()).toEqual([]);
    expect(f.requests).toHaveLength(2);
    expect(f.execute).toHaveBeenCalledTimes(1);
  });
  it('cancels the execution signal and rejects late completion', async () => {
    const f = await fixture(['hostname', 'whoami']);
    let finish: (() => void) | undefined;
    f.execute.mockImplementationOnce(async (_name, _args, _target, signal) => {
      await new Promise<void>((resolve) => {
        finish = resolve;
        signal.addEventListener('abort', () => resolve(), { once: true });
      });
      return { stdout: 'late', stderr: '', exitCode: 0 };
    });
    const run = await f.start();
    await vi.waitFor(() => expect(f.execute).toHaveBeenCalledTimes(1));
    f.service.cancel(run.id);
    finish?.();
    await f.service.close();
    expect(f.service.get(run.id).state).toBe('canceled');
    expect(f.requests).toHaveLength(1);
  });
});
