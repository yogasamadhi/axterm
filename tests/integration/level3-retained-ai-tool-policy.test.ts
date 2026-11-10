import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { TerminalChannel } from '@axterm/plugin-api/host';
import { redact } from '../../packages/plugins/ai/src/application/ai-service.ts';
import { ownedAiToolPolicy } from '../fixtures/level3-ai-tool-policy.ts';
function channel(): TerminalChannel & { writes: Uint8Array[] } {
  const writes: Uint8Array[] = [];
  return {
    writes,
    write: (data) => writes.push(data),
    resize: () => {},
    signal: () => {},
    onData: () => () => {},
    onExit: () => () => {},
    pause: () => {},
    resume: () => {},
    close: async () => {},
  };
}

describe('AI policy and audit', () => {
  it('redacts common credentials and private keys', () => {
    const value = redact(
      'password=hunter2 token=abcdefghijklmnop Bearer abcdefghijklmnop\n-----BEGIN PRIVATE KEY-----\nsecret\n-----END PRIVATE KEY-----',
    );
    expect(value).not.toMatch(/hunter2|abcdefghijklmnop|BEGIN PRIVATE|\nsecret\n/);
  });

  it('binds mutating approval to the exact args and persists the tool result', async () => {
    const terminalChannel = channel();
    const owned = await ownedAiToolPolicy({ open: () => terminalChannel });
    const terminals = owned.terminals;
    const terminal = await terminals.createLocal({ cols: 80, rows: 24 });
    const tools = owned.tools;
    const service = owned.createService(undefined, tools);
    const run = await service.start(
      {
        modelId: randomUUID(),
        useCase: 'diagnose',
        prompt: 'run a reviewed command',
        context: '',
        terminalId: terminal.id,
        tool: { name: 'terminal.exec', args: { command: 'printf approved' }, target: terminal.id },
      },
      randomUUID(),
    );
    await vi.waitFor(() => expect(service.get(run.id).state).toBe('waiting_approval'));
    const approval = service.approvals()[0]!;
    await expect(
      service.decideApproval(
        approval.id,
        {
          decision: 'approve_once',
          argsHash: 'f'.repeat(64),
        },
        randomUUID(),
      ),
    ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
    await service.decideApproval(
      approval.id,
      {
        decision: 'approve_once',
        argsHash: approval.argsHash,
      },
      randomUUID(),
    );
    await expect(
      service.decideApproval(
        approval.id,
        {
          decision: 'approve_once',
          argsHash: approval.argsHash,
        },
        randomUUID(),
      ),
    ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
    expect(Buffer.concat(terminalChannel.writes).toString()).toBe('printf approved\r');
    expect(service.get(run.id).state).toBe('succeeded');
    expect(service.toolCalls(run.id)[0]).toMatchObject({
      toolName: 'terminal.exec',
      args: { command: 'printf approved' },
      state: 'succeeded',
    });
    expect(owned.domain.events(0).map((event) => event.type)).toContain('ai-run.updated');
    await service.close();
    await terminals.dispose();
    await owned.close();
  });

  it('expires stale approvals and closes their tool and run state', async () => {
    const terminalChannel = channel();
    const owned = await ownedAiToolPolicy({ open: () => terminalChannel });
    const terminals = owned.terminals;
    const terminal = await terminals.createLocal({ cols: 80, rows: 24 });
    const tools = owned.tools;
    const service = owned.createService(undefined, tools);
    const run = await service.start(
      {
        modelId: randomUUID(),
        useCase: 'diagnose',
        prompt: 'expire this action',
        context: '',
        tool: { name: 'terminal.exec', args: { command: 'echo never' }, target: terminal.id },
      },
      randomUUID(),
    );
    await vi.waitFor(() => expect(service.get(run.id).state).toBe('waiting_approval'));
    const approval = service.approvals()[0]!;
    owned.domain.run(
      'UPDATE ai_approvals SET expires_at=? WHERE id=?',
      new Date(0).toISOString(),
      approval.id,
    );
    expect(service.approvals()[0]).toMatchObject({ id: approval.id, state: 'expired' });
    expect(service.toolCalls(run.id)[0]).toMatchObject({
      state: 'canceled',
      resultMetadata: { code: 'APPROVAL_EXPIRED' },
    });
    expect(service.get(run.id)).toMatchObject({ state: 'canceled', errorCode: 'APPROVAL_EXPIRED' });
    expect(Buffer.concat(terminalChannel.writes)).toHaveLength(0);
    await service.close();
    await terminals.dispose();
    await owned.close();
  });

  it('cancels an active read-only tool without allowing late success', async () => {
    const owned = await ownedAiToolPolicy({ open: channel });
    let resolveTool: ((value: unknown) => void) | undefined;
    const tools = {
      risk: () => 'read_only',
      execute: (_name: string, _args: unknown, _target: string, signal?: AbortSignal) =>
        new Promise((resolve, reject) => {
          resolveTool = resolve;
          signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
        }),
    };
    const service = owned.createService(undefined, tools as never);
    const run = await service.start(
      {
        modelId: randomUUID(),
        useCase: 'diagnose',
        prompt: 'inspect slowly',
        context: '',
        tool: { name: 'system.inspectDisk', args: {}, target: 'local' },
      },
      randomUUID(),
    );
    await vi.waitFor(() => expect(service.toolCalls(run.id)[0]?.state).toBe('running'));
    service.cancel(run.id);
    resolveTool?.({ tooLate: true });
    await vi.waitFor(() => expect(service.get(run.id).state).toBe('canceled'));
    expect(service.toolCalls(run.id)[0]).toMatchObject({
      state: 'canceled',
      resultMetadata: { code: 'REQUEST_CANCELED' },
    });
    expect(service.get(run.id).result).toBeUndefined();
    await service.close();
    await owned.close();
  });

  it('rejects tools outside the explicit allowlist', async () => {
    const owned = await ownedAiToolPolicy({ open: channel });
    const tools = owned.tools;
    expect(() => tools.risk('shell.anything')).toThrowError(
      expect.objectContaining({ code: 'CAPABILITY_UNAVAILABLE' }),
    );
    await owned.close();
  });

  it('exposes the registered MCP tools through persisted read and approval paths', async () => {
    const terminalChannel = channel();
    const owned = await ownedAiToolPolicy({ open: () => terminalChannel });
    const terminals = owned.terminals;
    const terminal = await terminals.createLocal({ cols: 80, rows: 24 });
    const tools = owned.tools;
    const service = owned.createService(undefined, tools);
    expect(tools.mcpTools()).toHaveLength(10);
    expect(tools.mcpTools().find(({ name }) => name === 'terminal.exec')).toMatchObject({
      risk: 'mutating',
      inputSchema: expect.objectContaining({ additionalProperties: false }),
    });

    const source = randomUUID();
    const readKey = randomUUID();
    const read = await service.invokeRegisteredTool(
      tools.mcpProposal('system.inspectMemory', {}),
      readKey,
      source,
    );
    expect(read).toMatchObject({
      state: 'succeeded',
      result: expect.objectContaining({ platform: expect.any(String) }),
    });
    const repeated = await service.invokeRegisteredTool(
      tools.mcpProposal('system.inspectMemory', {}),
      readKey,
      source,
    );
    expect(repeated.runId).toBe(read.runId);

    const mutation = await service.invokeRegisteredTool(
      tools.mcpProposal('terminal.exec', {
        terminalId: terminal.id,
        command: 'printf mcp-approved',
      }),
      randomUUID(),
      source,
    );
    expect(mutation).toMatchObject({
      state: 'waiting_approval',
      approvalId: expect.any(String),
      argsHash: expect.any(String),
      expiresAt: expect.any(String),
    });
    await service.decideApproval(
      mutation.approvalId!,
      {
        decision: 'approve_once',
        argsHash: mutation.argsHash!,
      },
      randomUUID(),
    );
    expect(Buffer.concat(terminalChannel.writes).toString()).toBe('printf mcp-approved\r');
    expect(owned.domain.events(0).map(({ type }) => type)).toContain('ai-run.created');
    await service.close();
    await terminals.dispose();
    await owned.close();
  });
});
