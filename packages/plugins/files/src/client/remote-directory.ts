import type { Context } from '@deepseek-ai/cordis';
import {
  remoteFileTargetSchema,
  type RemoteFileTarget,
  type RemoteDirectoryBaseline,
  type RemoteDirectoryUpdate,
} from '@axterm/plugin-api/files';
import { RemoteStreamCarrierError, type RemoteStream } from '@axterm/infra-gateway/client';
import { RemoteDirectoryProjection } from './remote-directory-projection.ts';
export type RemoteDirectoryState =
  | { readonly status: 'connecting' }
  | { readonly status: 'ready'; readonly baseline: RemoteDirectoryBaseline }
  | { readonly status: 'error'; readonly message: string };
export class RemoteDirectoryModel {
  private state: RemoteDirectoryState = { status: 'connecting' };
  private readonly listeners = new Set<() => void>();
  private stream: RemoteStream<RemoteDirectoryUpdate>;
  private done: Promise<void>;
  private disposed = false;
  private retrying: Promise<void> | undefined;
  private closing: Promise<void> | undefined;
  constructor(
    private readonly ctx: Context,
    target: RemoteFileTarget,
    readonly path: string,
    private readonly released: () => void,
  ) {
    this.target = Object.freeze({ ...remoteFileTargetSchema.parse(target) });
    this.stream = this.open();
    this.done = this.consume(this.stream);
  }
  readonly target: Readonly<RemoteFileTarget>;
  getSnapshot = (): RemoteDirectoryState => this.state;
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
    if (this.disposed) throw new Error('REMOTE_DIRECTORY_MODEL_CLOSED');
  }
  private open(): RemoteStream<RemoteDirectoryUpdate> {
    return this.ctx.remote.$stream({
      name:
        'files.remote-directory.' +
        this.target.protocol +
        ':' +
        this.target.connectionId +
        ':' +
        this.path,
      open: (signal) => this.ctx.remote.files.watchRemoteDirectory(this.target, this.path, signal),
      ended: () => new RemoteStreamCarrierError('Directory generation ended'),
    });
  }
  private async consume(stream: RemoteStream<RemoteDirectoryUpdate>): Promise<void> {
    const projection = new RemoteDirectoryProjection();
    let generation = 0;
    try {
      for await (const item of stream) {
        if (generation !== item.generation) {
          generation = item.generation;
          projection.reset();
        }
        const baseline = projection.accept(item.value);
        if (baseline) {
          if (
            baseline.target.connectionId !== this.target.connectionId ||
            baseline.target.protocol !== this.target.protocol ||
            baseline.path !== this.path
          )
            throw new Error('REMOTE_DIRECTORY_IDENTITY_MISMATCH');
          this.publish({ status: 'ready', baseline });
          item.accept();
        }
      }
    } catch {
      if (!this.disposed)
        this.publish({ status: 'error', message: 'Directory information is unavailable' });
    } finally {
      projection.reset();
    }
  }
  private publish(state: RemoteDirectoryState): void {
    if (this.disposed) return;
    this.state = Object.freeze(state);
    for (const listener of [...this.listeners]) {
      try {
        listener();
      } catch {
        console.warn('REMOTE_DIRECTORY_MODEL_OBSERVER_FAILED');
      }
    }
  }
}
