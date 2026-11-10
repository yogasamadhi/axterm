import { randomUUID } from 'node:crypto';
import { Context } from '@deepseek-ai/cordis';
import { afterEach, expect, it, vi } from 'vitest';
import Storage from '@axterm/infra-storage';
import * as Schema from '@axterm/data-schema';
import * as Relational from '@axterm/infra-storage-relational';
import * as Domains from '@axterm/infra-storage-domain';
import { OwnedTransferRepository } from '../../packages/plugins/transfers/src/adapters/transfer-repository.ts';
import type { Transfer } from '@axterm/plugin-api/transfers';
const contexts: Context[] = [];
afterEach(async () => {
  for (const ctx of contexts.splice(0).reverse()) await ctx.fiber.dispose();
});
async function fixture() {
  const ctx = new Context();
  contexts.push(ctx);
  await ctx.plugin(Storage);
  await ctx.plugin(Schema);
  await ctx.plugin(Relational, { path: ':memory:', schema: 'productSchema' });
  await ctx.plugin(Domains, { backend: 'relational' });
  const domain = await ctx.storage.domain.open(Schema.productDomains.transfers);
  return { ctx, domain };
}
function fact(state: Transfer['state'] = 'queued'): Transfer {
  const now = new Date().toISOString();
  return {
    id: randomUUID(),
    connectionId: randomUUID(),
    direction: 'upload',
    state,
    bytesTransferred: 0,
    source: 'relative-file',
    destination: '/remote/file',
    createdAt: now,
    updatedAt: now,
  };
}
it('reserves and persists atomically, rejects foreign Profile nonce reuse and never recreates a failed or cleared transfer', async () => {
  const { domain } = await fixture();
  const repository = new OwnedTransferRepository(domain, 'desktop', randomUUID());
  const other = new OwnedTransferRepository(domain, 'web', randomUUID());
  const key = randomUUID();
  const create = vi.fn(() => fact());
  const input = { target: randomUUID(), grant: 'ephemeral' };
  const first = repository.reserve(key, input, create);
  expect(first.created).toBe(true);
  expect(() => other.reserve(key.toUpperCase(), input, create)).toThrow(
    expect.objectContaining({ details: { reason: 'conflict' } }),
  );
  expect(other.commandOutcome(key)).toEqual({ status: 'missing' });
  expect(repository.commandOutcome(key)).toEqual({ status: 'accepted', transfer: first.transfer });
  expect(create).toHaveBeenCalledOnce();
  expect(() => repository.reserve(key, { ...input, grant: 'changed' }, create)).toThrow(
    expect.objectContaining({ details: { reason: 'conflict' } }),
  );
  repository.saveTransfer({
    ...first.transfer,
    source: 'relative-file',
    destination: '/remote/file',
    state: 'failed',
    errorCode: 'TRANSFER_FAILED',
  });
  expect(repository.reserve(key, input, create).transfer.state).toBe('failed');
  expect(create).toHaveBeenCalledOnce();
  expect(repository.clearCompletedTransfers()).toBe(1);
  expect(repository.commandOutcome(key)).toEqual({ status: 'expired' });
  expect(() => repository.reserve(key, input, create)).toThrow(
    expect.objectContaining({ details: { reason: 'receipt-expired' } }),
  );
  expect(create).toHaveBeenCalledOnce();
  expect(domain.events(0).map((event) => event.type)).toEqual([
    'transfers/updated',
    'transfers/updated',
    'transfers/cleared',
  ]);
  expect(JSON.stringify(domain.all('SELECT * FROM axterm_transfer_commands'))).not.toContain(
    'ephemeral',
  );
});
it('interrupts only older owned Profile work and refuses a different generation writing its facts', async () => {
  const { domain } = await fixture();
  const generation = randomUUID();
  const old = new OwnedTransferRepository(domain, 'desktop', generation);
  const web = new OwnedTransferRepository(domain, 'web', randomUUID());
  const desktopTask = old.reserve(randomUUID(), { kind: 'old' }, () => fact('running')).transfer;
  const webTask = web.reserve(randomUUID(), { kind: 'web' }, () => fact('paused')).transfer;
  const next = new OwnedTransferRepository(domain, 'desktop', randomUUID());
  expect(next.getTransfer(desktopTask.id)).toMatchObject({
    state: 'failed',
    errorCode: 'RUNTIME_INTERRUPTED',
  });
  expect(next.getTransfer(webTask.id).state).toBe('paused');
  expect(() =>
    next.saveTransfer({
      ...desktopTask,
      source: 'relative',
      destination: '/remote',
      state: 'succeeded',
    }),
  ).toThrow(expect.objectContaining({ details: { reason: 'conflict' } }));
  expect(domain.events(0).filter((event) => event.type === 'transfers/interrupted')).toHaveLength(
    1,
  );
});
it('rolls a rejected metadata creation back and reads history directly beyond the recent window', async () => {
  const { domain } = await fixture();
  const repository = new OwnedTransferRepository(domain, 'desktop', randomUUID());
  const rejected = randomUUID();
  expect(() =>
    repository.reserve(rejected, {}, () => {
      throw new Error('controlled metadata failure');
    }),
  ).toThrow('controlled metadata failure');
  expect(domain.all('SELECT * FROM axterm_transfer_commands')).toEqual([]);
  expect(repository.cursor()).toBe(0);
  let first = '';
  for (let index = 0; index < 501; index++) {
    const item = fact('succeeded');
    if (index === 0) first = item.id;
    repository.reserve(randomUUID(), { index }, () => item);
  }
  expect(repository.listTransfers()).toHaveLength(500);
  expect(repository.hasMore()).toBe(true);
  expect(repository.getTransfer(first).id).toBe(first);
});
