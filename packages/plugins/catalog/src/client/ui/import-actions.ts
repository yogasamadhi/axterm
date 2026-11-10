import { remoteErrorOf } from '@axterm/plugin-api';
import type { FileGrantActions, FileGrant } from '@axterm/plugin-api/files';
import type {
  BookmarkTree,
  CommitSshConfigImportInput,
  PreviewSshConfigImportInput,
  CatalogImportReceipt,
} from '@axterm/plugin-api/catalog';
import type { CatalogModel } from '../index.ts';
import { chooseBrowserFile } from './browser-file.ts';
export type ImportCatalogModel = Pick<
  CatalogModel,
  'getSnapshot' | 'previewSshConfigImport' | 'commitSshConfigImport' | 'getSshConfigImportReport'
>;
export type ImportCommandState = {
  readonly status: 'idle' | 'submitting' | 'uncertain' | 'committed';
  readonly receipt?: CatalogImportReceipt;
};
/** One explicit import flow owns accepted commands and native/browser grants until actual drain. */
export class ImportDialogActions {
  private readonly lifetime = new AbortController();
  private readonly pending = new Set<Promise<unknown>>();
  private readonly grants = new Set<string>();
  private reservations = 0;
  private closing: Promise<void> | undefined;
  private readonly listeners = new Set<() => void>();
  private state: ImportCommandState = { status: 'idle' };
  private attempt:
    { key: string; input: CommitSshConfigImportInput; treeIfMatch: string } | undefined;
  constructor(
    private readonly model: ImportCatalogModel,
    private readonly files: FileGrantActions,
    readonly generation: string,
  ) {}
  getSnapshot = (): ImportCommandState => this.state;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private publish(value: ImportCommandState): void {
    this.state = value;
    for (const listener of this.listeners) {
      try {
        listener();
      } catch {
        console.warn('CATALOG_IMPORT_COMMAND_OBSERVER_FAILED');
      }
    }
  }
  createFileGrant(kind: 'open-file' | 'open-directory') {
    return this.acquireGrant(async () => {
      if (location.protocol === 'axterm-app:')
        return this.files.create({ kind }, this.lifetime.signal);
      if (kind === 'open-directory') throw new Error('CATALOG_IMPORT_DIRECTORY_UNAVAILABLE');
      const file = await chooseBrowserFile(this.lifetime.signal);
      if (file && file.size > 1024 * 1024) throw new Error('CATALOG_IMPORT_FILE_TOO_LARGE');
      return file ? this.files.importFile(file, false, this.lifetime.signal) : undefined;
    });
  }
  importFile(file: File) {
    return this.acquireGrant(async () => {
      if (file.size > 1024 * 1024) throw new Error('CATALOG_IMPORT_FILE_TOO_LARGE');
      return this.files.importFile(file, false, this.lifetime.signal);
    });
  }
  private acquireGrant(acquire: () => Promise<FileGrant | undefined>) {
    return this.task(async () => {
      if (this.grants.size + this.reservations >= 129)
        throw new Error('CATALOG_IMPORT_GRANT_CAPACITY');
      this.reservations++;
      try {
        const grant = await acquire();
        if (grant) this.grants.add(grant.grantId);
        this.lifetime.signal.throwIfAborted();
        return grant;
      } finally {
        this.reservations--;
      }
    });
  }
  revokeFileGrant(id: string): Promise<void> {
    if (this.closing) return this.closing;
    if (!this.grants.has(id)) return Promise.resolve();
    return this.cleanup(async () => {
      await this.files.revoke(id);
      this.grants.delete(id);
    });
  }
  previewSshConfigImport(input: PreviewSshConfigImportInput, signal?: AbortSignal) {
    const copied = structuredClone(input);
    return this.task(() => {
      if (this.state.status !== 'idle') throw new Error('CATALOG_IMPORT_ALREADY_SUBMITTED');
      return this.model.previewSshConfigImport(
        copied,
        AbortSignal.any([this.lifetime.signal, ...(signal ? [signal] : [])]),
      );
    });
  }
  commitSshConfigImport(input: CommitSshConfigImportInput, tree: BookmarkTree) {
    const copied = structuredClone(input);
    const treeIfMatch = tree.etag;
    return this.task(async () => {
      if (!this.state.receipt) {
        if (this.state.status === 'submitting') throw new Error('CATALOG_IMPORT_SUBMITTING');
        this.attempt ??= {
          key: crypto.randomUUID(),
          input: copied,
          treeIfMatch,
        };
        this.publish({ status: 'submitting' });
        try {
          const receipt = await this.model.commitSshConfigImport(
            this.attempt.key,
            this.attempt.input,
            this.attempt.treeIfMatch,
          );
          this.publish({ status: 'committed', receipt });
        } catch (error) {
          const marked = remoteErrorOf(error);
          const definitelyUncommitted =
            marked?.code === 'catalog/failure' &&
            [
              'invalid-input',
              'precondition-required',
              'precondition-failed',
              'conflict',
              'capacity',
            ].includes(marked.details.reason);
          if (definitelyUncommitted) {
            this.attempt = undefined;
            this.publish({ status: 'idle' });
          } else this.publish({ status: 'uncertain' });
          throw error;
        }
      }
      return this.model.getSshConfigImportReport(
        this.state.receipt!.reportId,
        this.lifetime.signal,
      );
    });
  }
  private task<T>(action: () => Promise<T>): Promise<T> {
    if (this.closing || this.pending.size >= 8)
      return Promise.reject(new Error('CATALOG_IMPORT_UI_CLOSED_OR_BUSY'));
    return this.cleanup(async () => {
      this.lifetime.signal.throwIfAborted();
      const state = this.model.getSnapshot();
      if (state.status !== 'ready' || state.baseline.generation !== this.generation)
        throw new Error('CATALOG_IMPORT_GENERATION_CHANGED');
      return action();
    });
  }
  private cleanup<T>(action: () => Promise<T>): Promise<T> {
    const task = Promise.resolve().then(action);
    this.pending.add(task);
    void task.then(
      () => this.pending.delete(task),
      () => this.pending.delete(task),
    );
    return task;
  }
  dispose(): Promise<void> {
    if (this.closing) return this.closing;
    const closed = Promise.withResolvers<void>();
    this.closing = closed.promise;
    this.lifetime.abort();
    void (async () => {
      await Promise.allSettled([...this.pending]);
      const failures: unknown[] = [];
      for (const id of this.grants) {
        try {
          await this.files.revoke(id);
          this.grants.delete(id);
        } catch (error) {
          failures.push(error);
        }
      }
      this.listeners.clear();
      if (failures.length) throw new AggregateError(failures, 'CATALOG_IMPORT_GRANTS_DRAIN_FAILED');
    })().then(closed.resolve, closed.reject);
    return closed.promise;
  }
}
