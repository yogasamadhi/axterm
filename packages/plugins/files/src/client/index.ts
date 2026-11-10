import { ExternalEditorsModel } from './external-editors.ts';
export { ExternalEditorsModel } from './external-editors.ts';
export type { ExternalEditorsState } from './external-editors.ts';
import type { FileGrant, FileGrantRequest } from '@axterm/plugin-api/files';
import remote from '@axterm/plugin-files/remote';
import * as FileContract from '@axterm/plugin-api/files';
import { RemoteDirectoryModel } from './remote-directory.ts';
export { RemoteDirectoryModel } from './remote-directory.ts';
export type { RemoteDirectoryState } from './remote-directory.ts';
import { FileDirectoryModel } from './directory.ts';
export { FileDirectoryModel } from './directory.ts';
export type { FileDirectoryState } from './directory.ts';
import type { Context } from '@deepseek-ai/cordis';
import type { FileGrantsBaseline, FileGrantsUpdate } from '@axterm/plugin-api/files';
import { RemoteStreamCarrierError, type RemoteStream } from '@axterm/infra-gateway/client';
import { FileGrantsProjection } from './projection.ts';
import { ManagedFileImportModel } from './imports.ts';
export type FileGrantsState =
  | { readonly status: 'connecting' }
  | { readonly status: 'ready'; readonly baseline: FileGrantsBaseline }
  | { readonly status: 'error'; readonly message: string };
export class FileGrantsModel {
  private state: FileGrantsState = { status: 'connecting' };
  private readonly listeners = new Set<() => void>();
  private stream: RemoteStream<FileGrantsUpdate>;
  private done: Promise<void>;
  private disposed = false;
  private readonly directories = new Set<
    FileDirectoryModel | RemoteDirectoryModel | ExternalEditorsModel
  >();
  private readonly lifetime = new AbortController();
  private retrying: Promise<void> | undefined;
  private readonly imports: ManagedFileImportModel;
  private closing: Promise<void> | undefined;
  constructor(
    private readonly ctx: Context,
    request?: (input: string, init: RequestInit) => Promise<Response>,
  ) {
    this.imports = new ManagedFileImportModel(
      () => (this.state.status === 'ready' ? this.state.baseline.generation : undefined),
      request,
    );
    this.stream = this.open();
    this.done = this.consume(this.stream);
  }
  getSnapshot = (): FileGrantsState => this.state;
  subscribe = (listener: () => void): (() => void) => {
    this.assertOpen();
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  async createInGeneration(
    input: FileGrantRequest,
    generation: string,
    signal?: AbortSignal,
  ): Promise<FileGrant | undefined> {
    this.assertOpen();
    const result = await this.ctx.remote.files.createFileGrantInGeneration(
      input,
      generation,
      AbortSignal.any([this.lifetime.signal, ...(signal ? [signal] : [])]),
    );
    if (!result.ok) throw result.error;
    return result.value ?? undefined;
  }
  async create(input: FileGrantRequest, signal?: AbortSignal): Promise<FileGrant | undefined> {
    this.assertOpen();
    const result = await this.ctx.remote.files.createFileGrant(
      input,
      AbortSignal.any([this.lifetime.signal, ...(signal ? [signal] : [])]),
    );
    if (!result.ok) throw result.error;
    return result.value ?? undefined;
  }
  importFileInGeneration(file: File, generation: string, signal?: AbortSignal): Promise<FileGrant> {
    this.assertOpen();
    const state = this.getSnapshot();
    if (state.status !== 'ready' || state.baseline.generation !== generation)
      throw Error('FILE_IMPORT_GENERATION_CHANGED');
    return this.importFile(file, false, signal);
  }
  async prepareInputPathsInGeneration(
    ids: readonly string[],
    generation: string,
    signal?: AbortSignal,
  ): Promise<readonly string[]> {
    this.assertOpen();
    const result = await this.ctx.remote.files.prepareInputPaths(
      generation,
      ids,
      this.signal(signal),
    );
    if (!result.ok) throw result.error;
    return result.value;
  }
  importFile(file: File, editable = false, signal?: AbortSignal): Promise<FileGrant> {
    this.assertOpen();
    return this.imports.import(file, editable, this.signal(signal));
  }
  async revoke(id: string, signal?: AbortSignal): Promise<void> {
    this.assertOpen();
    const result = await this.ctx.remote.files.revokeFileGrant(
      id,
      AbortSignal.any([this.lifetime.signal, ...(signal ? [signal] : [])]),
    );
    if (!result.ok) throw result.error;
  }
  async readInGeneration(
    id: string,
    maxBytes: number,
    generation: string,
    signal?: AbortSignal,
  ): Promise<{ name: string; content: string }> {
    this.assertOpen();
    const result = await this.ctx.remote.files.readGrantedTextInGeneration(
      id,
      maxBytes,
      generation,
      this.signal(signal),
    );
    if (!result.ok) throw result.error;
    return result.value;
  }
  async revokeInGeneration(id: string, generation: string, signal?: AbortSignal): Promise<void> {
    this.assertOpen();
    const result = await this.ctx.remote.files.revokeFileGrantInGeneration(
      id,
      generation,
      this.signal(signal),
    );
    if (!result.ok) throw result.error;
  }
  openExternalEditors(): ExternalEditorsModel {
    this.assertOpen();
    if (this.directories.size >= 15) throw new Error('FILE_DIRECTORY_CAPACITY');
    const model = new ExternalEditorsModel(this.ctx, () => this.directories.delete(model));
    this.directories.add(model);
    return model;
  }
  private generation(): string {
    this.assertOpen();
    const state = this.state;
    if (state.status !== 'ready') throw new Error('FILES_NOT_READY');
    return state.baseline.generation;
  }
  async createExternalEditor(
    key: string,
    target: FileContract.RemoteFileTarget,
    path: string,
    signal?: AbortSignal,
  ): Promise<FileContract.FileOperationReceipt> {
    const result = await this.ctx.remote.files.createExternalEditor(
      key,
      { generation: this.generation(), target, path },
      this.signal(signal),
    );
    if (!result.ok) throw result.error;
    return result.value;
  }
  async pushExternalEditor(
    key: string,
    id: string,
    signal?: AbortSignal,
  ): Promise<FileContract.FileOperationReceipt> {
    const result = await this.ctx.remote.files.pushExternalEditor(
      this.generation(),
      key,
      id,
      this.signal(signal),
    );
    if (!result.ok) throw result.error;
    return result.value;
  }
  async closeExternalEditor(
    key: string,
    id: string,
    signal?: AbortSignal,
  ): Promise<FileContract.FileOperationReceipt> {
    const result = await this.ctx.remote.files.closeExternalEditor(
      this.generation(),
      key,
      id,
      this.signal(signal),
    );
    if (!result.ok) throw result.error;
    return result.value;
  }
  async performNativeFileOperation(
    key: string,
    input: FileContract.NativeFileOperation,
    signal?: AbortSignal,
  ): Promise<FileContract.FileOperationReceipt> {
    this.assertOpen();
    const result = await this.ctx.remote.files.performNativeFileOperation(
      key,
      FileContract.nativeFileOperationSchema.parse(input),
      this.signal(signal),
    );
    if (!result.ok) throw result.error;
    return result.value;
  }
  async getFileOperationOutcome(
    key: string,
    signal?: AbortSignal,
  ): Promise<FileContract.FileOperationOutcome> {
    this.assertOpen();
    const state = this.state;
    if (state.status !== 'ready') throw new Error('FILES_NOT_READY');
    const result = await this.ctx.remote.files.getFileOperationOutcome(
      state.baseline.generation,
      key,
      this.signal(signal),
    );
    if (!result.ok) throw result.error;
    return FileContract.fileOperationOutcomeSchema.parse(result.value);
  }
  async compareFiles(
    input: FileContract.CreateFileComparison,
    signal?: AbortSignal,
  ): Promise<FileContract.FileComparison> {
    this.assertOpen();
    const result = await this.ctx.remote.files.compareFiles(
      FileContract.createFileComparisonSchema.parse(input),
      this.signal(signal),
    );
    if (!result.ok) throw result.error;
    return FileContract.fileComparisonSchema.parse(result.value);
  }
  async readText(
    id: string,
    maxBytes: number,
    signal?: AbortSignal,
  ): Promise<{ name: string; content: string }> {
    this.assertOpen();
    const result = await this.ctx.remote.files.readGrantedText(
      id,
      maxBytes,
      AbortSignal.any([this.lifetime.signal, ...(signal ? [signal] : [])]),
    );
    if (!result.ok) throw result.error;
    return result.value;
  }

  openRemoteDirectory(target: FileContract.RemoteFileTarget, path: string): RemoteDirectoryModel {
    this.assertOpen();
    if (this.directories.size >= 15) throw new Error('FILE_DIRECTORY_CAPACITY');
    const model = new RemoteDirectoryModel(this.ctx, target, path, () =>
      this.directories.delete(model),
    );
    this.directories.add(model);
    return model;
  }
  async getRemoteHome(
    target: FileContract.RemoteFileTarget,
    signal?: AbortSignal,
  ): Promise<{ path: string }> {
    this.assertOpen();
    const result = await this.ctx.remote.files.getRemoteHome(target, this.signal(signal));
    if (!result.ok) throw result.error;
    return result.value;
  }
  async listRemoteDirectory(
    target: FileContract.RemoteFileTarget,
    path: string,
    signal?: AbortSignal,
  ): Promise<FileContract.RemoteDirectoryListing> {
    this.assertOpen();
    const result = await this.ctx.remote.files.listRemoteDirectory(
      target,
      path,
      this.signal(signal),
    );
    if (!result.ok) throw result.error;
    return result.value;
  }
  async statRemoteEntry(
    target: FileContract.RemoteFileTarget,
    path: string,
    signal?: AbortSignal,
  ): Promise<FileContract.RemoteFileEntry> {
    this.assertOpen();
    const result = await this.ctx.remote.files.statRemoteEntry(target, path, this.signal(signal));
    if (!result.ok) throw result.error;
    return result.value;
  }
  async readRemoteText(
    target: FileContract.RemoteFileTarget,
    path: string,
    signal?: AbortSignal,
  ): Promise<FileContract.RemoteText> {
    this.assertOpen();
    const result = await this.ctx.remote.files.readRemoteText(target, path, this.signal(signal));
    if (!result.ok) throw result.error;
    return result.value;
  }
  async createRemoteEntry(
    key: string,
    target: FileContract.RemoteFileTarget,
    input: FileContract.RemoteEntryCreate,
    signal?: AbortSignal,
  ): Promise<FileContract.FileOperationReceipt> {
    this.assertOpen();
    const result = await this.ctx.remote.files.createRemoteEntry(
      key,
      target,
      input,
      this.signal(signal),
    );
    if (!result.ok) throw result.error;
    return result.value;
  }
  async renameRemoteEntry(
    key: string,
    target: FileContract.RemoteFileTarget,
    input: FileContract.RemoteEntryRename,
    signal?: AbortSignal,
  ): Promise<FileContract.FileOperationReceipt> {
    this.assertOpen();
    const result = await this.ctx.remote.files.renameRemoteEntry(
      key,
      target,
      input,
      this.signal(signal),
    );
    if (!result.ok) throw result.error;
    return result.value;
  }
  async deleteRemoteEntry(
    key: string,
    target: FileContract.RemoteFileTarget,
    path: string,
    signal?: AbortSignal,
  ): Promise<FileContract.FileOperationReceipt> {
    this.assertOpen();
    const result = await this.ctx.remote.files.deleteRemoteEntry(
      key,
      target,
      path,
      this.signal(signal),
    );
    if (!result.ok) throw result.error;
    return result.value;
  }
  async chmodRemoteEntry(
    key: string,
    target: FileContract.RemoteFileTarget,
    input: FileContract.RemoteEntryChmod,
    signal?: AbortSignal,
  ): Promise<FileContract.FileOperationReceipt> {
    this.assertOpen();
    const result = await this.ctx.remote.files.chmodRemoteEntry(
      key,
      target,
      input,
      this.signal(signal),
    );
    if (!result.ok) throw result.error;
    return result.value;
  }
  async operateRemoteEntries(
    key: string,
    target: FileContract.RemoteFileTarget,
    input: FileContract.RemoteEntriesOperation,
    signal?: AbortSignal,
  ): Promise<FileContract.FileOperationReceipt> {
    this.assertOpen();
    const result = await this.ctx.remote.files.operateRemoteEntries(
      key,
      target,
      input,
      this.signal(signal),
    );
    if (!result.ok) throw result.error;
    return result.value;
  }
  async writeRemoteText(
    key: string,
    target: FileContract.RemoteFileTarget,
    input: FileContract.WriteRemoteText,
    signal?: AbortSignal,
  ): Promise<FileContract.FileOperationReceipt> {
    this.assertOpen();
    const result = await this.ctx.remote.files.writeRemoteText(
      key,
      target,
      input,
      this.signal(signal),
    );
    if (!result.ok) throw result.error;
    return result.value;
  }
  openDirectory(grantId: string, path = ''): FileDirectoryModel {
    this.assertOpen();
    if (this.directories.size >= 15) throw new Error('FILE_DIRECTORY_CAPACITY');
    const model = new FileDirectoryModel(this.ctx, grantId, path, () => {
      this.directories.delete(model);
    });
    this.directories.add(model);
    return model;
  }
  async listDirectory(
    id: string,
    path = '',
    signal?: AbortSignal,
  ): Promise<FileContract.GrantedDirectoryListing> {
    this.assertOpen();
    const result = await this.ctx.remote.files.listGrantedDirectory(id, path, this.signal(signal));
    if (!result.ok) throw result.error;
    return result.value;
  }
  async createEntry(
    key: string,
    id: string,
    input: FileContract.GrantedEntryCreate,
    signal?: AbortSignal,
  ): Promise<FileContract.FileOperationReceipt> {
    this.assertOpen();
    const result = await this.ctx.remote.files.createGrantedEntry(
      key,
      id,
      input,
      this.signal(signal),
    );
    if (!result.ok) throw result.error;
    return result.value;
  }
  async renameEntry(
    key: string,
    id: string,
    input: FileContract.GrantedEntryRename,
    signal?: AbortSignal,
  ): Promise<FileContract.FileOperationReceipt> {
    this.assertOpen();
    const result = await this.ctx.remote.files.renameGrantedEntry(
      key,
      id,
      input,
      this.signal(signal),
    );
    if (!result.ok) throw result.error;
    return result.value;
  }
  async deleteEntry(
    key: string,
    id: string,
    path: string,
    signal?: AbortSignal,
  ): Promise<FileContract.FileOperationReceipt> {
    this.assertOpen();
    const result = await this.ctx.remote.files.deleteGrantedEntry(
      key,
      id,
      path,
      this.signal(signal),
    );
    if (!result.ok) throw result.error;
    return result.value;
  }
  async chmodEntry(
    key: string,
    id: string,
    input: FileContract.GrantedEntryChmod,
    signal?: AbortSignal,
  ): Promise<FileContract.FileOperationReceipt> {
    this.assertOpen();
    const result = await this.ctx.remote.files.chmodGrantedEntry(
      key,
      id,
      input,
      this.signal(signal),
    );
    if (!result.ok) throw result.error;
    return result.value;
  }
  async operateEntries(
    key: string,
    id: string,
    input: FileContract.GrantedEntriesOperation,
    signal?: AbortSignal,
  ): Promise<FileContract.FileOperationReceipt> {
    this.assertOpen();
    const result = await this.ctx.remote.files.operateGrantedEntries(
      key,
      id,
      input,
      this.signal(signal),
    );
    if (!result.ok) throw result.error;
    return result.value;
  }
  private signal(signal?: AbortSignal): AbortSignal {
    return AbortSignal.any([this.lifetime.signal, ...(signal ? [signal] : [])]);
  }
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
    if (this.closing) return this.closing;
    const closed = Promise.withResolvers<void>();
    this.closing = closed.promise;
    this.disposed = true;
    this.lifetime.abort();
    void this.close().then(closed.resolve, closed.reject);
    return closed.promise;
  }
  private async close(): Promise<void> {
    await this.imports.dispose();
    await Promise.all([...this.directories].map((model) => model.dispose()));
    this.directories.clear();
    await this.stream.dispose();
    await this.done;
    await this.retrying;
    this.listeners.clear();
  }
  private assertOpen(): void {
    if (this.disposed) throw new Error('FILE_GRANTS_MODEL_CLOSED');
  }
  private open(): RemoteStream<FileGrantsUpdate> {
    return this.ctx.remote.$stream({
      name: 'files.grants',
      open: (signal) => this.ctx.remote.files.watchFileGrants(signal),
      ended: () => new RemoteStreamCarrierError('File grants generation ended'),
    });
  }
  private async consume(stream: RemoteStream<FileGrantsUpdate>): Promise<void> {
    const projection = new FileGrantsProjection();
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
        this.publish({ status: 'error', message: 'File grants information is unavailable' });
    } finally {
      projection.reset();
    }
  }
  private publish(state: FileGrantsState): void {
    if (this.disposed) return;
    this.state = Object.freeze(state);
    for (const listener of [...this.listeners]) {
      try {
        listener();
      } catch {
        console.warn('FILE_GRANTS_MODEL_OBSERVER_FAILED');
      }
    }
  }
}
declare module '@deepseek-ai/cordis' {
  interface Context {
    fileGrantsModel: FileGrantsModel;
  }
}

export const inject = ['typert', 'remote', 'connection'];
export async function apply(ctx: Context): Promise<void> {
  const unmount = await ctx.remote.$mount(remote);
  ctx.effect(() => unmount);
  await ctx.inject(['remote.files'], (scope) => {
    const model = new FileGrantsModel(scope);
    scope.effect(() => () => model.dispose());
    scope.provide('fileGrantsModel', model);
    scope.inject(
      [
        'workspaceUi',
        'shortcuts',
        'slots',
        'locale',
        'configurationActions',
        'connectionActions',
        'catalogActions',
        'transferActions',
        'terminalWorkspaceUi',
        'terminalSessionsView',
      ],
      async (ui) => {
        const { installFilesWorkbench } = await import('./ui/workbench.tsx');
        if (ui.fiber.uid !== null) installFilesWorkbench(ui, model);
      },
    );
    scope.provide('fileGrantActions', {
      importFileInGeneration: (file, generation, signal) =>
        model.importFileInGeneration(file, generation, signal),
      prepareInputPathsInGeneration: (ids, generation, signal) =>
        model.prepareInputPathsInGeneration(ids, generation, signal),
      createInGeneration: (input, generation, signal) =>
        model.createInGeneration(input, generation, signal),
      readInGeneration: (id, maxBytes, generation, signal) =>
        model.readInGeneration(id, maxBytes, generation, signal),
      revokeInGeneration: (id, generation, signal) =>
        model.revokeInGeneration(id, generation, signal),
      create: (input, signal) => model.create(input, signal),
      importFile: (file, editable, signal) => model.importFile(file, editable, signal),
      revoke: (id, signal) => model.revoke(id, signal),
    });
  });
}
