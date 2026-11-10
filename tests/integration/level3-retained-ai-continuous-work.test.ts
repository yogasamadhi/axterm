import { ownedAiPolicy } from '../fixtures/level3-ai-policy.ts';
import { encodeOpaqueCredentialRef } from '@axterm/plugin-api/credentials';
import type { AiHostPort } from '../../packages/plugins/ai/src/ports/host.ts';
import LocalSubprocess from '../../packages/infra/subprocess-local/src/index.ts';
import { OwnedWorkspaceCommands } from '../../packages/plugins/ai/src/adapters/workspace-command.ts';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
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
        ? workspaceCommands.execute(String(args.command), cwd, signal)
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
    denyReview: () => {
      allowReview = false;
    },
    closeTarget: () => {
      ready = false;
    },
  };
}
describe('native Pi continuous work and Runtime decisions', () => {
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
        'automatic',
        'automatic',
        'automatic',
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
      [1, 'automatic', 'succeeded'],
      [2, 'automatic', 'succeeded'],
      [3, 'automatic', 'succeeded'],
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
  it('executes a bounded authorized mutation with a separate tool-free review', async () => {
    const f = await fixture(['echo updated > marker.txt']);
    const run = await f.start();
    await vi.waitFor(() => expect(f.service.get(run.id).state).toBe('succeeded'));
    expect(f.execute).toHaveBeenCalledTimes(1);
    expect(f.service.toolCalls(run.id)[0]).toMatchObject({
      risk: 'mutating',
      approvalSource: 'automatic',
      review: { source: 'model', decision: 'auto_approve' },
    });
    const review = f.requests.find((request) =>
      request.messages[0]?.content.startsWith('You review one command'),
    )!;
    expect(review.tools ?? []).toHaveLength(0);
    expect(review.messages[0]?.content).not.toContain('You are Axterm');
  });
  it('stops the native loop on a reviewer safety refusal without an approval bypass', async () => {
    const f = await fixture(['echo updated > marker.txt', 'hostname']);
    f.denyReview();
    const run = await f.start();
    await vi.waitFor(() =>
      expect(f.service.get(run.id)).toMatchObject({
        state: 'failed',
        errorCode: 'AI_POLICY_REJECTED',
      }),
    );
    expect(f.service.toolCalls(run.id)[0]?.review).toMatchObject({
      decision: 'reject',
      riskLevel: 'critical',
    });
    expect(f.service.approvals()).toHaveLength(0);
    expect(f.execute).not.toHaveBeenCalled();
    expect(f.requests).toHaveLength(2);
  });
  it('pauses at danger, survives provider timeout while waiting, and resumes after one approval', async () => {
    const f = await fixture(['whoami', 'del marker.txt', 'hostname']);
    const run = await f.start();
    await vi.waitFor(() => expect(f.service.get(run.id).state).toBe('waiting_approval'));
    expect(f.execute).toHaveBeenCalledTimes(1);
    await new Promise((resolve) => setTimeout(resolve, 1100));
    expect(f.service.get(run.id).state).toBe('waiting_approval');
    const approval = f.service.approvals()[0]!;
    await f.service.decideApproval(
      approval.id,
      {
        decision: 'approve_once',
        argsHash: approval.argsHash,
      },
      randomUUID(),
    );
    await vi.waitFor(() => expect(f.service.get(run.id).state).toBe('succeeded'));
    expect(f.execute).toHaveBeenCalledTimes(3);
    expect(f.service.toolCalls(run.id)[1]).toMatchObject({
      approvalSource: 'user',
      state: 'succeeded',
    });
    await expect(
      f.service.decideApproval(
        approval.id,
        {
          decision: 'approve_once',
          argsHash: approval.argsHash,
        },
        randomUUID(),
      ),
    ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
  });
  it.each(['reject', 'cancel', 'expire', 'target'])(
    'stops the entire loop on %s while waiting',
    async (action) => {
      const f = await fixture(['del marker.txt', 'hostname']);
      const run = await f.start();
      await vi.waitFor(() => expect(f.service.get(run.id).state).toBe('waiting_approval'));
      const approval = f.service.approvals()[0]!;
      if (action === 'reject')
        await f.service.decideApproval(
          approval.id,
          {
            decision: 'reject',
            argsHash: approval.argsHash,
          },
          randomUUID(),
        );
      else if (action === 'cancel') f.service.cancel(run.id);
      else if (action === 'target') f.closeTarget();
      else {
        f.database.run(
          'UPDATE ai_approvals SET expires_at=? WHERE id=?',
          new Date(0).toISOString(),
          approval.id,
        );
        f.service.approvals();
      }
      await vi.waitFor(() => expect(f.service.get(run.id).state).toBe('canceled'));
      expect(f.execute).not.toHaveBeenCalled();
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
    const run = await f.start();
    await vi.waitFor(() => expect(f.service.get(run.id).state).toBe('waiting_approval'));
    await expect(f.start()).rejects.toMatchObject({ code: 'CAPACITY_EXCEEDED' });
    f.service.cancel(run.id);
  });
  it('rejects a fifth simultaneous work task', async () => {
    const f = await fixture(Array.from({ length: 4 }, () => 'del marker.txt'));
    const runs = [];
    for (let i = 0; i < 4; i++) {
      const run = await f.start(randomUUID());
      runs.push(run);
      await vi.waitFor(() => expect(f.service.get(run.id).state).toBe('waiting_approval'));
    }
    await expect(f.start(randomUUID())).rejects.toMatchObject({ code: 'CAPACITY_EXCEEDED' });
    for (const run of runs) f.service.cancel(run.id);
  });
  it('invalidates a changed review generation before consuming approval', async () => {
    const f = await fixture(['del marker.txt']);
    const run = await f.start();
    await vi.waitFor(() => expect(f.service.get(run.id).state).toBe('waiting_approval'));
    const call = f.service.toolCalls(run.id)[0]!;
    f.database.run(
      'UPDATE ai_tool_calls SET review_json=? WHERE id=?',
      JSON.stringify({ ...call.review, generation: 'old-generation' }),
      call.id,
    );
    const approval = f.service.approvals()[0]!;
    await expect(
      f.service.decideApproval(
        approval.id,
        {
          decision: 'approve_once',
          argsHash: approval.argsHash,
        },
        randomUUID(),
      ),
    ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
    expect(f.execute).not.toHaveBeenCalled();
    f.service.cancel(run.id);
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
  it('cancels a reviewer request and releases the task without executing', async () => {
    const f = await fixture(['echo updated > marker.txt'], false, true);
    const run = await f.start();
    await vi.waitFor(() => expect(f.requests).toHaveLength(2));
    expect(f.service.toolCalls(run.id)[0]?.review?.status).toBe('pending');
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
  it('does not retry a timed-out review and asks for human confirmation', async () => {
    const f = await fixture(['echo updated > marker.txt'], false, true);
    const run = await f.start();
    await vi.waitFor(() => expect(f.service.get(run.id).state).toBe('waiting_approval'), {
      timeout: 3000,
    });
    expect(f.service.toolCalls(run.id)[0]?.review).toMatchObject({
      status: 'unavailable',
      source: 'fallback',
    });
    expect(f.requests).toHaveLength(2);
    expect(f.execute).not.toHaveBeenCalled();
    f.service.cancel(run.id);
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
