import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { legacyMigrations } from '@axterm/data-schema';
import frozen from './generation2-migrations.json';
/** Only the original committed transformation is executed on the caller's closed-owner test input. */
export function applyHistoricalSql(input: DatabaseSync, id: number): void {
  const original = frozen.migrations.find((record) => record.id === id);
  const migration = legacyMigrations.find((record) => record.id === id);
  if (
    !original ||
    !migration ||
    createHash('sha256').update(migration.sql).digest('hex') !== original.sha256
  )
    throw Error('Historical SQL identity mismatch');
  input.exec('BEGIN IMMEDIATE');
  try {
    if (original.hasApply) {
      if (!migration.apply) throw Error('Historical apply hook missing');
      migration.apply(input);
    } else input.exec(original.sql);
    input
      .prepare('INSERT OR REPLACE INTO app_meta(key,value) VALUES(?,?)')
      .run(`migration:${id}`, original.sha256);
    input.exec('COMMIT');
  } catch (error) {
    input.exec('ROLLBACK');
    throw error;
  }
}
