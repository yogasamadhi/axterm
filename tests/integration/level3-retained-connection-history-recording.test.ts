import { DomainCommands } from '@axterm/infra-storage-domain';
import {
  DEFAULT_SSH_CONNECTION_OPTIONS,
  DEFAULT_SSH_STARTUP,
  type Host,
} from '@axterm/plugin-api/catalog';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ConnectionFactsFixture,
  ConnectionFacts,
  ConnectionEventObserver,
} from '../fixtures/level3-connection-facts.ts';
import { ConnectionHistoryRepository } from '../../packages/plugins/catalog/src/adapters/connection-history-repository.ts';
import type {
  SshConnectionHandle,
  SshTransport,
} from '../../packages/plugins/connections/src/ports/ssh-transport.ts';
import { ConnectionService } from '../../packages/plugins/connections/src/application/connection-service.ts';
import { InteractionService } from '../../packages/plugins/connections/src/application/interaction-service.ts';
import { TerminalService } from '../../packages/plugins/terminals/src/application/terminal-service.ts';
import { TerminalRecordingWriter } from '../../packages/plugins/terminals/src/adapters/terminal-recording.ts';
const RealtimeHub = ConnectionEventObserver;
async function fixture() {
  const database = await ConnectionFactsFixture.open(':memory:', { catalogOwner: true });
  return {
    database,
    hosts: new ConnectionFacts(database),
    historyRepository: new ConnectionHistoryRepository(database.catalog),
    history: database.ctx.catalogConnectionHistory,
    controller: database.ctx.catalogController,
  };
}
describe('ConnectionService history recording', () => {
  it('records only a first successful ready state per live connection and never persists a secret', async () => {
    const context = await fixture();
    const closeListeners = new Set<(error?: Error) => void>();
    const sshHandle: SshConnectionHandle = {
      id: randomUUID(),
      onClose(listener) {
        closeListeners.add(listener);
        return () => closeListeners.delete(listener);
      },
      async openShell() {
        throw new Error('unused');
      },
      async openSftp() {
        throw new Error('unused');
      },
      async exec() {
        return { stdout: '', stderr: '', exitCode: 0 };
      },
      async forwardOut() {
        throw new Error('unused');
      },
      async forwardIn() {
        return 0;
      },
      async unforwardIn() {},
      async close() {
        closeListeners.clear();
      },
    };
    const transport: SshTransport = { connect: vi.fn(async () => sshHandle) };
    const realtime = new RealtimeHub();
    const interactions = new InteractionService(realtime);
    const connections = new ConnectionService(
      context.hosts,
      transport,
      undefined,
      interactions,
      realtime,
      new TerminalService(
        {
          open: () => {
            throw new Error('unused');
          },
        },
        TerminalRecordingWriter,
      ),
      context.history,
    );
    try {
      const input = {
        target: {
          name: 'Quick',
          hostname: 'quick.example',
          port: 22,
          username: 'operator',
          authType: 'password' as const,
        },
        temporarySecret: 'never-store-this-password',
      };
      const first = connections.create(input);
      await vi.waitFor(() => expect(connections.get(first.id).state).toBe('ready'));
      const second = connections.create(input);
      await vi.waitFor(() => expect(connections.get(second.id).state).toBe('ready'));
      expect(context.historyRepository.list().items[0]).toMatchObject({
        hostname: 'quick.example',
        count: 2,
      });
      expect(JSON.stringify(context.historyRepository.list())).not.toContain(
        'never-store-this-password',
      );
    } finally {
      await connections.closeAll();
      interactions.close();
      await context.database.close();
    }
  });

  it('does not record a connection that never reaches ready', async () => {
    const context = await fixture();
    const realtime = new RealtimeHub();
    const interactions = new InteractionService(realtime);
    const connections = new ConnectionService(
      context.hosts,
      {
        connect: async () => {
          throw new Error('offline');
        },
      },
      undefined,
      interactions,
      realtime,
      new TerminalService(
        {
          open: () => {
            throw new Error('unused');
          },
        },
        TerminalRecordingWriter,
      ),
      context.history,
    );
    try {
      const connection = connections.create({
        target: { hostname: 'offline.example', username: 'operator', authType: 'agent' },
      });
      await vi.waitFor(() => expect(connections.get(connection.id).state).toBe('failed'));
      expect(context.historyRepository.list().items).toEqual([]);
    } finally {
      await connections.closeAll();
      interactions.close();
      await context.database.close();
    }
  });

  it('does not count transport recovery as a second user connection', async () => {
    vi.useFakeTimers();
    const context = await fixture();
    const controls: Array<{ disconnect(): void }> = [];
    const transport: SshTransport = {
      async connect() {
        const listeners = new Set<(error?: Error) => void>();
        controls.push({
          disconnect() {
            for (const listener of [...listeners]) listener(new Error('network lost'));
          },
        });
        return {
          id: randomUUID(),
          onClose(listener) {
            listeners.add(listener);
            return () => listeners.delete(listener);
          },
          async openShell() {
            throw new Error('unused');
          },
          async openSftp() {
            throw new Error('unused');
          },
          async exec() {
            return { stdout: '', stderr: '', exitCode: 0 };
          },
          async forwardOut() {
            throw new Error('unused');
          },
          async forwardIn() {
            return 0;
          },
          async unforwardIn() {},
          async close() {
            listeners.clear();
          },
        };
      },
    };
    const host = context.hosts.createHost({
      name: 'Recovering',
      hostname: 'recovering.example',
      username: 'operator',
      authType: 'agent',
      connectionOptions: {
        reconnectPolicy: { mode: 'automatic', delayMs: 250, maxAttempts: 2 },
      },
    });
    const realtime = new RealtimeHub();
    const interactions = new InteractionService(realtime);
    const connections = new ConnectionService(
      context.hosts,
      transport,
      undefined,
      interactions,
      realtime,
      new TerminalService(
        {
          open: () => {
            throw new Error('unused');
          },
        },
        TerminalRecordingWriter,
      ),
      context.history,
    );
    try {
      const connection = connections.create({ hostId: host.id });
      await vi.advanceTimersByTimeAsync(0);
      expect(connections.get(connection.id).state).toBe('ready');
      expect(context.historyRepository.list().items[0]?.count).toBe(1);
      controls[0]!.disconnect();
      await vi.advanceTimersByTimeAsync(250);
      expect(connections.get(connection.id).state).toBe('ready');
      expect(controls).toHaveLength(2);
      expect(context.historyRepository.list().items[0]?.count).toBe(1);
    } finally {
      await connections.closeAll();
      interactions.close();
      await context.database.close();
      vi.useRealTimers();
    }
  });
});

function transientHost(name: string, hostname: string): Host {
  const now = new Date().toISOString();
  return {
    id: randomUUID(),
    groupId: null,
    name,
    hostname,
    port: 22,
    username: 'operator',
    authType: 'agent',
    credentialRef: null,
    passphraseCredentialRef: null,
    certificateCredentialRef: null,
    jumpHostId: null,
    jumpHostIds: [],
    favorite: false,
    proxy: { mode: 'inherit' },
    connectionOptions: structuredClone(DEFAULT_SSH_CONNECTION_OPTIONS),
    startup: structuredClone(DEFAULT_SSH_STARTUP),
    x11: { enabled: false, display: null },
    sshAgent: { enabled: true, path: null },
    createdAt: now,
    updatedAt: now,
    version: 1,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});
const rowVersion = (version: number) => `"v${version}"`;
it('retains one atomic promotion per key with exact aggregate increments and current Host/Bookmark facts', async () => {
  const f = await fixture();
  try {
    const item = f.historyRepository.record({
        host: transientHost('Production', 'production.example'),
        persistedHostId: null,
      }),
      historyBefore = f.historyRepository.state(),
      tree = f.controller.getBookmarkTree(),
      key = randomUUID();
    const result = f.controller.promoteConnectionHistoryToBookmark(
      key,
      item.id,
      { groupId: null, title: 'Production SSH' },
      rowVersion(item.version),
      tree.etag,
    );
    expect(result.createdHost).toBe(true);
    expect(f.historyRepository.get(item.id)).toMatchObject({
      id: item.id,
      hostId: result.hostId,
      version: 2,
    });
    expect(f.controller.getBookmark(result.bookmarkId)).toMatchObject({
      hostId: result.hostId,
      title: 'Production SSH',
      protocol: 'ssh',
    });
    expect(f.historyRepository.state().revision).toBe(historyBefore.revision + 1);
    expect(f.controller.getBookmarkTree().revision).toBe(tree.revision + 1);
    expect(f.controller.listHosts()).toHaveLength(1);
    expect(
      f.controller.promoteConnectionHistoryToBookmark(
        key,
        item.id,
        { groupId: null, title: 'Production SSH' },
        rowVersion(item.version),
        tree.etag,
      ),
    ).toEqual(result);
    expect(f.controller.listHosts()).toHaveLength(1);
    expect(f.controller.getBookmarkTree().bookmarks).toHaveLength(1);
    expect(f.historyRepository.state().revision).toBe(historyBefore.revision + 1);
  } finally {
    await f.database.close();
  }
});
it('retains late promotion rollback after the actual command receipt and all prior owned writes', async () => {
  const f = await fixture();
  try {
    const item = f.historyRepository.record({
        host: transientHost('Rollback', 'rollback.example'),
        persistedHostId: null,
      }),
      history = f.historyRepository.state(),
      tree = f.controller.getBookmarkTree(),
      events = f.database.events(0),
      key = randomUUID();
    let reached = false;
    const original = DomainCommands.prototype.execute;
    const fault = vi.spyOn(DomainCommands.prototype, 'execute').mockImplementationOnce(function (
      this: DomainCommands,
      ...args
    ) {
      original.call(this, ...args);
      reached = true;
      expect(
        f.database.get(
          'SELECT command_id FROM axterm_catalog_command_receipts WHERE command_id=?',
          key,
        ),
      ).toEqual({ command_id: key });
      throw Error('CONTROLLED_POST_RECEIPT_FAILURE');
    });
    expect(() =>
      f.controller.promoteConnectionHistoryToBookmark(
        key,
        item.id,
        {},
        rowVersion(item.version),
        tree.etag,
      ),
    ).toThrow('The catalog operation failed');
    expect(reached).toBe(true);
    fault.mockRestore();
    expect(f.controller.listHosts()).toEqual([]);
    expect(f.controller.getBookmarkTree()).toEqual(tree);
    expect(f.historyRepository.get(item.id)).toEqual(item);
    expect(f.historyRepository.state()).toEqual(history);
    expect(f.database.events(0)).toEqual(events);
    expect(
      f.database.get(
        'SELECT command_id FROM axterm_catalog_command_receipts WHERE command_id=?',
        key,
      ),
    ).toBeUndefined();
    expect(
      f.controller.promoteConnectionHistoryToBookmark(
        key,
        item.id,
        {},
        rowVersion(item.version),
        tree.etag,
      ).createdHost,
    ).toBe(true);
  } finally {
    await f.database.close();
  }
});
it('retains saved jump targets while refusing invalid groups and stale item or tree versions', async () => {
  const f = await fixture();
  try {
    const jump = f.hosts.createHost({
        name: 'Jump',
        hostname: 'jump.example',
        username: 'jump-user',
        authType: 'agent',
      }),
      target = f.hosts.createHost({
        name: 'Target',
        hostname: 'target.example',
        username: 'operator',
        authType: 'agent',
        jumpHostId: jump.id,
      }),
      item = f.historyRepository.record({ host: target, persistedHostId: target.id }),
      tree = f.controller.getBookmarkTree();
    const promote = (groupId: string | null | undefined, version: string, treeVersion: string) =>
      f.controller.promoteConnectionHistoryToBookmark(
        randomUUID(),
        item.id,
        { ...(groupId !== undefined ? { groupId } : {}) },
        version,
        treeVersion,
      );
    expect(() => promote(randomUUID(), rowVersion(item.version), tree.etag)).toThrowError(
      expect.objectContaining({
        code: 'catalog/failure',
        details: expect.objectContaining({ reason: 'not-found' }),
      }),
    );
    expect(() => promote(undefined, rowVersion(99), tree.etag)).toThrowError(
      expect.objectContaining({
        code: 'catalog/failure',
        details: expect.objectContaining({ reason: 'precondition-failed' }),
      }),
    );
    expect(() => promote(undefined, rowVersion(item.version), '"bookmark-tree-v99"')).toThrowError(
      expect.objectContaining({
        code: 'catalog/failure',
        details: expect.objectContaining({ reason: 'precondition-failed' }),
      }),
    );
    const result = promote(undefined, rowVersion(item.version), tree.etag);
    expect(result.createdHost).toBe(false);
    expect(f.controller.getHost(result.hostId)).toMatchObject({
      id: target.id,
      jumpHostId: jump.id,
    });
    expect(f.controller.listHosts()).toHaveLength(2);
    expect(result.historyVersion).toBe(f.historyRepository.get(item.id).version);
  } finally {
    await f.database.close();
  }
});
it('retains retry-safe delete and clear with exact row and collection version refusal', async () => {
  const f = await fixture();
  try {
    const first = f.historyRepository.record({
      host: transientHost('First', 'first.example'),
      persistedHostId: null,
    });
    f.historyRepository.record({
      host: transientHost('Second', 'second.example'),
      persistedHostId: null,
    });
    expect(() =>
      f.controller.deleteConnectionHistory(randomUUID(), first.id, rowVersion(99)),
    ).toThrowError(
      expect.objectContaining({
        details: expect.objectContaining({ reason: 'precondition-failed' }),
      }),
    );
    const deleteKey = randomUUID(),
      deleted = f.controller.deleteConnectionHistory(
        deleteKey,
        first.id,
        rowVersion(first.version),
      );
    expect(
      f.controller.deleteConnectionHistory(deleteKey, first.id, rowVersion(first.version)),
    ).toEqual(deleted);
    const current = f.historyRepository.state();
    expect(() =>
      f.controller.clearConnectionHistory(randomUUID(), '"connection-history-v1"'),
    ).toThrowError(
      expect.objectContaining({
        details: expect.objectContaining({ reason: 'precondition-failed' }),
      }),
    );
    const clearKey = randomUUID(),
      cleared = f.controller.clearConnectionHistory(clearKey, current.etag);
    expect(cleared.deletedCount).toBe(1);
    expect(f.controller.clearConnectionHistory(clearKey, current.etag)).toEqual(cleared);
    expect(f.historyRepository.list().items).toEqual([]);
  } finally {
    await f.database.close();
  }
});
it('retains metadata history default-on, atomic privacy purge and refusal of later successful recordings', async () => {
  const f = await fixture();
  try {
    expect(f.hosts.getSettings().privacy.connectionHistoryEnabled).toBe(true);
    f.history.recordSuccessful({
      host: transientHost('Before disable', 'before.example'),
      persistedHostId: null,
    });
    expect(f.historyRepository.list().total).toBe(1);
    const notifications: { owner: string; count: number; enabled: boolean }[] = [];
    const observed = (owner: string) => () =>
      notifications.push({
        owner,
        count: f.historyRepository.list().total,
        enabled: f.hosts.getSettings().privacy.connectionHistoryEnabled,
      });
    const unsubscribe = f.database.subscribe(observed('catalog')),
      unsubscribeSettings = f.database.subscribeConfiguration(observed('configuration'));
    const settings = f.hosts.getSettings();
    f.hosts.updateSettings(
      { privacy: { connectionHistoryEnabled: false } },
      rowVersion(settings.version),
    );
    expect(f.historyRepository.list().items).toEqual([]);
    f.history.recordSuccessful({
      host: transientHost('After disable', 'after.example'),
      persistedHostId: null,
    });
    expect(f.historyRepository.list().items).toEqual([]);
    expect(f.database.events(0).at(-1)?.type).toBe('connection-history.cleared');
    expect(f.database.configurationEvents(0).at(-1)?.type).toBe('settings.updated');
    await vi.waitFor(() =>
      expect(new Set(notifications.map((item) => item.owner))).toEqual(
        new Set(['catalog', 'configuration']),
      ),
    );
    expect(notifications.every((item) => item.count === 0 && item.enabled === false)).toBe(true);
    unsubscribe();
    unsubscribeSettings();
    expect(f.hosts.getSettings().version).toBe(settings.version + 1);
  } finally {
    await f.database.close();
  }
});
