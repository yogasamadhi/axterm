import { afterEach, expect, it, vi } from 'vitest';
import { connectionSchema } from '@axterm/plugin-api/connections';
import type { ConnectionsState } from '../../packages/plugins/connections/src/client/index.ts';
import { ConnectionWorkspaceAdmissions } from '../../packages/plugins/connections/src/client/ui/workspace-owner.ts';
afterEach(() => vi.useRealTimers());
function fixture(options: { readyTimeoutMs?: number } = {}) {
  const generation = crypto.randomUUID(),
    listeners = new Set<() => void>();
  const row = connectionSchema.parse({
    id: crypto.randomUUID(),
    hostId: crypto.randomUUID(),
    state: 'connecting',
    reconnectAttempt: 0,
    nextReconnectAt: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
  let state: ConnectionsState = {
    status: 'ready',
    baseline: {
      generation,
      cursor: 0,
      revision: 0,
      connections: [row],
      ftpConnections: [],
      interactions: [],
      knownHosts: [],
      tunnelProfiles: [],
      tunnels: [],
    },
  };
  const model = {
    getSnapshot: () => state,
    subscribe: (fn: () => void) => {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
    createConnection: vi.fn(async (_key: string) => row),
    reconnectConnectionHistory: vi.fn(),
    getConnectionCommandOutcome: vi.fn(),
    closeConnection: vi.fn(async () => {}),
  };
  const terminals = { open: vi.fn(async () => 'terminal-view'), activate: vi.fn() };
  const owner = new ConnectionWorkspaceAdmissions(model, terminals, undefined, options);
  return {
    generation,
    row,
    model,
    terminals,
    owner,
    listeners,
    publish(ready: boolean, replacement = generation) {
      if (state.status !== 'ready') throw Error('Unexpected fixture');
      state = {
        status: 'ready',
        baseline: {
          ...state.baseline,
          generation: replacement,
          connections: [{ ...row, state: ready ? 'ready' : 'connecting' }],
        },
      };
      for (const fn of [...listeners]) fn();
    },
  };
}
it('admits only the ready target and releases the actual deadline, subscription and cancellation listener', async () => {
  vi.useFakeTimers();
  const f = fixture(),
    caller = new AbortController();
  const task = f.owner.openSsh({ hostId: f.row.hostId }, caller.signal);
  await vi.advanceTimersByTimeAsync(0);
  expect(f.listeners.size).toBe(1);
  expect(vi.getTimerCount()).toBe(1);
  f.publish(true);
  expect(await task).toBe('terminal-view');
  expect(f.terminals.open).toHaveBeenCalledOnce();
  expect(f.listeners.size).toBe(0);
  expect(vi.getTimerCount()).toBe(0);
  caller.abort();
  expect(f.model.closeConnection).not.toHaveBeenCalled();
  await f.owner.dispose();
});
it('aborts the actual pending subscription immediately and joins connection rollback without a retry timer', async () => {
  vi.useFakeTimers();
  const f = fixture(),
    caller = new AbortController(),
    task = f.owner.openSsh({ hostId: f.row.hostId }, caller.signal),
    rejected = expect(task).rejects.toThrow('CANCELED');
  await vi.advanceTimersByTimeAsync(0);
  caller.abort();
  await rejected;
  expect(f.terminals.open).not.toHaveBeenCalled();
  expect(f.model.closeConnection).toHaveBeenCalledExactlyOnceWith(f.row.id, f.generation);
  expect(f.listeners.size).toBe(0);
  expect(vi.getTimerCount()).toBe(0);
  await f.owner.dispose();
});
it('rejects pre-canceled and disposed admissions before any new network or terminal work', async () => {
  const f = fixture(),
    caller = new AbortController();
  caller.abort();
  await expect(f.owner.openSsh({ hostId: f.row.hostId }, caller.signal)).rejects.toMatchObject({
    name: 'AbortError',
  });
  expect(f.model.createConnection).not.toHaveBeenCalled();
  await f.owner.dispose();
  await expect(f.owner.openSsh({ hostId: f.row.hostId })).rejects.toThrow('CLOSED');
  expect(f.model.createConnection).not.toHaveBeenCalled();
  expect(f.terminals.open).not.toHaveBeenCalled();
});
it.each(['generation', 'disposed'] as const)(
  'rejects a late ready admission when its %s changed and never opens the new target',
  async (change) => {
    vi.useFakeTimers();
    const f = fixture(),
      ack = Promise.withResolvers<typeof f.row>();
    f.model.createConnection.mockReturnValueOnce(ack.promise);
    const task = f.owner.openSsh({ hostId: f.row.hostId }),
      rejected = expect(task).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(0);
    let closing: Promise<void> | undefined;
    if (change === 'generation') f.publish(true, crypto.randomUUID());
    else closing = f.owner.dispose();
    ack.resolve({ ...f.row, state: 'ready' });
    await rejected;
    expect(f.terminals.open).not.toHaveBeenCalled();
    if (change === 'generation') expect(f.model.closeConnection).not.toHaveBeenCalled();
    else expect(f.model.closeConnection).toHaveBeenCalledExactlyOnceWith(f.row.id, f.generation);
    await closing;
    await f.owner.dispose();
    expect(f.listeners.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  },
);
it('enforces the original 120 second view budget, captures shortened test options and releases scheduled work', async () => {
  vi.useFakeTimers();
  const f = fixture(),
    task = f.owner.openSsh({ hostId: f.row.hostId }),
    rejected = expect(task).rejects.toMatchObject({
      code: 'connections/failure',
      details: { reason: 'unavailable', diagnostic: { code: 'CONNECTION_WAIT_TIMEOUT' } },
    });
  await vi.advanceTimersByTimeAsync(119999);
  expect(f.model.closeConnection).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  await rejected;
  expect(f.model.closeConnection).toHaveBeenCalledExactlyOnceWith(f.row.id, f.generation);
  expect(f.listeners.size).toBe(0);
  expect(vi.getTimerCount()).toBe(0);
  await f.owner.dispose();
  const options = { readyTimeoutMs: 1000 },
    short = fixture(options);
  options.readyTimeoutMs = 120000;
  const shortened = short.owner.openSsh({ hostId: short.row.hostId }),
    expired = expect(shortened).rejects.toThrow('TIMEOUT');
  await vi.advanceTimersByTimeAsync(1000);
  await expired;
  expect(vi.getTimerCount()).toBe(0);
  await short.owner.dispose();
  for (const readyTimeoutMs of [0, 120001, NaN, Infinity])
    expect(
      () =>
        new ConnectionWorkspaceAdmissions(short.model, short.terminals, undefined, {
          readyTimeoutMs,
        }),
    ).toThrow('BUDGET_INVALID');
});

it('rejects a generation retired before submission without reading another network result or opening a terminal', async () => {
  vi.useFakeTimers();
  const f = fixture(),
    task = f.owner.openSsh({ hostId: f.row.hostId }),
    rejected = expect(task).rejects.toThrow('RETIRED');
  f.publish(false, crypto.randomUUID());
  await rejected;
  expect(f.model.createConnection).not.toHaveBeenCalled();
  expect(f.terminals.open).not.toHaveBeenCalled();
  expect(f.listeners.size).toBe(0);
  expect(vi.getTimerCount()).toBe(0);
  await f.owner.dispose();
});
