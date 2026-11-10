import type { Context } from '@deepseek-ai/cordis';
import { RemoteStreamCarrierError, type RemoteStream } from '@axterm/infra-gateway/client';
import remote from '@axterm/plugin-transfers/remote';
import * as Contract from '@axterm/plugin-api/transfers';
import { TransfersProjection } from './projection.ts';
export type TransfersState =
  | { readonly status: 'connecting' }
  | { readonly status: 'ready'; readonly baseline: Contract.TransfersBaseline }
  | { readonly status: 'error'; readonly message: string };
export class TransfersModel {
  private state: TransfersState = { status: 'connecting' };
  private readonly listeners = new Set<() => void>();
  private facts: Contract.TransfersBaseline | undefined;
  private progress: Contract.TransferProgressSnapshot | undefined;
  private factStream: RemoteStream<Contract.TransfersUpdate>;
  private progressStream: RemoteStream<Contract.TransferProgressSnapshot>;
  private factDone: Promise<void>;
  private progressDone: Promise<void>;
  private disposed = false;
  private retrying: Promise<void> | undefined;
  constructor(private readonly ctx: Context) {
    this.factStream = this.openFacts();
    this.progressStream = this.openProgress();
    this.factDone = this.consumeFacts(this.factStream);
    this.progressDone = this.consumeProgress(this.progressStream);
  }
  getSnapshot = (): TransfersState => this.state;
  subscribe = (listener: () => void): (() => void) => {
    this.assert();
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  async getCommandOutcome(
    generation: string,
    key: string,
  ): Promise<Contract.TransferCommandOutcome> {
    this.assert();
    const result = await this.ctx.remote.transfers.getCreateTransferOutcome(generation, key);
    if (!result.ok) throw result.error;
    return Contract.transferCommandOutcomeSchema.parse(result.value);
  }
  async create(key: string, input: Contract.CreateTransferInput): Promise<Contract.Transfer> {
    this.assert();
    const result = await this.ctx.remote.transfers.createTransfer(key, input);
    if (!result.ok) throw result.error;
    return result.value;
  }
  async get(id: string): Promise<Contract.Transfer> {
    this.assert();
    const result = await this.ctx.remote.transfers.getTransfer(id);
    if (!result.ok) throw result.error;
    return result.value;
  }
  async cancel(key: string, id: string): Promise<void> {
    this.assert();
    const result = await this.ctx.remote.transfers.cancelTransfer(key, id);
    if (!result.ok) throw result.error;
  }
  async pause(key: string, id: string): Promise<void> {
    this.assert();
    const result = await this.ctx.remote.transfers.pauseTransfer(key, id);
    if (!result.ok) throw result.error;
  }
  async resume(key: string, id: string): Promise<void> {
    this.assert();
    const result = await this.ctx.remote.transfers.resumeTransfer(key, id);
    if (!result.ok) throw result.error;
  }
  async retryTransfer(key: string, id: string): Promise<Contract.Transfer> {
    this.assert();
    const result = await this.ctx.remote.transfers.retryTransfer(key, id);
    if (!result.ok) throw result.error;
    return result.value;
  }
  async decideConflict(
    key: string,
    id: string,
    input: Contract.TransferConflictDecision,
  ): Promise<void> {
    this.assert();
    const result = await this.ctx.remote.transfers.resolveTransferConflict(key, id, input);
    if (!result.ok) throw result.error;
  }
  async clearCompleted(key: string): Promise<number> {
    this.assert();
    const result = await this.ctx.remote.transfers.clearCompletedTransfers(key);
    if (!result.ok) throw result.error;
    return result.value.cleared;
  }
  retry(): Promise<void> {
    this.assert();
    return (this.retrying ??= (async () => {
      await Promise.all([this.factStream.dispose(), this.progressStream.dispose()]);
      await Promise.all([this.factDone, this.progressDone]);
      if (this.disposed) return;
      this.facts = undefined;
      this.progress = undefined;
      this.publish({ status: 'connecting' });
      this.factStream = this.openFacts();
      this.progressStream = this.openProgress();
      this.factDone = this.consumeFacts(this.factStream);
      this.progressDone = this.consumeProgress(this.progressStream);
    })().finally(() => {
      this.retrying = undefined;
    }));
  }
  async dispose(): Promise<void> {
    this.disposed = true;
    await Promise.all([this.factStream.dispose(), this.progressStream.dispose()]);
    await Promise.all([this.factDone, this.progressDone]);
    await this.retrying;
    this.facts = undefined;
    this.progress = undefined;
    this.listeners.clear();
  }
  private assert(): void {
    if (this.disposed) throw new Error('TRANSFERS_MODEL_CLOSED');
  }
  private openFacts(): RemoteStream<Contract.TransfersUpdate> {
    return this.ctx.remote.$stream({
      name: 'transfers.facts',
      open: (signal) => this.ctx.remote.transfers.watchTransfers(signal),
      ended: () => new RemoteStreamCarrierError('Transfer facts generation ended'),
    });
  }
  private openProgress(): RemoteStream<Contract.TransferProgressSnapshot> {
    return this.ctx.remote.$stream({
      name: 'transfers.progress',
      open: (signal) => this.ctx.remote.transfers.watchTransferProgress(signal),
      ended: () => new RemoteStreamCarrierError('Transfer progress generation ended'),
    });
  }
  private async consumeFacts(stream: RemoteStream<Contract.TransfersUpdate>): Promise<void> {
    const projection = new TransfersProjection();
    let generation = 0;
    try {
      for await (const item of stream) {
        if (generation !== item.generation) {
          generation = item.generation;
          projection.reset();
          this.facts = undefined;
        }
        const baseline = projection.accept(item.value);
        if (baseline) {
          this.facts = baseline;
          this.update();
          item.accept();
        }
      }
    } catch {
      if (!this.disposed)
        this.publish({ status: 'error', message: 'Transfer facts are unavailable' });
    } finally {
      projection.reset();
    }
  }
  private async consumeProgress(
    stream: RemoteStream<Contract.TransferProgressSnapshot>,
  ): Promise<void> {
    let generation = 0;
    try {
      for await (const item of stream) {
        if (generation !== item.generation) {
          generation = item.generation;
          this.progress = undefined;
        }
        const snapshot = Contract.transferProgressSnapshotSchema.parse(item.value);
        if (
          this.progress &&
          (this.progress.generation !== snapshot.generation ||
            snapshot.revision <= this.progress.revision)
        )
          throw new Error('TRANSFER_PROGRESS_INVALID');
        this.progress = snapshot;
        this.update();
        item.accept();
      }
    } catch {
      if (!this.disposed)
        this.publish({ status: 'error', message: 'Transfer progress is unavailable' });
    }
  }
  private update(): void {
    if (!this.facts || !this.progress || this.facts.generation !== this.progress.generation) return;
    const progress =
      this.progress.factCursor >= this.facts.factCursor
        ? new Map(this.progress.items.map((item) => [item.id, item]))
        : new Map();
    const items = this.facts.items.map((fact) => {
      const value = progress.get(fact.id);
      return Contract.transferSchema.parse(
        value && fact.updatedAt <= value.updatedAt ? { ...fact, ...value } : fact,
      );
    });
    this.publish({ status: 'ready', baseline: freeze({ ...this.facts, items }) });
  }
  private publish(state: TransfersState): void {
    if (this.disposed) return;
    this.state = state;
    for (const listener of [...this.listeners]) {
      try {
        listener();
      } catch {
        console.warn('TRANSFERS_MODEL_OBSERVER_FAILED');
      }
    }
  }
}
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const item of Object.values(value)) freeze(item);
    Object.freeze(value);
  }
  return value;
}
declare module '@deepseek-ai/cordis' {
  interface Context {
    transfersModel: TransfersModel;
  }
}
export const inject = ['typert', 'remote', 'connection'];
export async function apply(ctx: Context): Promise<void> {
  const unmount = await ctx.remote.$mount(remote);
  ctx.effect(() => unmount);
  await ctx.inject(['remote.transfers'], (scope) => {
    const model = new TransfersModel(scope);
    scope.provide('transfersModel', model);
    scope.provide('transferActions', {
      getCommandOutcome: (generation, key) => model.getCommandOutcome(generation, key),
      getSnapshot: model.getSnapshot,
      subscribe: model.subscribe,
      retry: () => model.retry(),
      create: (key, input) => model.create(key, input),
      get: (id) => model.get(id),
      cancel: (key, id) => model.cancel(key, id),
      pause: (key, id) => model.pause(key, id),
      resume: (key, id) => model.resume(key, id),
      retryTransfer: (key, id) => model.retryTransfer(key, id),
      decideConflict: (key, id, input) => model.decideConflict(key, id, input),
      clearCompleted: (key) => model.clearCompleted(key),
    });
    scope.effect(() => () => model.dispose());
    scope.inject(['workspaceUi', 'slots', 'locale', 'filesWorkspaceUi'], async (ui) => {
      const { installTransferUi } = await import('./ui/index.tsx');
      if (ui.fiber.uid !== null) installTransferUi(ui, model);
    });
  });
}
