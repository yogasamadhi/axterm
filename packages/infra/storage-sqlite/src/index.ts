import type {} from '@axterm/plugin-api/host';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { withFileLock } from '@axterm/infra-atomic-write';
// Copyright (c) 2026 DeepSeek. SPDX-License-Identifier: MIT
// Adapted from packages/storage/storage-sqlite/src/index.ts at 8bd073392eef6f54e921a093b95076248eb08cbb.
/**
 * SQLite storage backend for the storage hub: one database file hosts every
 * routed unit, document-per-row (`key TEXT` / `value TEXT` JSON). Registers
 * as backend `sqlite`; the disposer unregisters first, then closes the medium.
 * @module @axterm/infra-storage-sqlite
 */

import type { Context } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
import type { DatabaseSync } from 'node:sqlite';
import { StorageError, UNIT_NAME_RE, storageBackendServiceKey } from '@axterm/infra-storage';
import type { KvFacet, KvUnit, KvUnitDescriptor, StorageBackend } from '@axterm/infra-storage';
import { openDatabase, recordTableName, type JournalMode } from './schema.ts';
import { SqliteKvUnit } from './unit.ts';

export { STORAGE_SQLITE_SCHEMA_VERSION, type JournalMode } from './schema.ts';

/** Cordis plugin name. */
export const name = 'storage-sqlite';
/** The backend registers on the storage hub. */
export const inject = ['storage'];

/** Plugin configuration. */
export interface Config {
  /**
   * Filesystem path to the SQLite database file. The special value `:memory:`
   * opens an in-process database (tests). On filesystems with POSIX modes,
   * missing directories and databases are created owner-only; existing path
   * modes are preserved. Filesystem setup errors other than an existing
   * database fail the open. The backend does not protect confidentiality or
   * integrity when another principal can replace the database entry in its
   * parent directory.
   */
  path: string;
  /**
   * SQLite `journal_mode` pragma. `wal` (the default) suits local disks; pick
   * a rollback-journal mode (`delete`/`truncate`/`persist`) on filesystems
   * where WAL's shared-memory files do not work (network mounts). See
   * {@link JournalMode}.
   */
  journalMode?: JournalMode;
}

/** Schemastery validator for {@link Config}. */
export const Config: z<Config> = z.object({
  path: z.string().required(),
  journalMode: z.union(['wal', 'delete', 'truncate', 'persist'] as const).default('wal'),
});

/**
 * The SQLite {@link StorageBackend}. Owns one `DatabaseSync` connection and
 * the open-unit table; `kv.open` validates names, enforces the per-unit
 * version stamp in `units`, and ensures the unit's record tables. A failed
 * rollback makes all reads, writes, and opens reject the retained failure;
 * close the backend and recreate it before further use.
 */
export class SqliteStorageBackend implements StorageBackend {
  /** The key-value facet; the only shape this backend serves. */
  readonly kv: KvFacet = { open: (descriptor) => this.openUnit(descriptor) };

  private readonly ready: Promise<DatabaseSync>;
  /** Open (or still-opening) units by name; presence is the double-open guard. */
  private readonly units = new Map<string, Promise<SqliteKvUnit>>();
  private closing: Promise<void> | undefined;
  private failure: StorageError | undefined;

  /**
   * @param config - Validated plugin configuration.
   */
  constructor(private readonly config: Config) {
    this.ready = openDatabase(config.path, (config as Required<Config>).journalMode);
    // Mark the rejection handled: every primitive re-awaits `ready`, so an
    // open failure still surfaces to each caller; this guard only prevents an
    // unhandled-rejection crash when the failure precedes the first use.
    this.ready.catch(() => {});
  }

  async initialize(): Promise<void> {
    await this.ready;
    this.ensureUsable();
  }

  private openUnit(descriptor: KvUnitDescriptor): Promise<KvUnit> {
    if (this.closing !== undefined) {
      return Promise.reject(new StorageError('closed', 'sqlite storage backend is closed'));
    }
    if (this.failure !== undefined) return Promise.reject(this.failure);
    if (!UNIT_NAME_RE.test(descriptor.name)) {
      return Promise.reject(
        new Error(`kv unit name '${descriptor.name}' violates ${UNIT_NAME_RE}`),
      );
    }
    for (const table of descriptor.tables) {
      if (!UNIT_NAME_RE.test(table)) {
        return Promise.reject(
          new Error(
            `kv table name '${table}' in unit '${descriptor.name}' violates ${UNIT_NAME_RE}`,
          ),
        );
      }
    }
    if (this.units.has(descriptor.name)) {
      return Promise.reject(
        new Error(`kv unit '${descriptor.name}' is already open (double-open is a caller bug)`),
      );
    }
    // Reserve the name synchronously so a concurrent second open of the same
    // name rejects instead of racing past the guard during the awaits below.
    const pending = this.materializeUnit(descriptor);
    this.units.set(descriptor.name, pending);
    pending.catch(() => this.units.delete(descriptor.name));
    return pending;
  }

  private async materializeUnit(descriptor: KvUnitDescriptor): Promise<SqliteKvUnit> {
    const db = await this.ready;
    const releaseLease = await this.acquireUnitLease(descriptor.name);
    try {
      this.ensureUsable();
      const row = db
        .prepare('SELECT version, owner FROM units WHERE name = ?')
        .get(descriptor.name) as { version: number; owner: string } | undefined;
      if (row === undefined) {
        db.prepare('INSERT INTO units (name, version, owner) VALUES (?, ?, ?)').run(
          descriptor.name,
          descriptor.version,
          descriptor.owner,
        );
      } else if (row.owner !== descriptor.owner) {
        throw new StorageError(
          'ownership-conflict',
          `Unit '${descriptor.name}' belongs to a different package`,
        );
      } else if (
        row.version !== descriptor.version &&
        !descriptor.compatibleVersions?.includes(row.version)
      ) {
        throw new StorageError(
          'version-mismatch',
          `kv unit '${descriptor.name}' is stamped version ${row.version} on the medium, incompatible with descriptor version ${descriptor.version}`,
        );
      }
      for (const table of descriptor.tables) {
        // Both segments passed UNIT_NAME_RE, so the identifier is safe in DDL.
        db.exec(`
        CREATE TABLE IF NOT EXISTS "${recordTableName(descriptor.name, table)}" (
          key   TEXT PRIMARY KEY,
          value TEXT NOT NULL
        ) STRICT
      `);
      }
      return new SqliteKvUnit(
        db,
        descriptor,
        row?.version ?? descriptor.version,
        async () => {
          this.units.delete(descriptor.name);
          await releaseLease();
        },
        () => {
          this.ensureUsable();
        },
        (error) => {
          this.failure = error;
        },
      );
    } catch (error) {
      await releaseLease();
      throw error;
    }
  }

  /** Cached domain projections require one live owner per unit across processes. */
  private async acquireUnitLease(name: string): Promise<() => Promise<void>> {
    if (this.config.path === ':memory:') return async () => {};
    const path = resolve(this.config.path);
    const identity = createHash('sha256')
      .update(path + '\0' + name)
      .digest('hex');
    const acquired = Promise.withResolvers<void>();
    const released = Promise.withResolvers<void>();
    const holding = withFileLock(
      join(dirname(path), `.record-${identity}`),
      async () => {
        acquired.resolve();
        await released.promise;
      },
      { waitMs: 0 },
    );
    void holding.catch(acquired.reject);
    try {
      await acquired.promise;
    } catch {
      await holding.catch(() => {});
      throw new StorageError('unit-in-use', 'Record unit is already owned by another Profile');
    }
    return async () => {
      released.resolve();
      await holding;
    };
  }

  private ensureUsable(): void {
    if (this.closing !== undefined) throw new StorageError('closed', 'SQLite backend is closing');
    if (this.failure !== undefined) throw this.failure;
  }

  /**
   * Close every open unit and release the database. Idempotent; concurrent
   * and repeated calls resolve once teardown finishes.
   * @returns resolution after the medium is released.
   */
  close(): Promise<void> {
    this.closing ??= this.doClose();
    return this.closing;
  }

  private async doClose(): Promise<void> {
    let db: DatabaseSync;
    try {
      db = await this.ready;
    } catch {
      // The medium never opened; that failure already rejected the opener and
      // every unit call, so there is nothing left to release here.
      return;
    }
    for (const pending of [...this.units.values()]) {
      const unit = await pending.catch(() => undefined);
      await unit?.close();
    }
    db.close();
  }
}

/**
 * Register the SQLite backend as `sqlite` on the storage hub. The disposer
 * unregisters the name first, then closes the backend.
 * @param ctx - Plugin context (must inject `storage`).
 * @param config - Validated plugin configuration.
 */
export async function apply(ctx: Context, config: Config): Promise<void> {
  const backend = new SqliteStorageBackend(config);
  ctx.effect(() => () => backend.close(), 'storage-sqlite.close');
  await backend.initialize();
  ctx.storage.backend.register('sqlite', backend);
  ctx.provide(storageBackendServiceKey('sqlite'), backend);
}
