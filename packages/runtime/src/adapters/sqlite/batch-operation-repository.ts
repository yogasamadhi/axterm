import { batchOperationSchema, type BatchOperation } from '@workspace/contracts';
import { ApplicationError } from '../../application/errors';
import type { ProductDatabase } from './database';

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

function fromRow(row: BatchOperationRow): BatchOperation {
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
  constructor(private readonly database: ProductDatabase) {
    this.recoverInterrupted();
  }

  list(limit = 100): BatchOperation[] {
    return this.database
      .all<BatchOperationRow>(
        `SELECT * FROM batch_operations ORDER BY updated_at DESC, id DESC LIMIT ?`,
        limit,
      )
      .map(fromRow);
  }

  get(id: string): BatchOperation {
    const row = this.database.get<BatchOperationRow>(
      'SELECT * FROM batch_operations WHERE id=?',
      id,
    );
    if (!row) throw new ApplicationError('NOT_FOUND', 'Batch operation not found', 404);
    return fromRow(row);
  }

  create(value: BatchOperation): BatchOperation {
    this.database.transaction(() => {
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
      this.database.appendEvent('batch-operation.created', value.id, eventPayload(value));
    });
    return value;
  }

  save(value: BatchOperation): BatchOperation {
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
    const placeholders = completedStates.map(() => '?').join(', ');
    const result = this.database.run(
      `DELETE FROM batch_operations WHERE state IN (${placeholders})`,
      ...completedStates,
    );
    return Number(result.changes);
  }

  private recoverInterrupted(): void {
    const placeholders = unfinishedStates.map(() => '?').join(', ');
    const rows = this.database.all<BatchOperationRow>(
      `SELECT * FROM batch_operations WHERE state IN (${placeholders})`,
      ...unfinishedStates,
    );
    for (const row of rows) {
      const current = fromRow(row);
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
