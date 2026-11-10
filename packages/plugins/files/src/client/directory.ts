import type { Context } from '@deepseek-ai/cordis';
import type { FileDirectoryBaseline, FileDirectoryUpdate } from '@axterm/plugin-api/files';
import { RemoteStreamCarrierError, type RemoteStream } from '@axterm/infra-gateway/client';
import { FileDirectoryProjection } from './directory-projection.ts';
export type FileDirectoryState =
  | { readonly status: 'connecting' }
  | { readonly status: 'ready'; readonly baseline: FileDirectoryBaseline }
  | { readonly status: 'error'; readonly message: string };
export class FileDirectoryModel {
  private state: FileDirectoryState = { status: 'connecting' };
  private readonly listeners = new Set<() => void>();
  private stream: RemoteStream<FileDirectoryUpdate>;
  private done: Promise<void>;
  private disposed = false;
  private retrying: Promise<void> | undefined;
  private closing: Promise<void> | undefined;
  constructor(
    private readonly ctx: Context,
    readonly grantId: string,
    readonly path: string,
    private readonly released: () => void,
  ) {
    this.stream = this.open();
    this.done = this.consume(this.stream);
  }
  getSnapshot = (): FileDirectoryState => this.state;
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
    if (this.disposed) throw new Error('FILE_DIRECTORY_MODEL_CLOSED');
  }
  private open(): RemoteStream<FileDirectoryUpdate> {
    return this.ctx.remote.$stream({
      name: 'files.directory.' + this.grantId + ':' + this.path,
      open: (signal) =>
        this.ctx.remote.files.watchGrantedDirectory(this.grantId, this.path, signal),
      ended: () => new RemoteStreamCarrierError('Directory generation ended'),
    });
  }
  private async consume(stream: RemoteStream<FileDirectoryUpdate>): Promise<void> {
    const projection = new FileDirectoryProjection();
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
        this.publish({ status: 'error', message: 'Directory information is unavailable' });
    } finally {
      projection.reset();
    }
  }
  private publish(state: FileDirectoryState): void {
    if (this.disposed) return;
    this.state = Object.freeze(state);
    for (const listener of [...this.listeners]) {
      try {
        listener();
      } catch {
        console.warn('FILE_DIRECTORY_MODEL_OBSERVER_FAILED');
      }
    }
  }
}
