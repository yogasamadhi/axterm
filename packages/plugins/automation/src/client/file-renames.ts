import type { Context } from '@deepseek-ai/cordis';
import { RemoteStreamCarrierError, type RemoteStream } from '@axterm/infra-gateway/client';
import {
  renameBaselineSchema,
  type RenameBaseline,
  type RenameUpdate,
  type FileRenamePreview,
  type PreviewFileRenameInput,
  type FileRenameResult,
} from '@axterm/plugin-api/automation';
export class RenameProjection {
  private pending:
    { generation: string; revision: number; text: string; final: boolean } | undefined;
  private generation: string | undefined;
  private revision = -1;
  reset(): void {
    this.pending = undefined;
    this.generation = undefined;
    this.revision = -1;
  }
  accept(value: RenameUpdate): RenameBaseline | undefined {
    if (value.type === 'begin') {
      if (
        this.pending ||
        !Number.isSafeInteger(value.revision) ||
        value.revision < 0 ||
        (this.generation === value.generation && value.revision < this.revision)
      )
        throw new Error('RENAME_INVALID_BASELINE');
      this.pending = {
        generation: value.generation,
        revision: value.revision,
        text: '',
        final: false,
      };
    } else if (value.type === 'chunk') {
      const pending = this.pending;
      if (
        !pending ||
        pending.final ||
        value.offset !== pending.text.length ||
        typeof value.text !== 'string' ||
        value.text.length > 16384 ||
        pending.text.length + value.text.length > 16 * 1024 * 1024
      )
        throw new Error('RENAME_INVALID_FRAGMENT');
      pending.text += value.text;
      pending.final = value.final;
    } else {
      const pending = this.pending;
      if (!pending?.final || value.revision !== pending.revision)
        throw new Error('RENAME_INVALID_COMMIT');
      const baseline = renameBaselineSchema.parse(JSON.parse(pending.text));
      if (baseline.generation !== pending.generation || baseline.revision !== pending.revision)
        throw new Error('RENAME_INVALID_COMMIT');
      this.generation = pending.generation;
      this.revision = pending.revision;
      this.pending = undefined;
      return freeze(baseline);
    }
    return undefined;
  }
}
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
export type FileRenameState =
  | { readonly status: 'connecting' }
  | { readonly status: 'ready'; readonly baseline: RenameBaseline }
  | { readonly status: 'error'; readonly message: string };
/** Transient reviews are replaced on reconnect; completed commands are never replayed by the model. */
export class FileRenameModel {
  private state: FileRenameState = { status: 'connecting' };
  private readonly listeners = new Set<() => void>();
  private disposed = false;
  private stream: RemoteStream<RenameUpdate>;
  private done: Promise<void>;
  private retrying: Promise<void> | undefined;
  constructor(private readonly ctx: Context) {
    this.stream = this.open();
    this.done = this.consume(this.stream);
  }
  getSnapshot = (): FileRenameState => this.state;
  subscribe = (listener: () => void): (() => void) => {
    this.assert();
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  async preview(input: PreviewFileRenameInput): Promise<FileRenamePreview> {
    this.assert();
    const result = await this.ctx.remote.automation.previewFileRename(input);
    if (!result.ok) throw result.error;
    return result.value;
  }
  async run(key: string, id: string, signal: AbortSignal): Promise<FileRenameResult> {
    this.assert();
    const result = await this.ctx.remote.automation.runFileRename(key, id, signal);
    if (!result.ok) throw result.error;
    return result.value;
  }
  async discard(id: string): Promise<void> {
    this.assert();
    const result = await this.ctx.remote.automation.discardFileRename(id);
    if (!result.ok) throw result.error;
  }
  async recover(id: string, grantId: string): Promise<void> {
    this.assert();
    const result = await this.ctx.remote.automation.recoverFileRename(id, grantId);
    if (!result.ok) throw result.error;
  }
  retry(): Promise<void> {
    this.assert();
    return (this.retrying ??= (async () => {
      await this.stream.dispose();
      await this.done;
      if (!this.disposed) {
        this.publish({ status: 'connecting' });
        this.stream = this.open();
        this.done = this.consume(this.stream);
      }
    })().finally(() => {
      this.retrying = undefined;
    }));
  }
  async dispose(): Promise<void> {
    this.disposed = true;
    await this.stream.dispose();
    await this.done;
    await this.retrying;
    this.listeners.clear();
  }
  private assert(): void {
    if (this.disposed) throw new Error('RENAME_MODEL_CLOSED');
  }
  private open(): RemoteStream<RenameUpdate> {
    return this.ctx.remote.$stream({
      name: 'automation.file-renames',
      open: (signal) => this.ctx.remote.automation.watchFileRenames(signal),
      ended: () => new RemoteStreamCarrierError('File rename generation ended'),
    });
  }
  private async consume(stream: RemoteStream<RenameUpdate>): Promise<void> {
    const projection = new RenameProjection();
    let generation = 0;
    try {
      for await (const item of stream) {
        if (generation !== item.generation) {
          generation = item.generation;
          projection.reset();
          this.publish({ status: 'connecting' });
        }
        const baseline = projection.accept(item.value);
        if (baseline) {
          this.publish({ status: 'ready', baseline });
          item.accept();
        }
      }
    } catch {
      if (!this.disposed)
        this.publish({ status: 'error', message: 'File rename information is unavailable' });
    } finally {
      projection.reset();
    }
  }
  private publish(state: FileRenameState): void {
    if (this.disposed) return;
    this.state = state;
    for (const listener of [...this.listeners]) {
      try {
        listener();
      } catch {
        console.warn('RENAME_MODEL_OBSERVER_FAILED');
      }
    }
  }
}
declare module '@deepseek-ai/cordis' {
  interface Context {
    fileRenameModel: FileRenameModel;
  }
}
