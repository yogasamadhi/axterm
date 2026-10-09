import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  realpathSync,
  unlinkSync,
} from 'node:fs';
import { basename, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/** Private Runtime metadata, never a File Grant or a directory-scanning authority. */
export type OwnedStageProtocol = 'xmodem' | 'zmodem' | 'trzsz';

interface StageRow {
  id: string;
  protocol: OwnedStageProtocol;
  transfer_id: string;
  directory_id: string;
  stage_name: string;
  final_name: string;
  created_at: number;
  device: string | null;
  inode: string | null;
  encoded_bytes: number;
}

export interface OwnedStageRecord {
  id: string;
  protocol: OwnedStageProtocol;
  name: string;
  createdAt: number;
  bytes: number;
  state: 'verified' | 'absent' | 'unverified' | 'expired';
}

export interface StageOwnershipWriter {
  prepare(
    directory: string,
    stageName: string,
    finalName: string,
    protocol: OwnedStageProtocol,
    transferId?: string,
  ): string;
  seal(id: string, descriptor: number): void;
  clearIfAbsent(id: string, directory: string): void;
}

const MAX_RECORDS = 4_096;
const MAX_RECORD_BYTES = 1_024;
const MAX_TOTAL_BYTES = 4 * 1024 * 1024;
const REVIEW_MS = 30 * 24 * 60 * 60 * 1000;

function validName(name: string): boolean {
  return (
    name.length > 0 &&
    name === basename(name) &&
    name !== '.' &&
    name !== '..' &&
    !name.includes('\\') &&
    !name.includes('\0') &&
    Buffer.byteLength(name, 'utf8') <= 255
  );
}

function metadata(path: string) {
  const value = lstatSync(path, { bigint: true });
  if (
    !value.isFile() ||
    value.isSymbolicLink() ||
    value.nlink !== 1n ||
    value.dev <= 0n ||
    value.ino === 0n
  )
    return undefined;
  return value;
}

/**
 * Durable, bounded record store for terminal receive stages. The database is
 * distinct from product SQLite and contains no absolute destination path.
 * Each write is a FULL-synchronous SQLite transaction, including the prepared
 * record committed before a protocol may create its stage.
 */
export class OwnedStageJournal implements StageOwnershipWriter {
  private readonly db: DatabaseSync;
  private readonly key: Buffer;

  constructor(dataDirectory: string) {
    mkdirSync(dataDirectory, { recursive: true, mode: 0o700 });
    const path = join(dataDirectory, 'terminal-stage-ownership.sqlite');
    // Ensure a newly created store is private even when the process umask is lax.
    try {
      const descriptor = openSync(path, 'wx', 0o600);
      closeSync(descriptor);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    const store = lstatSync(path);
    if (
      !store.isFile() ||
      store.isSymbolicLink() ||
      store.nlink !== 1 ||
      // Windows inherits the application data directory's ACL. Its stat mode
      // reports DOS read-only attributes, not POSIX group/other permissions.
      (process.platform !== 'win32' && (store.mode & 0o077) !== 0) ||
      (typeof process.getuid === 'function' && store.uid !== process.getuid())
    )
      throw new Error('Transfer ownership store is not a private regular file');
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA busy_timeout=0');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS journal_key (id INTEGER PRIMARY KEY CHECK (id = 1), key BLOB NOT NULL);
      CREATE TABLE IF NOT EXISTS owned_stage (
        id TEXT PRIMARY KEY, protocol TEXT NOT NULL, transfer_id TEXT NOT NULL,
        directory_id TEXT NOT NULL, stage_name TEXT NOT NULL UNIQUE,
        final_name TEXT NOT NULL, created_at INTEGER NOT NULL,
        device TEXT, inode TEXT, encoded_bytes INTEGER NOT NULL
      );
    `);
    const existing = this.db.prepare('SELECT key FROM journal_key WHERE id = 1').get() as
      { key: Uint8Array } | undefined;
    if (existing) {
      this.key = Buffer.from(existing.key);
      if (this.key.length !== 32) throw new Error('Transfer ownership key is invalid');
    } else {
      const key = randomBytes(32);
      this.db.prepare('INSERT OR IGNORE INTO journal_key (id, key) VALUES (1, ?)').run(key);
      this.key = Buffer.from(
        (this.db.prepare('SELECT key FROM journal_key WHERE id = 1').get() as { key: Uint8Array })
          .key,
      );
    }
  }

  prepare(
    directory: string,
    stageName: string,
    finalName: string,
    protocol: OwnedStageProtocol,
    transferId = randomUUID(),
  ): string {
    if (!validName(stageName) || !stageName.endsWith('.part') || !validName(finalName))
      throw new Error('Unsafe transfer filename');
    const id = randomUUID();
    const row = {
      id,
      protocol,
      transferId,
      directoryId: this.directoryId(directory),
      stageName,
      finalName,
      createdAt: Date.now(),
    };
    const encodedBytes = Buffer.byteLength(JSON.stringify(row), 'utf8');
    if (encodedBytes > MAX_RECORD_BYTES) throw new Error('Transfer ownership record exceeds limit');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const count = this.db
        .prepare(
          'SELECT COUNT(*) AS count, COALESCE(SUM(encoded_bytes), 0) AS bytes FROM owned_stage',
        )
        .get() as { count: number; bytes: number };
      if (count.count >= MAX_RECORDS || count.bytes + encodedBytes > MAX_TOTAL_BYTES)
        throw new Error('Transfer ownership journal is full');
      this.db
        .prepare(
          `INSERT INTO owned_stage
        (id, protocol, transfer_id, directory_id, stage_name, final_name, created_at,
         device, inode, encoded_bytes) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?)`,
        )
        .run(
          id,
          protocol,
          transferId,
          row.directoryId,
          stageName,
          finalName,
          row.createdAt,
          encodedBytes,
        );
      this.db.exec('COMMIT');
      return id;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  /** Call after open and after each write; FAT may change its file ID on first allocation. */
  seal(id: string, descriptor: number): void {
    const value = fstatSync(descriptor, { bigint: true });
    // macOS FAT volumes can expose a stable signed (negative) file ID.
    if (!value.isFile() || value.nlink !== 1n || value.dev <= 0n || value.ino === 0n)
      throw new Error('Transfer stage lacks a unique regular-file identity');
    const existing = this.db
      .prepare('SELECT device, inode FROM owned_stage WHERE id = ?')
      .get(id) as { device: string | null; inode: string | null } | undefined;
    if (existing?.device === String(value.dev) && existing.inode === String(value.ino)) return;
    const result = this.db
      .prepare('UPDATE owned_stage SET device = ?, inode = ? WHERE id = ?')
      .run(String(value.dev), String(value.ino), id);
    if (result.changes !== 1) throw new Error('Transfer ownership record is unavailable');
  }

  /** Clear only after normal cleanup or no-replace publication consumed the stage. */
  clearIfAbsent(id: string, directory: string): void {
    const row = this.row(id);
    if (!row || row.directory_id !== this.directoryId(directory)) return;
    try {
      lstatSync(join(directory, row.stage_name));
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    this.db.prepare('DELETE FROM owned_stage WHERE id = ?').run(id);
  }

  /** The caller must have resolved a fresh generation-bound Host write Grant. */
  review(directory: string): OwnedStageRecord[] {
    const directoryId = this.directoryId(directory);
    const rows = this.db
      .prepare(
        'SELECT * FROM owned_stage WHERE directory_id = ? ORDER BY created_at DESC LIMIT 4096',
      )
      .all(directoryId) as unknown as StageRow[];
    return rows.map((row) => this.inspect(row, directory));
  }

  /** Explicit user confirmation, with a final no-follow identity check. */
  removeVerified(id: string, directory: string): void {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const row = this.row(id);
      if (!row || row.directory_id !== this.directoryId(directory))
        throw new Error('Transfer ownership record does not match the selected directory');
      if (Date.now() - row.created_at > REVIEW_MS)
        throw new Error('Transfer ownership review window expired');
      const path = join(directory, row.stage_name);
      const first = metadata(path);
      if (!first || String(first.dev) !== row.device || String(first.ino) !== row.inode)
        throw new Error('Transfer stage identity cannot be verified');
      const descriptor = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      try {
        const opened = fstatSync(descriptor, { bigint: true });
        const final = metadata(path);
        if (
          !final ||
          !opened.isFile() ||
          opened.nlink !== 1n ||
          String(opened.dev) !== row.device ||
          String(opened.ino) !== row.inode ||
          String(final.dev) !== row.device ||
          String(final.ino) !== row.inode
        )
          throw new Error('Transfer stage identity changed');
        unlinkSync(path);
      } finally {
        closeSync(descriptor);
      }
      this.clearIfAbsent(id, directory);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  /** User-acknowledged forgetting never touches a destination file. */
  forget(id: string): void {
    this.db.prepare('DELETE FROM owned_stage WHERE id = ?').run(id);
  }

  close(): void {
    this.db.close();
  }

  private inspect(row: StageRow, directory: string): OwnedStageRecord {
    let state: OwnedStageRecord['state'] = 'unverified';
    let bytes = 0;
    if (Date.now() - row.created_at > REVIEW_MS) state = 'expired';
    else {
      try {
        const value = metadata(join(directory, row.stage_name));
        if (value && String(value.dev) === row.device && String(value.ino) === row.inode) {
          state = 'verified';
          bytes = Number(value.size);
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') state = 'absent';
      }
    }
    return {
      id: row.id,
      protocol: row.protocol,
      name: row.final_name,
      createdAt: row.created_at,
      bytes,
      state,
    };
  }

  private row(id: string): StageRow | undefined {
    return this.db.prepare('SELECT * FROM owned_stage WHERE id = ?').get(id) as
      StageRow | undefined;
  }

  private directoryId(directory: string): string {
    return createHmac('sha256', this.key).update(realpathSync(directory)).digest('hex');
  }
}
