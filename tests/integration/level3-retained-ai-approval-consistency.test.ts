import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { TerminalChannel } from '@axterm/plugin-api/host';
import { ownedAiToolPolicy } from '../fixtures/level3-ai-tool-policy.ts';
async function fixture() {
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
  const owned = await ownedAiToolPolicy({ open: () => channel });
  const terminal = await owned.terminals.createLocal({ cols: 80, rows: 24 });
  const service = owned.createService(undefined, owned.tools);
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
  await vi.waitFor(() => expect(service.get(run.id).state).toBe('waiting_approval'));
  const approval = service.approvals()[0]!,
    call = service.toolCalls(run.id)[0]!;
  return { ...owned, database: owned.domain, service, run, approval, call, writes };
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
        const other = f.facts.admit(
          randomUUID(),
          f.generation,
          { engineId: 'pi', useCase: 'diagnose', prompt: '', attachments: [] },
          {},
        ).run;
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
        f.service.decideApproval(
          f.approval.id,
          {
            decision: 'approve_once',
            argsHash: f.approval.argsHash,
          },
          randomUUID(),
        ),
      ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
      expect(f.writes).toEqual([]);
    } finally {
      await f.close();
    }
  });
});

it('refuses a canceled approval without invoking the terminal owner or accepting a second execution', async () => {
  const f = await fixture();
  try {
    f.service.cancel(f.run.id);
    await expect(
      f.service.decideApproval(
        f.approval.id,
        {
          decision: 'approve_once',
          argsHash: f.approval.argsHash,
        },
        randomUUID(),
      ),
    ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
    expect(f.writes).toEqual([]);
    expect(f.service.get(f.run.id).state).toBe('canceled');
    expect(f.service.toolCalls(f.run.id)[0]?.state).toBe('canceled');
  } finally {
    await f.close();
  }
});
