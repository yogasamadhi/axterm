import { expect, it, vi } from 'vitest';
import { RemoteError } from '@axterm/plugin-api';
import type { TransferClientActions } from '@axterm/plugin-api/transfers';
import { TransferUiCommands } from '../../packages/plugins/transfers/src/client/ui/commands.ts';
import { visibleTransferCount } from '../../packages/plugins/transfers/src/client/ui/paging.ts';
function fixture() {
  let generation = crypto.randomUUID();
  const listeners = new Set<() => void>();
  const model = {
    getSnapshot: () => ({ status: 'ready', baseline: { generation, items: [] } }),
    subscribe: (fn: () => void) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  } as unknown as TransferClientActions;
  return {
    model,
    listeners,
    commands: new TransferUiCommands(model),
    replace() {
      generation = crypto.randomUUID();
      for (const fn of listeners) fn();
    },
  };
}
it('serializes a row and explicitly retries the captured idempotency key after uncertain acknowledgement', async () => {
  const f = fixture(),
    done = Promise.withResolvers<void>();
  const perform = vi.fn(async (key: string) => {
    if (perform.mock.calls.length === 1) {
      await done.promise;
      throw Error('LOST_ACK');
    }
    return key;
  });
  const first = f.commands.run('row', perform);
  await expect(f.commands.run('row', async () => {})).rejects.toThrow('PENDING');
  done.resolve();
  await expect(first).rejects.toThrow('LOST_ACK');
  expect(f.commands.getSnapshot()[0]?.state).toBe('uncertain');
  const key = f.commands.getSnapshot()[0]!.key;
  expect(await f.commands.retry('row')).toBe(key);
  expect(perform.mock.calls.map((call) => call[0])).toEqual([key, key]);
  await f.commands.close();
  expect(f.listeners.size).toBe(0);
});
it('joins actual command completion on withdrawal and retains unresolved acceptance', async () => {
  const f = fixture(),
    done = Promise.withResolvers<void>();
  let closed = false;
  const job = f.commands.run('row', async () => done.promise);
  const closing = f.commands.close().then(() => {
    closed = true;
  });
  await Promise.resolve();
  expect(closed).toBe(false);
  done.resolve();
  await job;
  await closing;
  expect(closed).toBe(true);
  const g = fixture();
  await expect(
    g.commands.run('row', async () => {
      throw Error('LOST_ACK');
    }),
  ).rejects.toThrow();
  await expect(g.commands.close()).rejects.toThrow('UNDRAINED');
});
it('retires old generation intents and refuses to replay them in the replacement Host', async () => {
  const f = fixture(),
    perform = vi.fn(async () => {
      throw Error('LOST_ACK');
    });
  await expect(f.commands.run('row', perform)).rejects.toThrow();
  f.replace();
  expect(f.commands.getSnapshot()).toEqual([]);
  await expect(f.commands.retry('row')).rejects.toThrow('NOT_RETRYABLE');
  expect(perform).toHaveBeenCalledOnce();
  await f.commands.close();
});
it('bounds pending rows and retires definitive validation failures', async () => {
  const f = fixture(),
    done = Promise.withResolvers<void>();
  const pending = Array.from({ length: 16 }, (_, i) =>
    f.commands.run(String(i), async () => done.promise),
  );
  await expect(f.commands.run('overflow', async () => {})).rejects.toThrow('PENDING');
  done.resolve();
  await Promise.all(pending);
  await expect(
    f.commands.run('invalid', async () => {
      throw new RemoteError('transfers/failure', 'Invalid input', { reason: 'invalid-input' });
    }),
  ).rejects.toThrow();
  expect(f.commands.getSnapshot()).toEqual([]);
  await f.commands.close();
  expect(visibleTransferCount(500, 0)).toBe(20);
  expect(visibleTransferCount(500, 20)).toBe(40);
  expect(visibleTransferCount(3, 100)).toBe(3);
});
