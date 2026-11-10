import { setImmediate } from 'node:timers/promises';
import { randomUUID } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { aiProviderSchema, type AiBaseline, type AiProvider } from '@axterm/plugin-api/ai';
import type { AiModel } from '../../packages/plugins/ai/src/client/index.ts';
import { AiReadRegistry } from '../../packages/plugins/ai/src/client/read-registry.ts';
import { AiPanelQueries } from '../../packages/plugins/ai/src/client/panel-queries.ts';

it('shares a selected read across two UI mounts and joins the actual late result after the final mount leaves', async () => {
  const reads = new AiReadRegistry();
  const pending = Promise.withResolvers<{ name: string }>();
  let calls = 0;
  let signal: AbortSignal | undefined;
  const read = (owned: AbortSignal) => {
    calls++;
    signal = owned;
    return pending.promise;
  };
  const first = reads.open('selected', read, () => 'generation:1');
  const second = reads.open('selected', read, () => 'generation:1');
  expect(first.resource).toBe(second.resource);
  await setImmediate();
  expect(calls).toBe(1);
  await first.dispose();
  expect(signal!.aborted).toBe(false);
  let drained = false;
  const closing = second.dispose().then(() => {
    drained = true;
  });
  await setImmediate();
  expect(signal!.aborted).toBe(true);
  expect(drained).toBe(false);
  expect(reads.resourceCount()).toBe(1);
  pending.resolve({ name: 'late result' });
  await closing;
  expect(second.resource.getSnapshot().data).toBeUndefined();
  expect(reads.resourceCount()).toBe(0);
  expect(reads.retainedBytes()).toBe(0);
  await reads.dispose();
});
it('coalesces invalidations during an accepted read and publishes immutable fresh facts without starting another command', async () => {
  const reads = new AiReadRegistry();
  const initial = Promise.withResolvers<{ version: number; selected: string[] }>();
  let revision = 1;
  let calls = 0;
  const lease = reads.open(
    'selected',
    () =>
      ++calls === 1
        ? initial.promise
        : Promise.resolve({ version: revision, selected: ['current'] }),
    () => String(revision),
  );
  try {
    await setImmediate();
    revision++;
    reads.invalidate();
    reads.invalidate();
    initial.resolve({ version: 1, selected: ['old'] });
    await vi.waitFor(() => expect(lease.resource.getSnapshot().data?.version).toBe(2));
    expect(calls).toBe(2);
    const value = lease.resource.getSnapshot().data!;
    expect(Object.isFrozen(value)).toBe(true);
    expect(Object.isFrozen(value.selected)).toBe(true);
    expect(() => value.selected.push('mutation')).toThrow();
  } finally {
    await lease.dispose();
    await reads.dispose();
  }
});
it('refuses oversized detail replacement while retaining the last accepted facts and releases reader capacity deterministically', async () => {
  const reads = new AiReadRegistry();
  let tooLarge = false;
  const lease = reads.open(
    'selected',
    async () => (tooLarge ? 'x'.repeat(4 * 1024 * 1024) : 'accepted'),
    () => String(tooLarge),
  );
  try {
    await vi.waitFor(() => expect(lease.resource.getSnapshot().data).toBe('accepted'));
    const before = reads.retainedBytes();
    tooLarge = true;
    reads.invalidate();
    await vi.waitFor(() => expect(lease.resource.getSnapshot().isError).toBe(true));
    expect(lease.resource.getSnapshot().data).toBe('accepted');
    expect(reads.retainedBytes()).toBe(before);
    for (let index = 0; index < 31; index++)
      reads.open(
        'other:' + index,
        async () => index,
        () => 'same',
      );
    expect(() =>
      reads.open(
        'over-capacity',
        async () => 0,
        () => '',
      ),
    ).toThrow('AI_READ_CAPACITY');
  } finally {
    await reads.dispose();
  }
  expect(reads.resourceCount()).toBe(0);
  expect(reads.retainedBytes()).toBe(0);
  expect(() =>
    reads.open(
      'closed',
      async () => 0,
      () => '',
    ),
  ).toThrow('AI_READ_REGISTRY_CLOSED');
});

it('rejects a late provider detail from the retired generation and replaces it from the current metadata owner', async () => {
  let generation = randomUUID();
  let provider = aiProviderSchema.parse({
    id: randomUUID(),
    engineId: 'external',
    name: 'Old generation',
    enabled: true,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    version: 1,
  });
  const old = provider;
  const deferred = Promise.withResolvers<AiProvider>();
  const listeners = new Set<() => void>();
  let calls = 0;
  const model = {
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    getSnapshot: () => ({
      status: 'ready',
      baseline: {
        generation,
        cursor: 0,
        revision: 0,
        providers: [
          {
            id: provider.id,
            engineId: provider.engineId,
            name: provider.name,
            enabled: provider.enabled,
            createdAt: provider.createdAt,
            updatedAt: provider.updatedAt,
            version: provider.version,
          },
        ],
        models: [],
        conversations: [],
        runs: [],
        approvals: [],
        engines: [],
      } satisfies AiBaseline,
    }),
    readProvider: async () => (++calls === 1 ? deferred.promise : provider),
  } as unknown as AiModel;
  const owner = new AiPanelQueries(model);
  const lease = owner.open('provider', provider.id)!;
  const published: (string | undefined)[] = [];
  const off = lease.resource.subscribe(() =>
    published.push(lease.resource.getSnapshot().data?.name),
  );
  try {
    await setImmediate();
    generation = randomUUID();
    provider = { ...provider, name: 'Current generation', version: 2 };
    for (const listener of listeners) listener();
    deferred.resolve(old);
    await vi.waitFor(() =>
      expect(lease.resource.getSnapshot().data?.name).toBe('Current generation'),
    );
    expect(published).not.toContain('Old generation');
    expect(calls).toBe(2);
  } finally {
    off();
    await lease.dispose();
    await owner.dispose();
  }
  expect(listeners.size).toBe(0);
});

it('hands a view to a fresh reader while the retired instance drains without letting the old disposer remove the new owner', async () => {
  const reads = new AiReadRegistry(),
    pending = Promise.withResolvers<string>();
  const old = reads.open(
    'workspace:selected',
    () => pending.promise,
    () => 'same',
  );
  await setImmediate();
  const stopped = old.dispose();
  const fresh = reads.open(
    'workspace:selected',
    async () => 'fresh facts',
    () => 'same',
  );
  expect(fresh.resource).not.toBe(old.resource);
  expect(reads.resourceCount()).toBe(2);
  await vi.waitFor(() => expect(fresh.resource.getSnapshot().data).toBe('fresh facts'));
  pending.resolve('late stale facts');
  await stopped;
  expect(old.resource.getSnapshot().data).toBeUndefined();
  expect(reads.resourceCount()).toBe(1);
  expect(reads.retainedBytes()).toBe(
    new TextEncoder().encode(JSON.stringify('fresh facts')).byteLength,
  );
  const same = reads.open(
    'workspace:selected',
    async () => 'must not run',
    () => 'same',
  );
  expect(same.resource).toBe(fresh.resource);
  await same.dispose();
  await fresh.dispose();
  await reads.dispose();
  expect(reads.resourceCount()).toBe(0);
  expect(reads.retainedBytes()).toBe(0);
});
it('counts retired IO against the same admission limit and joins it during registry shutdown', async () => {
  const reads = new AiReadRegistry(),
    pending = Promise.withResolvers<string>();
  const old = reads.open(
    'selected',
    () => pending.promise,
    () => 'same',
  );
  await setImmediate();
  const retiring = old.dispose();
  for (let index = 0; index < 31; index++)
    reads.open(
      'other:' + index,
      async () => index,
      () => 'same',
    );
  expect(() =>
    reads.open(
      'selected',
      async () => 'over budget',
      () => 'same',
    ),
  ).toThrow('CAPACITY');
  let done = false;
  const closing = reads.dispose().then(() => {
    done = true;
  });
  await setImmediate();
  expect(done).toBe(false);
  pending.resolve('retired');
  await retiring;
  await closing;
  expect(reads.resourceCount()).toBe(0);
  expect(reads.retainedBytes()).toBe(0);
});

it('does not resurrect a reader when its last UI lease leaves after registry shutdown', async () => {
  const reads = new AiReadRegistry();
  const lease = reads.open(
    'selected',
    async () => 'facts',
    () => 'same',
  );
  await setImmediate();
  await reads.dispose();
  expect(reads.resourceCount()).toBe(0);
  await lease.dispose();
  expect(reads.resourceCount()).toBe(0);
  expect(reads.retainedBytes()).toBe(0);
});
