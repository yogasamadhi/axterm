import type { RelationalDomain, SqlValue } from '@axterm/plugin-api/storage';
import type { AutomationSql } from '../ports/sql.ts';
import { ApplicationError } from '../application/errors.ts';
/** Existing relational IO is owned and bounded, without a native connection or app_meta access. */
export class AutomationStorage implements AutomationSql {
  constructor(private readonly domain: RelationalDomain) {}
  all<T extends object>(sql: string, ...parameters: SqlValue[]): T[] {
    return this.domain.all<T>(sql, ...parameters);
  }
  get<T extends object>(sql: string, ...parameters: SqlValue[]): T | undefined {
    return this.domain.get<T>(sql, ...parameters);
  }
  run(sql: string, ...parameters: SqlValue[]) {
    return this.domain.run(sql, ...parameters);
  }
  transaction<T>(operation: () => T): T {
    return this.domain.transaction(() => {
      const result = operation();
      this.assertBounds();
      return result;
    });
  }
  appendEvent(type: string, entityId: string, payload: unknown): number {
    return this.domain.appendEvent(type, { entityId, payload });
  }
  assertBounds(): void {
    const commands = this.domain.get<{ count: number; bytes: number; largest: number }>(
      'SELECT COUNT(*) AS count, COALESCE(SUM(length(CAST(payload AS BLOB))+length(CAST(name AS BLOB))+512),0) AS bytes, COALESCE(MAX(length(CAST(payload AS BLOB))),0) AS largest FROM quick_commands',
    )!;
    const groups = this.domain.get<{ count: number; bytes: number }>(
      'SELECT COUNT(*) AS count, COALESCE(SUM(length(CAST(name AS BLOB))+256),0) AS bytes FROM quick_command_groups',
    )!;
    const triggers = this.domain.get<{ count: number; bytes: number; largest: number }>(
      'SELECT COUNT(*) AS count, COALESCE(SUM(length(CAST(payload AS BLOB))+length(CAST(name AS BLOB))+512),0) AS bytes, COALESCE(MAX(length(CAST(payload AS BLOB))),0) AS largest FROM automation_triggers',
    )!;
    if (
      commands.count + groups.count > 5000 ||
      commands.bytes + groups.bytes > 32 * 1024 * 1024 ||
      commands.largest > 512 * 1024 ||
      triggers.count > 256 ||
      triggers.bytes > 8 * 1024 * 1024 ||
      triggers.largest > 256 * 1024
    )
      throw new ApplicationError(
        'CAPACITY_EXCEEDED',
        'Automation facts exceed the supported bound',
        503,
      );
  }
}
