import type { Context } from '@deepseek-ai/cordis';
import {
  Remote,
  RemoteError,
  TypertRemoteService,
  remoteErrorOf,
  StorageCommandError,
} from '@axterm/plugin-api';
import type {} from '@axterm/plugin-api/host';
import * as Contract from '@axterm/plugin-api/transfers';
import { z, ZodError } from 'zod';
import { DomainCommands } from '@axterm/infra-storage-domain';
import { productDomains } from '@axterm/data-schema';
import { OwnedTransferRepository } from './adapters/transfer-repository.ts';
import { TransferControls } from './adapters/runtime-controls.ts';
import { NativeArchiveStaging } from './adapters/archive-staging.ts';
import { ArchiveTransferWorkflow } from './application/archive-workflow.ts';
import { TransferService } from './application/transfer-service.ts';
import { ApplicationError } from './application/errors.ts';
import { TransferSnapshotObservation } from './observation.ts';
import { TransferProgress } from './progress.ts';
export const inject = [
  'storage',
  'storageDomain',
  'runtimeIdentity',
  'desktopTaskInspection',
  'files',
  'connections',
];
declare module '@deepseek-ai/cordis' {
  interface Context {
    transfersController: TransfersController;
  }
}
export class TransfersController extends TypertRemoteService {
  private readonly lifetime = new AbortController();
  private readonly controls = new TransferControls();
  private open = true;
  private closing: Promise<void> | undefined;
  constructor(
    ctx: Context,
    private readonly app: TransferService,
    private readonly commands: DomainCommands,
    private readonly facts: TransferSnapshotObservation,
    private readonly progress: TransferProgress,
  ) {
    super(ctx, 'transfersController', { namespace: 'transfers' });
    ctx.effect(() => () => this.close());
    ctx.desktopTaskInspection.register('transfers', {
      inspect: (signal) => {
        signal.throwIfAborted();
        return { active: app.resourceCount() > 0 };
      },
      dispose: () => this.close(),
    });
  }
  resourceSnapshot(): Readonly<Record<string, number>> {
    return Object.freeze({
      transfers: this.app.resourceCount(),
      transferFactFollowers: this.facts.resourceCount(),
      realtimeSubscribers: this.progress.resourceCount(),
    });
  }
  @Remote listTransfers(): Contract.Transfer[] {
    return this.call(() => this.app.list());
  }
  @Remote({ resources: { transfer: (id: string) => id } }) getTransfer(
    id: string,
  ): Contract.Transfer {
    return this.call(() => this.app.get(z.uuid().parse(id)));
  }
  @Remote getCreateTransferOutcome(
    generation: string,
    key: string,
  ): Contract.TransferCommandOutcome {
    return this.call(() => {
      if (generation !== this.ctx.runtimeIdentity.generation)
        throw new RemoteError('transfers/failure', 'Transfer generation changed', {
          reason: 'conflict',
        });
      return this.app.commandOutcome(z.uuid().parse(key));
    });
  }
  @Remote createTransfer(key: string, input: Contract.CreateTransferInput): Contract.Transfer {
    return this.call(() => this.app.create(Contract.createTransferSchema.parse(input), key));
  }
  @Remote({ resources: { transfer: (_key: string, id: string) => id } }) cancelTransfer(
    key: string,
    id: string,
  ): { accepted: true } {
    return this.control(key, 'cancel', id, () => {
      this.app.cancel(id);
      return { accepted: true };
    });
  }
  @Remote({ resources: { transfer: (_key: string, id: string) => id } }) pauseTransfer(
    key: string,
    id: string,
  ): { accepted: true } {
    return this.control(key, 'pause', id, () => {
      this.app.pause(id);
      return { accepted: true };
    });
  }
  @Remote({ resources: { transfer: (_key: string, id: string) => id } }) resumeTransfer(
    key: string,
    id: string,
  ): { accepted: true } {
    return this.control(key, 'resume', id, () => {
      this.app.resume(id);
      return { accepted: true };
    });
  }
  @Remote({ resources: { transfer: (_key: string, id: string) => id } }) retryTransfer(
    key: string,
    id: string,
  ): Contract.Transfer {
    return this.control(key, 'retry', id, () => this.app.retry(id));
  }
  @Remote({ resources: { transfer: (_key: string, id: string) => id } }) resolveTransferConflict(
    key: string,
    id: string,
    input: Contract.TransferConflictDecision,
  ): { accepted: true } {
    return this.call(() => {
      const decision = Contract.transferConflictDecisionSchema.parse(input);
      return this.controls.execute(key, 'decision', { id: z.uuid().parse(id), decision }, () => {
        this.app.decideConflict(id, decision);
        return { accepted: true };
      });
    });
  }
  @Remote clearCompletedTransfers(key: string): { cleared: number } {
    return this.call(() =>
      this.commands.execute(key, 'clearCompletedTransfers', {}, () => ({
        cleared: this.app.clearCompleted(),
      })),
    );
  }
  @Remote({ mode: 'stream' }) watchTransfers(
    signal: AbortSignal,
  ): AsyncIterable<Contract.TransfersUpdate> {
    return this.call(() => this.facts.watch(AbortSignal.any([signal, this.lifetime.signal])));
  }
  @Remote({ mode: 'stream' }) watchTransferProgress(
    signal: AbortSignal,
  ): AsyncIterable<Contract.TransferProgressSnapshot> {
    return this.call(() => this.progress.watch(AbortSignal.any([signal, this.lifetime.signal])));
  }
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.open = false;
    this.controls.close();
    this.lifetime.abort();
    return (this.closing = (async () => {
      await Promise.all([this.facts.dispose(), this.progress.close()]);
      await this.app.closeAll();
    })());
  }
  private control<T>(key: string, operation: string, id: string, perform: () => T): T {
    return this.call(() =>
      this.controls.execute(key, operation, { id: z.uuid().parse(id) }, perform),
    );
  }
  private call<T>(perform: () => T): T {
    if (!this.open)
      throw new RemoteError('transfers/failure', 'Transfer services are closed', {
        reason: 'closed',
      });
    try {
      return perform();
    } catch (error) {
      const marked = remoteErrorOf(error);
      if (marked?.code === 'transfers/failure') throw marked;
      let reason: Contract.TransfersFailureReason = 'unavailable';
      if (error instanceof ZodError) reason = 'invalid-input';
      else if (error instanceof StorageCommandError)
        reason =
          error.code === 'conflict'
            ? 'conflict'
            : error.code === 'receipt-expired'
              ? 'receipt-expired'
              : 'invalid-input';
      else if (error instanceof ApplicationError)
        reason =
          error.code === 'NOT_FOUND'
            ? 'not-found'
            : error.code === 'CAPACITY_EXCEEDED'
              ? 'capacity'
              : error.code === 'VALIDATION_ERROR'
                ? 'invalid-input'
                : error.code === 'INVALID_STATE'
                  ? 'conflict'
                  : 'unavailable';
      throw new RemoteError('transfers/failure', 'The transfer operation failed', { reason });
    }
  }
}
export async function apply(ctx: Context, config: unknown): Promise<void> {
  const { profile } = z
    .object({ profile: z.string().min(1).max(128) })
    .strict()
    .parse(config);
  const opening = ctx.storage.domain.open(productDomains.transfers);
  const state: {
    controller?: TransfersController;
    service?: TransferService;
    progress?: TransferProgress;
    observation?: TransferSnapshotObservation;
  } = {};
  ctx.effect(() => async () => {
    try {
      await state.controller?.close();
      await state.service?.closeAll();
      await state.observation?.dispose();
      await state.progress?.close();
    } finally {
      await (await opening.catch(() => undefined))?.close();
    }
  });
  const domain = await opening;
  const repository = new OwnedTransferRepository(domain, profile, ctx.runtimeIdentity.generation);
  const archive = new ArchiveTransferWorkflow(new NativeArchiveStaging());
  const progress = (state.progress = new TransferProgress(ctx.runtimeIdentity.generation, () => ({
    items: state.service!.progressSnapshot(),
    factCursor: repository.cursor(),
  })));
  const service = (state.service = new TransferService(
    ctx.connections,
    ctx.files,
    repository,
    progress,
    archive,
  ));
  const observation = (state.observation = new TransferSnapshotObservation(
    ctx.runtimeIdentity.generation,
    async () => ({
      items: service!.facts(),
      factCursor: repository.cursor(),
      hasMore: repository.hasMore(),
      limit: 500,
    }),
  ));
  const controller = (state.controller = new TransfersController(
    ctx,
    service,
    new DomainCommands(domain, 'axterm_transfer_fact_commands'),
    observation,
    progress,
  ));
  const owned = controller;
  ctx.provide('transfers', {
    create: (key, input) => owned.createTransfer(key, input),
    list: () => owned.listTransfers(),
    get: (id) => owned.getTransfer(id),
    cancel: (key, id) => {
      owned.cancelTransfer(key, id);
    },
    pause: (key, id) => {
      owned.pauseTransfer(key, id);
    },
    resume: (key, id) => {
      owned.resumeTransfer(key, id);
    },
    decideConflict: (key, id, input) => {
      owned.resolveTransferConflict(key, id, input);
    },
    retry: (key, id) => owned.retryTransfer(key, id),
  });
}
