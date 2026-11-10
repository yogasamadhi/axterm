import type {} from '@axterm/ui/shortcuts';
import type { Context } from '@deepseek-ai/cordis';
import type { RemoteStreamHandle } from '@axterm/plugin-api';
import {
  sshConfigImportPreviewSchema,
  sshConfigImportResultSchema,
} from '@axterm/plugin-api/catalog';
import type * as Contract from '@axterm/plugin-api/catalog';
import { RemoteStreamCarrierError, type RemoteStream } from '@axterm/infra-gateway/client';
import remote from '@axterm/plugin-catalog/remote';
import { CatalogProjection } from './projection.ts';
export type CatalogState =
  | { readonly status: 'connecting' }
  | { readonly status: 'ready'; readonly baseline: Contract.CatalogBaseline }
  | { readonly status: 'error'; readonly message: string };
/** Catalog business facts live here; workspace selection and terminal bytes have separate owners. */
export class CatalogModel {
  private state: CatalogState = { status: 'connecting' };
  private readonly listeners = new Set<() => void>();
  private stream: RemoteStream<Contract.CatalogUpdate>;
  private done: Promise<void>;
  private disposed = false;
  private retrying: Promise<void> | undefined;
  private readonly importLifetime = new AbortController();
  private readonly importTasks = new Set<Promise<unknown>>();
  private importBytes = 0;
  constructor(private readonly ctx: Context) {
    this.stream = this.open();
    this.done = this.consume(this.stream);
  }
  getSnapshot = (): CatalogState => this.state;
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
  async dispose(): Promise<void> {
    this.disposed = true;
    this.importLifetime.abort();
    await Promise.allSettled([...this.importTasks]);
    await this.stream.dispose();
    await this.done;
    await this.retrying;
    this.listeners.clear();
  }
  async createHost(key: string, input: Contract.CreateHostInput): Promise<Contract.CatalogReceipt> {
    this.assertOpen();
    const result = await this.ctx.remote.catalog.createHost(key, input);
    if (!result.ok) throw result.error;
    return result.value;
  }
  async updateHost(
    key: string,
    id: string,
    input: Contract.UpdateHostInput,
    ifMatch: string | undefined,
  ): Promise<Contract.CatalogReceipt> {
    this.assertOpen();
    const result = await this.ctx.remote.catalog.updateHost(key, id, input, ifMatch);
    if (!result.ok) throw result.error;
    return result.value;
  }
  async deleteHost(
    key: string,
    id: string,
    ifMatch: string | undefined,
  ): Promise<Contract.CatalogReceipt> {
    this.assertOpen();
    const result = await this.ctx.remote.catalog.deleteHost(key, id, ifMatch);
    if (!result.ok) throw result.error;
    return result.value;
  }
  async createHostGroup(
    key: string,
    input: Contract.CreateHostGroupInput,
  ): Promise<Contract.CatalogReceipt> {
    this.assertOpen();
    const result = await this.ctx.remote.catalog.createHostGroup(key, input);
    if (!result.ok) throw result.error;
    return result.value;
  }
  async updateHostGroup(
    key: string,
    id: string,
    input: Contract.UpdateHostGroupInput,
    ifMatch: string | undefined,
  ): Promise<Contract.CatalogReceipt> {
    this.assertOpen();
    const result = await this.ctx.remote.catalog.updateHostGroup(key, id, input, ifMatch);
    if (!result.ok) throw result.error;
    return result.value;
  }
  async deleteHostGroup(
    key: string,
    id: string,
    ifMatch: string | undefined,
  ): Promise<Contract.CatalogReceipt> {
    this.assertOpen();
    const result = await this.ctx.remote.catalog.deleteHostGroup(key, id, ifMatch);
    if (!result.ok) throw result.error;
    return result.value;
  }
  async createBookmarkGroup(
    key: string,
    input: Contract.CreateBookmarkGroupInput,
    ifMatch: string | undefined,
  ): Promise<Contract.CatalogReceipt> {
    this.assertOpen();
    const result = await this.ctx.remote.catalog.createBookmarkGroup(key, input, ifMatch);
    if (!result.ok) throw result.error;
    return result.value;
  }
  async updateBookmarkGroup(
    key: string,
    id: string,
    input: Contract.UpdateBookmarkGroupInput,
    ifMatch: string | undefined,
  ): Promise<Contract.CatalogReceipt> {
    this.assertOpen();
    const result = await this.ctx.remote.catalog.updateBookmarkGroup(key, id, input, ifMatch);
    if (!result.ok) throw result.error;
    return result.value;
  }
  async deleteBookmarkGroup(
    key: string,
    id: string,
    ifMatch: string | undefined,
  ): Promise<Contract.CatalogReceipt> {
    this.assertOpen();
    const result = await this.ctx.remote.catalog.deleteBookmarkGroup(key, id, ifMatch);
    if (!result.ok) throw result.error;
    return result.value;
  }
  async createBookmark(
    key: string,
    input: Contract.CreateBookmarkInput,
    ifMatch: string | undefined,
  ): Promise<Contract.CatalogReceipt> {
    this.assertOpen();
    const result = await this.ctx.remote.catalog.createBookmark(key, input, ifMatch);
    if (!result.ok) throw result.error;
    return result.value;
  }
  async updateBookmark(
    key: string,
    id: string,
    input: Contract.UpdateBookmarkInput,
    ifMatch: string | undefined,
  ): Promise<Contract.CatalogReceipt> {
    this.assertOpen();
    const result = await this.ctx.remote.catalog.updateBookmark(key, id, input, ifMatch);
    if (!result.ok) throw result.error;
    return result.value;
  }
  async deleteBookmark(
    key: string,
    id: string,
    ifMatch: string | undefined,
  ): Promise<Contract.CatalogReceipt> {
    this.assertOpen();
    const result = await this.ctx.remote.catalog.deleteBookmark(key, id, ifMatch);
    if (!result.ok) throw result.error;
    return result.value;
  }
  async moveBookmarkTreeNode(
    key: string,
    input: Contract.MoveBookmarkTreeNodeInput,
    ifMatch: string | undefined,
  ): Promise<Contract.CatalogReceipt> {
    this.assertOpen();
    const result = await this.ctx.remote.catalog.moveBookmarkTreeNode(key, input, ifMatch);
    if (!result.ok) throw result.error;
    return result.value;
  }
  async createSshBookmark(
    key: string,
    input: Contract.CreateSshBookmarkInput,
    ifMatch: string | undefined,
  ): Promise<Contract.CatalogReceipt> {
    this.assertOpen();
    const result = await this.ctx.remote.catalog.createSshBookmark(key, input, ifMatch);
    if (!result.ok) throw result.error;
    return result.value;
  }
  async updateSshBookmark(
    key: string,
    id: string,
    input: Contract.UpdateSshBookmarkInput,
    hostIfMatch: string | undefined,
    treeIfMatch: string | undefined,
  ): Promise<Contract.CatalogReceipt> {
    this.assertOpen();
    const result = await this.ctx.remote.catalog.updateSshBookmark(
      key,
      id,
      input,
      hostIfMatch,
      treeIfMatch,
    );
    if (!result.ok) throw result.error;
    return result.value;
  }
  async deleteSshBookmark(
    key: string,
    id: string,
    hostIfMatch: string | undefined,
    treeIfMatch: string | undefined,
  ): Promise<Contract.CatalogReceipt> {
    this.assertOpen();
    const result = await this.ctx.remote.catalog.deleteSshBookmark(
      key,
      id,
      hostIfMatch,
      treeIfMatch,
    );
    if (!result.ok) throw result.error;
    return result.value;
  }
  async deleteSshBookmarkHost(
    key: string,
    id: string,
    hostIfMatch: string | undefined,
    treeIfMatch: string | undefined,
  ): Promise<Contract.CatalogReceipt> {
    this.assertOpen();
    const result = await this.ctx.remote.catalog.deleteSshBookmarkHost(
      key,
      id,
      hostIfMatch,
      treeIfMatch,
    );
    if (!result.ok) throw result.error;
    return result.value;
  }
  async createConnectionProfile(
    key: string,
    input: Contract.ConnectionProfileInput,
  ): Promise<Contract.CatalogReceipt> {
    this.assertOpen();
    const result = await this.ctx.remote.catalog.createConnectionProfile(key, input);
    if (!result.ok) throw result.error;
    return result.value;
  }
  async updateConnectionProfile(
    key: string,
    id: string,
    input: Contract.ConnectionProfilePatch,
    ifMatch: string | undefined,
  ): Promise<Contract.CatalogReceipt> {
    this.assertOpen();
    const result = await this.ctx.remote.catalog.updateConnectionProfile(key, id, input, ifMatch);
    if (!result.ok) throw result.error;
    return result.value;
  }
  async deleteConnectionProfile(
    key: string,
    id: string,
    ifMatch: string | undefined,
  ): Promise<Contract.CatalogReceipt> {
    this.assertOpen();
    const result = await this.ctx.remote.catalog.deleteConnectionProfile(key, id, ifMatch);
    if (!result.ok) throw result.error;
    return result.value;
  }
  async listConnectionHistory(
    generation: string,
    query: Contract.CatalogHistoryQuery,
  ): Promise<Contract.ConnectionHistoryPage> {
    this.assertOpen();
    const result = await this.ctx.remote.catalog.listConnectionHistory(generation, query);
    if (!result.ok) throw result.error;
    return result.value;
  }
  async deleteConnectionHistory(
    key: string,
    id: string,
    ifMatch: string | undefined,
  ): Promise<Contract.CatalogReceipt> {
    this.assertOpen();
    const result = await this.ctx.remote.catalog.deleteConnectionHistory(key, id, ifMatch);
    if (!result.ok) throw result.error;
    return result.value;
  }
  async clearConnectionHistory(
    key: string,
    ifMatch: string | undefined,
  ): Promise<Contract.CatalogReceipt> {
    this.assertOpen();
    const result = await this.ctx.remote.catalog.clearConnectionHistory(key, ifMatch);
    if (!result.ok) throw result.error;
    return result.value;
  }
  async promoteConnectionHistoryToBookmark(
    key: string,
    id: string,
    input: Contract.PromoteConnectionHistoryInput,
    historyIfMatch: string | undefined,
    treeIfMatch: string | undefined,
  ): Promise<Contract.CatalogHistoryPromotionReceipt> {
    this.assertOpen();
    const result = await this.ctx.remote.catalog.promoteConnectionHistoryToBookmark(
      key,
      id,
      input,
      historyIfMatch,
      treeIfMatch,
    );
    if (!result.ok) throw result.error;
    return result.value;
  }
  previewSshConfigImport(
    input: Contract.PreviewSshConfigImportInput,
    signal?: AbortSignal,
  ): Promise<Contract.SshConfigImportPreview> {
    const copied = structuredClone(input);
    return this.readImport(
      (joined) => this.ctx.remote.catalog.previewSshConfigImport(copied, joined),
      16 * 1024 * 1024,
      (value) => sshConfigImportPreviewSchema.parse(value),
      signal,
    );
  }
  async commitSshConfigImport(
    key: string,
    input: Contract.CommitSshConfigImportInput,
    treeIfMatch: string | undefined,
  ): Promise<Contract.CatalogImportReceipt> {
    this.assertOpen();
    const result = await this.ctx.remote.catalog.commitSshConfigImport(key, input, treeIfMatch);
    if (!result.ok) throw result.error;
    return result.value;
  }
  getSshConfigImportReport(
    id: string,
    signal?: AbortSignal,
  ): Promise<Contract.SshConfigImportResult> {
    return this.readImport(
      (joined) => this.ctx.remote.catalog.getSshConfigImportReport(id, joined),
      64 * 1024 * 1024,
      (value) => sshConfigImportResultSchema.parse(value),
      signal,
    );
  }
  private readImport<T>(
    open: (signal: AbortSignal) => RemoteStreamHandle<Contract.CatalogImportChunk, never>,
    maxBytes: number,
    parse: (value: unknown) => T,
    signal?: AbortSignal,
  ): Promise<T> {
    this.assertOpen();
    if (this.importTasks.size >= 4)
      return Promise.reject(new Error('CATALOG_IMPORT_READ_CAPACITY'));
    const joined = AbortSignal.any([this.importLifetime.signal, ...(signal ? [signal] : [])]);
    let bytes = 0;
    const task = Promise.resolve()
      .then(async () => {
        joined.throwIfAborted();
        const stream = open(joined);
        try {
          let offset = 0;
          let final = false;
          const chunks: string[] = [];
          for await (const item of stream) {
            joined.throwIfAborted();
            if (final || item.offset !== offset || !item.text.length || item.text.length > 16_384)
              throw new Error('CATALOG_IMPORT_CHUNK_INVALID');
            const size = new TextEncoder().encode(item.text).byteLength;
            if (bytes + size > maxBytes || this.importBytes + size > 64 * 1024 * 1024)
              throw new Error('CATALOG_IMPORT_READ_CAPACITY');
            bytes += size;
            this.importBytes += size;
            offset += item.text.length;
            final = item.final;
            chunks.push(item.text);
          }
          joined.throwIfAborted();
          if (!final) throw new Error('CATALOG_IMPORT_INCOMPLETE');
          return parse(JSON.parse(chunks.join('')));
        } finally {
          stream.dispose();
        }
      })
      .finally(() => {
        this.importBytes -= bytes;
      });
    this.importTasks.add(task);
    void task.then(
      () => this.importTasks.delete(task),
      () => this.importTasks.delete(task),
    );
    return task;
  }
  private assertOpen(): void {
    if (this.disposed) throw new Error('CATALOG_MODEL_CLOSED');
  }
  private open(): RemoteStream<Contract.CatalogUpdate> {
    return this.ctx.remote.$stream({
      name: 'catalog.facts',
      open: (signal) => this.ctx.remote.catalog.watchCatalog(signal),
      ended: () => new RemoteStreamCarrierError('Catalog generation ended'),
    });
  }
  private async consume(stream: RemoteStream<Contract.CatalogUpdate>): Promise<void> {
    const projection = new CatalogProjection();
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
        this.publish({ status: 'error', message: 'Catalog information is unavailable' });
    } finally {
      projection.reset();
    }
  }
  private publish(state: CatalogState): void {
    if (this.disposed) return;
    this.state = state;
    for (const listener of [...this.listeners]) {
      try {
        listener();
      } catch {
        console.warn('CATALOG_MODEL_OBSERVER_FAILED');
      }
    }
  }
}
declare module '@deepseek-ai/cordis' {
  interface Context {
    catalogModel: CatalogModel;
  }
}
export const inject = ['typert', 'remote', 'connection'];
export async function apply(ctx: Context): Promise<void> {
  const unmount = await ctx.remote.$mount(remote);
  ctx.effect(() => unmount);
  await ctx.inject(['remote.catalog'], (scope) => {
    const model = new CatalogModel(scope);
    scope.provide('catalogModel', model);
    scope.provide('catalogActions', {
      getSnapshot: model.getSnapshot,
      subscribe: model.subscribe,
      retry: () => model.retry(),
      createSshBookmark: (key, input, ifMatch) => model.createSshBookmark(key, input, ifMatch),
    });
    scope.effect(() => () => model.dispose());
    scope.inject(
      ['workspaceUi', 'slots', 'locale', 'fileGrantActions', 'shortcuts'],
      async (ui) => {
        const { installCatalogUi } = await import('./ui/index.tsx');
        if (ui.fiber.uid !== null) installCatalogUi(ui, model);
      },
    );
  });
}
