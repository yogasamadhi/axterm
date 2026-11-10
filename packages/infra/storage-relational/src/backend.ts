import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import { lstat, mkdir, open } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { DatabaseSync, constants, backup, type StatementSync } from 'node:sqlite';
import { withFileLock } from '@axterm/infra-atomic-write';
import { StorageError, defineDomain, isRemoteJsonValue } from '@axterm/plugin-api';
import type {
  StorageBackend,
  RelationalFacet,
  RelationalDomain,
  RelationalDomainSpec,
  RelationalParticipant,
  StorageOutboxEvent,
  SqlValue,
} from '@axterm/plugin-api';
import type {
  StorageBootstrapPlan,
  StorageBootstrapMigration,
  StorageMigrationConnection,
} from '@axterm/plugin-api/host';

interface State {
  readonly spec: RelationalDomainSpec;
  readonly token: RelationalParticipant;
  closed: boolean;
  readonly subscriptions: Set<() => void>;
}
type Access = 'system' | { readonly state: State; readonly migration: boolean } | undefined;
const META = `
CREATE TABLE IF NOT EXISTS axterm_storage_format (version INTEGER PRIMARY KEY);
CREATE TABLE IF NOT EXISTS axterm_storage_domains (name TEXT PRIMARY KEY, owner TEXT NOT NULL, version INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS axterm_storage_owners (name TEXT PRIMARY KEY, domain TEXT NOT NULL, owner TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS axterm_storage_migrations (domain TEXT NOT NULL, version INTEGER NOT NULL, checksum TEXT NOT NULL, PRIMARY KEY(domain,version));
CREATE TABLE IF NOT EXISTS axterm_storage_outbox (id INTEGER PRIMARY KEY AUTOINCREMENT, domain TEXT NOT NULL, type TEXT NOT NULL, payload TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS axterm_storage_outbox_domain_cursor ON axterm_storage_outbox(domain,id DESC);
CREATE TABLE IF NOT EXISTS axterm_storage_outbox_bounds (domain TEXT PRIMARY KEY, discarded_cursor INTEGER NOT NULL);
INSERT OR IGNORE INTO axterm_storage_format VALUES (1);
`;
const MAX_ROWS = 100_000;
const MAX_DOMAIN_EVENTS = 10_000;

function privateOwner(info: Awaited<ReturnType<typeof lstat>>): boolean {
  return (
    process.platform === 'win32' ||
    ((Number(info.mode) & 0o077) === 0 &&
      (typeof process.getuid !== 'function' || Number(info.uid) === process.getuid()))
  );
}
const privateMediumError = () =>
  new StorageError('malformed-medium', 'Relational medium must be private and have one owner');
async function assertPrivateParent(path: string): Promise<void> {
  const parent = await lstat(dirname(path));
  if (!parent.isDirectory() || parent.isSymbolicLink() || !privateOwner(parent))
    throw privateMediumError();
}
/** Reject aliases and non-private existing media before SQLite can touch any bytes. */
async function assertPrivateMedium(path: string): Promise<void> {
  await assertPrivateParent(path);
  for (const file of [path, path + '-wal', path + '-shm']) {
    const info = await lstat(file).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT' && file !== path) return undefined;
      throw error;
    });
    if (
      info &&
      (!info.isFile() || info.isSymbolicLink() || Number(info.nlink) !== 1 || !privateOwner(info))
    )
      throw privateMediumError();
  }
}

/** Native relational facet: owned statements, synchronous transactions and a durable outbox. */
export class RelationalStorageBackend implements StorageBackend {
  readonly sql: RelationalFacet;
  private db: DatabaseSync | undefined;
  private access: Access;
  private readonly states = new Map<string, State>();
  private readonly participants = new WeakMap<RelationalParticipant, State>();
  private readonly expectedOwners = new Map<string, { domain: string; owner: string }>();
  private readonly listeners = new Set<{
    listener: (events: readonly StorageOutboxEvent[]) => void;
  }>();
  private readonly transactionLeases = new AsyncLocalStorage<{ active: boolean }>();
  private depth = 0;
  private admitted: ReadonlySet<State> | undefined;
  private notifications: StorageOutboxEvent[] = [];
  private closing = false;
  private ready: Promise<void>;
  private readonly openings = new Set<Promise<RelationalDomain>>();

  constructor(
    private readonly path: string,
    private readonly bootstrap?: StorageBootstrapPlan,
  ) {
    this.sql = {
      open: (spec) => {
        if (this.closing)
          return Promise.reject(new StorageError('closed', 'Relational backend is not available'));
        const task = this.openDomain(spec);
        this.openings.add(task);
        const settled = () => {
          this.openings.delete(task);
        };
        void task.then(settled, settled);
        return task;
      },
      transaction: (participants, operation) => this.transaction(participants, operation),
      events: (after, limit = 1000) =>
        this.system(() => {
          if (
            !Number.isSafeInteger(after) ||
            after < 0 ||
            !Number.isSafeInteger(limit) ||
            limit < 1 ||
            limit > 10_000
          )
            throw new RangeError('Invalid outbox range');
          return this.connection()
            .prepare(
              'SELECT id AS cursor, domain, type, payload FROM axterm_storage_outbox WHERE id > ? ORDER BY id LIMIT ?',
            )
            .all(after, limit)
            .map((row) => ({
              ...row,
              payload: JSON.parse(String(row.payload)),
            })) as unknown as StorageOutboxEvent[];
        }),
      subscribe: (listener) => {
        this.connection();
        const entry = { listener };
        this.listeners.add(entry);
        return () => {
          this.listeners.delete(entry);
        };
      },
    };
    if (bootstrap) {
      if (bootstrap.generation !== 2)
        throw new StorageError('malformed-medium', 'Unsupported bootstrap generation');
      let previous = 0;
      for (const migration of bootstrap.migrations) {
        if (
          !Number.isSafeInteger(migration.id) ||
          migration.id <= previous ||
          typeof migration.sql !== 'string'
        )
          throw new StorageError('malformed-medium', 'Invalid bootstrap migration order');
        previous = migration.id;
      }
      for (const owner of bootstrap.tables) {
        if (this.expectedOwners.has(owner.table))
          throw new StorageError('ownership-conflict', 'Duplicate bootstrap table ownership');
        this.expectedOwners.set(owner.table, owner);
      }
    }
    this.ready = this.initializeDatabase();
    void this.ready.catch(() => {});
  }
  initialize(): Promise<void> {
    return this.ready;
  }
  private connection(): DatabaseSync {
    if (this.closing || !this.db)
      throw new StorageError('closed', 'Relational backend is not available');
    return this.db;
  }
  private system<T>(operation: () => T): T {
    const previous = this.access;
    this.access = 'system';
    try {
      return operation();
    } finally {
      this.access = previous;
    }
  }
  private inDomain<T>(state: State, operation: () => T, migration = false): T {
    this.connection();
    if (this.transactionLeases.getStore()?.active === false)
      throw new StorageError('closed', 'Transaction scope has ended');
    if (!migration) {
      const version = this.system(
        () =>
          this.connection()
            .prepare('SELECT version FROM axterm_storage_domains WHERE name=?')
            .get(state.spec.name)?.version,
      );
      if (version !== state.spec.version)
        throw new StorageError('version-mismatch', 'Domain schema changed; reopen the domain');
    }
    if (state.closed) throw new StorageError('closed', 'Relational domain is closed');
    if (this.admitted && !this.admitted.has(state))
      throw new StorageError('ownership-conflict', 'Domain is not admitted to this transaction');
    const previous = this.access;
    this.access = { state, migration };
    try {
      return operation();
    } finally {
      this.access = previous;
    }
  }
  private authorize(
    action: number,
    table: string | null,
    secondary: string | null,
    database: string | null,
  ): number {
    if (!this.access) return constants.SQLITE_DENY;
    if (
      action === constants.SQLITE_FUNCTION &&
      ['load_extension', 'readfile', 'writefile'].includes(secondary ?? '')
    )
      return constants.SQLITE_DENY;
    if (this.access === 'system') return constants.SQLITE_OK;
    const { state, migration } = this.access;
    const owned = (name: string | null) => name !== null && state.spec.tables.includes(name);
    if (database && database !== 'main') return constants.SQLITE_DENY;
    if (
      [constants.SQLITE_SELECT, constants.SQLITE_FUNCTION, constants.SQLITE_RECURSIVE].includes(
        action,
      )
    )
      return constants.SQLITE_OK;
    if (
      [
        constants.SQLITE_READ,
        constants.SQLITE_INSERT,
        constants.SQLITE_UPDATE,
        constants.SQLITE_DELETE,
      ].includes(action)
    ) {
      return owned(table) || (migration && table === 'sqlite_master')
        ? constants.SQLITE_OK
        : constants.SQLITE_DENY;
    }
    if (!migration) return constants.SQLITE_DENY;
    if ([constants.SQLITE_CREATE_TABLE, constants.SQLITE_DROP_TABLE].includes(action))
      return owned(table) ? constants.SQLITE_OK : constants.SQLITE_DENY;
    if (
      [
        constants.SQLITE_CREATE_INDEX,
        constants.SQLITE_DROP_INDEX,
        constants.SQLITE_CREATE_TRIGGER,
        constants.SQLITE_DROP_TRIGGER,
      ].includes(action)
    )
      return owned(secondary) ? constants.SQLITE_OK : constants.SQLITE_DENY;
    if (action === constants.SQLITE_ALTER_TABLE)
      return owned(secondary) ? constants.SQLITE_OK : constants.SQLITE_DENY;
    return constants.SQLITE_DENY;
  }
  private async initializeDatabase(): Promise<void> {
    const path = this.path === ':memory:' ? this.path : resolve(this.path);
    if (path !== ':memory:') {
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      await assertPrivateParent(path);
      try {
        const handle = await open(path, 'wx', 0o600);
        await handle.close();
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
    }
    const initialize = async () => {
      if (path !== ':memory:') await assertPrivateMedium(path);
      const db = new DatabaseSync(path);
      try {
        const tables = new Set(
          (
            db
              .prepare(
                "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
              )
              .all() as { name: string }[]
          ).map((row) => row.name),
        );
        if (tables.size && !tables.has('axterm_storage_format')) {
          if (
            !this.bootstrap ||
            !tables.has('app_meta') ||
            db.prepare("SELECT value FROM app_meta WHERE key='axterm:schema-generation'").get()
              ?.value !== '2'
          )
            throw new StorageError('malformed-medium', 'Unrecognized relational database identity');
        }
        if (
          tables.has('axterm_storage_format') &&
          db.prepare('SELECT version FROM axterm_storage_format').get()?.version !== 1
        )
          throw new StorageError('version-mismatch', 'Unsupported relational storage format');
        if (tables.size && db.prepare('PRAGMA quick_check').get()?.quick_check !== 'ok')
          throw new StorageError('malformed-medium', 'Database integrity check failed');
        db.exec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;');
        if (this.bootstrap) await this.applyBootstrap(db, path);
        db.exec('BEGIN IMMEDIATE');
        try {
          db.exec(META);
          for (const [table, owner] of this.expectedOwners) {
            const previous = db
              .prepare('SELECT domain,owner FROM axterm_storage_owners WHERE name=?')
              .get(table);
            if (previous && (previous.domain !== owner.domain || previous.owner !== owner.owner))
              throw new StorageError('ownership-conflict', 'Bootstrap table ownership changed');
            db.prepare('INSERT OR IGNORE INTO axterm_storage_owners VALUES (?,?,?)').run(
              table,
              owner.domain,
              owner.owner,
            );
          }
          db.exec('COMMIT');
        } catch (error) {
          db.exec('ROLLBACK');
          throw error;
        }
        db.setAuthorizer((action, table, secondary, database) =>
          this.authorize(action, table, secondary, database),
        );
        this.db = db;
      } catch (error) {
        db.close();
        throw error;
      }
    };
    if (path === ':memory:') await initialize();
    else await withFileLock(path + '.schema', initialize, { waitMs: 30_000 });
  }
  private async applyBootstrap(db: DatabaseSync, path: string): Promise<void> {
    const existing = new Set(
      (
        db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]
      ).map((row) => row.name),
    );
    const applied = new Map<number, string>();
    if (existing.has('app_meta'))
      for (const row of db
        .prepare("SELECT key,value FROM app_meta WHERE key LIKE 'migration:%'")
        .all())
        applied.set(Number(String(row.key).slice(10)), String(row.value));
    const declared = new Map(
      this.bootstrap!.migrations.map((migration) => [migration.id, migration]),
    );
    const highest = Math.max(0, ...applied.keys());
    for (const [id, checksum] of applied) {
      const migration = declared.get(id);
      if (!migration || createHash('sha256').update(migration.sql).digest('hex') !== checksum)
        throw new StorageError(
          'version-mismatch',
          'Applied product migration differs from the registered immutable ledger',
        );
    }
    if (
      this.bootstrap!.migrations.some(
        (migration) => migration.id <= highest && !applied.has(migration.id),
      )
    )
      throw new StorageError('version-mismatch', 'Applied product migration ledger is incomplete');
    for (const migration of this.bootstrap!.migrations) {
      const checksum = createHash('sha256').update(migration.sql).digest('hex');
      const previous = applied.get(migration.id);
      if (previous && previous !== checksum)
        throw new StorageError(
          'version-mismatch',
          `Committed migration ${migration.id} checksum mismatch`,
        );
      if (previous) continue;
      if (migration.risky && path !== ':memory:' && existing.has('app_meta'))
        await backup(db, `${path}.pre-migration-${migration.id}-${Date.now()}.bak`);
      db.exec('BEGIN IMMEDIATE');
      try {
        if (migration.apply) this.applyMigration(db, migration);
        else db.exec(migration.sql);
        db.prepare('INSERT INTO app_meta(key,value) VALUES (?,?)').run(
          `migration:${migration.id}`,
          checksum,
        );
        db.exec('COMMIT');
        applied.set(migration.id, checksum);
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    }
  }
  private applyMigration(db: DatabaseSync, migration: StorageBootstrapMigration): void {
    let active = true;
    const statements = new Set<{ value: StatementSync | undefined }>();
    const assertActive = () => {
      if (!active) throw new StorageError('closed', 'Migration scope has ended');
    };
    const port: StorageMigrationConnection = {
      exec: (sql) => {
        assertActive();
        db.exec(sql);
      },
      prepare: (sql) => {
        assertActive();
        const slot = { value: db.prepare(sql) as StatementSync | undefined };
        statements.add(slot);
        const statement = () => {
          assertActive();
          return slot.value!;
        };
        return {
          all: (...parameters) => statement().all(...parameters),
          get: (...parameters) => statement().get(...parameters),
          run: (...parameters) => statement().run(...parameters),
        };
      },
    };
    try {
      const result: unknown = migration.apply!(port);
      if (
        result &&
        (typeof result === 'object' || typeof result === 'function') &&
        'then' in result
      ) {
        void Promise.resolve(result).catch(() => {});
        throw new TypeError('Migrations require a synchronous callback');
      }
    } finally {
      active = false;
      for (const slot of statements) slot.value = undefined;
      statements.clear();
    }
  }

  private async openDomain(input: RelationalDomainSpec): Promise<RelationalDomain> {
    const declaration = defineDomain(input);
    await this.ready;
    if (this.depth || this.transactionLeases.getStore()?.active === false)
      throw new TypeError('Cannot open domains inside a transaction scope');
    const materialize = async () => {
      const previous = this.system(() =>
        this.connection()
          .prepare('SELECT version FROM axterm_storage_domains WHERE name=?')
          .get(declaration.name),
      );
      if (previous && Number(previous.version) < declaration.version && this.path !== ':memory:')
        await backup(
          this.connection(),
          `${resolve(this.path)}.pre-domain-${declaration.name}-${Date.now()}.bak`,
        );
      return this.materializeDomain(declaration);
    };
    return this.path === ':memory:'
      ? materialize()
      : withFileLock(resolve(this.path) + '.schema', materialize, { waitMs: 30_000 });
  }
  private materializeDomain(declaration: RelationalDomainSpec): RelationalDomain {
    const db = this.connection();
    if (this.states.has(declaration.name))
      throw new StorageError('ownership-conflict', 'Relational domain is already open');
    const spec = Object.freeze({
      ...declaration,
      tables: Object.freeze([...declaration.tables]),
      migrations: Object.freeze(
        declaration.migrations.map((migration) => Object.freeze({ ...migration })),
      ),
    });
    if (
      spec.tables.some(
        (table) => table.startsWith('axterm_storage_') || table.startsWith('sqlite_'),
      )
    )
      throw new StorageError('ownership-conflict', 'Reserved storage table');
    const state: State = {
      spec,
      token: {} as RelationalParticipant,
      closed: false,
      subscriptions: new Set(),
    };
    const subscriptions = state.subscriptions;
    this.system(() => {
      db.exec('BEGIN IMMEDIATE');
      try {
        const row = db
          .prepare('SELECT owner,version FROM axterm_storage_domains WHERE name=?')
          .get(spec.name);
        if (row && row.owner !== spec.owner)
          throw new StorageError('ownership-conflict', 'Domain belongs to another package');
        if (row && Number(row.version) > spec.version)
          throw new StorageError('version-mismatch', 'Domain downgrade is unsupported');
        const saved = new Map(
          db
            .prepare('SELECT version,checksum FROM axterm_storage_migrations WHERE domain=?')
            .all(spec.name)
            .map((row) => [Number(row.version), String(row.checksum)]),
        );
        for (const [version, checksum] of saved)
          if (
            !spec.migrations.some(
              (migration) =>
                migration.version === version &&
                createHash('sha256').update(migration.sql).digest('hex') === checksum,
            )
          )
            throw new StorageError(
              'version-mismatch',
              'Committed domain migration changed or disappeared',
            );
        for (const table of spec.tables) {
          const owner =
            db.prepare('SELECT domain,owner FROM axterm_storage_owners WHERE name=?').get(table) ??
            this.expectedOwners.get(table);
          if (owner && (owner.domain !== spec.name || owner.owner !== spec.owner))
            throw new StorageError('ownership-conflict', 'Table belongs to another domain');
          if (
            !owner &&
            db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)
          )
            throw new StorageError(
              'ownership-conflict',
              'Existing table has no matching ownership declaration',
            );
          db.prepare('INSERT OR IGNORE INTO axterm_storage_owners VALUES (?,?,?)').run(
            table,
            spec.name,
            spec.owner,
          );
        }
        for (const migration of spec.migrations)
          if (!saved.has(migration.version)) {
            this.inDomain(state, () => db.exec(migration.sql), true);
            db.prepare('INSERT INTO axterm_storage_migrations VALUES (?,?,?)').run(
              spec.name,
              migration.version,
              createHash('sha256').update(migration.sql).digest('hex'),
            );
          }
        for (const table of spec.tables)
          if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table))
            throw new StorageError('malformed-medium', 'Declared relational table is missing');
        db.prepare(
          'INSERT INTO axterm_storage_domains VALUES (?,?,?) ON CONFLICT(name) DO UPDATE SET version=excluded.version',
        ).run(spec.name, spec.owner, spec.version);
        db.exec('COMMIT');
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    });
    this.states.set(spec.name, state);
    this.participants.set(state.token, state);
    const statement = (
      sql: string,
      _parameters: SqlValue[],
      read: (statement: StatementSync) => unknown,
    ) => this.inDomain(state, () => read(db.prepare(sql)));
    return {
      name: spec.name,
      participant: state.token,
      all: <T extends object>(sql: string, ...parameters: SqlValue[]): T[] =>
        statement(sql, parameters, (prepared) => {
          const rows: object[] = [];
          for (const row of prepared.iterate(...parameters)) {
            if (rows.length >= MAX_ROWS)
              throw new RangeError('Relational query requires pagination');
            rows.push(row);
          }
          return rows;
        }) as T[],
      get: <T extends object>(sql: string, ...parameters: SqlValue[]) =>
        statement(sql, parameters, (prepared) => prepared.get(...parameters)) as T | undefined,
      run: (sql, ...parameters) =>
        statement(sql, parameters, (prepared) => prepared.run(...parameters)) as ReturnType<
          StatementSync['run']
        >,
      transaction: (operation) => this.transaction([state.token], operation),
      appendEvent: (type, payload) => this.appendEvent(state, type, payload),
      cursor: () =>
        this.inDomain(state, () =>
          this.system(() =>
            Number(
              db
                .prepare(
                  'SELECT COALESCE(MAX(id),0) AS cursor FROM axterm_storage_outbox WHERE domain=?',
                )
                .get(spec.name)!.cursor,
            ),
          ),
        ),
      events: (after, limit = 1000) =>
        this.inDomain(state, () =>
          this.system(() => {
            if (
              !Number.isSafeInteger(after) ||
              after < 0 ||
              !Number.isSafeInteger(limit) ||
              limit < 1 ||
              limit > 10_000
            )
              throw new RangeError('Invalid domain outbox range');
            const discarded = db
              .prepare('SELECT discarded_cursor FROM axterm_storage_outbox_bounds WHERE domain=?')
              .get(spec.name)?.discarded_cursor;
            // A retained suffix is not a complete delta. Existing owner observations
            // recover an empty delta by replacing every collection from actual facts.
            if (discarded !== undefined && after < Number(discarded)) return [];
            return db
              .prepare(
                'SELECT id AS cursor,domain,type,payload FROM axterm_storage_outbox WHERE domain=? AND id>? ORDER BY id LIMIT ?',
              )
              .all(spec.name, after, limit)
              .map((row) => ({
                cursor: Number(row.cursor),
                domain: String(row.domain),
                type: String(row.type),
                payload: JSON.parse(String(row.payload)),
              }));
          }),
        ),
      subscribe: (listener) =>
        this.inDomain(state, () => {
          if (subscriptions.size >= 256) throw new RangeError('Domain observer capacity exceeded');
          const unregister = this.sql.subscribe((events) => {
            if (state.closed) return;
            const selected = events.filter((event) => event.domain === spec.name);
            if (selected.length) return listener(structuredClone(selected));
          });
          const dispose = () => {
            unregister();
            subscriptions.delete(dispose);
          };
          subscriptions.add(dispose);
          return dispose;
        }),
      close: async () => {
        if (this.depth && this.admitted?.has(state))
          throw new StorageError('closed', 'Cannot close a domain during a transaction');
        if (!state.closed) {
          state.closed = true;
          for (const dispose of [...subscriptions]) dispose();
          this.states.delete(spec.name);
        }
      },
    };
  }
  private transaction<T>(tokens: readonly RelationalParticipant[], operation: () => T): T {
    if (this.transactionLeases.getStore()?.active === false)
      throw new StorageError('closed', 'Transaction scope has ended');
    const db = this.connection();
    const admitted = new Set(
      tokens.map((token) => {
        const state = this.participants.get(token);
        if (!state || state.closed)
          throw new StorageError('ownership-conflict', 'Invalid transaction participant');
        return state;
      }),
    );
    if (this.admitted && [...admitted].some((state) => !this.admitted!.has(state)))
      throw new StorageError('ownership-conflict', 'Nested transaction cannot add participants');
    const previous = this.admitted;
    this.admitted ??= admitted;
    const level = this.depth;
    const mark = this.notifications.length;
    const savepoint = `axterm_tx_${level}`;
    try {
      this.system(() => db.exec(level ? `SAVEPOINT ${savepoint}` : 'BEGIN IMMEDIATE'));
    } catch (error) {
      this.admitted = previous;
      throw error;
    }
    this.depth++;
    const lease = { active: true };
    let result: T;
    try {
      result = this.transactionLeases.run(lease, operation);
      if (
        result &&
        (typeof result === 'object' || typeof result === 'function') &&
        'then' in result
      ) {
        void Promise.resolve(result).catch(() => {});
        throw new TypeError('Storage transactions require a synchronous callback');
      }
      this.system(() => db.exec(level ? `RELEASE SAVEPOINT ${savepoint}` : 'COMMIT'));
    } catch (error) {
      this.system(() =>
        db.exec(
          level ? `ROLLBACK TO SAVEPOINT ${savepoint}; RELEASE SAVEPOINT ${savepoint}` : 'ROLLBACK',
        ),
      );
      this.notifications.splice(mark);
      throw error;
    } finally {
      lease.active = false;
      this.depth--;
      this.admitted = previous;
    }
    if (!level) {
      const events = this.notifications.splice(0);
      if (events.length)
        for (const { listener } of [...this.listeners]) {
          try {
            void Promise.resolve(listener(Object.freeze(events))).catch(() =>
              console.warn('[storage] Commit observer failed'),
            );
          } catch {
            console.warn('[storage] Commit observer failed');
          }
        }
    }
    return result;
  }
  private appendEvent(state: State, type: string, payload: unknown): number {
    return this.inDomain(state, () => {
      if (!this.depth)
        return this.transaction([state.token], () => this.appendEvent(state, type, payload));
      if (!type || !isRemoteJsonValue(payload))
        throw new TypeError('Outbox events require a type and JSON payload');
      const encoded = JSON.stringify(payload);
      if (Buffer.byteLength(encoded) > 8 * 1024 * 1024)
        throw new RangeError('Outbox payload exceeds limit');
      const cursor = this.system(() =>
        Number(
          this.connection()
            .prepare('INSERT INTO axterm_storage_outbox(domain,type,payload) VALUES (?,?,?)')
            .run(state.spec.name, type, encoded).lastInsertRowid,
        ),
      );
      this.system(() => {
        const db = this.connection();
        const discarded = db
          .prepare(
            'SELECT id FROM axterm_storage_outbox WHERE domain=? ORDER BY id DESC LIMIT 1 OFFSET ?',
          )
          .get(state.spec.name, MAX_DOMAIN_EVENTS)?.id;
        if (discarded === undefined) return;
        db.prepare('DELETE FROM axterm_storage_outbox WHERE domain=? AND id<=?').run(
          state.spec.name,
          discarded,
        );
        db.prepare(
          `INSERT INTO axterm_storage_outbox_bounds(domain,discarded_cursor) VALUES (?,?)
          ON CONFLICT(domain) DO UPDATE SET discarded_cursor=MAX(discarded_cursor,excluded.discarded_cursor)`,
        ).run(state.spec.name, discarded);
      });
      const committed = JSON.parse(encoded) as unknown;
      const freeze = (value: unknown): void => {
        if (value && typeof value === 'object') {
          for (const item of Object.values(value)) freeze(item);
          Object.freeze(value);
        }
      };
      freeze(committed);
      this.notifications.push(
        Object.freeze({ cursor, domain: state.spec.name, type, payload: committed }),
      );
      return cursor;
    });
  }
  async close(): Promise<void> {
    if (this.depth) throw new StorageError('closed', 'Cannot close a backend during a transaction');
    this.closing = true;
    await this.ready.catch(() => {});
    await Promise.allSettled([...this.openings]);
    for (const state of this.states.values()) {
      state.closed = true;
      for (const dispose of [...state.subscriptions]) dispose();
    }
    this.states.clear();
    this.listeners.clear();
    this.db?.close();
    this.db = undefined;
  }
}
