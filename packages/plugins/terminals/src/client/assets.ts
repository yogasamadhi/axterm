import type { Context } from '@deepseek-ai/cordis';
import type * as Contract from '@axterm/plugin-api/terminals';
import type { TerminalAssetsBaseline, TerminalAssetsUpdate } from '@axterm/plugin-api/terminals';
import { RemoteStreamCarrierError, type RemoteStream } from '@axterm/infra-gateway/client';
import { TerminalAssetsProjection } from './assets-projection.ts';
export type TerminalAssetsState =
  | { readonly status: 'connecting' }
  | { readonly status: 'ready'; readonly baseline: TerminalAssetsBaseline }
  | { readonly status: 'error'; readonly message: string };
export class TerminalAssetsModel {
  private state: TerminalAssetsState = { status: 'connecting' };
  private readonly listeners = new Set<() => void>();
  private stream: RemoteStream<TerminalAssetsUpdate>;
  private done: Promise<void>;
  private disposed = false;
  private closing = false;
  private readonly calls = new Set<Promise<unknown>>();
  private retrying: Promise<void> | undefined;
  constructor(private readonly ctx: Context) {
    this.stream = this.open();
    this.done = this.consume(this.stream);
  }
  getSnapshot = (): TerminalAssetsState => this.state;
  subscribe = (listener: () => void): (() => void) => {
    this.assertOpen();
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  async importAsset(
    key: string,
    grantId: string,
    generation: string,
  ): Promise<Contract.TerminalAssetReceipt> {
    this.assertOpen();
    if (this.generation() !== generation) throw Error('TERMINAL_ASSETS_GENERATION_CHANGED');
    const result = await this.call(() =>
      this.ctx.remote.terminals.importTerminalBackgroundAsset(key, grantId, generation),
    );
    if (!result.ok) throw result.error;
    return result.value;
  }
  async deleteAsset(
    key: string,
    id: string,
    version: number,
    generation: string,
  ): Promise<Contract.TerminalAssetDeleteReceipt> {
    this.assertOpen();
    if (this.generation() !== generation) throw Error('TERMINAL_ASSETS_GENERATION_CHANGED');
    const result = await this.call(() =>
      this.ctx.remote.terminals.deleteTerminalBackgroundAsset(key, id, version, generation),
    );
    if (!result.ok) throw result.error;
    return result.value;
  }
  async content(
    id: string,
    generation: string,
    signal?: AbortSignal,
  ): Promise<Contract.TerminalBackgroundContentDescriptor> {
    this.assertOpen();
    if (this.generation() !== generation) throw Error('TERMINAL_ASSETS_GENERATION_CHANGED');
    const result = await this.call(() =>
      this.ctx.remote.terminals.getTerminalBackgroundAssetContent(id, generation, signal),
    );
    if (!result.ok) throw result.error;
    return result.value;
  }
  retry(): Promise<void> {
    this.assertOpen();
    return (this.retrying ??= (async () => {
      await this.stream.dispose();
      await this.done;
      if (!this.disposed && !this.closing) {
        this.stream = this.open();
        this.done = this.consume(this.stream);
      }
    })().finally(() => {
      this.retrying = undefined;
    }));
  }
  async dispose(): Promise<void> {
    this.closing = true;
    await Promise.allSettled([...this.calls]);
    this.disposed = true;
    await this.stream.dispose();
    await this.done;
    await this.retrying;
    this.listeners.clear();
  }
  private generation(): string {
    if (this.state.status !== 'ready') throw Error('TERMINAL_ASSETS_MODEL_NOT_READY');
    return this.state.baseline.generation;
  }
  private call<T>(invoke: () => Promise<T>): Promise<T> {
    this.assertOpen();
    if (this.calls.size >= 32) throw Error('TERMINAL_ASSETS_COMMAND_CAPACITY');
    const task = Promise.resolve().then(invoke);
    this.calls.add(task);
    void task.then(
      () => this.calls.delete(task),
      () => this.calls.delete(task),
    );
    return task;
  }
  private assertOpen(): void {
    if (this.disposed || this.closing) throw new Error('TERMINAL_ASSETS_MODEL_CLOSED');
  }
  private open(): RemoteStream<TerminalAssetsUpdate> {
    return this.ctx.remote.$stream({
      name: 'terminals.assets',
      open: (signal) => this.ctx.remote.terminals.watchTerminalBackgroundAssets(signal),
      ended: () => new RemoteStreamCarrierError('Terminal background assets generation ended'),
    });
  }
  private async consume(stream: RemoteStream<TerminalAssetsUpdate>): Promise<void> {
    const projection = new TerminalAssetsProjection();
    let generation = 0;
    try {
      for await (const item of stream) {
        if (generation !== item.generation) {
          generation = item.generation;
          projection.reset();
        }
        const baseline = projection.accept(item.value);
        if (baseline) {
          this.publish({ status: 'ready', baseline });
          item.accept();
        }
      }
    } catch {
      if (!this.disposed)
        this.publish({
          status: 'error',
          message: 'Terminal background assets information is unavailable',
        });
    } finally {
      projection.reset();
    }
  }
  private publish(state: TerminalAssetsState): void {
    if (this.disposed) return;
    this.state = Object.freeze(state);
    for (const listener of [...this.listeners]) {
      try {
        listener();
      } catch {
        console.warn('TERMINAL_ASSETS_MODEL_OBSERVER_FAILED');
      }
    }
  }
}
declare module '@deepseek-ai/cordis' {
  interface Context {
    terminalAssetsModel: TerminalAssetsModel;
  }
}
