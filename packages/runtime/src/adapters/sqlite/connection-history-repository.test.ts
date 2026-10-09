import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_SSH_CONNECTION_OPTIONS,
  DEFAULT_SSH_STARTUP,
  type Host,
} from '@workspace/contracts';
import { ProductDatabase } from './database';
import { ConnectionHistoryRepository, connectionTargetKey } from './connection-history-repository';

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

describe('ConnectionHistoryRepository', () => {
  it('aggregates an exact safe target and pages deterministically by recent or frequency', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-12T01:00:00.000Z'));
    const database = await ProductDatabase.open();
    const repository = new ConnectionHistoryRepository(database);
    try {
      const frequent = transientHost('Frequent', 'FREQUENT.example.');
      const first = repository.record({ host: frequent, persistedHostId: null });
      vi.setSystemTime(new Date('2026-09-12T01:01:00.000Z'));
      const second = repository.record({
        host: {
          ...frequent,
          name: 'Renamed frequent',
          hostname: 'frequent.example',
          authType: 'privateKey',
          connectionOptions: {
            ...frequent.connectionOptions,
            connectionTimeoutMs: 12_000,
            compression: false,
            reconnectPolicy: { mode: 'automatic', delayMs: 750, maxAttempts: 3 },
          },
        },
        persistedHostId: null,
      });
      vi.setSystemTime(new Date('2026-09-12T01:02:00.000Z'));
      const newest = repository.record({
        host: transientHost('Newest', 'newest.example'),
        persistedHostId: null,
      });

      expect(first.id).toBe(second.id);
      expect(second).toMatchObject({
        count: 2,
        name: 'Renamed frequent',
        authType: 'privateKey',
        connectionOptions: {
          connectionTimeoutMs: 12_000,
          compression: false,
          reconnectPolicy: { mode: 'automatic', delayMs: 750, maxAttempts: 3 },
        },
        version: 2,
      });
      expect(connectionTargetKey(frequent)).toBe(
        connectionTargetKey({ ...frequent, hostname: 'frequent.example' }),
      );
      expect(repository.list({ sort: 'recent', limit: 50 }).items.map(({ id }) => id)).toEqual([
        newest.id,
        second.id,
      ]);
      expect(repository.list({ sort: 'frequency', limit: 50 }).items.map(({ id }) => id)).toEqual([
        second.id,
        newest.id,
      ]);

      const page = repository.list({ sort: 'recent', limit: 1 });
      expect(page).toMatchObject({ total: 2, limit: 1 });
      expect(page.nextCursor).not.toBeNull();
      expect(
        repository.list({ sort: 'recent', limit: 1, cursor: page.nextCursor! }).items[0]?.id,
      ).toBe(second.id);

      repository.record({
        host: transientHost('Changed', 'changed.example'),
        persistedHostId: null,
      });
      expect(() =>
        repository.list({ sort: 'recent', limit: 1, cursor: page.nextCursor! }),
      ).toThrowError(expect.objectContaining({ code: 'PRECONDITION_FAILED' }));

      const stored = database.get<Record<string, unknown>>(
        'SELECT * FROM recent_connections WHERE id=?',
        second.id,
      );
      expect(stored).not.toHaveProperty('credential_ref');
      expect(JSON.stringify(stored)).not.toMatch(
        /credential-marker|passphrase-marker|one-use-only/i,
      );
    } finally {
      database.close();
      vi.useRealTimers();
    }
  });

  it('retains only the fifty most recent distinct targets and advances once per record', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-12T02:00:00.000Z'));
    const database = await ProductDatabase.open();
    const repository = new ConnectionHistoryRepository(database);
    try {
      for (let index = 0; index < 55; index += 1) {
        vi.setSystemTime(new Date(Date.UTC(2026, 8, 12, 2, 0, index)));
        repository.record({
          host: transientHost(`Host ${index}`, `host-${index}.example`),
          persistedHostId: null,
        });
      }
      const page = repository.list({ limit: 50 });
      expect(page.total).toBe(50);
      expect(page.items[0]?.hostname).toBe('host-54.example');
      expect(page.items.at(-1)?.hostname).toBe('host-5.example');
      expect(page.revision).toBe(56);
      expect(
        database.get<{ count: number }>(
          "SELECT COUNT(*) AS count FROM domain_events WHERE type='connection-history.recorded'",
        )?.count,
      ).toBe(55);
    } finally {
      database.close();
      vi.useRealTimers();
    }
  });
});
