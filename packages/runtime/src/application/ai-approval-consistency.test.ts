import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { ProductDatabase } from '../adapters/sqlite/database';
import { ProductRepository } from '../adapters/sqlite/product-repository';
import type { TerminalChannel } from '../ports/terminal-channel';
import { AiService } from './ai-service';
import { AiToolService } from './ai-tool-service';
import { TerminalService } from './terminal-service';
import { RealtimeHub } from './realtime-hub';

async function fixture() {
  const database = await ProductDatabase.open();
  const repository = new ProductRepository(database);
  const writes: Uint8Array[] = [];
  const channel: TerminalChannel = {
    write: (data) => writes.push(data),
    resize: () => {},
    signal: () => {},
    pause: () => {},
    resume: () => {},
    onData: () => () => {},
    onExit: () => () => {},
    close: async () => {},
  };
  const terminals = new TerminalService({ open: () => channel });
  const terminal = terminals.createLocal({ cols: 80, rows: 24 });
  const tools = new AiToolService(repository, terminals, {} as never, {} as never);
  const service = new AiService(repository, undefined, new RealtimeHub(), tools);
  const run = await service.start(
    {
      modelId: randomUUID(),
      useCase: 'diagnose',
      prompt: 'review',
      context: '',
      tool: { name: 'terminal.exec', args: { command: 'printf reviewed' }, target: terminal.id },
    },
    randomUUID(),
  );
  const approval = service.approvals()[0]!;
  const call = service.toolCalls(run.id)[0]!;
  return {
    database,
    repository,
    terminals,
    tools,
    service,
    run,
    approval,
    call,
    writes,
    close: async () => {
      await service.close();
      await terminals.closeAll();
      database.close();
    },
  };
}

describe('persisted exact tool approval consistency', () => {
  const mutations: Array<[string, (f: Awaited<ReturnType<typeof fixture>>) => void]> = [
    [
      'arguments',
      (f) =>
        f.database.run(
          'UPDATE ai_tool_calls SET args_json=? WHERE id=?',
          JSON.stringify({ command: 'printf changed' }),
          f.call.id,
        ),
    ],
    [
      'call target',
      (f) =>
        f.database.run('UPDATE ai_tool_calls SET target=? WHERE id=?', randomUUID(), f.call.id),
    ],
    [
      'tool identity',
      (f) =>
        f.database.run(
          'UPDATE ai_tool_calls SET tool_name=? WHERE id=?',
          'terminal.getRecentOutput',
          f.call.id,
        ),
    ],
    [
      'risk',
      (f) => f.database.run('UPDATE ai_tool_calls SET risk=? WHERE id=?', 'read_only', f.call.id),
    ],
    [
      'call digest',
      (f) =>
        f.database.run(
          'UPDATE ai_tool_calls SET args_hash=? WHERE id=?',
          'f'.repeat(64),
          f.call.id,
        ),
    ],
    [
      'approval target',
      (f) =>
        f.database.run('UPDATE ai_approvals SET target=? WHERE id=?', randomUUID(), f.approval.id),
    ],
    [
      'approval run',
      (f) => {
        const other = f.repository.createAiRun({ useCase: 'diagnose', request: {} });
        f.database.run('UPDATE ai_approvals SET run_id=? WHERE id=?', other.id, f.approval.id);
      },
    ],
    [
      'extended expiry',
      (f) =>
        f.database.run(
          'UPDATE ai_approvals SET expires_at=? WHERE id=?',
          new Date(Date.now() + 30 * 60_000).toISOString(),
          f.approval.id,
        ),
    ],
    [
      'call state',
      (f) => f.database.run('UPDATE ai_tool_calls SET state=? WHERE id=?', 'running', f.call.id),
    ],
    [
      'run state',
      (f) => f.database.run('UPDATE ai_runs SET state=? WHERE id=?', 'failed', f.run.id),
    ],
  ];
  it.each(mutations)('refuses changed %s without executing', async (_label, mutate) => {
    const f = await fixture();
    try {
      mutate(f);
      await expect(
        f.service.decideApproval(f.approval.id, {
          decision: 'approve_once',
          argsHash: f.approval.argsHash,
        }),
      ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
      expect(f.writes).toEqual([]);
    } finally {
      await f.close();
    }
  });
  it('refuses an approval after cancellation and after Runtime interrupted-work recovery', async () => {
    const f = await fixture();
    try {
      f.service.cancel(f.run.id);
      await expect(
        f.service.decideApproval(f.approval.id, {
          decision: 'approve_once',
          argsHash: f.approval.argsHash,
        }),
      ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
      const next = await f.service.start(
        {
          modelId: randomUUID(),
          useCase: 'diagnose',
          prompt: 'review again',
          context: '',
          tool: {
            name: 'terminal.exec',
            args: { command: 'printf second' },
            target: f.call.target,
          },
        },
        randomUUID(),
      );
      const approval = f.service.approvals().find((x) => x.runId === next.id)!;
      f.repository.recoverInterruptedWork();
      const runtime = new AiService(f.repository, undefined, new RealtimeHub(), f.tools);
      try {
        await expect(
          runtime.decideApproval(approval.id, {
            decision: 'approve_once',
            argsHash: approval.argsHash,
          }),
        ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
      } finally {
        await runtime.close();
      }
      expect(f.writes).toEqual([]);
    } finally {
      await f.close();
    }
  });
});
