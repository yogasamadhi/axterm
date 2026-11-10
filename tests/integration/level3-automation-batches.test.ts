import { Context } from '@deepseek-ai/cordis';
import { randomUUID } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import Storage from '@axterm/infra-storage';
import * as Schema from '@axterm/data-schema';
import * as Relational from '@axterm/infra-storage-relational';
import * as Domains from '@axterm/infra-storage-domain';
import { bookmarkSchema, createBookmarkSchema } from '@axterm/plugin-api/catalog';
import type { ConnectionsApplication } from '@axterm/plugin-api/host';
import type { BatchOperation } from '@axterm/plugin-api/automation';
import { AutomationStorage } from '../../packages/plugins/automation/src/adapters/storage.ts';
import { BatchOperationRepository } from '../../packages/plugins/automation/src/adapters/batch-repository.ts';
import { BatchOperationService } from '../../packages/plugins/automation/src/application/batches.ts';
import { BatchCommands } from '../../packages/plugins/automation/src/adapters/batch-commands.ts';
const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
});
async function fixture(targetCount = 1) {
  const ctx = new Context();
  cleanups.push(() => ctx.fiber.dispose());
  await ctx.plugin(Storage);
  await ctx.plugin(Schema);
  await ctx.plugin(Relational, { path: ':memory:', schema: 'productSchema' });
  await ctx.plugin(Domains, { backend: 'relational' });
  const domain = await ctx.storage.domain.open(Schema.productDomains.automation);
  cleanups.push(() => domain.close());
  const sql = new AutomationStorage(domain);
  const generation = randomUUID();
  const repo = new BatchOperationRepository(sql, 'desktop', generation);
  const now = new Date().toISOString();
  const hostId = randomUUID();
  const bookmark = bookmarkSchema.parse({
    ...createBookmarkSchema.parse({ protocol: 'ssh', hostId, title: 'Batch target' }),
    id: randomUUID(),
    position: 0,
    connectionDisplay: null,
    version: 1,
    createdAt: now,
    updatedAt: now,
  });
  const bookmarks = Array.from({ length: targetCount }, (_, index) => ({
    ...bookmark,
    id: randomUUID(),
    title: `Target ${index + 1}`,
  }));
  const native = new Set<string>();
  let inTransaction = false;
  const create = vi.fn<ConnectionsApplication['create']>(async () => {
    expect(inTransaction).toBe(false);
    const id = randomUUID();
    native.add(id);
    return {
      id,
      hostId,
      state: 'ready',
      reconnectAttempt: 0,
      nextReconnectAt: null,
      createdAt: now,
      updatedAt: now,
    };
  });
  const exec = vi.fn<ConnectionsApplication['exec']>(async () => ({
    stdout: 'BATCH_PRIVATE_EXEC_OUTPUT',
    stderr: '',
    exitCode: 0,
  }));
  const close = vi.fn<ConnectionsApplication['close']>(async (id) => {
    native.delete(id);
  });
  const service = new BatchOperationService(
    repo,
    {
      getBookmarkTree: () => ({
        revision: 1,
        etag: '"bookmark-tree-v1"',
        groups: [],
        bookmarks,
      }),
    },
    {
      create,
      exec,
      close,
      get: (id) => ({
        id,
        hostId,
        state: 'ready',
        reconnectAttempt: 0,
        nextReconnectAt: null,
        createdAt: now,
        updatedAt: now,
      }),
    },
  );
  cleanups.push(() => service.closeAll());
  const commands = new BatchCommands(domain, service, (action) =>
    domain.transaction(() => {
      inTransaction = true;
      try {
        return action();
      } finally {
        inTransaction = false;
      }
    }),
  );
  const input = {
    name: 'Controlled batch',
    bookmarkIds: bookmarks.map((item) => item.id),
    steps: [{ id: randomUUID(), name: 'Inspect', command: 'echo PRIVATE_BATCH_COMMAND' }],
    concurrency: 1,
    connectionTimeoutMs: 1000,
  };
  return {
    ctx,
    domain,
    sql,
    generation,
    repo,
    service,
    commands,
    input,
    native,
    create,
    exec,
    close,
  };
}
it('commits batch creation once before network IO and replays a completed receipt without executing commands again', async () => {
  const f = await fixture();
  const key = randomUUID();
  const first = f.commands.create(key, f.input);
  expect(f.create).not.toHaveBeenCalled();
  expect(f.commands.create(key, f.input)).toEqual(first);
  await vi.waitFor(() => expect(f.service.resourceCount()).toBe(0));
  expect(f.create).toHaveBeenCalledOnce();
  expect(f.exec).toHaveBeenCalledOnce();
  expect(f.native.size).toBe(0);
  expect(f.repo.get(first.ids[0]!).state).toBe('succeeded');
  expect(f.commands.create(key, f.input)).toEqual(first);
  expect(f.exec).toHaveBeenCalledOnce();
  const facts =
    JSON.stringify(f.domain.all('SELECT payload FROM batch_operations')) +
    JSON.stringify(f.domain.events(0));
  expect(facts).not.toContain('PRIVATE_BATCH_COMMAND');
  expect(facts).not.toContain('BATCH_PRIVATE_EXEC_OUTPUT');
  expect(f.commands.clearCompleted(randomUUID()).cleared).toBe(1);
});
it('keeps successful command facts active until the actual connection close finishes and pins them against history clearing', async () => {
  const f = await fixture();
  const release = Promise.withResolvers<void>();
  f.close.mockImplementation(async (id) => {
    await release.promise;
    f.native.delete(id);
  });
  const created = f.commands.create(randomUUID(), f.input);
  await vi.waitFor(() => expect(f.close).toHaveBeenCalledOnce());
  expect(f.service.resourceCount()).toBe(1);
  expect(f.repo.activeCount()).toBe(1);
  expect(f.commands.clearCompleted(randomUUID()).cleared).toBe(0);
  release.resolve();
  await vi.waitFor(() => expect(f.service.resourceCount()).toBe(0));
  expect(f.repo.get(created.ids[0]!).state).toBe('succeeded');
  expect(f.repo.activeCount()).toBe(0);
});
it('commits cancellation before aborting execution and drains owned connections without replay', async () => {
  const f = await fixture();
  f.exec.mockImplementation(
    async (_id, input) =>
      new Promise((_resolve, reject) => {
        input.signal!.addEventListener(
          'abort',
          () => {
            const metadata = f.repo.list()[0]!;
            expect(metadata.state).toBe('canceling');
            reject(new Error('Controlled cancellation'));
          },
          { once: true },
        );
      }),
  );
  const created = f.commands.create(randomUUID(), f.input);
  await vi.waitFor(() => expect(f.exec).toHaveBeenCalledOnce());
  const key = randomUUID();
  const canceled = f.commands.cancel(key, created.ids[0]!);
  expect(f.commands.cancel(key, created.ids[0]!)).toEqual(canceled);
  await vi.waitFor(() => expect(f.service.resourceCount()).toBe(0));
  expect(f.repo.get(created.ids[0]!).state).toBe('canceled');
  expect(f.native.size).toBe(0);
  expect(f.exec).toHaveBeenCalledOnce();
});
it('interrupts only stale ownership in the same Profile and cannot release another Profile or generation', async () => {
  const f = await fixture();
  const now = new Date().toISOString();
  const metadata = (id = randomUUID()): BatchOperation => ({
    id,
    name: 'Stale batch',
    state: 'queued',
    concurrency: 1,
    targetCount: 1,
    completedCount: 0,
    succeededCount: 0,
    failedCount: 0,
    canceledCount: 0,
    targets: [
      {
        bookmarkId: f.input.bookmarkIds[0]!,
        title: 'target',
        state: 'queued',
        steps: [{ stepId: f.input.steps[0]!.id, name: 'step', state: 'queued', exitCode: null }],
      },
    ],
    createdAt: now,
    updatedAt: now,
    version: 1,
  });
  const desktop = f.repo.create(metadata());
  const web = new BatchOperationRepository(f.sql, 'web', randomUUID());
  const remote = web.create(metadata());
  expect(() => web.release(desktop.id)).toThrow();
  const restarted = new BatchOperationRepository(f.sql, 'desktop', randomUUID());
  expect(restarted.get(desktop.id).state).toBe('interrupted');
  expect(web.get(remote.id).state).toBe('queued');
  expect(() => f.repo.save(desktop)).toThrow();
  const completed = web.save({ ...remote, state: 'failed' });
  web.release(completed.id);
  expect(f.exec).not.toHaveBeenCalled();
});

it('retains failed native cleanup as active and refuses to clear its successful fact until cleanup really succeeds', async () => {
  const f = await fixture();
  f.close.mockImplementationOnce(async () => {
    throw new Error('Controlled close failure');
  });
  const created = f.commands.create(randomUUID(), f.input);
  await vi.waitFor(() => expect(f.repo.get(created.ids[0]!).state).toBe('succeeded'));
  expect(f.service.resourceCount()).toBe(1);
  expect(f.repo.activeCount()).toBe(1);
  expect(f.native.size).toBe(1);
  expect(f.commands.clearCompleted(randomUUID()).cleared).toBe(0);
  await f.service.closeAll();
  expect(f.native.size).toBe(0);
  expect(f.repo.activeCount()).toBe(0);
  expect(f.commands.clearCompleted(randomUUID()).cleared).toBe(1);
});

it('retains original four-target ordered execution, concurrency two and secret-free persisted summaries', async () => {
  const f = await fixture(4),
    commands = new Map<string, string[]>();
  let active = 0,
    maximum = 0;
  f.exec.mockImplementation(async (id, input) => {
    commands.set(id, [...(commands.get(id) ?? []), input.command]);
    maximum = Math.max(maximum, ++active);
    try {
      await new Promise((resolve) => setTimeout(resolve, 20));
      return { stdout: `output:${input.command}`, stderr: '', exitCode: 0 };
    } finally {
      active--;
    }
  });
  const created = f.commands.create(randomUUID(), {
    ...f.input,
    name: 'Fleet health',
    concurrency: 2,
    connectionTimeoutMs: 5000,
    steps: [
      { id: randomUUID(), name: 'First', command: 'one' },
      { id: randomUUID(), name: 'Second', command: 'two' },
    ],
  });
  await vi.waitFor(() => expect(f.service.resourceCount()).toBe(0));
  const complete = f.repo.get(created.ids[0]!);
  expect(complete).toMatchObject({
    state: 'succeeded',
    targetCount: 4,
    completedCount: 4,
    succeededCount: 4,
    failedCount: 0,
  });
  expect(maximum).toBe(2);
  expect([...commands.values()]).toEqual(Array.from({ length: 4 }, () => ['one', 'two']));
  expect(complete.targets.every((target) => target.steps[0]?.name === 'First')).toBe(true);
  expect(JSON.stringify(complete)).not.toContain('output:');
  expect(JSON.stringify(f.domain.events(0))).not.toContain('one');
  expect(f.native.size).toBe(0);
});
it('retains cancellation of all three queued targets and their unstarted steps without dispatch', async () => {
  const f = await fixture(3);
  const created = f.commands.create(randomUUID(), f.input);
  f.commands.cancel(randomUUID(), created.ids[0]!);
  await vi.waitFor(() => expect(f.service.resourceCount()).toBe(0));
  const complete = f.repo.get(created.ids[0]!);
  expect(complete.state).toBe('canceled');
  expect(complete.canceledCount).toBe(3);
  expect(complete.targets.every(({ state }) => state === 'canceled')).toBe(true);
  expect(
    complete.targets.every((target) => target.steps.every(({ state }) => state === 'canceled')),
  ).toBe(true);
  expect(f.exec).not.toHaveBeenCalled();
  expect(f.native.size).toBe(0);
});

it('retains running target and step interruption on actual Profile generation restart without execution', async () => {
  const f = await fixture(),
    now = new Date().toISOString();
  const operation = f.repo.create({
    id: randomUUID(),
    name: 'Interrupted',
    state: 'running',
    concurrency: 1,
    targetCount: 1,
    completedCount: 0,
    succeededCount: 0,
    failedCount: 0,
    canceledCount: 0,
    targets: [
      {
        bookmarkId: f.input.bookmarkIds[0]!,
        title: 'Server',
        state: 'running',
        startedAt: now,
        steps: [
          { stepId: randomUUID(), name: 'Check', state: 'running', exitCode: null, startedAt: now },
        ],
      },
    ],
    createdAt: now,
    updatedAt: now,
    version: 1,
  });
  const restarted = new BatchOperationRepository(f.sql, 'desktop', randomUUID());
  expect(restarted.get(operation.id)).toMatchObject({
    state: 'interrupted',
    completedCount: 1,
    failedCount: 1,
    targets: [
      {
        state: 'failed',
        errorCode: 'RUNTIME_INTERRUPTED',
        steps: [{ state: 'canceled', errorCode: 'RUNTIME_INTERRUPTED' }],
      },
    ],
  });
  expect(f.exec).not.toHaveBeenCalled();
  expect(f.create).not.toHaveBeenCalled();
});
