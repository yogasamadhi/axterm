import { randomUUID } from 'node:crypto';
import {
  createBatchOperationSchema,
  type BatchOperation,
  type BatchOperationTarget,
  type CreateBatchOperationInput,
  type CreateBatchOperationRequest,
} from '@workspace/contracts';
import type { BatchOperationRepository } from '../adapters/sqlite/batch-operation-repository';
import type { ProductRepository } from '../adapters/sqlite/product-repository';
import type { BookmarkTreeService } from './bookmark-tree-service';
import type { ConnectionService } from './connection-service';
import { ApplicationError } from './errors';
import type { RealtimeHub } from './realtime-hub';

interface ManagedBatchOperation {
  metadata: BatchOperation;
  request: CreateBatchOperationRequest;
  abort: AbortController;
}

const MAX_ACTIVE_OPERATIONS = 4;
const MAX_EXEC_OUTPUT_BYTES = 128 * 1024;

export class BatchOperationService {
  private readonly active = new Map<string, ManagedBatchOperation>();
  private readonly running = new Map<string, Promise<void>>();

  constructor(
    private readonly repository: BatchOperationRepository,
    private readonly productRepository: ProductRepository,
    private readonly bookmarks: BookmarkTreeService,
    private readonly connections: ConnectionService,
    private readonly realtime: RealtimeHub,
  ) {}

  list(): BatchOperation[] {
    return this.repository.list();
  }

  get(id: string): BatchOperation {
    return this.repository.get(id);
  }

  create(raw: CreateBatchOperationInput, idempotencyKey: string | undefined): BatchOperation {
    if (!idempotencyKey || idempotencyKey.length > 200)
      throw new ApplicationError('PRECONDITION_REQUIRED', 'Idempotency-Key is required', 428);
    const request = createBatchOperationSchema.parse(raw);
    const previous = this.productRepository.resolveIdempotency<{ id: string }>(
      idempotencyKey,
      'batch-operation.create',
      request,
    );
    if (previous) return this.repository.get(previous.id);
    if (this.active.size >= MAX_ACTIVE_OPERATIONS)
      throw new ApplicationError(
        'CONFLICT',
        `At most ${MAX_ACTIVE_OPERATIONS} batch operations may be active`,
        409,
      );

    const tree = this.bookmarks.snapshot();
    const bookmarkById = new Map(tree.bookmarks.map((bookmark) => [bookmark.id, bookmark]));
    const targets: BatchOperationTarget[] = request.bookmarkIds.map((bookmarkId) => {
      const bookmark = bookmarkById.get(bookmarkId);
      if (!bookmark)
        throw new ApplicationError('NOT_FOUND', 'Batch operation bookmark not found', 404);
      if (bookmark.protocol !== 'ssh' || !bookmark.hostId)
        throw new ApplicationError(
          'INVALID_STATE',
          'Batch operation targets must be SSH bookmarks',
          409,
        );
      return {
        bookmarkId,
        title: bookmark.title,
        state: 'queued',
        steps: request.steps.map((step) => ({
          stepId: step.id,
          name: step.name,
          state: 'queued',
          exitCode: null,
        })),
      };
    });
    const now = new Date().toISOString();
    const metadata: BatchOperation = {
      id: randomUUID(),
      name: request.name,
      state: 'queued',
      concurrency: request.concurrency,
      targetCount: targets.length,
      completedCount: 0,
      succeededCount: 0,
      failedCount: 0,
      canceledCount: 0,
      targets,
      createdAt: now,
      updatedAt: now,
      version: 1,
    };
    const managed = {
      metadata: this.repository.create(metadata),
      request,
      abort: new AbortController(),
    };
    this.active.set(metadata.id, managed);
    this.productRepository.recordIdempotency(
      idempotencyKey,
      'batch-operation.create',
      request,
      { id: metadata.id },
      500,
    );
    const completion = this.run(managed);
    this.running.set(metadata.id, completion);
    void completion.finally(() => this.running.delete(metadata.id));
    return managed.metadata;
  }

  cancel(id: string): BatchOperation {
    const managed = this.active.get(id);
    if (!managed) throw new ApplicationError('INVALID_STATE', 'Batch operation is not active', 409);
    if (!managed.abort.signal.aborted) {
      managed.abort.abort(new Error('Batch operation canceled'));
      this.transition(managed, 'canceling');
    }
    return managed.metadata;
  }

  clearCompleted(): number {
    return this.repository.clearCompleted();
  }

  resourceCount(): number {
    return this.active.size;
  }

  async closeAll(): Promise<void> {
    for (const managed of this.active.values()) managed.abort.abort(new Error('Runtime closed'));
    await Promise.allSettled(this.running.values());
  }

  private async run(managed: ManagedBatchOperation): Promise<void> {
    this.transition(managed, 'running');
    let cursor = 0;
    const worker = async () => {
      while (!managed.abort.signal.aborted) {
        const index = cursor++;
        if (index >= managed.metadata.targets.length) return;
        await this.runTarget(managed, index);
      }
    };
    try {
      await Promise.all(
        Array.from(
          { length: Math.min(managed.request.concurrency, managed.metadata.targets.length) },
          worker,
        ),
      );
    } finally {
      if (managed.abort.signal.aborted) this.cancelQueuedTargets(managed);
      const targets = managed.metadata.targets;
      this.updateCounts(managed);
      const state = managed.abort.signal.aborted
        ? 'canceled'
        : targets.every(({ state }) => state === 'succeeded')
          ? 'succeeded'
          : 'failed';
      this.transition(managed, state);
      this.active.delete(managed.metadata.id);
    }
  }

  private async runTarget(managed: ManagedBatchOperation, index: number): Promise<void> {
    const bookmark = this.bookmarks
      .snapshot()
      .bookmarks.find(({ id }) => id === managed.request.bookmarkIds[index]);
    const target = managed.metadata.targets[index]!;
    const startedAt = new Date().toISOString();
    if (!bookmark?.hostId) {
      this.updateTarget(managed, index, {
        ...target,
        state: 'failed',
        errorCode: 'BOOKMARK_UNAVAILABLE',
        startedAt,
        finishedAt: startedAt,
      });
      return;
    }

    let connectionId: string | undefined;
    try {
      this.updateTarget(managed, index, { ...target, state: 'connecting', startedAt });
      const connection = this.connections.create({
        hostId: bookmark.hostId,
        ...(bookmark.connectionProfileId
          ? { connectionProfileId: bookmark.connectionProfileId }
          : {}),
      });
      connectionId = connection.id;
      await this.waitForConnection(
        connection.id,
        managed.request.connectionTimeoutMs,
        managed.abort.signal,
      );
      this.updateTarget(managed, index, {
        ...managed.metadata.targets[index]!,
        state: 'running',
      });

      for (const [stepIndex, step] of managed.request.steps.entries()) {
        if (managed.abort.signal.aborted) throw managed.abort.signal.reason;
        const result = managed.metadata.targets[index]!.steps[stepIndex]!;
        const stepStartedAt = new Date().toISOString();
        this.updateStep(managed, index, stepIndex, {
          ...result,
          state: 'running',
          startedAt: stepStartedAt,
        });
        try {
          const outcome = await this.connections.exec(connection.id, {
            command: step.command,
            maxBytes: MAX_EXEC_OUTPUT_BYTES,
            signal: managed.abort.signal,
          });
          const finishedAt = new Date().toISOString();
          const succeeded = outcome.exitCode === 0;
          this.updateStep(managed, index, stepIndex, {
            ...managed.metadata.targets[index]!.steps[stepIndex]!,
            state: succeeded ? 'succeeded' : 'failed',
            exitCode: outcome.exitCode,
            ...(succeeded ? {} : { errorCode: 'REMOTE_COMMAND_FAILED' }),
            finishedAt,
          });
          if (!succeeded && !step.continueOnError) {
            this.skipRemainingSteps(managed, index, stepIndex + 1, 'PREVIOUS_STEP_FAILED');
            throw new ApplicationError('INVALID_STATE', 'Remote command failed', 409);
          }
          if (step.delayMs > 0 && stepIndex < managed.request.steps.length - 1)
            await abortableDelay(step.delayMs, managed.abort.signal);
        } catch (error) {
          if (managed.abort.signal.aborted) throw error;
          const current = managed.metadata.targets[index]!.steps[stepIndex]!;
          if (current.state === 'running')
            this.updateStep(managed, index, stepIndex, {
              ...current,
              state: 'failed',
              errorCode: classifyError(error),
              finishedAt: new Date().toISOString(),
            });
          if (!step.continueOnError) {
            this.skipRemainingSteps(managed, index, stepIndex + 1, 'PREVIOUS_STEP_FAILED');
            throw error;
          }
        }
      }
      const finalTarget = managed.metadata.targets[index]!;
      const failed = finalTarget.steps.some(({ state }) => state === 'failed');
      this.updateTarget(managed, index, {
        ...finalTarget,
        state: failed ? 'failed' : 'succeeded',
        ...(failed ? { errorCode: 'REMOTE_COMMAND_FAILED' } : {}),
        finishedAt: new Date().toISOString(),
      });
    } catch (error) {
      const aborted = managed.abort.signal.aborted;
      this.updateTarget(managed, index, {
        ...managed.metadata.targets[index]!,
        state: aborted ? 'canceled' : 'failed',
        ...(aborted ? {} : { errorCode: classifyError(error) }),
        finishedAt: new Date().toISOString(),
        steps: managed.metadata.targets[index]!.steps.map((step) =>
          ['queued', 'running'].includes(step.state)
            ? {
                ...step,
                state: aborted ? ('canceled' as const) : ('skipped' as const),
                errorCode: aborted ? 'BATCH_OPERATION_CANCELED' : 'TARGET_FAILED',
                finishedAt: new Date().toISOString(),
              }
            : step,
        ),
      });
    } finally {
      if (connectionId) await this.connections.close(connectionId).catch(() => undefined);
    }
  }

  private async waitForConnection(
    id: string,
    timeoutMs: number,
    signal: AbortSignal,
  ): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (signal.aborted) throw signal.reason;
      const connection = this.connections.get(id);
      if (connection.state === 'ready') return;
      if (['failed', 'closed'].includes(connection.state))
        throw new ApplicationError(
          'INVALID_STATE',
          connection.errorCode ?? 'SSH connection failed',
          409,
        );
      await abortableDelay(50, signal);
    }
    throw new ApplicationError('INVALID_STATE', 'SSH connection timed out', 409);
  }

  private updateTarget(
    managed: ManagedBatchOperation,
    index: number,
    target: BatchOperationTarget,
  ): void {
    const targets = [...managed.metadata.targets];
    targets[index] = target;
    managed.metadata = this.repository.save(withCounts({ ...managed.metadata, targets }));
    this.publish(managed.metadata);
  }

  private updateStep(
    managed: ManagedBatchOperation,
    targetIndex: number,
    stepIndex: number,
    step: BatchOperationTarget['steps'][number],
  ): void {
    const target = managed.metadata.targets[targetIndex]!;
    const steps = [...target.steps];
    steps[stepIndex] = step;
    this.updateTarget(managed, targetIndex, { ...target, steps });
  }

  private skipRemainingSteps(
    managed: ManagedBatchOperation,
    targetIndex: number,
    from: number,
    errorCode: string,
  ): void {
    const target = managed.metadata.targets[targetIndex]!;
    const now = new Date().toISOString();
    this.updateTarget(managed, targetIndex, {
      ...target,
      steps: target.steps.map((step, index) =>
        index >= from && step.state === 'queued'
          ? { ...step, state: 'skipped' as const, errorCode, finishedAt: now }
          : step,
      ),
    });
  }

  private cancelQueuedTargets(managed: ManagedBatchOperation): void {
    const now = new Date().toISOString();
    const targets = managed.metadata.targets.map((target) =>
      target.state === 'queued'
        ? {
            ...target,
            state: 'canceled' as const,
            finishedAt: now,
            steps: target.steps.map((step) => ({
              ...step,
              state: 'canceled' as const,
              errorCode: 'BATCH_OPERATION_CANCELED',
              finishedAt: now,
            })),
          }
        : target,
    );
    managed.metadata = this.repository.save({ ...managed.metadata, targets });
  }

  private updateCounts(managed: ManagedBatchOperation): void {
    managed.metadata = this.repository.save(withCounts(managed.metadata));
  }

  private transition(managed: ManagedBatchOperation, state: BatchOperation['state']): void {
    managed.metadata = this.repository.save({ ...managed.metadata, state });
    this.publish(managed.metadata);
  }

  private publish(value: BatchOperation): void {
    this.realtime.publish('batch-operation.updated', value);
  }
}

function abortableDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const timer = setTimeout(done, milliseconds);
    function done() {
      signal.removeEventListener('abort', aborted);
      resolve();
    }
    function aborted() {
      clearTimeout(timer);
      signal.removeEventListener('abort', aborted);
      reject(signal.reason);
    }
    signal.addEventListener('abort', aborted, { once: true });
  });
}

function classifyError(error: unknown): string {
  return error instanceof ApplicationError ? error.code : 'BATCH_TARGET_FAILED';
}

function withCounts(value: BatchOperation): BatchOperation {
  return {
    ...value,
    completedCount: value.targets.filter(({ state }) =>
      ['succeeded', 'failed', 'canceled'].includes(state),
    ).length,
    succeededCount: value.targets.filter(({ state }) => state === 'succeeded').length,
    failedCount: value.targets.filter(({ state }) => state === 'failed').length,
    canceledCount: value.targets.filter(({ state }) => state === 'canceled').length,
  };
}
