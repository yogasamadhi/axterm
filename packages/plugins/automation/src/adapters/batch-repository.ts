import { batchOperationSchema, type BatchOperation } from '@axterm/plugin-api/automation';
import { ApplicationError } from '../application/errors.ts';
import type { AutomationSql } from '../ports/sql.ts';

interface BatchOperationRow {
  id: string;
  name: string;
  state: BatchOperation['state'];
  target_count: number;
  payload: string;
  created_at: string;
  updated_at: string;
  version: number;
}

const unfinishedStates = ['queued', 'running', 'canceling'] as const;
const completedStates = ['succeeded', 'failed', 'canceled', 'interrupted'] as const;

export function fromRow(row: BatchOperationRow): BatchOperation {
  return batchOperationSchema.parse({
    id: row.id,
    name: row.name,
    state: row.state,
    targetCount: row.target_count,
    ...JSON.parse(row.payload),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    version: row.version,
  });
}

function payload(value: BatchOperation): string {
  return JSON.stringify({
    concurrency: value.concurrency,
    completedCount: value.completedCount,
    succeededCount: value.succeededCount,
    failedCount: value.failedCount,
    canceledCount: value.canceledCount,
    targets: value.targets,
  });
}

export class BatchOperationRepository {
  private recovering = false;
  constructor(
    private readonly database: AutomationSql,
    private readonly profile: string,
    private readonly generation: string,
  ) {
    this.database.transaction(() => this.recoverInterrupted());
  }

  list(limit = 100): BatchOperation[] {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100)
      throw new ApplicationError('VALIDATION_ERROR', 'Batch history limit is invalid', 400);
    const pinned = this.database.all<{ id: string; bytes: number }>(
      "SELECT b.id,length(CAST(b.payload AS BLOB)) AS bytes FROM batch_operations b JOIN axterm_batch_ownership o ON o.batch_id=b.id WHERE o.state='active' ORDER BY b.updated_at DESC,b.id DESC LIMIT 5",
    );
    if (pinned.length > 4 || pinned.some((row) => row.bytes > 2 * 1024 * 1024))
      throw new ApplicationError(
        'CAPACITY_EXCEEDED',
        'Batch activity exceeds the supported bound',
        503,
      );
    const recent = this.database.all<{ id: string; bytes: number }>(
      'SELECT id,length(CAST(payload AS BLOB)) AS bytes FROM batch_operations ORDER BY updated_at DESC,id DESC LIMIT ?',
      limit,
    );
    let bytes = pinned.reduce((size, row) => size + row.bytes, 0);
    const ids = new Set(pinned.map((row) => row.id));
    for (const row of recent) {
      if (ids.has(row.id)) continue;
      if (row.bytes > 2 * 1024 * 1024)
        throw new ApplicationError(
          'CAPACITY_EXCEEDED',
          'Batch record exceeds the supported bound',
          503,
        );
      if (bytes + row.bytes > 16 * 1024 * 1024) continue;
      bytes += row.bytes;
      ids.add(row.id);
    }
    return [...ids]
      .map((id) => this.get(id))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || b.id.localeCompare(a.id));
  }
  activeCount(): number {
    return this.database.get<{ count: number }>(
      "SELECT COUNT(*) AS count FROM batch_operations b JOIN axterm_batch_ownership o ON o.batch_id=b.id WHERE o.state='active'",
    )!.count;
  }
  release(id: string): void {
    this.database.transaction(() => {
      this.assertOwned(id);
      this.database.run(
        "UPDATE axterm_batch_ownership SET state='released' WHERE batch_id=? AND profile=?",
        id,
        this.profile,
      );
      this.database.appendEvent('batch-operation.released', id, { id });
    });
  }
  private assertOwned(id: string): void {
    const owner = this.database.get<{ profile: string; generation: string; state: string }>(
      'SELECT profile,generation,state FROM axterm_batch_ownership WHERE batch_id=?',
      id,
    );
    if (
      owner?.profile !== this.profile ||
      owner.state !== 'active' ||
      (!this.recovering && owner.generation !== this.generation)
    )
      throw new ApplicationError(
        'CONFLICT',
        'Batch operation belongs to another Profile or generation',
      );
  }
  get(id: string): BatchOperation {
    const size = this.database.get<{ bytes: number }>(
      'SELECT length(CAST(payload AS BLOB)) AS bytes FROM batch_operations WHERE id=?',
      id,
    );
    if (size && size.bytes > 2 * 1024 * 1024)
      throw new ApplicationError(
        'CAPACITY_EXCEEDED',
        'Batch record exceeds the supported bound',
        503,
      );
    const row = this.database.get<BatchOperationRow>(
      'SELECT * FROM batch_operations WHERE id=?',
      id,
    );
    if (!row) throw new ApplicationError('NOT_FOUND', 'Batch operation not found', 404);
    return fromRow(row);
  }

  create(value: BatchOperation): BatchOperation {
    batchOperationSchema.parse(value);
    this.database.transaction(() => {
      if (this.activeCount() >= 4)
        throw new ApplicationError('CAPACITY_EXCEEDED', 'Batch operation capacity exceeded', 503);
      this.database.run(
        `INSERT INTO batch_operations(
          id, name, state, target_count, payload, created_at, updated_at, version
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        value.id,
        value.name,
        value.state,
        value.targetCount,
        payload(value),
        value.createdAt,
        value.updatedAt,
        value.version,
      );
      this.database.run(
        'INSERT INTO axterm_batch_ownership(batch_id,profile,generation) VALUES (?,?,?)',
        value.id,
        this.profile,
        this.generation,
      );
      this.database.appendEvent('batch-operation.created', value.id, eventPayload(value));
    });
    return value;
  }

  save(value: BatchOperation): BatchOperation {
    this.assertOwned(value.id);
    batchOperationSchema.parse(value);
    const next = { ...value, updatedAt: new Date().toISOString(), version: value.version + 1 };
    this.database.transaction(() => {
      const result = this.database.run(
        `UPDATE batch_operations
         SET name=?, state=?, target_count=?, payload=?, updated_at=?, version=?
         WHERE id=? AND version=?`,
        next.name,
        next.state,
        next.targetCount,
        payload(next),
        next.updatedAt,
        next.version,
        next.id,
        value.version,
      );
      if (!result.changes)
        throw new ApplicationError('PRECONDITION_FAILED', 'Batch operation changed', 412);
      this.database.appendEvent('batch-operation.updated', value.id, eventPayload(next));
    });
    return next;
  }

  clearCompleted(): number {
    return this.database.transaction(() => {
      const placeholders = completedStates.map(() => '?').join(', ');
      const result = this.database.run(
        `DELETE FROM batch_operations WHERE state IN (${placeholders}) AND NOT EXISTS (SELECT 1 FROM axterm_batch_ownership o WHERE o.batch_id=batch_operations.id AND o.state='active')`,
        ...completedStates,
      );
      const cleared = Number(result.changes);
      if (cleared)
        this.database.appendEvent('batch-operation.cleared', 'batch-operations', { cleared });
      return cleared;
    });
  }

  private recoverInterrupted(): void {
    const count = this.database.get<{ count: number }>(
      "SELECT COUNT(*) AS count FROM batch_operations b JOIN axterm_batch_ownership o ON o.batch_id=b.id WHERE o.state='active' AND o.profile=? AND o.generation<>?",
      this.profile,
      this.generation,
    )!.count;
    if (count > 4)
      throw new ApplicationError(
        'CAPACITY_EXCEEDED',
        'Stale batch ownership exceeds the supported bound',
        503,
      );
    const largest = this.database.get<{ bytes: number }>(
      "SELECT COALESCE(MAX(length(CAST(b.payload AS BLOB))),0) AS bytes FROM batch_operations b JOIN axterm_batch_ownership o ON o.batch_id=b.id WHERE o.state='active' AND o.profile=? AND o.generation<>?",
      this.profile,
      this.generation,
    )!.bytes;
    if (largest > 2 * 1024 * 1024)
      throw new ApplicationError(
        'CAPACITY_EXCEEDED',
        'Stale batch data exceeds the supported bound',
        503,
      );
    const rows = this.database.all<BatchOperationRow>(
      `SELECT b.* FROM batch_operations b JOIN axterm_batch_ownership o ON o.batch_id=b.id WHERE o.state='active' AND o.profile=? AND o.generation<>?`,
      this.profile,
      this.generation,
    );
    this.recovering = true;
    try {
      for (const row of rows) {
        const current = fromRow(row);
        if (!(unfinishedStates as readonly string[]).includes(current.state)) {
          this.release(current.id);
          continue;
        }
        const now = new Date().toISOString();
        const targets = current.targets.map((target) =>
          ['queued', 'connecting', 'running'].includes(target.state)
            ? {
                ...target,
                state: 'failed' as const,
                errorCode: 'RUNTIME_INTERRUPTED',
                finishedAt: now,
                steps: target.steps.map((step) =>
                  ['queued', 'running'].includes(step.state)
                    ? {
                        ...step,
                        state: 'canceled' as const,
                        errorCode: 'RUNTIME_INTERRUPTED',
                        finishedAt: now,
                      }
                    : step,
                ),
              }
            : target,
        );
        const next: BatchOperation = {
          ...current,
          state: 'interrupted',
          targets,
          completedCount: targets.length,
          succeededCount: targets.filter(({ state }) => state === 'succeeded').length,
          failedCount: targets.filter(({ state }) => state === 'failed').length,
          canceledCount: targets.filter(({ state }) => state === 'canceled').length,
        };
        this.save(next);
        this.release(next.id);
      }
    } finally {
      this.recovering = false;
    }
  }
}

function eventPayload(value: BatchOperation) {
  return {
    id: value.id,
    name: value.name,
    state: value.state,
    targetCount: value.targetCount,
    completedCount: value.completedCount,
    succeededCount: value.succeededCount,
    failedCount: value.failedCount,
    canceledCount: value.canceledCount,
  };
}
