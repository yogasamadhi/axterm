import type { Context } from '@deepseek-ai/cordis';
import { type ExternalEditorsBaseline, type ExternalEditorsUpdate } from '@axterm/plugin-api/files';
import { RemoteStreamCarrierError, type RemoteStream } from '@axterm/infra-gateway/client';
import { ExternalEditorsProjection } from './external-editors-projection.ts';
export type ExternalEditorsState =
  | { readonly status: 'connecting' }
  | { readonly status: 'ready'; readonly baseline: ExternalEditorsBaseline }
  | { readonly status: 'error'; readonly message: string };
export class ExternalEditorsModel {
  private state: ExternalEditorsState = { status: 'connecting' };
  private readonly listeners = new Set<() => void>();
  private stream: RemoteStream<ExternalEditorsUpdate>;
  private done: Promise<void>;
  private disposed = false;
  private retrying: Promise<void> | undefined;
  private closing: Promise<void> | undefined;
  constructor(
    private readonly ctx: Context,
    private readonly released: () => void,
  ) {
    this.stream = this.open();
    this.done = this.consume(this.stream);
  }
  getSnapshot = (): ExternalEditorsState => this.state;
  subscribe = (listener: () => void): (() => void) => {
    this.assertOpen();
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  retry(): Promise<void> {
    this.assertOpen();
    return (this.retrying ??= (async () => {
      await this.stream.dispose();
      await this.done;
      if (!this.disposed) {
        this.stream = this.open();
        this.done = this.consume(this.stream);
      }
    })().finally(() => {
      this.retrying = undefined;
    }));
  }
  dispose(): Promise<void> {
    return (this.closing ??= (async () => {
      this.disposed = true;
      await this.stream.dispose();
      await this.done;
      await this.retrying;
      this.listeners.clear();
      this.released();
    })());
  }
  private assertOpen(): void {
    if (this.disposed) throw new Error('EXTERNAL_EDITORS_MODEL_CLOSED');
  }
  private open(): RemoteStream<ExternalEditorsUpdate> {
    return this.ctx.remote.$stream({
      name: 'files.external-editors',
      open: (signal) => this.ctx.remote.files.watchExternalEditors(signal),
      ended: () => new RemoteStreamCarrierError('External editor generation ended'),
    });
  }
  private async consume(stream: RemoteStream<ExternalEditorsUpdate>): Promise<void> {
    const projection = new ExternalEditorsProjection();
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
        this.publish({ status: 'error', message: 'External editor information is unavailable' });
    } finally {
      projection.reset();
    }
  }
  private publish(state: ExternalEditorsState): void {
    if (this.disposed) return;
    this.state = Object.freeze(state);
    for (const listener of [...this.listeners]) {
      try {
        listener();
      } catch {
        console.warn('EXTERNAL_EDITORS_MODEL_OBSERVER_FAILED');
      }
    }
  }
}
