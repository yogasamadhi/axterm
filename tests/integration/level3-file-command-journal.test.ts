import { Context } from '@deepseek-ai/cordis';
import { randomUUID } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import Storage from '@axterm/infra-storage';
import * as Schema from '@axterm/data-schema';
import * as Relational from '@axterm/infra-storage-relational';
import * as Domains from '@axterm/infra-storage-domain';
import { RemoteError } from '@axterm/plugin-api';
import { FileCommandJournal } from '../../packages/plugins/files/src/adapters/command-journal.ts';
const contexts: Context[] = [];
afterEach(async () => {
  for (const ctx of contexts.splice(0).reverse()) await ctx.fiber.dispose();
});
const signal = () => new AbortController().signal;
async function fixture() {
  const ctx = new Context();
  contexts.push(ctx);
  await ctx.plugin(Storage);
  await ctx.plugin(Schema);
  await ctx.plugin(Relational, { path: ':memory:', schema: 'productSchema' });
  await ctx.plugin(Domains, { backend: 'relational' });
  const domain = await ctx.storage.domain.open(Schema.productDomains.files);
  return { ctx, domain };
}
it('reserves once, coalesces duplicates, records compact committed outcomes and rejects changed payloads', async () => {
  const { domain } = await fixture();
  const journal = new FileCommandJournal(domain, 'desktop', randomUUID());
  const key = randomUUID();
  const release = Promise.withResolvers<number>();
  const perform = vi.fn(() => release.promise);
  try {
    const first = journal.execute(
      key,
      'createGrantedEntry',
      { grantId: 'ephemeral', path: 'SENSITIVE_PATH_NOT_PERSISTED' },
      perform,
      signal(),
    );
    const second = journal.execute(
      key,
      'createGrantedEntry',
      { path: 'SENSITIVE_PATH_NOT_PERSISTED', grantId: 'ephemeral' },
      perform,
      signal(),
    );
    await expect(
      journal.execute(key, 'createGrantedEntry', { grantId: 'another' }, perform, signal()),
    ).rejects.toMatchObject({ details: { reason: 'conflict' } });
    await vi.waitFor(() => expect(perform).toHaveBeenCalledOnce());
    release.resolve(1);
    const receipt = await first;
    expect(await second).toEqual(receipt);
    expect(receipt).toMatchObject({ id: key, operation: 'createGrantedEntry', changedCount: 1 });
    expect(
      await journal.execute(
        key,
        'createGrantedEntry',
        { grantId: 'ephemeral', path: 'SENSITIVE_PATH_NOT_PERSISTED' },
        perform,
        signal(),
      ),
    ).toEqual(receipt);
    expect(perform).toHaveBeenCalledOnce();
    expect(
      JSON.stringify(domain.all('SELECT * FROM axterm_file_operation_receipts')),
    ).not.toContain('SENSITIVE_PATH_NOT_PERSISTED');
    expect(JSON.stringify(domain.events(0))).not.toContain('SENSITIVE_PATH_NOT_PERSISTED');
    expect(domain.events(0).map((event) => event.type)).toEqual([
      'files/operation-started',
      'files/operation-completed',
    ]);
    domain.run(
      "UPDATE axterm_file_operation_receipts SET status='expired',result_json='null' WHERE command_id=?",
      key,
    );
    await expect(
      journal.execute(
        key,
        'createGrantedEntry',
        { grantId: 'ephemeral', path: 'SENSITIVE_PATH_NOT_PERSISTED' },
        perform,
        signal(),
      ),
    ).rejects.toMatchObject({ details: { reason: 'receipt-expired' } });
    expect(perform).toHaveBeenCalledOnce();
  } finally {
    release.resolve(0);
    await journal.close();
  }
});
it('does not replay failed or uncertain outcomes and recovers only its own retired Profile generation', async () => {
  const { domain } = await fixture();
  const previous = randomUUID();
  const other = randomUUID();
  const own = randomUUID();
  const now = new Date().toISOString();
  const input = { grantId: 'retired-authority', path: 'file' };
  const hash = Domains.commandPayloadHash(input);
  for (const [id, profile] of [
    [own, 'desktop'],
    [other, 'web'],
  ] as const)
    domain.run(
      "INSERT INTO axterm_file_operation_receipts(command_id,operation,payload_hash,profile_name,generation,status,result_json,created_at,updated_at) VALUES(?,?,?,?,?,'running','null',?,?)",
      id,
      'deleteGrantedEntry',
      hash,
      profile,
      previous,
      now,
      now,
    );
  const journal = new FileCommandJournal(domain, 'desktop', randomUUID());
  try {
    expect(
      domain.get<{ status: string }>(
        'SELECT status FROM axterm_file_operation_receipts WHERE command_id=?',
        own,
      )?.status,
    ).toBe('interrupted');
    expect(
      domain.get<{ status: string }>(
        'SELECT status FROM axterm_file_operation_receipts WHERE command_id=?',
        other,
      )?.status,
    ).toBe('running');
    const perform = vi.fn(async () => 1);
    await expect(
      journal.execute(own, 'deleteGrantedEntry', input, perform, signal()),
    ).rejects.toMatchObject({ details: { reason: 'uncertain' } });
    expect(perform).not.toHaveBeenCalled();
    const key = randomUUID();
    const denied = vi.fn(async () => {
      throw new RemoteError('files/failure', 'Denied', { reason: 'forbidden' });
    });
    await expect(
      journal.execute(key, 'deleteGrantedEntry', input, denied, signal()),
    ).rejects.toMatchObject({ details: { reason: 'forbidden' } });
    await expect(
      journal.execute(key, 'deleteGrantedEntry', input, denied, signal()),
    ).rejects.toMatchObject({ details: { reason: 'forbidden' } });
    expect(denied).toHaveBeenCalledOnce();
  } finally {
    await journal.close();
  }
});
it('cancels callers independently, stops admission and waits for the actual operation to drain', async () => {
  const { domain } = await fixture();
  const journal = new FileCommandJournal(domain, 'desktop', randomUUID());
  const entered = Promise.withResolvers<AbortSignal>();
  const drained = Promise.withResolvers<number>();
  const key = randomUUID();
  const first = journal.execute(
    key,
    'operateGrantedEntries',
    {},
    async (signal) => {
      entered.resolve(signal);
      return drained.promise;
    },
    signal(),
  );
  const secondAbort = new AbortController();
  const second = journal.execute(
    key,
    'operateGrantedEntries',
    {},
    async () => 2,
    secondAbort.signal,
  );
  const rejected = expect(second).rejects.toMatchObject({ details: { reason: 'cancelled' } });
  secondAbort.abort();
  await rejected;
  const executing = await entered.promise;
  expect(executing.aborted).toBe(false);
  let closed = false;
  const closing = journal.close().then(() => {
    closed = true;
  });
  expect(executing.aborted).toBe(true);
  await Promise.resolve();
  expect(closed).toBe(false);
  await expect(
    journal.execute(randomUUID(), 'createGrantedEntry', {}, async () => 1, signal()),
  ).rejects.toMatchObject({ details: { reason: 'closed' } });
  drained.resolve(1);
  expect(await first).toMatchObject({ changedCount: 1 });
  await closing;
  expect(closed).toBe(true);
});

it('looks up owned outcomes without executing IO and hides deliberately reused foreign Profile keys', async () => {
  const { domain } = await fixture();
  const generation = randomUUID();
  const desktop = new FileCommandJournal(domain, 'desktop', generation);
  const web = new FileCommandJournal(domain, 'web', randomUUID());
  const id = randomUUID(),
    missing = randomUUID();
  const release = Promise.withResolvers<number>();
  const perform = vi.fn(() => release.promise);
  const running = desktop.execute(
    id,
    'createGrantedEntry',
    { path: 'owned.txt' },
    perform,
    signal(),
  );
  expect(desktop.outcome(id)).toMatchObject({ status: 'running', id, generation });
  expect(desktop.outcome(missing)).toEqual({ status: 'missing', id: missing });
  expect(web.outcome(id)).toEqual({ status: 'missing', id });
  const foreign = vi.fn(async () => 99);
  await expect(
    web.execute(id, 'createGrantedEntry', { path: 'owned.txt' }, foreign, signal()),
  ).rejects.toMatchObject({ details: { reason: 'conflict' } });
  expect(foreign).not.toHaveBeenCalled();
  release.resolve(1);
  const receipt = await running;
  expect(desktop.outcome(id)).toMatchObject({ status: 'completed', id, receipt });
  expect(web.outcome(id)).toEqual({ status: 'missing', id });
  expect(perform).toHaveBeenCalledTimes(1);
  await desktop.close();
  await web.close();
});
it('exposes failure/interruption/expiry without replaying partial filesystem work', async () => {
  const { domain } = await fixture();
  const generation = randomUUID();
  const journal = new FileCommandJournal(domain, 'desktop', generation);
  const failed = randomUUID();
  const perform = vi.fn(async () => {
    throw new RemoteError('files/failure', 'PARTIAL', { reason: 'unavailable' });
  });
  await expect(
    journal.execute(failed, 'operateGrantedEntries', { paths: ['one'] }, perform, signal()),
  ).rejects.toBeInstanceOf(RemoteError);
  expect(journal.outcome(failed)).toMatchObject({ status: 'failed', reason: 'unavailable' });
  expect(perform).toHaveBeenCalledTimes(1);
  domain.run(
    "UPDATE axterm_file_operation_receipts SET status='running' WHERE command_id=?",
    failed,
  );
  await journal.close();
  const restarted = new FileCommandJournal(domain, 'desktop', randomUUID());
  expect(restarted.outcome(failed)).toMatchObject({
    status: 'interrupted',
    reason: 'uncertain',
    generation,
  });
  domain.run(
    "UPDATE axterm_file_operation_receipts SET status='expired',result_json='null',error_reason=NULL WHERE command_id=?",
    failed,
  );
  expect(restarted.outcome(failed)).toMatchObject({ status: 'expired' });
  expect(perform).toHaveBeenCalledTimes(1);
  await restarted.close();
});

it('retains unsupported destination receipts across reopening without replaying filesystem mutations', async () => {
  const { domain } = await fixture();
  const generation = randomUUID(),
    key = randomUUID();
  let journal = new FileCommandJournal(domain, 'desktop', generation);
  const perform = vi.fn(async () => {
    throw new RemoteError('files/failure', 'Publication unavailable', {
      reason: 'unsupported-destination',
    });
  });
  try {
    await expect(
      journal.execute(key, 'operateGrantedEntries', {}, perform, signal()),
    ).rejects.toMatchObject({ details: { reason: 'unsupported-destination' } });
    await journal.close();
    journal = new FileCommandJournal(domain, 'desktop', generation);
    expect(journal.outcome(key)).toMatchObject({
      status: 'failed',
      reason: 'unsupported-destination',
    });
    await expect(
      journal.execute(key, 'operateGrantedEntries', {}, perform, signal()),
    ).rejects.toMatchObject({ details: { reason: 'unsupported-destination' } });
    expect(perform).toHaveBeenCalledOnce();
  } finally {
    await journal.close();
  }
});
