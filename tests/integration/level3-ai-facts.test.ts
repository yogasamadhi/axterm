import { Context } from '@deepseek-ai/cordis';
import { randomUUID, createHash } from 'node:crypto';
import { afterEach, expect, it } from 'vitest';
import Storage from '@axterm/infra-storage';
import * as Schema from '@axterm/data-schema';
import * as Relational from '@axterm/infra-storage-relational';
import * as Domains from '@axterm/infra-storage-domain';
import { aiProviderInputSchema } from '@axterm/plugin-api/ai';
import { AiRepository } from '../../packages/plugins/ai/src/adapters/repository.ts';
import { AiStorage } from '../../packages/plugins/ai/src/adapters/storage.ts';
import { AiRunJournal } from '../../packages/plugins/ai/src/adapters/run-journal.ts';

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
});
async function fixture() {
  const ctx = new Context();
  cleanups.push(() => ctx.fiber.dispose());
  await ctx.plugin(Storage);
  await ctx.plugin(Schema);
  await ctx.plugin(Relational, { path: ':memory:', schema: 'productSchema' });
  await ctx.plugin(Domains, { backend: 'relational' });
  const domain = await ctx.storage.domain.open(Schema.productDomains.ai);
  cleanups.push(() => domain.close());
  const repository = new AiRepository(new AiStorage(domain));
  const owner = { profile: 'desktop', generation: randomUUID(), pid: process.pid };
  const journal = new AiRunJournal(domain, repository, owner, (text) =>
    text.replaceAll('controlled-secret', '[REDACTED]'),
  );
  const input = { engineId: 'pi', useCase: 'chat' as const, prompt: 'hello controlled-secret' };
  return { ctx, domain, repository, owner, journal, input };
}

it('retains all committed forward SQL checksums while appending explicit Pi ownership', () => {
  const hashes = new Map([
    [47, '3c7cfafa7e3206a92eb06ac426e2668e1e041ff42c12b1cd6a85da49ff017660'],
    [48, '49a31a47899b8ef87ace680315d3718ccabe85e98b4fd4429a5c8bbb5ac7f0b6'],
    [49, '531a0692114472b0073accbcbc7cbd16018427a320be8e0aa8084ed691fd30bb'],
  ]);
  for (const [id, hash] of hashes)
    expect(
      createHash('sha256')
        .update(Schema.forwardMigrations.find((m) => m.id === id)!.sql)
        .digest('hex'),
    ).toBe(hash);
  expect(Schema.productDomains.ai.version).toBe(2);
  expect(Schema.productDomains.ai.tables).toEqual(
    expect.arrayContaining([
      'axterm_ai_command_receipts',
      'axterm_ai_run_intents',
      'axterm_ai_run_log',
    ]),
  );
});
it('commits one Run, input, intent and receipt atomically; retries never grant execution again', async () => {
  const f = await fixture();
  const key = randomUUID();
  const first = f.journal.admit(key, f.owner.generation, f.input);
  expect(first.admitted).toBe(true);
  expect(f.journal.outcome(key.toUpperCase(), f.owner.generation)).toEqual({
    status: 'accepted',
    id: first.run.id,
  });
  expect(f.journal.outcome(randomUUID(), f.owner.generation)).toEqual({ status: 'missing' });
  expect(() => f.journal.outcome(key, randomUUID())).toThrow('Stale generation');
  expect(() => f.journal.outcome('invalid', f.owner.generation)).toThrow();
  const cursor = f.domain.cursor();
  expect(f.journal.admit(key.toUpperCase(), f.owner.generation, f.input)).toEqual({
    run: first.run,
    admitted: false,
  });
  expect(f.domain.cursor()).toBe(cursor);
  expect(f.repository.listAiRuns()).toHaveLength(1);
  expect(() =>
    f.journal.admit(key, f.owner.generation, { ...f.input, prompt: 'different' }),
  ).toThrow();
  expect(() => f.journal.admit(randomUUID(), randomUUID(), f.input)).toThrow('Stale generation');
  const stored =
    JSON.stringify(f.domain.all('SELECT * FROM axterm_ai_run_intents')) +
    JSON.stringify(f.domain.all('SELECT * FROM axterm_ai_run_log')) +
    JSON.stringify(f.domain.all('SELECT * FROM axterm_ai_command_receipts')) +
    JSON.stringify(f.domain.all('SELECT * FROM ai_runs'));
  expect(stored).not.toContain('controlled-secret');
  expect(stored).toContain('[REDACTED]');
  expect(first.run.engineId).toBe('pi');
  expect(() => f.domain.all('SELECT * FROM transfer_history')).toThrow();
  expect(() => f.domain.all('SELECT * FROM idempotency_records')).toThrow();
});
it('rolls back every fact, log, intent, receipt and notification when the encompassing transaction fails', async () => {
  const f = await fixture();
  const events: unknown[] = [];
  const dispose = f.domain.subscribe((batch) => events.push(...batch));
  const cursor = f.domain.cursor();
  const key = randomUUID();
  expect(() =>
    f.domain.transaction(() => {
      f.journal.admit(key, f.owner.generation, f.input);
      throw new Error('controlled rollback');
    }),
  ).toThrow('controlled rollback');
  expect(f.repository.listAiRuns()).toEqual([]);
  for (const table of ['axterm_ai_command_receipts', 'axterm_ai_run_intents', 'axterm_ai_run_log'])
    expect(f.domain.all(`SELECT * FROM ${table}`)).toEqual([]);
  expect(f.domain.cursor()).toBe(cursor);
  expect(events).toEqual([]);
  expect(f.journal.admit(key, f.owner.generation, f.input).admitted).toBe(true);
  dispose();
});
it('keeps conversation messages and final output redacted and supplies bounded resumable log pages', async () => {
  const f = await fixture();
  const conversation = f.repository.createAiConversation({ name: 'Chat', modelId: randomUUID() });
  const { run } = f.journal.admit(randomUUID(), f.owner.generation, {
    ...f.input,
    conversationId: conversation.id,
  });
  f.journal.transition(run.id, 'running');
  f.journal.append(run.id, { kind: 'output', text: 'visible controlled-secret' });
  f.journal.transition(run.id, 'succeeded', 'done controlled-secret');
  const first = f.journal.read(run.id, 0, 2);
  expect(first.hasMore).toBe(true);
  const second = f.journal.read(run.id, first.entries.at(-1)!.cursor, 200);
  expect(second.hasMore).toBe(false);
  expect(new Set([...first.entries, ...second.entries].map((e) => e.cursor)).size).toBe(6);
  expect(JSON.stringify(f.repository.listAiMessages(conversation.id))).not.toContain(
    'controlled-secret',
  );
  expect(f.repository.listAiMessages(conversation.id).map((m) => m.role)).toEqual([
    'user',
    'assistant',
  ]);
  expect(f.repository.getAiRun(run.id).result).toBe('done [REDACTED]');
  expect(() => f.journal.transition(run.id, 'running')).toThrow('already finished');
  expect(() => f.journal.read(run.id, -1)).toThrow();
  expect(() => f.journal.read(run.id, 0, 201)).toThrow();
});
it('refuses unknown/private events and oversized visible facts without advancing cursors', async () => {
  const f = await fixture();
  const { run } = f.journal.admit(randomUUID(), f.owner.generation, f.input);
  const cursor = f.domain.cursor();
  expect(() => f.journal.append(run.id, { kind: 'reasoning', text: 'private' } as never)).toThrow();
  expect(() =>
    f.journal.append(run.id, {
      kind: 'audit',
      action: 'admitted',
      outcome: 'accepted',
      reasoning: 'private',
    } as never),
  ).toThrow();
  expect(() =>
    f.journal.append(run.id, { kind: 'output', text: '界'.repeat(128 * 1024) }),
  ).toThrow();
  expect(f.domain.cursor()).toBe(cursor);
});
it('isolates owners and conservatively interrupts only proven stopped work without replaying effects', async () => {
  const f = await fixture();
  const other = { profile: 'web', generation: randomUUID(), pid: 2147483646 };
  const otherJournal = new AiRunJournal(f.domain, f.repository, other, (text) => text);
  const { run } = otherJournal.admit(randomUUID(), other.generation, {
    ...f.input,
    prompt: 'old request',
  });
  otherJournal.transition(run.id, 'running');
  const call = f.repository.createToolCall({
    runId: run.id,
    toolName: 'terminal.exec',
    risk: 'mutating',
    argsHash: 'bound',
    args: { command: 'pwd' },
    target: 'pinned',
    state: 'waiting_approval',
  });
  const approval = f.repository.createApproval({
    runId: run.id,
    toolCallId: call.id,
    argsHash: 'bound',
    target: 'pinned',
    expiresAt: new Date(Date.now() + 60000).toISOString(),
  });
  expect(() => f.journal.transition(run.id, 'canceled')).toThrow('owner changed');
  expect(f.journal.interruptStoppedOwner(other, () => false)).toBe(0);
  expect(f.repository.getAiRun(run.id).state).toBe('running');
  expect(f.journal.interruptStoppedOwner(f.owner, () => true)).toBe(0);
  expect(f.journal.interruptStoppedOwner(other, () => true)).toBe(1);
  expect(f.repository.getAiRun(run.id)).toMatchObject({
    state: 'failed',
    errorCode: 'RUN_INTERRUPTED',
  });
  expect(f.repository.getApproval(approval.id).state).toBe('expired');
  expect(f.repository.getToolCall(call.id).state).toBe('canceled');
  expect(() => otherJournal.transition(run.id, 'succeeded', 'late result')).toThrow(
    'owner changed',
  );
  expect(f.journal.interruptStoppedOwner(other, () => true)).toBe(0);
  expect(f.journal.read(run.id).entries.at(-1)?.payload).toEqual({
    kind: 'audit',
    action: 'interrupted',
    outcome: 'interrupted',
  });
});
it('does not recover an owner whose liveness changes during the proof', async () => {
  const f = await fixture();
  const other = { profile: 'web', generation: randomUUID(), pid: 2147483646 };
  const journal = new AiRunJournal(f.domain, f.repository, other, (text) => text);
  const { run } = journal.admit(randomUUID(), other.generation, f.input);
  let proof = 0;
  expect(f.journal.interruptStoppedOwner(other, () => ++proof === 1)).toBe(0);
  expect(f.repository.getAiRun(run.id).state).toBe('queued');
});
it('retains direct access to old approvals outside bounded recent lists and makes decisions single-use', async () => {
  const f = await fixture();
  const { run } = f.journal.admit(randomUUID(), f.owner.generation, f.input);
  const call = f.repository.createToolCall({
    runId: run.id,
    toolName: 'terminal.exec',
    risk: 'mutating',
    argsHash: 'bound',
    args: {},
    target: 'pinned',
    state: 'waiting_approval',
  });
  const first = f.repository.createApproval({
    runId: run.id,
    toolCallId: call.id,
    argsHash: 'bound',
    target: 'pinned',
    expiresAt: new Date(Date.now() + 60000).toISOString(),
  });
  for (let i = 0; i < 205; i++)
    f.repository.createApproval({
      runId: run.id,
      toolCallId: call.id,
      argsHash: String(i),
      target: 'pinned',
      expiresAt: first.expiresAt,
    });
  expect(f.repository.listApprovals()).toHaveLength(200);
  expect(f.repository.getApproval(first.id)).toEqual(first);
  expect(f.repository.decideApproval(first.id, 'rejected').state).toBe('rejected');
  expect(() => f.repository.decideApproval(first.id, 'approved')).toThrow('already decided');
});
it('defaults copied provider DTOs to Pi and refuses credential values in their strict contract', () => {
  const provider = aiProviderInputSchema.parse({
    name: 'Existing',
    baseUrl: 'http://127.0.0.1:1234',
    credentialRef: 'stored-reference',
    enabled: true,
  });
  expect(provider.engineId).toBe('pi');
  expect(() => aiProviderInputSchema.parse({ ...provider, apiKey: 'must-not-persist' })).toThrow();
});
it('commits Tool and Approval transitions with log/outbox, binds the exact target and never executes on a decision', async () => {
  const f = await fixture();
  const { run } = f.journal.admit(randomUUID(), f.owner.generation, f.input);
  f.journal.transition(run.id, 'running');
  const argsHash = 'b'.repeat(64);
  const tool = f.journal.createTool({
    runId: run.id,
    toolName: 'workspace.exec',
    risk: 'mutating',
    argsHash,
    args: { command: 'echo controlled-secret' },
    target: 'local:/pinned',
  });
  expect(tool.args).toEqual({ command: 'echo [REDACTED]' });
  const approval = f.journal.requestApproval(tool.id, new Date(Date.now() + 60000).toISOString());
  expect(f.repository.getAiRun(run.id).state).toBe('waiting_approval');
  expect(() =>
    f.journal.decideApproval(randomUUID(), f.owner.generation, {
      id: approval.id,
      argsHash: 'a'.repeat(64),
      decision: 'approve_once',
    }),
  ).toThrow('target changed');
  const key = randomUUID();
  const decision = f.journal.decideApproval(key, f.owner.generation, {
    id: approval.id,
    argsHash,
    decision: 'approve_once',
  });
  expect(decision.state).toBe('approved');
  expect(
    f.journal.decideApproval(key, f.owner.generation, {
      id: approval.id,
      argsHash,
      decision: 'approve_once',
    }),
  ).toEqual(decision);
  expect(f.repository.getToolCall(tool.id).state).toBe('waiting_approval');
  expect(() =>
    f.journal.decideApproval(randomUUID(), f.owner.generation, {
      id: approval.id,
      argsHash,
      decision: 'approve_once',
    }),
  ).toThrow('already decided');
  f.journal.transition(run.id, 'running');
  f.journal.updateTool(tool.id, 'running');
  f.journal.updateTool(tool.id, 'succeeded', { stdout: 'controlled-secret' });
  expect(f.repository.getToolCall(tool.id).resultMetadata).toEqual({ stdout: '[REDACTED]' });
  expect(f.journal.read(run.id).entries.filter((e) => e.payload.kind === 'approval')).toHaveLength(
    2,
  );
});
it('expires late approval decisions without granting permission or accepting a second decision', async () => {
  const f = await fixture();
  const { run } = f.journal.admit(randomUUID(), f.owner.generation, f.input);
  f.journal.transition(run.id, 'running');
  const argsHash = 'b'.repeat(64);
  const tool = f.journal.createTool({
    runId: run.id,
    toolName: 'workspace.exec',
    risk: 'mutating',
    argsHash,
    args: {},
    target: 'pinned',
  });
  const approval = f.journal.requestApproval(tool.id, new Date(Date.now() + 60000).toISOString());
  f.domain.run(
    'UPDATE ai_approvals SET expires_at=? WHERE id=?',
    new Date(Date.now() - 1000).toISOString(),
    approval.id,
  );
  expect(
    f.journal.decideApproval(randomUUID(), f.owner.generation, {
      id: approval.id,
      argsHash,
      decision: 'approve_once',
    }).state,
  ).toBe('expired');
  expect(f.repository.getToolCall(tool.id).state).toBe('waiting_approval');
});
it('stores the full bounded final answer using UTF-8 safe pages and refuses oversized output atomically', async () => {
  const f = await fixture();
  const { run } = f.journal.admit(randomUUID(), f.owner.generation, f.input);
  f.journal.transition(run.id, 'running');
  const before = f.domain.cursor();
  expect(() => f.journal.transition(run.id, 'succeeded', 'x'.repeat(2 * 1024 * 1024 + 1))).toThrow(
    'too large',
  );
  expect(f.domain.cursor()).toBe(before);
  expect(f.repository.getAiRun(run.id).state).toBe('running');
  const answer = 'a'.repeat(32767) + '😀' + '界'.repeat(100000);
  f.journal.transition(run.id, 'succeeded', answer);
  const pages = f.journal.read(run.id, 0, 200).entries.filter((e) => e.payload.kind === 'output');
  expect(pages.map((e) => (e.payload.kind === 'output' ? e.payload.text : '')).join('')).toBe(
    answer,
  );
  expect(f.repository.getAiRun(run.id).result).toBe(answer);
  for (const row of f.domain.all<{ payload: string }>('SELECT payload FROM axterm_ai_run_log'))
    expect(Buffer.byteLength(row.payload)).toBeLessThanOrEqual(262144);
});
it('refuses hidden reasoning nested inside Tool arguments and rolls back the Tool fact', async () => {
  const f = await fixture();
  const { run } = f.journal.admit(randomUUID(), f.owner.generation, f.input);
  f.journal.transition(run.id, 'running');
  expect(() =>
    f.journal.createTool({
      runId: run.id,
      toolName: 'tool',
      risk: 'read_only',
      argsHash: 'a'.repeat(64),
      args: { nested: { reasoning: 'private' } },
      target: 'pinned',
    }),
  ).toThrow('Private reasoning');
  expect(f.repository.listToolCalls(run.id)).toEqual([]);
});

it('checks the complete original request without IO or writes, retaining only its hash', async () => {
  const f = await fixture();
  const key = randomUUID();
  const original = {
    ...f.input,
    modelId: randomUUID(),
    context: 'controlled-secret context',
    attachmentIds: [randomUUID()],
    terminalId: randomUUID(),
    mode: 'work',
    reviewReceipt: 'a'.repeat(64),
    tool: {
      name: 'workspace.exec',
      args: { command: 'echo controlled-secret' },
      target: randomUUID(),
    },
  };
  const before = f.domain.cursor();
  expect(f.journal.lookup(key, f.owner.generation, original)).toBeUndefined();
  expect(f.domain.cursor()).toBe(before);
  expect(f.domain.all('SELECT * FROM axterm_ai_command_receipts')).toEqual([]);
  const admitted = f.journal.admit(key, f.owner.generation, f.input, original);
  const cursor = f.domain.cursor();
  expect(f.journal.lookup(key.toUpperCase(), f.owner.generation, { ...original })).toEqual(
    admitted.run,
  );
  expect(
    f.journal.admit(key, f.owner.generation, { ...f.input, engineId: 'another-engine' }, original),
  ).toEqual({ run: admitted.run, admitted: false });
  for (const patch of [
    { modelId: randomUUID() },
    { context: 'changed' },
    { attachmentIds: [] },
    { terminalId: randomUUID() },
    { mode: 'chat' },
    { reviewReceipt: 'b'.repeat(64) },
    { tool: { ...original.tool, args: { command: 'echo changed' } } },
  ])
    expect(() => f.journal.lookup(key, f.owner.generation, { ...original, ...patch })).toThrow(
      'CONFLICT',
    );
  expect(() => f.journal.lookup(key, randomUUID(), original)).toThrow('Stale generation');
  expect(f.domain.cursor()).toBe(cursor);
  const stored = JSON.stringify(f.domain.all('SELECT * FROM axterm_ai_command_receipts'));
  expect(stored).not.toContain('controlled-secret');
  expect(stored).not.toContain(original.modelId);
  expect(stored).not.toContain(original.reviewReceipt);
  f.domain.run(
    "UPDATE axterm_ai_command_receipts SET status='expired',result_json='null' WHERE command_id=?",
    key,
  );
  expect(() => f.journal.lookup(key, f.owner.generation, original)).toThrow('RECEIPT_EXPIRED');
  expect(() => f.journal.admit(key, f.owner.generation, f.input, original)).toThrow(
    'RECEIPT_EXPIRED',
  );
  expect(f.repository.listAiRuns()).toHaveLength(1);
});

it('refuses malformed or corrupt original-request receipts without admitting replacement work', async () => {
  const f = await fixture();
  const key = randomUUID();
  const original = { prompt: 'visible' };
  expect(() => f.journal.lookup('not-an-id', f.owner.generation, original)).toThrow(
    'INVALID_INPUT',
  );
  const cyclic: { self?: unknown } = {};
  cyclic.self = cyclic;
  expect(() => f.journal.lookup(key, f.owner.generation, cyclic)).toThrow('INVALID_INPUT');
  f.journal.admit(key, f.owner.generation, f.input, original);
  for (const result of ['{"id":"invalid"}', 'null', '{"id":"' + randomUUID() + '","extra":true}']) {
    f.domain.run(
      'UPDATE axterm_ai_command_receipts SET result_json=? WHERE command_id=?',
      result,
      key,
    );
    expect(() => f.journal.lookup(key, f.owner.generation, original)).toThrow();
  }
  expect(f.repository.listAiRuns()).toHaveLength(1);
});

it('keeps pending authority and active effects visible beyond the recent-history limit', async () => {
  const f = await fixture();
  const { run } = f.journal.admit(randomUUID(), f.owner.generation, f.input);
  f.journal.transition(run.id, 'running');
  const first = f.journal.createTool({
    runId: run.id,
    toolName: 'workspace.exec',
    risk: 'mutating',
    argsHash: 'a'.repeat(64),
    args: { command: 'echo selected' },
    target: 'selected',
  });
  const approval = f.journal.requestApproval(first.id, new Date(Date.now() + 60000).toISOString());
  f.domain.run(
    "UPDATE ai_approvals SET created_at='2000-01-01T00:00:00.000Z' WHERE id=?",
    approval.id,
  );
  for (let index = 0; index < 205; index++) {
    const tool = f.repository.createToolCall({
      runId: run.id,
      toolName: 'terminal.exec',
      risk: 'mutating',
      argsHash: 'b'.repeat(64),
      args: { command: 'echo past' },
      target: 'past',
      state: 'succeeded',
    });
    const old = f.repository.createApproval({
      runId: run.id,
      toolCallId: tool.id,
      argsHash: tool.argsHash,
      target: tool.target,
      expiresAt: new Date(Date.now() + 60000).toISOString(),
    });
    f.repository.decideApproval(old.id, 'rejected');
  }
  expect(f.repository.listApprovals().some((item) => item.id === approval.id)).toBe(false);
  expect(f.repository.pendingApprovals(run.id).map((item) => item.id)).toEqual([approval.id]);
  expect(f.repository.activeToolCalls(run.id).map((item) => item.id)).toEqual([first.id]);
  f.journal.decideApproval(randomUUID(), f.owner.generation, {
    id: approval.id,
    argsHash: approval.argsHash,
    decision: 'approve_once',
  });
  expect(f.journal.updateCommand(first.id, { approvalSource: 'user' }).approvalSource).toBe('user');
});

it('atomically retains only bounded redacted visible review inputs before execution', async () => {
  const f = await fixture();
  const input = {
    ...f.input,
    context: 'reviewed context controlled-secret',
    system: 'reviewed instruction controlled-secret',
  };
  const key = randomUUID();
  const admitted = f.journal.admit(key, f.owner.generation, input);
  const row = f.domain.get<{ request: string }>(
    'SELECT request FROM ai_runs WHERE id=?',
    admitted.run.id,
  )!;
  expect(JSON.parse(row.request)).toMatchObject({
    prompt: 'hello [REDACTED]',
    context: 'reviewed context [REDACTED]',
    system: 'reviewed instruction [REDACTED]',
  });
  expect(row.request).not.toMatch(/controlled-secret|reviewReceipt|credentialRef|reasoning/);
  expect(f.journal.admit(key, f.owner.generation, input).admitted).toBe(false);
  const cursor = f.domain.cursor();
  for (const oversized of [{ system: 'x'.repeat(32_769) }, { context: 'x'.repeat(131_073) }]) {
    expect(() =>
      f.journal.admit(randomUUID(), f.owner.generation, { ...input, ...oversized }),
    ).toThrow();
    expect(f.domain.cursor()).toBe(cursor);
  }
  expect(f.domain.get<{ count: number }>('SELECT count(*) AS count FROM ai_runs')!.count).toBe(1);
});
