import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_SSH_CONNECTION_OPTIONS,
  DEFAULT_SSH_STARTUP,
  type Host,
} from '@workspace/contracts';
import { ConnectionHistoryRepository } from './connection-history-repository';
import { ProductDatabase } from './database';
import { ProductRepository } from './product-repository';

const directories: string[] = [];

function transientHost(hostname: string): Host {
  const now = new Date().toISOString();
  return {
    id: '00000000-0000-4000-8000-000000000020',
    groupId: null,
    name: 'Original snapshot',
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

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe('Connection history migration', () => {
  it('aggregates legacy rows into the bounded safe target schema without credential data', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'axterm-history-migration-'));
    directories.push(directory);
    const path = join(directory, 'product.sqlite');
    let database = await ProductDatabase.open(path);
    const host = new ProductRepository(database).createHost({
      name: 'Legacy target',
      hostname: 'legacy.example',
      port: 2202,
      username: 'operator',
      authType: 'privateKey',
      credentialRef: 'credential-marker-that-must-not-be-copied',
      passphraseCredentialRef: 'passphrase-marker-that-must-not-be-copied',
      connectionOptions: {
        connectionTimeoutMs: 12_000,
        keepaliveIntervalMs: 5_000,
        keepaliveCountMax: 4,
        compression: false,
        reconnectPolicy: { mode: 'automatic', delayMs: 750, maxAttempts: 3 },
      },
    });
    database.close();

    const legacy = new DatabaseSync(path);
    legacy.exec(`
      PRAGMA foreign_keys=OFF;
      DROP INDEX recent_connections_host;
      DROP INDEX recent_connections_recent;
      DROP INDEX recent_connections_frequency;
      DROP TABLE recent_connections;
      CREATE TABLE recent_connections (
        id TEXT PRIMARY KEY,
        host_id TEXT NOT NULL REFERENCES hosts(id) ON DELETE CASCADE,
        connected_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        version INTEGER NOT NULL DEFAULT 1
      );
      CREATE INDEX recent_connections_host ON recent_connections(host_id, connected_at DESC);
      DELETE FROM app_meta
        WHERE key IN ('migration:5', 'connection-history:revision');
      DELETE FROM app_settings WHERE section='privacy';
    `);
    const insert = legacy.prepare(
      `INSERT INTO recent_connections(
        id, host_id, connected_at, created_at, updated_at, version
      ) VALUES (?, ?, ?, ?, ?, ?)`,
    );
    insert.run(
      '00000000-0000-4000-8000-000000000010',
      host.id,
      '2026-09-10T00:00:00.000Z',
      '2026-09-10T00:00:00.000Z',
      '2026-09-10T00:00:00.000Z',
      1,
    );
    insert.run(
      '00000000-0000-4000-8000-000000000011',
      host.id,
      '2026-09-11T00:00:00.000Z',
      '2026-09-11T00:00:00.000Z',
      '2026-09-11T00:00:00.000Z',
      1,
    );
    legacy.close();

    database = await ProductDatabase.open(path);
    try {
      const page = new ConnectionHistoryRepository(database).list({ limit: 50 });
      expect(page.items).toEqual([
        expect.objectContaining({
          hostId: host.id,
          name: host.name,
          hostname: host.hostname,
          port: host.port,
          username: host.username,
          authType: host.authType,
          connectionOptions: host.connectionOptions,
          count: 2,
          lastConnectedAt: '2026-09-11T00:00:00.000Z',
        }),
      ]);
      expect(new ProductRepository(database).getSettings().privacy.connectionHistoryEnabled).toBe(
        true,
      );
      expect(database.get("SELECT value FROM app_meta WHERE key='migration:5'")).toBeDefined();
      const columns = database
        .all<{ name: string }>('PRAGMA table_info(recent_connections)')
        .map(({ name }) => name);
      expect(columns).not.toEqual(
        expect.arrayContaining(['credential_ref', 'passphrase_credential_ref', 'password']),
      );
      expect(JSON.stringify(page)).not.toMatch(/credential-marker|passphrase-marker/);
    } finally {
      database.close();
    }
  });

  it('collapses pre-identity rows and retains the latest safe snapshot', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'axterm-history-identity-migration-'));
    directories.push(directory);
    const path = join(directory, 'product.sqlite');
    let database = await ProductDatabase.open(path);
    const original = new ConnectionHistoryRepository(database).record({
      host: transientHost('SAME.example.'),
      persistedHostId: null,
    });
    database.close();

    const preIdentity = new DatabaseSync(path);
    preIdentity.exec(`
      DELETE FROM app_meta WHERE key='migration:6';
      UPDATE recent_connections
      SET target_key='legacy-original-key', connection_count=2,
          last_connected_at='2026-09-10T00:00:00.000Z',
          created_at='2026-09-09T00:00:00.000Z',
          updated_at='2026-09-10T00:00:00.000Z', version=2
      WHERE id='${original.id}';
      INSERT INTO recent_connections(
        id, target_key, host_id, name, hostname, port, username, auth_type, jump_host_id,
        connection_timeout_ms, keepalive_interval_ms, keepalive_count_max, compression,
        reconnect_mode, reconnect_delay_ms, reconnect_max_attempts, connection_count,
        last_connected_at, created_at, updated_at, version
      ) VALUES (
        '00000000-0000-4000-8000-000000000021', 'legacy-changed-options-key', NULL,
        'Latest snapshot', 'same.example', 22, 'operator', 'privateKey', NULL,
        12000, 5000, 4, 0, 'automatic', 750, 3, 3,
        '2026-09-11T00:00:00.000Z', '2026-09-10T12:00:00.000Z',
        '2026-09-11T00:00:00.000Z', 3
      );
    `);
    preIdentity.close();

    database = await ProductDatabase.open(path);
    try {
      const page = new ConnectionHistoryRepository(database).list({ limit: 50 });
      expect(page.items).toEqual([
        expect.objectContaining({
          id: '00000000-0000-4000-8000-000000000021',
          name: 'Latest snapshot',
          hostname: 'same.example',
          authType: 'privateKey',
          count: 5,
          createdAt: '2026-09-09T00:00:00.000Z',
          lastConnectedAt: '2026-09-11T00:00:00.000Z',
          connectionOptions: {
            connectionTimeoutMs: 12_000,
            keepaliveIntervalMs: 5_000,
            keepaliveCountMax: 4,
            compression: false,
            algorithms: { kex: [], cipher: [], serverHostKey: [], hmac: [] },
            reconnectPolicy: { mode: 'automatic', delayMs: 750, maxAttempts: 3 },
          },
        }),
      ]);
      expect(database.get("SELECT value FROM app_meta WHERE key='migration:6'")).toBeDefined();
    } finally {
      database.close();
    }
  });
});
