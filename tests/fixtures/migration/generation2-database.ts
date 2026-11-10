import { createHash } from 'node:crypto';
import { mkdir, open } from 'node:fs/promises';
import { dirname } from 'node:path';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { legacyMigrations } from '@axterm/data-schema';
import frozen from './generation2-migrations.json';
import history from './generation2-history.json';
/** Test input writer only. Creates a fresh generation 2 medium; never upgrades existing data. */
export class Generation2Database {
  private constructor(private readonly connection: DatabaseSync) {}
  static async open(path: string): Promise<Generation2Database> {
    if (path !== ':memory:') {
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      const file = await open(path, 'wx', 0o600);
      await file.close();
    }
    const db = new DatabaseSync(path);
    try {
      db.exec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL;');
      for (const record of frozen.migrations) {
        if (createHash('sha256').update(record.sql).digest('hex') !== record.sha256)
          throw Error('Frozen generation 2 SQL changed');
        db.exec('BEGIN IMMEDIATE');
        if (record.hasApply) {
          const migration = legacyMigrations.find((m) => m.id === record.id);
          if (
            !migration?.apply ||
            createHash('sha256').update(migration.sql).digest('hex') !== record.sha256
          )
            throw Error('Historical migration adapter changed');
          migration.apply(db);
        } else db.exec(record.sql);
        db.prepare('INSERT INTO app_meta(key,value) VALUES(?,?)').run(
          `migration:${record.id}`,
          record.sha256,
        );
        db.exec('COMMIT');
      }
      return new Generation2Database(db);
    } catch (error) {
      db.close();
      throw error;
    }
  }
  all<T extends object>(sql: string, ...params: SQLInputValue[]): T[] {
    return this.connection.prepare(sql).all(...params) as unknown as T[];
  }
  get<T extends object>(sql: string, ...params: SQLInputValue[]): T | undefined {
    return this.connection.prepare(sql).get(...params) as unknown as T | undefined;
  }
  run(sql: string, ...params: SQLInputValue[]) {
    return this.connection.prepare(sql).run(...params);
  }
  close(): void {
    this.connection.close();
  }
}

/** Only recorded historical rows enter this fresh test input; no live owner is bypassed. */
export function seedGeneration2History(database: Generation2Database): void {
  database.run('BEGIN IMMEDIATE');
  try {
    for (const table of ['hosts', 'recent_connections', 'command_history'] as const) {
      for (const row of history.tables[table]) {
        const columns = Object.keys(row);
        if (columns.some((column) => !/^[_a-z][_a-z0-9]*$/u.test(column)))
          throw Error('Invalid historical fixture column');
        const values = Object.values(row) as SQLInputValue[];
        database.run(
          `INSERT INTO "${table}" (${columns.map((column) => `"${column}"`).join(',')}) VALUES (${columns.map(() => '?').join(',')})`,
          ...values,
        );
      }
    }
    for (const row of history.revisions)
      database.run('UPDATE app_meta SET value=? WHERE key=?', row.value, row.key);
    database.run('COMMIT');
  } catch (error) {
    database.run('ROLLBACK');
    throw error;
  }
}
