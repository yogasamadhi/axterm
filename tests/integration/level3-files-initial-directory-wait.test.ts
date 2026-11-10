import { afterEach, expect, it, vi } from 'vitest';
import type { FileGrant } from '@axterm/plugin-api/files';
import type { FileGrantsState } from '../../packages/plugins/files/src/client/index.ts';
import { InitialDirectories } from '../../packages/plugins/files/src/client/ui/initial-directories.ts';
afterEach(() => vi.useRealTimers());
function fixture() {
  const generation = crypto.randomUUID();
  let state: FileGrantsState = { status: 'ready', baseline: { generation, cursor: 0, grants: [] } };
  const listeners = new Set<() => void>();
  const files = {
    getSnapshot: () => state,
    subscribe: (fn: () => void) => {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
  };
  const owner = new InitialDirectories(files);
  return {
    owner,
    files,
    generation,
    listeners,
    publish(next: FileGrantsState) {
      state = next;
      for (const fn of [...listeners]) fn();
    },
    grant(id: string): FileGrant {
      return {
        grantId: id,
        kind: 'directory',
        name: 'Native directory',
        permissions: ['read', 'write'],
        createdAt: new Date().toISOString(),
      };
    },
  };
}
it('waits for a newly issued Native directory to enter the accepted Files baseline before handing it to a pane', async () => {
  const f = fixture(),
    id = crypto.randomUUID(),
    pending = f.owner.take(id, f.generation);
  let accepted = false;
  void pending.then(() => {
    accepted = true;
  });
  expect(accepted).toBe(false);
  expect(f.listeners.size).toBe(1);
  const grant = f.grant(id);
  f.publish({
    status: 'ready',
    baseline: { generation: f.generation, cursor: 1, grants: [grant] },
  });
  expect(await pending).toBe(grant);
  expect(f.listeners.size).toBe(0);
  expect(f.owner.resourceCount()).toBe(0);
  await f.owner.close();
});
it('does not accept another generation or leave a subscription after cancellation', async () => {
  const f = fixture(),
    id = crypto.randomUUID(),
    pending = f.owner.take(id, f.generation);
  const outcome = Promise.allSettled([pending]);
  f.publish({
    status: 'ready',
    baseline: { generation: crypto.randomUUID(), cursor: 0, grants: [f.grant(id)] },
  });
  expect((await outcome)[0]!.status).toBe('rejected');
  expect(f.listeners.size).toBe(0);
  await f.owner.close();
  const next = fixture(),
    cancel = new AbortController(),
    other = next.owner.take(id, next.generation, cancel.signal);
  const canceled = Promise.allSettled([other]);
  cancel.abort();
  expect((await canceled)[0]!.status).toBe('rejected');
  expect(next.listeners.size).toBe(0);
  await next.owner.close();
});
it('bounds all pending admissions and drains them on withdrawal', async () => {
  const f = fixture(),
    pending = Array.from({ length: 4 }, () => f.owner.take(crypto.randomUUID(), f.generation)),
    outcomes = Promise.allSettled(pending);
  await expect(f.owner.take('overflow', f.generation)).rejects.toThrow('CAPACITY');
  await f.owner.close();
  expect((await outcomes).every((result) => result.status === 'rejected')).toBe(true);
  expect(f.owner.resourceCount()).toBe(0);
  expect(f.listeners.size).toBe(0);
});
it('rejects expired/file/write-only metadata instead of constructing directory authority from it', async () => {
  for (const change of [
    { kind: 'file' as const },
    { permissions: ['write'] as ('read' | 'write')[] },
    { expiresAt: new Date(Date.now() - 1000).toISOString() },
  ]) {
    const f = fixture(),
      id = crypto.randomUUID();
    f.publish({
      status: 'ready',
      baseline: { generation: f.generation, cursor: 1, grants: [{ ...f.grant(id), ...change }] },
    });
    await expect(f.owner.take(id, f.generation)).rejects.toThrow('UNAVAILABLE');
    expect(f.listeners.size).toBe(0);
    await f.owner.close();
  }
});
it('cleans up synchronous subscription publication and bounded timeout', async () => {
  const f = fixture(),
    id = crypto.randomUUID();
  const owner = new InitialDirectories({
    ...f.files,
    subscribe: (fn) => {
      f.publish({
        status: 'ready',
        baseline: { generation: f.generation, cursor: 1, grants: [f.grant(id)] },
      });
      const off = f.files.subscribe(fn);
      fn();
      return off;
    },
  });
  expect((await owner.take(id, f.generation)).grantId).toBe(id);
  expect(f.listeners.size).toBe(0);
  await owner.close();
  vi.useFakeTimers();
  const late = fixture(),
    pending = late.owner.take(id, late.generation);
  const outcome = Promise.allSettled([pending]);
  await vi.advanceTimersByTimeAsync(10000);
  expect((await outcome)[0]!.status).toBe('rejected');
  expect(late.listeners.size).toBe(0);
  expect(vi.getTimerCount()).toBe(0);
  await late.owner.close();
});
