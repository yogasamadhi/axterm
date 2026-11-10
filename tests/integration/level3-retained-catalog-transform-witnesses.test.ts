import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { productDomains } from '@axterm/data-schema';
import { type CreateHostInput, sshConnectionOptionsSchema } from '@axterm/plugin-api/catalog';
import { Generation2Database } from '../fixtures/migration/generation2-database.ts';
import { applyHistoricalSql } from '../fixtures/migration/historical-sql.ts';
import { catalogStorage, readMigrationMarker } from '../fixtures/level3-catalog-storage.ts';
import { BookmarkRepository } from '../../packages/plugins/catalog/src/adapters/bookmark-repository.ts';
import { ConnectionHistoryRepository } from '../../packages/plugins/catalog/src/adapters/connection-history-repository.ts';
import { SettingsRepository } from '../../packages/plugins/configuration/src/adapters/settings-repository.ts';
const directories: string[] = [];
afterEach(async () => {
  for (const path of directories.splice(0)) await rm(path, { recursive: true, force: true });
});
/** Fresh historical input only: literal rows, never an application repository or an upgrade path. */
function historicalRows(writer: Generation2Database) {
  const now = '2026-09-01T00:00:00.000Z';
  return {
    seedGroup(input: { name: string; sortOrder: number }) {
      const id = randomUUID();
      writer.run(
        'INSERT INTO host_groups(id,name,sort_order,created_at,updated_at) VALUES (?,?,?,?,?)',
        id,
        input.name,
        input.sortOrder,
        now,
        now,
      );
      return { id, ...input };
    },
    seedHost(input: CreateHostInput) {
      const id = randomUUID(),
        options = sshConnectionOptionsSchema.parse(input.connectionOptions);
      writer.run(
        `INSERT INTO hosts(id,group_id,name,hostname,port,username,auth_type,credential_ref,passphrase_credential_ref,favorite,created_at,updated_at,
        connection_timeout_ms,keepalive_interval_ms,keepalive_count_max,compression,reconnect_mode,reconnect_delay_ms,reconnect_max_attempts)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        id,
        input.groupId ?? null,
        input.name,
        input.hostname,
        input.port ?? 22,
        input.username,
        input.authType ?? 'password',
        input.credentialRef ?? null,
        input.passphraseCredentialRef ?? null,
        input.favorite ? 1 : 0,
        now,
        now,
        options.connectionTimeoutMs,
        options.keepaliveIntervalMs,
        options.keepaliveCountMax,
        options.compression ? 1 : 0,
        options.reconnectPolicy.mode,
        options.reconnectPolicy.delayMs,
        options.reconnectPolicy.maxAttempts,
      );
      return { ...input, id, connectionOptions: options };
    },
  };
}
function columns(path: string, table: 'bookmarks' | 'recent_connections') {
  const reader = new DatabaseSync(path, { readOnly: true });
  try {
    return reader.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  } finally {
    reader.close();
  }
}
describe('Bookmark database migration', () => {
  it('creates one SSH bookmark per legacy Host without copying connection or credential facts', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'axterm-bookmark-migration-'));
    directories.push(directory);
    const path = join(directory, 'product.sqlite');

    const writer = await Generation2Database.open(path);
    const rows = historicalRows(writer);
    const production = rows.seedGroup({ name: 'Production', sortOrder: 2 });
    const staging = rows.seedGroup({ name: 'Staging', sortOrder: 2 });
    const favorite = rows.seedHost({
      groupId: production.id,
      name: 'favorite-host',
      hostname: 'favorite.internal.example',
      port: 2201,
      username: 'favorite-user',
      authType: 'privateKey',
      credentialRef: 'cred_private_key_marker',
      passphraseCredentialRef: 'cred_passphrase_marker',
      jumpHostId: null,
      favorite: true,
    });
    const ordinary = rows.seedHost({
      groupId: production.id,
      name: 'ordinary-host',
      hostname: 'ordinary.internal.example',
      port: 2202,
      username: 'ordinary-user',
      authType: 'password',
      credentialRef: 'cred_password_marker',
      passphraseCredentialRef: null,
      jumpHostId: null,
      favorite: false,
    });
    const ungrouped = rows.seedHost({
      groupId: null,
      name: 'ungrouped-host',
      hostname: 'ungrouped.internal.example',
      port: 22,
      username: 'ungrouped-user',
      authType: 'agent',
      credentialRef: null,
      passphraseCredentialRef: null,
      jumpHostId: null,
      favorite: false,
    });
    writer.close();

    // Recreate the exact pre-ADR-005 state while retaining the already verified
    // checksums for migrations 1 and 2, then let ProductDatabase apply migration 3.
    const legacy = new DatabaseSync(path);
    legacy.exec('PRAGMA foreign_keys=ON; DROP TABLE bookmarks; DROP TABLE bookmark_groups;');
    legacy
      .prepare("DELETE FROM app_meta WHERE key IN ('migration:3', 'bookmark-tree:revision')")
      .run();
    applyHistoricalSql(legacy, 3);
    legacy.close();

    const database = await catalogStorage(path);
    try {
      const snapshot = new BookmarkRepository(database.sql).snapshot();
      expect(snapshot.revision).toBe(1);
      expect(snapshot.groups).toEqual([
        expect.objectContaining({
          id: production.id,
          parentId: null,
          name: production.name,
          position: 0,
        }),
        expect.objectContaining({
          id: staging.id,
          parentId: null,
          name: staging.name,
          position: 1,
        }),
      ]);
      expect(snapshot.bookmarks).toEqual([
        expect.objectContaining({
          id: ungrouped.id,
          groupId: null,
          protocol: 'ssh',
          hostId: ungrouped.id,
          title: ungrouped.name,
          position: 2,
        }),
        expect.objectContaining({
          id: favorite.id,
          groupId: production.id,
          protocol: 'ssh',
          hostId: favorite.id,
          title: favorite.name,
          position: 0,
        }),
        expect.objectContaining({
          id: ordinary.id,
          groupId: production.id,
          protocol: 'ssh',
          hostId: ordinary.id,
          title: ordinary.name,
          position: 1,
        }),
      ]);
      const nodesByParent = new Map<string, number[]>();
      for (const group of snapshot.groups) {
        const key = group.parentId ?? 'root';
        nodesByParent.set(key, [...(nodesByParent.get(key) ?? []), group.position]);
      }
      for (const bookmark of snapshot.bookmarks) {
        const key = bookmark.groupId ?? 'root';
        nodesByParent.set(key, [...(nodesByParent.get(key) ?? []), bookmark.position]);
      }
      for (const positions of nodesByParent.values())
        expect(positions.sort((left, right) => left - right)).toEqual(
          Array.from({ length: positions.length }, (_, index) => index),
        );
      const bookmarkColumns = columns(path, 'bookmarks').map((column) => column.name);
      expect(bookmarkColumns).not.toEqual(
        expect.arrayContaining([
          'hostname',
          'port',
          'username',
          'auth_type',
          'credential_ref',
          'passphrase_credential_ref',
          'password',
          'private_key',
        ]),
      );
      expect(JSON.stringify(snapshot)).not.toContain('cred_private_key_marker');
      expect(snapshot.bookmarks.find((item) => item.id === favorite.id)?.connectionDisplay).toBe(
        'favorite-user@favorite.internal.example:2201',
      );
    } finally {
      await database.close();
    }
  });
});

describe('Connection history migration', () => {
  it('aggregates legacy rows into the bounded safe target schema without credential data', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'axterm-history-migration-'));
    directories.push(directory);
    const path = join(directory, 'product.sqlite');
    const writer = await Generation2Database.open(path);
    const host = historicalRows(writer).seedHost({
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
    writer.close();

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
    applyHistoricalSql(legacy, 5);
    legacy.close();

    const database = await catalogStorage(path);
    try {
      const page = new ConnectionHistoryRepository(database.sql).list({ limit: 50 });
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
      expect(
        new SettingsRepository(await database.open(productDomains.configuration)).getSettings()
          .privacy.connectionHistoryEnabled,
      ).toBe(true);
      expect(await readMigrationMarker(path, 5)).toBeDefined();
      const historyColumns = columns(path, 'recent_connections').map(({ name }) => name);
      expect(historyColumns).not.toEqual(
        expect.arrayContaining(['credential_ref', 'passphrase_credential_ref', 'password']),
      );
      expect(JSON.stringify(page)).not.toMatch(/credential-marker|passphrase-marker/);
    } finally {
      await database.close();
    }
  });

  it('collapses pre-identity rows and retains the latest safe snapshot', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'axterm-history-identity-migration-'));
    directories.push(directory);
    const path = join(directory, 'product.sqlite');
    const writer = await Generation2Database.open(path);
    const original = { id: '00000000-0000-4000-8000-000000000020' };
    writer.run(
      `INSERT INTO recent_connections(
      id,target_key,host_id,name,hostname,port,username,auth_type,jump_host_id,
      connection_timeout_ms,keepalive_interval_ms,keepalive_count_max,compression,
      reconnect_mode,reconnect_delay_ms,reconnect_max_attempts,connection_count,
      last_connected_at,created_at,updated_at,version
    ) VALUES (?, 'initial-key', NULL, 'Original snapshot', 'SAME.example.', 22, 'operator', 'agent', NULL,
      50000, 10000, 10, 1, 'manual', 3000, 10, 1,
      '2026-09-10', '2026-09-10', '2026-09-10', 1)`,
      original.id,
    );
    writer.close();

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
    applyHistoricalSql(preIdentity, 6);
    preIdentity.close();

    const database = await catalogStorage(path);
    try {
      const page = new ConnectionHistoryRepository(database.sql).list({ limit: 50 });
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
      expect(await readMigrationMarker(path, 6)).toBeDefined();
    } finally {
      await database.close();
    }
  });
});
