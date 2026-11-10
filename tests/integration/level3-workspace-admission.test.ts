import { expect, it, vi } from 'vitest';
import {
  terminalSessionSchema,
  type TerminalSession,
  type CreateTerminalInput,
} from '@axterm/plugin-api/terminals';
import { connectionSchema } from '@axterm/plugin-api/connections';
import type { TerminalsState } from '../../packages/plugins/terminals/src/client/index.ts';
import type {
  ConnectionsModel,
  ConnectionsState,
} from '../../packages/plugins/connections/src/client/index.ts';
import { TerminalWorkspaceAdmissions } from '../../packages/plugins/terminals/src/client/workspace-owner.ts';
import { ConnectionWorkspaceAdmissions } from '../../packages/plugins/connections/src/client/ui/workspace-owner.ts';
const session = () =>
  terminalSessionSchema.parse({
    id: crypto.randomUUID(),
    kind: 'local',
    title: 'Admission fixture',
    state: 'ready',
    createdAt: new Date().toISOString(),
  });
function terminalFixture() {
  const generation = crypto.randomUUID();
  let state: TerminalsState = {
    status: 'ready',
    baseline: { type: 'baseline', generation, revision: 0, sessions: [] },
  };
  const listeners = new Set<() => void>();
  const accepted = Promise.withResolvers<TerminalSession>();
  const model = {
    getCommandOutcome: vi.fn(async (_generation: string, _key: string) => ({
      status: 'missing' as const,
    })),
    create: vi.fn((_input: CreateTerminalInput, _key?: string) => accepted.promise),
    close: vi.fn(async (_id: string, _generation?: string) => {}),
    getSnapshot: () => state,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
  const activate = vi.fn();
  const owner = new TerminalWorkspaceAdmissions(model, activate);
  return {
    generation,
    accepted,
    model,
    activate,
    owner,
    listeners,
    publish(next: TerminalsState) {
      state = next;
      for (const listener of [...listeners]) listener();
    },
  };
}
it('waits for owned terminal facts before activation and copies input without retaining business facts in workspace state', async () => {
  const f = terminalFixture();
  const input: CreateTerminalInput = {
    kind: 'local',
    cols: 80,
    rows: 24,
    environment: { TEST_DRAFT: 'original' },
  };
  const opening = f.owner.open(input);
  input.environment!.TEST_DRAFT = 'mutated';
  await Promise.resolve();
  expect(f.model.create).toHaveBeenCalledExactlyOnceWith(
    {
      ...input,
      environment: { TEST_DRAFT: 'original' },
    },
    expect.any(String),
  );
  const created = session();
  f.accepted.resolve(created);
  await vi.waitFor(() => expect(f.listeners.size).toBe(1));
  expect(f.activate).not.toHaveBeenCalled();
  f.publish({
    status: 'ready',
    baseline: { type: 'baseline', generation: f.generation, revision: 1, sessions: [created] },
  });
  expect(await opening).toBe(created.id);
  expect(f.activate).toHaveBeenCalledExactlyOnceWith(created.id);
  expect(f.listeners.size).toBe(0);
  await f.owner.dispose();
  expect(f.model.close).not.toHaveBeenCalled();
});
it('closes a canceled late accepted terminal and joins its actual rollback before disposal', async () => {
  const f = terminalFixture();
  const close = Promise.withResolvers<void>();
  f.model.close.mockImplementation(() => close.promise);
  const opening = f.owner.open({ kind: 'local', cols: 80, rows: 24 });
  const outcome = Promise.allSettled([opening]);
  await Promise.resolve();
  const stopping = f.owner.dispose();
  expect(f.owner.dispose()).toBe(stopping);
  let done = false;
  void stopping.then(() => {
    done = true;
  });
  const created = session();
  f.accepted.resolve(created);
  await vi.waitFor(() =>
    expect(f.model.close).toHaveBeenCalledExactlyOnceWith(created.id, f.generation),
  );
  expect(done).toBe(false);
  expect(f.activate).not.toHaveBeenCalled();
  close.resolve();
  await stopping;
  expect((await outcome)[0]!.status).toBe('rejected');
  expect(f.listeners.size).toBe(0);
});
it('rejects a generation retired before submission and does not route old terminal rollback into a replacement Host', async () => {
  const f = terminalFixture();
  const opening = f.owner.open({ kind: 'local', cols: 80, rows: 24 });
  f.publish({
    status: 'ready',
    baseline: { type: 'baseline', generation: crypto.randomUUID(), revision: 0, sessions: [] },
  });
  await expect(opening).rejects.toThrow('RETIRED');
  expect(f.model.create).not.toHaveBeenCalled();
  await f.owner.dispose();
  const late = terminalFixture();
  const operation = late.owner.open({ kind: 'local', cols: 80, rows: 24 });
  await Promise.resolve();
  late.publish({
    status: 'ready',
    baseline: { type: 'baseline', generation: crypto.randomUUID(), revision: 0, sessions: [] },
  });
  late.accepted.resolve(session());
  await expect(operation).rejects.toThrow('RETIRED');
  expect(late.model.close).not.toHaveBeenCalled();
  expect(late.activate).not.toHaveBeenCalled();
  await late.owner.dispose();
});
it('retains failed terminal rollback and reports an unsuccessful actual drain', async () => {
  const f = terminalFixture();
  f.model.close.mockRejectedValue(new Error('Controlled close failure'));
  const cancel = new AbortController();
  const opening = f.owner.open({ kind: 'local', cols: 80, rows: 24 }, cancel.signal);
  await Promise.resolve();
  cancel.abort();
  f.accepted.resolve(session());
  await expect(opening).rejects.toThrow('close failure');
  await expect(f.owner.dispose()).rejects.toThrow('DRAIN_FAILED');
  expect(f.model.close).toHaveBeenCalledTimes(2);
});
it('waits for its own SSH facts before delegating one terminal admission, and rolls back an unaccepted launch on close', async () => {
  const generation = crypto.randomUUID(),
    id = crypto.randomUUID();
  let state: ConnectionsState = {
    status: 'ready',
    baseline: {
      generation,
      cursor: 0,
      revision: 0,
      connections: [],
      ftpConnections: [],
      interactions: [],
      knownHosts: [],
      tunnelProfiles: [],
      tunnels: [],
    },
  };
  const listeners = new Set<() => void>();
  const row = connectionSchema.parse({
    id,
    hostId: crypto.randomUUID(),
    state: 'connecting',
    reconnectAttempt: 0,
    nextReconnectAt: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
  const model = {
    getConnectionCommandOutcome: vi.fn(async () => ({ status: 'missing' as const })),
    reconnectConnectionHistory: vi.fn(async () => {
      throw new Error('Unexpected history request');
    }),
    createConnection: vi.fn(async () => row),
    closeConnection: vi.fn(async () => {}),
    getSnapshot: () => state,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
  const terminals = {
    open: vi.fn(async (_input: CreateTerminalInput, _signal?: AbortSignal) => 'terminal-id'),
    activate: vi.fn(),
  };
  const owner = new ConnectionWorkspaceAdmissions(model, terminals);
  const bookmarkId = crypto.randomUUID(),
    profileId = crypto.randomUUID();
  const options = {
    bookmarkId,
    profileId,
    cols: 120,
    rows: 30,
    environment: { BOOKMARK_START: 'original' },
  };
  const opening = owner.openSsh({ hostId: crypto.randomUUID() }, undefined, options);
  options.environment.BOOKMARK_START = 'changed-after-admission';
  await vi.waitFor(() => expect(listeners.size).toBe(1));
  expect(terminals.open).not.toHaveBeenCalled();
  state = {
    status: 'ready',
    baseline: { ...state.baseline, connections: [{ ...row, state: 'ready' }] },
  };
  for (const listener of [...listeners]) listener();
  expect(await opening).toBe('terminal-id');
  expect(terminals.open).toHaveBeenCalledTimes(1);
  expect(terminals.open.mock.calls[0]![0]).toMatchObject({
    kind: 'ssh',
    connectionId: id,
    bookmarkId,
    profileId,
    cols: 120,
    rows: 30,
    environment: { BOOKMARK_START: 'original' },
  });
  expect(listeners.size).toBe(0);
  await owner.dispose();
  expect(model.closeConnection).not.toHaveBeenCalled();
  const rollbackId = crypto.randomUUID();
  model.createConnection.mockResolvedValue({ ...row, id: rollbackId });
  const waiting = new ConnectionWorkspaceAdmissions(model, terminals);
  state = { status: 'ready', baseline: { ...state.baseline, connections: [] } };
  const pending = waiting.openSsh({ hostId: crypto.randomUUID() });
  const outcome = Promise.allSettled([pending]);
  await vi.waitFor(() => expect(listeners.size).toBe(1));
  await waiting.dispose();
  expect((await outcome)[0]!.status).toBe('rejected');
  expect(model.closeConnection).toHaveBeenCalledExactlyOnceWith(rollbackId, generation);
  expect(listeners.size).toBe(0);
});

it('bounds terminal admissions before allocation and actually drains every canceled late allocation', async () => {
  const f = terminalFixture();
  const accepted: ReturnType<typeof Promise.withResolvers<TerminalSession>>[] = [];
  f.model.create.mockImplementation(() => {
    const value = Promise.withResolvers<TerminalSession>();
    accepted.push(value);
    return value.promise;
  });
  const pending = Array.from({ length: 8 }, () =>
    f.owner.open({ kind: 'local', cols: 80, rows: 24 }),
  );
  const outcomes = Promise.allSettled(pending);
  await expect(f.owner.open({ kind: 'local', cols: 80, rows: 24 })).rejects.toThrow('CAPACITY');
  await vi.waitFor(() => expect(accepted).toHaveLength(8));
  const closing = f.owner.dispose();
  for (const value of accepted) value.resolve(session());
  expect((await outcomes).every((value) => value.status === 'rejected')).toBe(true);
  await closing;
  expect(f.model.close).toHaveBeenCalledTimes(8);
  expect(new Set(f.model.close.mock.calls.map((call) => call[0])).size).toBe(8);
  expect(f.activate).not.toHaveBeenCalled();
  expect(f.listeners.size).toBe(0);
});

it('counts retained failed rollback resources against subsequent terminal admission capacity', async () => {
  const f = terminalFixture();
  f.model.create.mockImplementation(async () => session());
  f.model.close.mockRejectedValue(new Error('Controlled retained rollback'));
  for (let index = 0; index < 8; index++) {
    const scope = new AbortController();
    const operation = f.owner.open({ kind: 'local', cols: 80, rows: 24 }, scope.signal);
    await Promise.resolve();
    scope.abort();
    await expect(operation).rejects.toThrow('retained rollback');
  }
  await expect(f.owner.open({ kind: 'local', cols: 80, rows: 24 })).rejects.toThrow('CAPACITY');
  expect(f.model.create).toHaveBeenCalledTimes(8);
  await expect(f.owner.dispose()).rejects.toThrow('DRAIN_FAILED');
});
it('bounds retained SSH rollback resources and never opens terminals for failed connections', async () => {
  const generation = crypto.randomUUID();
  let state: ConnectionsState = {
    status: 'ready',
    baseline: {
      generation,
      cursor: 0,
      revision: 0,
      connections: [],
      ftpConnections: [],
      interactions: [],
      knownHosts: [],
      tunnelProfiles: [],
      tunnels: [],
    },
  };
  const listeners = new Set<() => void>();
  const model = {
    getSnapshot: () => state,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    getConnectionCommandOutcome: vi.fn(async () => ({ status: 'missing' as const })),
    reconnectConnectionHistory: vi.fn(async () => {
      throw new Error('Unexpected history request');
    }),
    createConnection: vi.fn(async () => {
      if (state.status !== 'ready') throw new Error('fixture');
      const row = connectionSchema.parse({
        id: crypto.randomUUID(),
        hostId: crypto.randomUUID(),
        state: 'failed',
        reconnectAttempt: 0,
        nextReconnectAt: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
      state = {
        status: 'ready',
        baseline: { ...state.baseline, connections: [...state.baseline.connections, row] },
      };
      return row;
    }),
    closeConnection: vi.fn(async () => {
      throw new Error('Controlled retained SSH rollback');
    }),
  };
  const terminals = { open: vi.fn(), activate: vi.fn() };
  const owner = new ConnectionWorkspaceAdmissions(model, terminals);
  for (let index = 0; index < 8; index++)
    await expect(owner.openSsh({ hostId: crypto.randomUUID() })).rejects.toThrow(
      'retained SSH rollback',
    );
  await expect(owner.openSsh({ hostId: crypto.randomUUID() })).rejects.toThrow('CAPACITY');
  expect(model.createConnection).toHaveBeenCalledTimes(8);
  expect(terminals.open).not.toHaveBeenCalled();
  expect(listeners.size).toBe(0);
  await expect(owner.dispose()).rejects.toThrow('DRAIN_FAILED');
  expect(model.closeConnection).toHaveBeenCalledTimes(16);
});

it('owns a history reconnect through ready facts and late cancellation without creating another connection path', async () => {
  const generation = crypto.randomUUID();
  let state: ConnectionsState = {
    status: 'ready',
    baseline: {
      generation,
      cursor: 0,
      revision: 0,
      connections: [],
      ftpConnections: [],
      interactions: [],
      knownHosts: [],
      tunnelProfiles: [],
      tunnels: [],
    },
  };
  const listeners = new Set<() => void>();
  const row = connectionSchema.parse({
    id: crypto.randomUUID(),
    hostId: crypto.randomUUID(),
    state: 'connecting',
    reconnectAttempt: 0,
    nextReconnectAt: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
  const accepted = Promise.withResolvers<typeof row>();
  const model = {
    createConnection: vi.fn(async () => row),
    getConnectionCommandOutcome: vi.fn(async () => ({ status: 'missing' as const })),
    reconnectConnectionHistory: vi.fn(
      async (
        _key: string,
        _id: string,
        _input: { temporarySecret?: string },
        _ifMatch: string | undefined,
      ) => accepted.promise,
    ),
    closeConnection: vi.fn(async () => {}),
    getSnapshot: () => state,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
  const terminals = { open: vi.fn(async () => 'history-terminal'), activate: vi.fn() };
  const owner = new ConnectionWorkspaceAdmissions(model, terminals);
  const id = crypto.randomUUID();
  const input = { temporarySecret: 'OWNED_HISTORY_INPUT' };
  const abort = new AbortController();
  const opening = owner.openHistory(id, input, '"v4"', abort.signal, {
    profileId: '11111111-1111-4111-8111-111111111111',
  });
  const outcome = Promise.allSettled([opening]);
  input.temporarySecret = 'Changed after admission';
  await Promise.resolve();
  expect(model.reconnectConnectionHistory.mock.calls[0]!.slice(1)).toEqual([
    id,
    { temporarySecret: 'OWNED_HISTORY_INPUT' },
    '"v4"',
  ]);
  abort.abort();
  accepted.resolve(row);
  await outcome;
  expect((await outcome)[0]!.status).toBe('rejected');
  expect(model.closeConnection).toHaveBeenCalledExactlyOnceWith(row.id, generation);
  expect(terminals.open).not.toHaveBeenCalled();
  expect(model.createConnection).not.toHaveBeenCalled();
  await owner.dispose();
  model.reconnectConnectionHistory.mockResolvedValue(row);
  const liveOwner = new ConnectionWorkspaceAdmissions(model, terminals);
  const live = liveOwner.openHistory(id, {}, '"v4"', undefined, {
    profileId: '11111111-1111-4111-8111-111111111111',
  });
  await vi.waitFor(() => expect(listeners.size).toBe(1));
  state = {
    status: 'ready',
    baseline: { ...state.baseline, connections: [{ ...row, state: 'ready' }] },
  };
  for (const listener of listeners) listener();
  expect(await live).toBe('history-terminal');
  expect(terminals.open).toHaveBeenCalledWith(
    expect.objectContaining({
      connectionId: row.id,
      profileId: '11111111-1111-4111-8111-111111111111',
      kind: 'ssh',
    }),
    expect.any(AbortSignal),
  );
  await liveOwner.dispose();
  expect(model.createConnection).not.toHaveBeenCalled();
});

function uncertainConnectionFixture() {
  const generation = crypto.randomUUID();
  let state: ConnectionsState = {
    status: 'ready',
    baseline: {
      generation,
      cursor: 0,
      revision: 0,
      connections: [],
      ftpConnections: [],
      interactions: [],
      knownHosts: [],
      tunnelProfiles: [],
      tunnels: [],
    },
  };
  const model = {
    createConnection: vi
      .fn<ConnectionsModel['createConnection']>()
      .mockRejectedValue(new Error('LOST_CREATION_ACK')),
    reconnectConnectionHistory: vi
      .fn<ConnectionsModel['reconnectConnectionHistory']>()
      .mockRejectedValue(new Error('LOST_HISTORY_ACK')),
    getConnectionCommandOutcome: vi
      .fn<ConnectionsModel['getConnectionCommandOutcome']>()
      .mockResolvedValue({ status: 'missing' }),
    closeConnection: vi.fn<ConnectionsModel['closeConnection']>().mockResolvedValue(undefined),
    getSnapshot: () => state,
    subscribe: () => () => {},
  };
  const terminals = { open: vi.fn(async () => 'unused-terminal'), activate: vi.fn() };
  const owner = new ConnectionWorkspaceAdmissions(model, terminals);
  return {
    owner,
    generation,
    model,
    terminals,
    retire: () => {
      if (state.status === 'ready')
        state = {
          status: 'ready',
          baseline: { ...state.baseline, generation: crypto.randomUUID() },
        };
    },
  };
}
it('finds and actually closes a creation whose acknowledgment was lost without replaying its network command', async () => {
  const f = uncertainConnectionFixture();
  const id = crypto.randomUUID();
  f.model.getConnectionCommandOutcome.mockResolvedValue({ status: 'accepted', id });
  const gate = Promise.withResolvers<void>();
  const entered = Promise.withResolvers<void>();
  f.model.closeConnection.mockImplementation(async () => {
    entered.resolve();
    await gate.promise;
  });
  const opening = f.owner.openSsh({ hostId: crypto.randomUUID() });
  const outcome = Promise.allSettled([opening]);
  await entered.promise;
  let drained = false;
  const close = f.owner.dispose().then(() => {
    drained = true;
  });
  await Promise.resolve();
  expect(drained).toBe(false);
  expect(f.model.createConnection).toHaveBeenCalledTimes(1);
  const key = f.model.createConnection.mock.calls[0]![0];
  expect(f.model.getConnectionCommandOutcome.mock.calls[0]![1]).toBe(key);
  gate.resolve();
  await outcome;
  await close;
  expect(f.model.closeConnection).toHaveBeenCalledExactlyOnceWith(id, f.generation);
  expect(f.terminals.open).not.toHaveBeenCalled();
});
it('retains missing acknowledgment identities in admission capacity and refuses to claim same-generation drain', async () => {
  const f = uncertainConnectionFixture();
  for (let index = 0; index < 8; index++)
    await expect(f.owner.openHistory(crypto.randomUUID(), {}, '"v1"')).rejects.toThrow(
      'LOST_HISTORY_ACK',
    );
  await expect(f.owner.openSsh({ hostId: crypto.randomUUID() })).rejects.toThrow('CAPACITY');
  await expect(f.owner.dispose()).rejects.toThrow('DRAIN_FAILED');
  expect(f.model.reconnectConnectionHistory).toHaveBeenCalledTimes(8);
  expect(f.model.closeConnection).not.toHaveBeenCalled();
  expect(f.terminals.open).not.toHaveBeenCalled();
});
it('reconciles a retained acknowledgment by read-only lookup, or retires it only after the actual Host generation changes', async () => {
  const f = uncertainConnectionFixture();
  await expect(f.owner.openSsh({ hostId: crypto.randomUUID() })).rejects.toThrow(
    'LOST_CREATION_ACK',
  );
  const id = crypto.randomUUID();
  f.model.getConnectionCommandOutcome.mockResolvedValue({ status: 'accepted', id });
  await f.owner.dispose();
  expect(f.model.closeConnection).toHaveBeenCalledExactlyOnceWith(id, f.generation);
  expect(f.model.createConnection).toHaveBeenCalledTimes(1);
  const retired = uncertainConnectionFixture();
  await expect(retired.owner.openSsh({ hostId: crypto.randomUUID() })).rejects.toThrow(
    'LOST_CREATION_ACK',
  );
  retired.retire();
  await retired.owner.dispose();
  expect(retired.model.getConnectionCommandOutcome).toHaveBeenCalledTimes(1);
  expect(retired.model.closeConnection).not.toHaveBeenCalled();
});

it('reconciles a lost terminal creation acknowledgment without replay, and joins actual generation-owned close', async () => {
  const f = terminalFixture();
  const id = crypto.randomUUID();
  const closed = Promise.withResolvers<void>();
  f.model.getCommandOutcome.mockImplementation(async () => ({ status: 'accepted', id }) as never);
  f.model.close.mockImplementation(() => closed.promise);
  const opening = f.owner.open({ kind: 'local', cols: 80, rows: 24 });
  const ended = Promise.allSettled([opening]);
  await Promise.resolve();
  f.accepted.reject(new Error('Lost response'));
  await vi.waitFor(() => expect(f.model.close).toHaveBeenCalledExactlyOnceWith(id, f.generation));
  const stopping = f.owner.dispose();
  let done = false;
  void stopping.then(() => {
    done = true;
  });
  await Promise.resolve();
  expect(done).toBe(false);
  closed.resolve();
  await stopping;
  expect((await ended)[0]!.status).toBe('rejected');
  expect(f.model.create).toHaveBeenCalledTimes(1);
  expect(f.model.getCommandOutcome).toHaveBeenCalledExactlyOnceWith(
    f.generation,
    f.model.create.mock.calls[0]![1],
  );
  expect(f.activate).not.toHaveBeenCalled();
});
it('keeps eight unresolved terminal commands owned, refuses further admission and fails same-generation drain', async () => {
  const f = terminalFixture();
  f.model.create.mockRejectedValue(new Error('Lost response'));
  for (let i = 0; i < 8; i++)
    await expect(f.owner.open({ kind: 'local', cols: 80, rows: 24 })).rejects.toThrow(
      'Lost response',
    );
  await expect(f.owner.open({ kind: 'local', cols: 80, rows: 24 })).rejects.toThrow('CAPACITY');
  await expect(f.owner.dispose()).rejects.toThrow('DRAIN_FAILED');
  expect(f.model.create).toHaveBeenCalledTimes(8);
  expect(new Set(f.model.create.mock.calls.map((call) => call[1])).size).toBe(8);
  expect(f.model.close).not.toHaveBeenCalled();
});
it('retires unresolved terminal identities only after observing a replacement generation', async () => {
  const f = terminalFixture();
  f.model.create.mockRejectedValue(new Error('Lost response'));
  await expect(f.owner.open({ kind: 'local', cols: 80, rows: 24 })).rejects.toThrow(
    'Lost response',
  );
  f.publish({
    status: 'ready',
    baseline: { type: 'baseline', generation: crypto.randomUUID(), revision: 0, sessions: [] },
  });
  await f.owner.dispose();
  expect(f.model.close).not.toHaveBeenCalled();
  expect(f.model.getCommandOutcome).toHaveBeenCalledTimes(1);
});

function sshFilesFixture() {
  const generation = crypto.randomUUID(),
    hostId = crypto.randomUUID(),
    connectionProfileId = crypto.randomUUID();
  const row = connectionSchema.parse({
    id: crypto.randomUUID(),
    hostId,
    connectionProfileId,
    state: 'ready',
    reconnectAttempt: 0,
    nextReconnectAt: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
  let rows = [row];
  const model = {
    getSnapshot: () =>
      ({
        status: 'ready',
        baseline: {
          generation,
          cursor: 0,
          revision: 0,
          connections: rows,
          ftpConnections: [],
          interactions: [],
          knownHosts: [],
          tunnels: [],
          tunnelProfiles: [],
        },
      }) as ConnectionsState,
    subscribe: vi.fn(() => () => {}),
    createConnection: vi.fn(async () => row),
    closeConnection: vi.fn(async () => {}),
    getConnectionCommandOutcome: vi.fn(async () => ({ status: 'missing' as const })),
    reconnectConnectionHistory: vi.fn(async () => row),
  };
  const terminals = { open: vi.fn(async () => 'terminal'), activate: vi.fn() };
  const files = { open: vi.fn(async (..._args: unknown[]) => 'files'), openFtp: vi.fn() };
  const owner = new ConnectionWorkspaceAdmissions(model, terminals);
  const detach = owner.attachFiles(files);
  return {
    owner,
    model,
    terminals,
    files,
    row,
    generation,
    hostId,
    connectionProfileId,
    detach,
    setRows: (next: typeof rows) => {
      rows = next;
    },
  };
}
it('admits Files-only through the optional Files owner, capturing the title and directory authority without a terminal', async () => {
  const f = sshFilesFixture();
  const view = { title: 'Files only', initialDirectoryGrantId: 'live-grant', path: '/initial' };
  const pending = f.owner.openSsh(
    { hostId: f.hostId, connectionProfileId: f.connectionProfileId },
    undefined,
    undefined,
    view,
  );
  view.title = 'mutated';
  expect(await pending).toBe('files');
  expect(f.model.createConnection).not.toHaveBeenCalled();
  expect(f.files.open).toHaveBeenCalledExactlyOnceWith(
    {
      kind: 'remote',
      target: { protocol: 'sftp', connectionId: f.row.id },
      title: 'Files only',
      initialDirectoryGrantId: 'live-grant',
      path: '/initial',
    },
    expect.any(AbortSignal),
  );
  expect(f.terminals.open).not.toHaveBeenCalled();
  await f.owner.dispose();
  expect(f.model.closeConnection).not.toHaveBeenCalled();
});
it('does not disconnect a shared ready SSH connection when a new Files view fails', async () => {
  const f = sshFilesFixture();
  f.files.open.mockRejectedValue(Error('view failed'));
  await expect(
    f.owner.openSsh(
      { hostId: f.hostId, connectionProfileId: f.connectionProfileId },
      undefined,
      undefined,
      {},
    ),
  ).rejects.toThrow('view failed');
  await f.owner.dispose();
  expect(f.model.createConnection).not.toHaveBeenCalled();
  expect(f.model.closeConnection).not.toHaveBeenCalled();
});
it('joins rollback for newly allocated Files-only SSH, and rejects a withdrawn owner before network IO', async () => {
  const f = sshFilesFixture();
  f.files.open.mockRejectedValue(Error('view failed'));
  const drain = Promise.withResolvers<void>();
  f.model.closeConnection.mockImplementation(() => drain.promise);
  const opening = f.owner.openSsh(
    { hostId: f.hostId, connectionProfileId: f.connectionProfileId, temporarySecret: 'transient' },
    undefined,
    undefined,
    {},
  );
  const result = Promise.allSettled([opening]);
  await vi.waitFor(() => expect(f.model.closeConnection).toHaveBeenCalledTimes(1));
  let drained = false;
  void opening
    .finally(() => {
      drained = true;
    })
    .catch(() => {});
  expect(drained).toBe(false);
  drain.resolve();
  expect((await result)[0]!.status).toBe('rejected');
  expect(f.model.createConnection).toHaveBeenCalledTimes(1);
  f.detach();
  await expect(f.owner.openSsh({ hostId: f.hostId }, undefined, undefined, {})).rejects.toThrow(
    'OWNER_MISSING',
  );
  expect(f.model.createConnection).toHaveBeenCalledTimes(1);
  await f.owner.dispose();
});
it('requires an exact SSH connection Profile match for reuse', async () => {
  const f = sshFilesFixture();
  await f.owner.openSsh({ hostId: f.hostId, connectionProfileId: crypto.randomUUID() });
  expect(f.model.createConnection).toHaveBeenCalledTimes(1);
  expect(f.terminals.open).toHaveBeenCalledTimes(1);
  await f.owner.dispose();
});

it('keeps terminal presentation titles outside the strict Host request and admits the captured title only with accepted facts', async () => {
  const f = terminalFixture();
  const opening = f.owner.open({ kind: 'local', cols: 80, rows: 24 }, undefined, 'Captured tab');
  await vi.waitFor(() => expect(f.model.create).toHaveBeenCalledOnce());
  expect(f.model.create.mock.calls[0]![0]).not.toHaveProperty('title');
  const created = session();
  f.accepted.resolve(created);
  await vi.waitFor(() => expect(f.listeners.size).toBe(1));
  expect(f.activate).not.toHaveBeenCalled();
  f.publish({
    status: 'ready',
    baseline: { type: 'baseline', generation: f.generation, revision: 1, sessions: [created] },
  });
  expect(await opening).toBe(created.id);
  expect(f.activate).toHaveBeenCalledExactlyOnceWith(created.id, 'Captured tab');
  await f.owner.dispose();
  const invalid = terminalFixture();
  await expect(
    invalid.owner.open({ kind: 'local', cols: 80, rows: 24 }, undefined, 'invalid\ntitle'),
  ).rejects.toThrow('TITLE_INVALID');
  expect(invalid.model.create).not.toHaveBeenCalled();
  await invalid.owner.dispose();
});
it('separates SSH presentation titles from strict terminal inputs while retaining the chosen Profile', async () => {
  const f = sshFilesFixture();
  const profileId = crypto.randomUUID();
  await f.owner.openSsh(
    { hostId: f.hostId, connectionProfileId: f.connectionProfileId },
    undefined,
    { profileId, title: 'SSH title' },
  );
  expect(f.terminals.open).toHaveBeenCalledExactlyOnceWith(
    { kind: 'ssh', connectionId: f.row.id, profileId, cols: 80, rows: 24 },
    expect.any(AbortSignal),
    { title: 'SSH title' },
  );
  await f.owner.dispose();
});

it('opens the terminal before a combined Files view and keeps the accepted terminal connection if Files fails', async () => {
  const f = sshFilesFixture();
  f.files.open.mockImplementationOnce(async () => {
    expect(f.terminals.open).toHaveBeenCalledTimes(1);
    return 'files';
  });
  expect(
    await f.owner.openSsh(
      { hostId: f.hostId, temporarySecret: 'fresh' },
      undefined,
      { title: 'Combined' },
      undefined,
      { title: 'Combined files', initialDirectoryGrantId: 'directory' },
    ),
  ).toBe('terminal');
  expect(f.files.open).toHaveBeenCalledWith(
    {
      kind: 'remote',
      target: { protocol: 'sftp', connectionId: f.row.id },
      title: 'Combined files',
      initialDirectoryGrantId: 'directory',
    },
    expect.any(AbortSignal),
  );
  f.files.open.mockRejectedValueOnce(Error('Files failed'));
  await expect(
    f.owner.openSsh(
      { hostId: f.hostId, temporarySecret: 'fresh' },
      undefined,
      undefined,
      undefined,
      {},
    ),
  ).rejects.toThrow('Files failed');
  expect(f.terminals.open).toHaveBeenCalledTimes(2);
  expect(f.model.closeConnection).not.toHaveBeenCalled();
  await f.owner.dispose();
  expect(f.model.closeConnection).not.toHaveBeenCalled();
});
it('rejects conflicting view requests before any SSH allocation', async () => {
  const f = sshFilesFixture();
  await expect(f.owner.openSsh({ hostId: f.hostId }, undefined, undefined, {}, {})).rejects.toThrow(
    'VIEW_CONFLICT',
  );
  expect(f.model.createConnection).not.toHaveBeenCalled();
  await f.owner.dispose();
});
