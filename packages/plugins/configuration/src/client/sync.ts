import { ImportAutosaveGuard } from './import-autosave.ts';
import { RemoteError } from '@axterm/plugin-api';
import type { Context } from '@deepseek-ai/cordis';
import type {
  SyncBaseline,
  SyncUpdate,
  SyncProfileInput,
  SyncProfilePatch,
  SyncProfile,
  SyncOperation,
  SyncCommandOutcome,
  AxtermSyncCommitResult,
} from '@axterm/plugin-api/configuration-sync';
import type { AxtermConfigurationPreview } from '@axterm/plugin-api/configuration-portable';
import { RemoteStreamCarrierError, type RemoteStream } from '@axterm/infra-gateway/client';
import { SyncProjection } from './sync-projection.ts';
export type SyncState =
  | { readonly status: 'connecting' }
  | {
      readonly status: 'ready';
      readonly baseline: SyncBaseline;
      readonly outcome?: SyncCommandOutcome;
      readonly preview?: AxtermConfigurationPreview;
    }
  | { readonly status: 'error'; readonly message: string };
/** Configuration model owns metadata. Every IO submission has one fresh nonce; outcome queries never resubmit. */
export class SyncModel {
  private state: SyncState = { status: 'connecting' };
  private readonly listeners = new Set<() => void>();
  private readonly commands = new Set<Promise<unknown>>();
  private stream: RemoteStream<SyncUpdate>;
  private done: Promise<void>;
  private readonly lifetime = new AbortController();
  private closing = false;
  private readonly importAutosave = new ImportAutosaveGuard(() =>
    this.ctx.get('workspaceAutosaveUi'),
  );
  private disposed = false;
  private retrying: Promise<void> | undefined;
  constructor(private readonly ctx: Context) {
    this.stream = this.open();
    this.done = this.consume(this.stream);
  }
  getSnapshot = (): SyncState => this.state;
  subscribe = (listener: () => void): (() => void) => {
    this.assertOpen();
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  create(
    input: SyncProfileInput,
    commandId: string = crypto.randomUUID(),
    generation: string = this.generation(),
  ): Promise<SyncProfile> {
    const captured = structuredClone(input);
    return this.command(() =>
      this.ctx.remote.configuration.createSyncProfile(commandId, generation, captured),
    );
  }
  update(
    id: string,
    input: SyncProfilePatch,
    version: number,
    commandId: string = crypto.randomUUID(),
    generation: string = this.generation(),
  ): Promise<SyncProfile> {
    const captured = structuredClone(input);
    return this.command(() =>
      this.ctx.remote.configuration.updateSyncProfile(
        commandId,
        generation,
        id,
        captured,
        '"v' + version + '"',
      ),
    );
  }
  remove(
    id: string,
    version: number,
    commandId: string = crypto.randomUUID(),
    generation: string = this.generation(),
  ): Promise<void> {
    return this.command(() =>
      this.ctx.remote.configuration.deleteSyncProfile(
        commandId,
        generation,
        id,
        '"v' + version + '"',
      ),
    );
  }
  run(
    id: string,
    operation: SyncOperation,
    grantId?: string,
  ): { commandId: string; result: Promise<SyncCommandOutcome> } {
    const commandId = crypto.randomUUID();
    const generation = this.generation();
    return {
      commandId,
      result: this.command(async () => {
        const result = await this.ctx.remote.configuration.runSync(
          commandId,
          generation,
          id,
          operation,
          grantId,
          this.lifetime.signal,
        );
        if (
          result.ok &&
          this.state.status === 'ready' &&
          this.state.baseline.generation === generation
        )
          this.publish({ ...this.state, outcome: result.value });
        return result;
      }),
    };
  }
  outcome(commandId: string): Promise<SyncCommandOutcome> {
    return this.command(async () => {
      const generation = this.generation();
      const result = await this.ctx.remote.configuration.getSyncOutcome(commandId);
      if (
        result.ok &&
        this.state.status === 'ready' &&
        this.state.baseline.generation === generation
      )
        this.publish({ ...this.state, outcome: result.value });
      return result;
    });
  }
  cancel(commandId: string): Promise<void> {
    return this.command(() => this.ctx.remote.configuration.cancelSync(commandId));
  }
  preview(id: string): Promise<AxtermConfigurationPreview> {
    return this.command(async () => {
      const generation = this.generation();
      const result = await this.ctx.remote.configuration.getSyncDownloadPreview(id);
      if (
        result.ok &&
        this.state.status === 'ready' &&
        this.state.baseline.generation === generation
      )
        this.publish({ ...this.state, preview: result.value });
      return result;
    });
  }
  commit(
    id: string,
    previewId: string,
    commandId: string = crypto.randomUUID(),
  ): Promise<AxtermSyncCommitResult> {
    const generation = this.generation();
    return this.command(async () => {
      const value = await this.importAutosave.run(
        commandId,
        generation,
        () => this.state.status === 'ready' && this.state.baseline.generation === generation,
        async () => {
          const result = await this.ctx.remote.configuration.commitSyncDownload(
            commandId,
            generation,
            id,
            previewId,
          );
          if (!result.ok) throw result.error;
          return result.value;
        },
      );
      await this.observeProfile(generation, value.profile);
      return { ok: true as const, value };
    });
  }
  private observeProfile(generation: string, accepted: SyncProfile): Promise<void> {
    return new Promise((resolve, reject) => {
      let finished = false;
      const finish = (error?: Error) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        this.listeners.delete(check);
        this.lifetime.signal.removeEventListener('abort', aborted);
        if (error) reject(error);
        else resolve();
      };
      const aborted = () => finish(Error('SYNC_MODEL_CLOSED'));
      const check = () => {
        if (this.lifetime.signal.aborted) return aborted();
        if (this.state.status === 'error') return finish(Error('SYNC_UNAVAILABLE'));
        if (this.state.status !== 'ready') return;
        if (this.state.baseline.generation !== generation)
          return finish(Error('SYNC_GENERATION_RETIRED'));
        const current = this.state.baseline.profiles.find((item) => item.id === accepted.id);
        if (current && current.version >= accepted.version) finish();
      };
      const timer = setTimeout(() => finish(Error('SYNC_ACCEPTANCE_UNAVAILABLE')), 10_000);
      this.listeners.add(check);
      this.lifetime.signal.addEventListener('abort', aborted, { once: true });
      check();
    });
  }
  cancelDownload(id: string): Promise<SyncProfile> {
    return this.command(() =>
      this.ctx.remote.configuration.cancelSyncDownload(crypto.randomUUID(), this.generation(), id),
    );
  }
  private command<T>(
    operation: () => Promise<{ ok: true; value: T } | { ok: false; error: unknown }>,
  ): Promise<T> {
    this.assertOpen();
    if (this.commands.size >= 32) throw new Error('SYNC_COMMAND_CAPACITY');
    const task = Promise.resolve()
      .then(operation)
      .then((result) => {
        if (!result.ok) throw result.error;
        return result.value;
      });
    this.commands.add(task);
    void task.then(
      () => this.commands.delete(task),
      () => this.commands.delete(task),
    );
    return task;
  }
  private generation(): string {
    this.assertOpen();
    if (this.state.status !== 'ready')
      throw new RemoteError('configuration/sync-failure', 'Sync is unavailable', {
        reason: 'unavailable',
      });
    return this.state.baseline.generation;
  }
  retry(): Promise<void> {
    this.assertOpen();
    return (this.retrying ??= (async () => {
      await this.stream.dispose();
      await this.done;
      if (!this.closing) {
        this.stream = this.open();
        this.done = this.consume(this.stream);
      }
    })().finally(() => {
      this.retrying = undefined;
    }));
  }
  async dispose(): Promise<void> {
    this.closing = true;
    this.lifetime.abort();
    await Promise.allSettled([...this.commands]);
    await this.importAutosave.close();
    this.disposed = true;
    await this.stream.dispose();
    await this.done;
    await this.retrying;
    this.listeners.clear();
  }
  private assertOpen(): void {
    if (this.closing) throw new Error('SYNC_MODEL_CLOSED');
  }
  private open(): RemoteStream<SyncUpdate> {
    return this.ctx.remote.$stream({
      name: 'configuration.sync',
      open: (signal) => this.ctx.remote.configuration.watchSync(signal),
      ended: () => new RemoteStreamCarrierError('Sync generation ended'),
    });
  }
  private async consume(stream: RemoteStream<SyncUpdate>): Promise<void> {
    const projection = new SyncProjection();
    let generation = 0;
    try {
      for await (const item of stream) {
        if (generation !== item.generation) {
          generation = item.generation;
          projection.reset();
        }
        const baseline = projection.accept(item.value);
        if (baseline) {
          const previous = this.state;
          this.publish({
            ...(previous.status === 'ready' && previous.baseline.generation === baseline.generation
              ? previous
              : {}),
            status: 'ready',
            baseline,
          });
          item.accept();
        }
      }
    } catch {
      if (!this.disposed) this.publish({ status: 'error', message: 'Sync is unavailable' });
    } finally {
      projection.reset();
    }
  }
  private publish(state: SyncState): void {
    if (this.disposed) return;
    this.state = state;
    for (const listener of [...this.listeners]) {
      try {
        listener();
      } catch {
        console.warn('SYNC_OBSERVER_FAILED');
      }
    }
  }
}
declare module '@deepseek-ai/cordis' {
  interface Context {
    syncModel: SyncModel;
  }
}
