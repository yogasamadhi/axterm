import { constants } from 'node:fs';
import { chmod, lstat, mkdir, open } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { backup, DatabaseSync } from 'node:sqlite';
export interface CopyIdentity {
  readonly path: string;
  readonly device: number;
  readonly inode: number;
  readonly size: number;
  readonly modified: number;
  readonly sha256: string;
}
const fail = (code: string): never => {
  throw Error('DATA_COPY_' + code);
};
/** Read only a regular, unchanged source inode; never follow a file symlink or rewrite source media. */
export async function copyMigrationFile(
  source: string,
  target: string,
  maxBytes: number,
): Promise<CopyIdentity> {
  if (resolve(source) === resolve(target)) fail('SOURCE_TARGET_ALIAS');
  const before = await lstat(source);
  if (!before.isFile() || before.isSymbolicLink() || before.size > maxBytes) fail('INVALID_FILE');
  const input = await open(source, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  let output: Awaited<ReturnType<typeof open>> | undefined;
  let answer: CopyIdentity | undefined, operationError: unknown;
  let operationFailed = false;
  try {
    const actual = await input.stat();
    if (actual.dev !== before.dev || actual.ino !== before.ino || actual.size !== before.size)
      fail('SOURCE_CHANGED');
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    output = await open(target, 'wx', 0o600);
    const buffer = Buffer.alloc(64 * 1024),
      hash = createHash('sha256');
    let total = 0;
    for (;;) {
      const { bytesRead } = await input.read(buffer, 0, buffer.length, null);
      if (!bytesRead) break;
      total += bytesRead;
      if (total > before.size || total > maxBytes) fail('SOURCE_CHANGED');
      hash.update(buffer.subarray(0, bytesRead));
      let offset = 0;
      while (offset < bytesRead) {
        const result = await output.write(buffer, offset, bytesRead - offset, null);
        if (!result.bytesWritten) fail('SHORT_WRITE');
        offset += result.bytesWritten;
      }
    }
    const after = await input.stat();
    if (
      total !== before.size ||
      after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs ||
      after.ctimeMs !== before.ctimeMs
    )
      fail('SOURCE_CHANGED');
    await output.sync();
    answer = {
      path: resolve(source),
      device: before.dev,
      inode: before.ino,
      size: total,
      modified: before.mtimeMs,
      sha256: hash.digest('hex'),
    };
  } catch (error) {
    operationFailed = true;
    operationError = error;
  }
  const results = await Promise.allSettled([input.close(), ...(output ? [output.close()] : [])]);
  if (operationFailed) throw operationError;
  const failed = results.find((result) => result.status === 'rejected');
  if (failed?.status === 'rejected') throw failed.reason;
  return answer ?? fail('COPY_INCOMPLETE');
}
export async function verifyMigrationFile(identity: CopyIdentity): Promise<void> {
  const input = await open(identity.path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const before = await input.stat();
    if (
      !before.isFile() ||
      before.dev !== identity.device ||
      before.ino !== identity.inode ||
      before.size !== identity.size ||
      before.mtimeMs !== identity.modified
    )
      fail('SOURCE_CHANGED');
    const buffer = Buffer.alloc(64 * 1024),
      hash = createHash('sha256');
    for (;;) {
      const { bytesRead } = await input.read(buffer, 0, buffer.length, null);
      if (!bytesRead) break;
      hash.update(buffer.subarray(0, bytesRead));
    }
    const after = await input.stat();
    if (
      hash.digest('hex') !== identity.sha256 ||
      after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs ||
      after.ctimeMs !== before.ctimeMs
    )
      fail('SOURCE_CHANGED');
  } finally {
    await input.close();
  }
}
export interface LegacySnapshotPlan {
  readonly migrations: readonly { readonly id: number; readonly sql: string }[];
  readonly minimumMigrationId: number;
  readonly tables: readonly string[];
}
export function inspectMigrationDatabase(
  path: string,
  plan?: LegacySnapshotPlan,
): Readonly<Record<string, number>> {
  const database = new DatabaseSync(path, { readOnly: true });
  try {
    if (
      database.prepare('PRAGMA integrity_check').get()?.integrity_check !== 'ok' ||
      database.prepare('PRAGMA foreign_key_check').all().length
    )
      fail('DATABASE_INTEGRITY');
    if (plan) {
      if (
        database.prepare("SELECT value FROM app_meta WHERE key='axterm:schema-generation'").get()
          ?.value !== '2'
      )
        fail('UNSUPPORTED_GENERATION');
      const migrations = database
        .prepare("SELECT key,value FROM app_meta WHERE key LIKE 'migration:%'")
        .all();
      const applied = new Map(migrations.map((row) => [String(row.key), row.value]));
      const highest = plan.migrations.findLastIndex((migration) =>
        applied.has('migration:' + migration.id),
      );
      const prefix = plan.migrations.slice(0, highest + 1);
      if (
        !prefix.some((migration) => migration.id === plan.minimumMigrationId) ||
        migrations.length !== prefix.length ||
        prefix.some(
          (migration) =>
            applied.get('migration:' + migration.id) !==
            createHash('sha256').update(migration.sql).digest('hex'),
        )
      )
        fail('UNSUPPORTED_SCHEMA');
    }
    const tables = database
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      )
      .all();
    if (
      plan &&
      (tables.length !== plan.tables.length ||
        tables.some((row) => !plan.tables.includes(String(row.name))))
    )
      fail('UNSUPPORTED_TABLES');
    const counts: Record<string, number> = {};
    for (const row of tables) {
      const name = String(row.name);
      if (!/^[a-z_][a-z0-9_]*$/i.test(name)) fail('INVALID_TABLE');
      counts[name] = Number(
        database.prepare(`SELECT count(*) AS total FROM "${name}"`).get()!.total,
      );
    }
    return Object.freeze(counts);
  } finally {
    database.close();
  }
}
/** The legacy-instance lease must be held by the caller. SQLite only opens the private scratch copy. */
export async function copyGeneration2Database(
  source: string,
  scratch: string,
  target: string,
  plan: LegacySnapshotPlan,
): Promise<{ identities: readonly CopyIdentity[]; counts: Readonly<Record<string, number>> }> {
  const copied = join(scratch, 'source.sqlite');
  const identities = [await copyMigrationFile(source, copied, Number.MAX_SAFE_INTEGER)];
  for (const suffix of ['-wal', '-shm']) {
    const status = await lstat(source + suffix).catch((error) => {
      if (error.code === 'ENOENT') return undefined;
      throw error;
    });
    if (status)
      identities.push(
        await copyMigrationFile(source + suffix, copied + suffix, Number.MAX_SAFE_INTEGER),
      );
  }
  const counts = inspectMigrationDatabase(copied, plan);
  await mkdir(dirname(target), { recursive: true, mode: 0o700 });
  if (
    await lstat(target).then(
      () => true,
      (error) => {
        if (error.code === 'ENOENT') return false;
        throw error;
      },
    )
  )
    fail('TARGET_CONFLICT');
  const database = new DatabaseSync(copied, { readOnly: true });
  try {
    await backup(database, target);
  } finally {
    database.close();
  }
  await chmod(target, 0o600);
  if (JSON.stringify(inspectMigrationDatabase(target, plan)) !== JSON.stringify(counts))
    fail('COUNT_MISMATCH');
  for (const identity of identities) await verifyMigrationFile(identity);
  return { identities: Object.freeze(identities), counts };
}
/** A bounded read-only identity for prepared target validation and resumable publication. */
export async function identifyMigrationFile(
  path: string,
  maxBytes = Number.MAX_SAFE_INTEGER,
): Promise<CopyIdentity> {
  const input = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const before = await input.stat();
    if (!before.isFile() || before.size > maxBytes) fail('INVALID_FILE');
    const hash = createHash('sha256'),
      buffer = Buffer.alloc(64 * 1024);
    let total = 0;
    for (;;) {
      const { bytesRead } = await input.read(buffer, 0, buffer.length, null);
      if (!bytesRead) break;
      total += bytesRead;
      if (total > before.size) fail('SOURCE_CHANGED');
      hash.update(buffer.subarray(0, bytesRead));
    }
    const after = await input.stat();
    if (
      total !== before.size ||
      after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs ||
      after.ctimeMs !== before.ctimeMs
    )
      fail('SOURCE_CHANGED');
    return {
      path: resolve(path),
      device: before.dev,
      inode: before.ino,
      size: total,
      modified: before.mtimeMs,
      sha256: hash.digest('hex'),
    };
  } finally {
    await input.close();
  }
}
/** Every normal Profile admission holds the home migration lease while checking this marker. */
export async function assertDataMigrationReady(home: string): Promise<void> {
  const { readFile, readdir } = await import('node:fs/promises');
  const marker = join(home, 'level3-data-copy.json');
  const status = await lstat(marker).catch((error) => {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  });
  if (!status) {
    const names = await readdir(home).catch((error) => {
      if (error.code === 'ENOENT') return [];
      throw error;
    });
    if (names.some((name) => name.startsWith('.level3-copy-'))) fail('RECOVERY_REQUIRED');
    return;
  }
  if (!status.isFile() || status.isSymbolicLink() || status.size > 4096) fail('INVALID_JOURNAL');
  const document: unknown = JSON.parse(await readFile(marker, 'utf8'));
  if (!document || typeof document !== 'object' || Array.isArray(document)) fail('INVALID_JOURNAL');
  const value = document as Record<string, unknown>;
  if (
    Object.keys(value).sort().join(',') !== 'createdAt,id,published,source,state,version' ||
    value.version !== 1 ||
    value.state !== 'committed' ||
    typeof value.id !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value.id) ||
    typeof value.source !== 'string' ||
    !/^[0-9a-f]{64}$/.test(value.source) ||
    typeof value.createdAt !== 'string' ||
    !Number.isFinite(Date.parse(value.createdAt)) ||
    !Array.isArray(value.published) ||
    value.published.join(',') !== 'data-v2,vault-v2,desktop'
  )
    fail('RECOVERY_REQUIRED');
  const id = value.id as string;
  for (const entry of ['data-v2', 'vault-v2', 'desktop']) {
    const root = join(home, entry),
      value = await lstat(root);
    if (!value.isDirectory() || value.isSymbolicLink()) fail('INCOMPLETE_TARGET');
    const owner = join(root, '.level3-data-copy-owner'),
      file = await lstat(owner);
    if (
      !file.isFile() ||
      file.isSymbolicLink() ||
      file.size !== 36 ||
      (await readFile(owner, 'utf8')) !== id
    )
      fail('INCOMPLETE_TARGET');
  }
}
