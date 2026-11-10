import { expect, it } from 'vitest';
import { EditorCompletion } from '../../packages/plugins/catalog/src/client/ui/session/editor-completion.ts';
import type { CatalogEditorOwner } from '../../packages/plugins/catalog/src/client/ui/editor/owner.ts';
function fixture() {
  let id: string | undefined = 'first';
  const listeners = new Set<() => void>();
  const editor = {
    getSnapshot: () => ({ session: id ? { id } : undefined }),
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  } as unknown as Pick<CatalogEditorOwner, 'getSnapshot' | 'subscribe'>;
  return {
    owner: new EditorCompletion(editor),
    listeners,
    set: (value: string | undefined) => {
      id = value;
      for (const listener of [...listeners]) listener();
    },
  };
}
it('serializes editor intent until its actual selection closes', async () => {
  const f = fixture();
  let idle = false,
    closed = false;
  const signal = new AbortController().signal,
    idleWait = f.owner.idle(signal).then(() => {
      idle = true;
    }),
    closeWait = f.owner.closed('first', signal).then(() => {
      closed = true;
    });
  await Promise.resolve();
  expect(idle).toBe(false);
  expect(closed).toBe(false);
  f.set(undefined);
  await Promise.all([idleWait, closeWait]);
  expect(idle && closed).toBe(true);
  expect(f.listeners.size).toBe(0);
  await f.owner.close();
});
it('bounds pending listeners and cancels all waiters on owner unload', async () => {
  const f = fixture(),
    waiters = Array.from({ length: 8 }, () => f.owner.idle(new AbortController().signal));
  expect(() => f.owner.idle(new AbortController().signal)).toThrow('CAPACITY');
  const outcomes = Promise.allSettled(waiters);
  await f.owner.close();
  expect((await outcomes).every((value) => value.status === 'rejected')).toBe(true);
  expect(f.listeners.size).toBe(0);
});
it('releases its subscription when the captured delivery signal retires', async () => {
  const f = fixture(),
    signal = new AbortController(),
    waiting = f.owner.closed('first', signal.signal);
  signal.abort();
  await expect(waiting).rejects.toThrow('CANCELED');
  expect(f.listeners.size).toBe(0);
  await f.owner.close();
});
