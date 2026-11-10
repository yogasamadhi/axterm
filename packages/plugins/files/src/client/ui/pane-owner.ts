import {
  grantedDirectoryPathSchema,
  remoteFilePathSchema,
  remoteFileTargetSchema,
  type FileDirectoryBaseline,
  type RemoteDirectoryBaseline,
  type RemoteFileTarget,
} from '@axterm/plugin-api/files';
import type { FileGrantsState } from '../index.ts';
export type FilePaneSource =
  | { readonly kind: 'local'; readonly grantId: string; readonly path: string }
  | { readonly kind: 'remote'; readonly target: RemoteFileTarget; readonly path: string };
export type FilePaneState =
  | { readonly status: 'empty' }
  | { readonly status: 'connecting'; readonly source: FilePaneSource }
  | { readonly status: 'error'; readonly source?: FilePaneSource; readonly message: 'unavailable' }
  | {
      readonly status: 'ready';
      readonly source: FilePaneSource;
      readonly baseline: FileDirectoryBaseline | RemoteDirectoryBaseline;
    };
interface DirectoryView {
  getSnapshot():
    | { readonly status: 'connecting' }
    | { readonly status: 'error'; readonly message: string }
    | {
        readonly status: 'ready';
        readonly baseline: FileDirectoryBaseline | RemoteDirectoryBaseline;
      };
  subscribe(listener: () => void): () => void;
  dispose(): Promise<void>;
}
interface Directories {
  getSnapshot(): FileGrantsState;
  subscribe(listener: () => void): () => void;
  openDirectory(grantId: string, path: string): DirectoryView;
  openRemoteDirectory(target: RemoteFileTarget, path: string): DirectoryView;
}
interface OwnedDirectory {
  model: DirectoryView;
  off: () => void;
  source: FilePaneSource;
  generation: string;
}
/** View composition only: published directory facts are references to their owner's accepted baseline. */
export class FilePaneOwner {
  private state: FilePaneState = Object.freeze({ status: 'empty' });
  private readonly listeners = new Set<() => void>();
  private readonly directories = new Set<OwnedDirectory>();
  private readonly pending = new Set<Promise<unknown>>();
  private current: OwnedDirectory | undefined;
  private sequence = 0;
  private queue: Promise<unknown> = Promise.resolve();
  private retiring: Promise<void> | undefined;
  private clearing: Promise<void> | undefined;
  private closing: Promise<void> | undefined;
  private closed = false;
  private generation: string | undefined;
  private readonly off: () => void;
  constructor(private readonly files: Directories) {
    this.generation = this.currentGeneration();
    this.off = files.subscribe(() => {
      const next = this.currentGeneration();
      if (next === this.generation) return;
      this.generation = next;
      this.sequence++;
      this.publish({ status: 'empty' });
      if (!this.retiring) {
        this.retiring = this.enqueue(() => this.releaseAll())
          .catch(() => {
            if (!this.closed) this.publish({ status: 'error', message: 'unavailable' });
          })
          .finally(() => {
            this.retiring = undefined;
          });
      }
    });
  }
  getSnapshot = (): FilePaneState => this.state;
  subscribe = (listener: () => void): (() => void) => {
    if (this.closed) throw Error('FILES_PANE_CLOSED');
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  resourceCount(): number {
    return this.directories.size + this.pending.size;
  }
  navigate(input: FilePaneSource): Promise<void> {
    if (this.closed) return Promise.reject(Error('FILES_PANE_CLOSED'));
    if (this.pending.size >= 2) return Promise.reject(Error('FILES_PANE_CAPACITY'));
    const generation = this.currentGeneration();
    if (!generation) return Promise.reject(Error('FILES_NOT_READY'));
    const source: FilePaneSource =
      input.kind === 'local'
        ? Object.freeze({
            kind: 'local',
            grantId: input.grantId,
            path: grantedDirectoryPathSchema.parse(input.path),
          })
        : Object.freeze({
            kind: 'remote',
            target: Object.freeze(remoteFileTargetSchema.parse(input.target)),
            path: remoteFilePathSchema.parse(input.path),
          });
    if (source.kind === 'local' && (!source.grantId || source.grantId.length > 256))
      return Promise.reject(Error('FILES_INVALID_GRANT'));
    const sequence = ++this.sequence;
    this.publish({ status: 'connecting', source });
    return this.enqueue(async () => {
      if (!this.accepts(sequence, generation)) return;
      await this.releaseAll();
      if (!this.accepts(sequence, generation)) return;
      const model =
        source.kind === 'local'
          ? this.files.openDirectory(source.grantId, source.path)
          : this.files.openRemoteDirectory(source.target, source.path);
      const record: OwnedDirectory = { model, source, generation, off: () => {} };
      this.directories.add(record);
      this.current = record;
      record.off = model.subscribe(() => this.acceptSnapshot(record));
      this.acceptSnapshot(record);
    }).catch((error) => {
      if (this.accepts(sequence, generation))
        this.publish({ status: 'error', source, message: 'unavailable' });
      throw error;
    });
  }
  clear(): Promise<void> {
    if (this.closed) return Promise.reject(Error('FILES_PANE_CLOSED'));
    this.sequence++;
    this.publish({ status: 'empty' });
    return (this.clearing ??= this.enqueue(() => this.releaseAll()).finally(() => {
      this.clearing = undefined;
    }));
  }
  refresh(): Promise<void> {
    const source = 'source' in this.state ? this.state.source : undefined;
    return source ? this.navigate(source) : Promise.resolve();
  }
  dispose(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    this.sequence++;
    this.off();
    this.listeners.clear();
    this.state = Object.freeze({ status: 'empty' });
    return (this.closing = (async () => {
      await this.queue.catch(() => {});
      await this.releaseAll();
      if (this.directories.size) throw Error('FILES_PANE_UNDRAINED');
    })());
  }
  private currentGeneration() {
    const state = this.files.getSnapshot();
    return state.status === 'ready' ? state.baseline.generation : undefined;
  }
  private accepts(sequence: number, generation: string) {
    return !this.closed && sequence === this.sequence && generation === this.currentGeneration();
  }
  private acceptSnapshot(record: OwnedDirectory) {
    if (this.closed || this.current !== record || record.generation !== this.currentGeneration())
      return;
    const state = record.model.getSnapshot(),
      source = record.source;
    if (state.status === 'connecting') {
      this.publish({ status: 'connecting', source });
      return;
    }
    if (state.status === 'error') {
      this.publish({ status: 'error', source, message: 'unavailable' });
      return;
    }
    const baseline = state.baseline;
    const matches =
      baseline.generation === record.generation &&
      baseline.path === source.path &&
      (source.kind === 'local'
        ? 'grantId' in baseline && baseline.grantId === source.grantId
        : 'target' in baseline &&
          baseline.target.protocol === source.target.protocol &&
          baseline.target.connectionId === source.target.connectionId);
    if (!matches) {
      this.publish({ status: 'error', source, message: 'unavailable' });
      return;
    }
    this.publish({ status: 'ready', source, baseline });
  }
  private async releaseAll() {
    this.current = undefined;
    const results = await Promise.allSettled(
      [...this.directories].map(async (record) => {
        const closed = await Promise.allSettled([
          Promise.resolve().then(() => record.off()),
          Promise.resolve().then(() => record.model.dispose()),
        ]);
        if (closed.some((result) => result.status === 'rejected'))
          throw Error('FILES_PANE_UNDRAINED');
        this.directories.delete(record);
      }),
    );
    if (results.some((result) => result.status === 'rejected')) throw Error('FILES_PANE_UNDRAINED');
  }
  private enqueue<T>(perform: () => Promise<T>): Promise<T> {
    const task = this.queue.catch(() => {}).then(perform);
    this.queue = task;
    this.pending.add(task);
    void task.finally(() => this.pending.delete(task)).catch(() => {});
    return task;
  }
  private publish(state: FilePaneState) {
    if (this.closed) return;
    this.state = Object.freeze(state);
    for (const listener of [...this.listeners]) {
      try {
        listener();
      } catch {
        console.warn('FILES_PANE_OBSERVER_FAILED');
      }
    }
  }
}
