import { GrantedInputPaths } from './adapters/input-paths.ts';
import { ExternalEditorApplication } from './application/external-editor.ts';
import { FileComparisonApplication } from './application/comparison.ts';
import { Remote, RemoteError, TypertRemoteService, remoteErrorOf } from '@axterm/plugin-api';
import {
  fileGrantRequestSchema,
  type FileGrantRequest,
  type FileGrant,
  type FileGrantsUpdate,
} from '@axterm/plugin-api/files';
import type {} from '@axterm/plugin-api/host';
import type { Context } from '@deepseek-ai/cordis';
import {
  FileGrantsObservation,
  FileSnapshotObservation,
  FileSnapshotBudget,
} from './observation.ts';
import { ZodError } from 'zod';
import { z } from 'zod';
import * as FileContract from '@axterm/plugin-api/files';
import { productDomains } from '@axterm/data-schema';
import { FileCommandJournal } from './adapters/command-journal.ts';
import { GrantedLocalFiles } from './adapters/local-files.ts';
import { FileHttpStreams } from './adapters/http-streams.ts';
import { FileHttpImports } from './adapters/http-imports.ts';
import { GrantedStreamingFiles } from './adapters/streaming-files.ts';
import { RemoteFileApplication } from './application/remote-files.ts';
import { LocalFileApplication } from './application/local-files.ts';
declare module '@deepseek-ai/cordis' {
  interface Context {
    filesController: FilesController;
  }
}

/** File business ownership stays in the Host; the shell supplies native authority only. */
export class FilesController extends TypertRemoteService {
  private readonly lifetime = new AbortController();
  private readonly pending = new Set<Promise<unknown>>();
  private readonly observation: FileGrantsObservation;
  private readonly budget = new FileSnapshotBudget();
  private readonly directories = new Set<FileSnapshotObservation>();
  private readonly httpStreams = new Set<FileHttpStreams | FileHttpImports>();
  private open = true;
  private readonly inputPaths: GrantedInputPaths;
  private readonly externalEditors: ExternalEditorApplication;
  private readonly comparisons: FileComparisonApplication;
  private closing: Promise<void> | undefined;
  resourceSnapshot(): Readonly<Record<string, number>> {
    return Object.freeze({
      externalEditors: this.externalEditors.resourceCount(),
      fileRequests: this.pending.size,
    });
  }
  constructor(
    ctx: Context,
    private readonly application: LocalFileApplication,
    private readonly journal: FileCommandJournal,
    private readonly remoteFiles: RemoteFileApplication,
    private readonly streaming: GrantedStreamingFiles,
    onClose: (close: () => Promise<void>) => void,
  ) {
    super(ctx, 'filesController', { namespace: 'files' });
    this.inputPaths = new GrantedInputPaths(ctx.runtimeIdentity.generation, () => this.grants());
    this.comparisons = new FileComparisonApplication(streaming, remoteFiles);
    this.externalEditors = new ExternalEditorApplication(ctx, streaming, remoteFiles, journal);
    ctx.provide('remoteFiles', {
      list: (target, path, signal) => this.listRemoteDirectory(target, path, signal),
      readText: (target, path, signal) => this.readRemoteText(target, path, signal),
    });
    this.observation = new FileGrantsObservation(
      ctx.runtimeIdentity.generation,
      (signal) => this.grants().list(signal),
      this.budget,
    );
    ctx.inject(['connection'], (web) => {
      for (const create of [
        () => new FileHttpStreams(web, this.streaming, this.journal),
        () => new FileHttpImports(web, this.streaming),
      ]) {
        const stream = create();
        this.httpStreams.add(stream);
        web.effect(() => async () => {
          await stream.close();
          this.httpStreams.delete(stream);
        });
      }
    });
    ctx.effect(() => () => this.close());
    onClose(() => this.close());
    ctx.desktopTaskInspection.register('files', {
      inspect: (signal) => {
        signal.throwIfAborted();
        return {
          active:
            this.pending.size > 0 ||
            this.externalEditors.resourceCount() > 0 ||
            this.streaming.resourceCount() > 0 ||
            [...this.httpStreams].some((stream) => stream.resourceCount() > 0),
        };
      },
      dispose: () => this.close(),
    });
  }
  @Remote async createExternalEditor(
    key: string,
    input: FileContract.CreateExternalEditor,
    signal: AbortSignal,
  ): Promise<FileContract.FileOperationReceipt> {
    return this.run(() => this.externalEditors.create(key, input, this.signal(signal)));
  }
  @Remote async pushExternalEditor(
    generation: string,
    key: string,
    id: string,
    signal: AbortSignal,
  ): Promise<FileContract.FileOperationReceipt> {
    return this.run(() => this.externalEditors.push(generation, key, id, this.signal(signal)));
  }
  @Remote async closeExternalEditor(
    generation: string,
    key: string,
    id: string,
    signal: AbortSignal,
  ): Promise<FileContract.FileOperationReceipt> {
    return this.run(() => this.externalEditors.remove(generation, key, id, this.signal(signal)));
  }
  @Remote({ mode: 'stream' }) watchExternalEditors(
    signal: AbortSignal,
  ): AsyncIterable<FileContract.ExternalEditorsUpdate> {
    return this.observeDirectory((owned) => this.externalEditors.snapshot(owned), signal);
  }
  @Remote async performNativeFileOperation(
    key: string,
    input: FileContract.NativeFileOperation,
    signal: AbortSignal,
  ): Promise<FileContract.FileOperationReceipt> {
    const parsed = FileContract.nativeFileOperationSchema.parse(input);
    return this.run(() => {
      const applications = this.ctx.get('fileApplications');
      if (!applications)
        throw new RemoteError('files/failure', 'Native file actions are unavailable', {
          reason: 'unavailable',
        });
      return this.journal.execute(
        key,
        'performNativeFileOperation',
        parsed,
        async (owned) => {
          await applications[parsed.action](parsed.grantId, parsed.path, owned);
          return 1;
        },
        this.signal(signal),
      );
    });
  }
  @Remote getFileOperationOutcome(
    generation: string,
    key: string,
    signal: AbortSignal,
  ): FileContract.FileOperationOutcome {
    this.assert();
    if (signal.aborted)
      throw new RemoteError('files/failure', 'File outcome lookup canceled', {
        reason: 'cancelled',
      });
    if (generation !== this.ctx.runtimeIdentity.generation)
      throw new RemoteError('files/failure', 'File operation caller generation changed', {
        reason: 'stale',
      });
    return this.journal.outcome(key);
  }
  @Remote async compareFiles(
    input: FileContract.CreateFileComparison,
    signal: AbortSignal,
  ): Promise<FileContract.FileComparison> {
    return this.run(() => this.comparisons.compare(input, this.signal(signal)));
  }
  @Remote({ resources: { fileGrant: (id: string) => id } }) async listGrantedDirectory(
    id: string,
    path: string,
    signal: AbortSignal,
  ): Promise<FileContract.GrantedDirectoryListing> {
    return this.local((app, signal) => app.list(id, path, signal), signal);
  }
  @Remote({ mode: 'stream', resources: { fileGrant: (id: string) => id } }) watchGrantedDirectory(
    id: string,
    path: string,
    signal: AbortSignal,
  ): AsyncIterable<FileContract.FileDirectoryUpdate> {
    FileContract.grantedDirectoryPathSchema.parse(path);
    return this.observeDirectory((signal) => this.application.list(id, path, signal), signal);
  }
  private observeDirectory(
    snapshot: (signal: AbortSignal) => Promise<unknown>,
    signal: AbortSignal,
  ): AsyncIterable<FileContract.FileDirectoryUpdate> {
    this.assert();
    if (this.directories.size >= 16)
      throw new RemoteError('files/failure', 'Directory observation capacity exceeded', {
        reason: 'capacity',
      });
    const lifetime = AbortSignal.any([signal, this.lifetime.signal]);
    lifetime.throwIfAborted();
    const observer = new FileSnapshotObservation(
      this.ctx.runtimeIdentity.generation,
      (signal) => this.run(() => snapshot(signal)),
      this.budget,
    );
    this.directories.add(observer);
    let stream: AsyncIterableIterator<FileContract.FileDirectoryUpdate>;
    try {
      stream = observer.watch(lifetime);
    } catch (error) {
      this.directories.delete(observer);
      void observer.dispose();
      throw error;
    }
    let ending: Promise<void> | undefined;
    const release = () =>
      (ending ??= (async () => {
        try {
          await observer.dispose();
        } finally {
          this.directories.delete(observer);
          lifetime.removeEventListener('abort', abort);
        }
      })());
    const abort = () => {
      void release().catch(() => {});
    };
    lifetime.addEventListener('abort', abort, { once: true });
    const iterator: AsyncIterableIterator<FileContract.FileDirectoryUpdate> = {
      [Symbol.asyncIterator]() {
        return this;
      },
      next: async () => {
        try {
          const result = await stream.next();
          if (result.done) await release();
          return result;
        } catch (error) {
          await release();
          throw error;
        }
      },
      return: async () => {
        const done = release();
        try {
          await stream.return?.();
        } finally {
          await done;
        }
        return { done: true as const, value: undefined };
      },
    };
    return iterator;
  }
  @Remote({ resources: { fileGrant: (_key: string, id: string) => id } }) async createGrantedEntry(
    key: string,
    id: string,
    input: FileContract.GrantedEntryCreate,
    signal: AbortSignal,
  ): Promise<FileContract.FileOperationReceipt> {
    return this.local((app, signal) => app.create(key, id, input, signal), signal);
  }
  @Remote({ resources: { fileGrant: (_key: string, id: string) => id } }) async renameGrantedEntry(
    key: string,
    id: string,
    input: FileContract.GrantedEntryRename,
    signal: AbortSignal,
  ): Promise<FileContract.FileOperationReceipt> {
    return this.local((app, signal) => app.rename(key, id, input, signal), signal);
  }
  @Remote({ resources: { fileGrant: (_key: string, id: string) => id } }) async deleteGrantedEntry(
    key: string,
    id: string,
    path: string,
    signal: AbortSignal,
  ): Promise<FileContract.FileOperationReceipt> {
    return this.local((app, signal) => app.remove(key, id, path, signal), signal);
  }
  @Remote({ resources: { fileGrant: (_key: string, id: string) => id } }) async chmodGrantedEntry(
    key: string,
    id: string,
    input: FileContract.GrantedEntryChmod,
    signal: AbortSignal,
  ): Promise<FileContract.FileOperationReceipt> {
    return this.local((app, signal) => app.chmod(key, id, input, signal), signal);
  }
  @Remote({ resources: { fileGrant: (_key: string, id: string) => id } })
  async operateGrantedEntries(
    key: string,
    id: string,
    input: FileContract.GrantedEntriesOperation,
    signal: AbortSignal,
  ): Promise<FileContract.FileOperationReceipt> {
    return this.local((app, signal) => app.operate(key, id, input, signal), signal);
  }
  @Remote({
    resources: { connection: (target: FileContract.RemoteFileTarget) => target.connectionId },
  })
  async getRemoteHome(
    target: FileContract.RemoteFileTarget,
    signal: AbortSignal,
  ): Promise<{ path: string }> {
    return this.run(() => {
      const lifetime = this.signal(signal);
      return this.remoteFiles.home(target, lifetime);
    });
  }
  @Remote({
    resources: { connection: (target: FileContract.RemoteFileTarget) => target.connectionId },
  })
  async listRemoteDirectory(
    target: FileContract.RemoteFileTarget,
    path: string,
    signal: AbortSignal,
  ): Promise<FileContract.RemoteDirectoryListing> {
    return this.run(() => {
      const lifetime = this.signal(signal);
      return this.remoteFiles.list(target, path, lifetime);
    });
  }
  @Remote({
    resources: { connection: (target: FileContract.RemoteFileTarget) => target.connectionId },
  })
  async statRemoteEntry(
    target: FileContract.RemoteFileTarget,
    path: string,
    signal: AbortSignal,
  ): Promise<FileContract.RemoteFileEntry> {
    return this.run(() => {
      const lifetime = this.signal(signal);
      return this.remoteFiles.stat(target, path, lifetime);
    });
  }
  @Remote({
    resources: { connection: (target: FileContract.RemoteFileTarget) => target.connectionId },
  })
  async readRemoteText(
    target: FileContract.RemoteFileTarget,
    path: string,
    signal: AbortSignal,
  ): Promise<FileContract.RemoteText> {
    return this.run(() => {
      const lifetime = this.signal(signal);
      return this.remoteFiles.readText(target, path, lifetime);
    });
  }
  @Remote({
    resources: {
      connection: (_key: string, target: FileContract.RemoteFileTarget) => target.connectionId,
    },
  })
  async createRemoteEntry(
    key: string,
    target: FileContract.RemoteFileTarget,
    input: FileContract.RemoteEntryCreate,
    signal: AbortSignal,
  ): Promise<FileContract.FileOperationReceipt> {
    return this.run(() => {
      const lifetime = this.signal(signal);
      return this.remoteFiles.create(key, target, input, lifetime);
    });
  }
  @Remote({
    resources: {
      connection: (_key: string, target: FileContract.RemoteFileTarget) => target.connectionId,
    },
  })
  async renameRemoteEntry(
    key: string,
    target: FileContract.RemoteFileTarget,
    input: FileContract.RemoteEntryRename,
    signal: AbortSignal,
  ): Promise<FileContract.FileOperationReceipt> {
    return this.run(() => {
      const lifetime = this.signal(signal);
      return this.remoteFiles.rename(key, target, input, lifetime);
    });
  }
  @Remote({
    resources: {
      connection: (_key: string, target: FileContract.RemoteFileTarget) => target.connectionId,
    },
  })
  async deleteRemoteEntry(
    key: string,
    target: FileContract.RemoteFileTarget,
    path: string,
    signal: AbortSignal,
  ): Promise<FileContract.FileOperationReceipt> {
    return this.run(() => {
      const lifetime = this.signal(signal);
      return this.remoteFiles.remove(key, target, path, lifetime);
    });
  }
  @Remote({
    resources: {
      connection: (_key: string, target: FileContract.RemoteFileTarget) => target.connectionId,
    },
  })
  async chmodRemoteEntry(
    key: string,
    target: FileContract.RemoteFileTarget,
    input: FileContract.RemoteEntryChmod,
    signal: AbortSignal,
  ): Promise<FileContract.FileOperationReceipt> {
    return this.run(() => {
      const lifetime = this.signal(signal);
      return this.remoteFiles.chmod(key, target, input, lifetime);
    });
  }
  @Remote({
    resources: {
      connection: (_key: string, target: FileContract.RemoteFileTarget) => target.connectionId,
    },
  })
  async operateRemoteEntries(
    key: string,
    target: FileContract.RemoteFileTarget,
    input: FileContract.RemoteEntriesOperation,
    signal: AbortSignal,
  ): Promise<FileContract.FileOperationReceipt> {
    return this.run(() => {
      const lifetime = this.signal(signal);
      return this.remoteFiles.operate(key, target, input, lifetime);
    });
  }
  @Remote({
    resources: {
      connection: (_key: string, target: FileContract.RemoteFileTarget) => target.connectionId,
    },
  })
  async writeRemoteText(
    key: string,
    target: FileContract.RemoteFileTarget,
    input: FileContract.WriteRemoteText,
    signal: AbortSignal,
  ): Promise<FileContract.FileOperationReceipt> {
    return this.run(() => {
      const lifetime = this.signal(signal);
      return this.remoteFiles.writeText(key, target, input, lifetime);
    });
  }
  @Remote({
    mode: 'stream',
    resources: { connection: (target: FileContract.RemoteFileTarget) => target.connectionId },
  })
  watchRemoteDirectory(
    target: FileContract.RemoteFileTarget,
    path: string,
    signal: AbortSignal,
  ): AsyncIterable<FileContract.RemoteDirectoryUpdate> {
    FileContract.remoteFilePathSchema.parse(path);
    return this.observeDirectory((signal) => this.remoteFiles.list(target, path, signal), signal);
  }
  private signal(signal: AbortSignal): AbortSignal {
    return AbortSignal.any([signal, this.lifetime.signal]);
  }
  @Remote({ resources: { fileGrant: (_generation: string, ids: readonly string[]) => ids } })
  prepareInputPaths(
    generation: string,
    ids: readonly string[],
    signal: AbortSignal,
  ): Promise<readonly string[]> {
    return this.run(() =>
      this.inputPaths.prepare(generation, ids, AbortSignal.any([signal, this.lifetime.signal])),
    );
  }
  @Remote async createFileGrantInGeneration(
    input: FileGrantRequest,
    generation: string,
    signal: AbortSignal,
  ): Promise<FileGrant | null> {
    if (generation !== this.ctx.runtimeIdentity.generation)
      throw new RemoteError('files/failure', 'The file picker belongs to a retired generation', {
        reason: 'stale',
      });
    return this.createFileGrant(input, signal);
  }
  @Remote async createFileGrant(
    input: FileGrantRequest,
    signal: AbortSignal,
  ): Promise<FileGrant | null> {
    return this.run(
      async () =>
        (await this.grants().create(
          fileGrantRequestSchema.parse(input),
          AbortSignal.any([signal, this.lifetime.signal]),
        )) ?? null,
    );
  }
  @Remote({ resources: { fileGrant: (id: string) => id } }) async revokeFileGrantInGeneration(
    id: string,
    generation: string,
    signal: AbortSignal,
  ): Promise<{ revoked: true }> {
    if (generation !== this.ctx.runtimeIdentity.generation)
      throw new RemoteError('files/failure', 'The file grant belongs to a retired generation', {
        reason: 'stale',
      });
    return this.revokeFileGrant(id, signal);
  }
  @Remote({ resources: { fileGrant: (id: string) => id } }) async readGrantedTextInGeneration(
    id: string,
    maxBytes: number,
    generation: string,
    signal: AbortSignal,
  ): Promise<{ name: string; content: string }> {
    if (generation !== this.ctx.runtimeIdentity.generation)
      throw new RemoteError('files/failure', 'The file grant belongs to a retired generation', {
        reason: 'stale',
      });
    return this.readGrantedText(id, maxBytes, signal);
  }
  @Remote({ resources: { fileGrant: (id: string) => id } }) async revokeFileGrant(
    id: string,
    signal: AbortSignal,
  ): Promise<{ revoked: true }> {
    return this.run(async () => {
      await this.grants().revoke(id, AbortSignal.any([signal, this.lifetime.signal]));
      this.inputPaths.released(id);
      return { revoked: true as const };
    });
  }
  @Remote({ resources: { fileGrant: (id: string) => id } }) async readGrantedText(
    id: string,
    maxBytes: number,
    signal: AbortSignal,
  ): Promise<{ name: string; content: string }> {
    return this.run(() =>
      this.grants().readText(id, maxBytes, AbortSignal.any([signal, this.lifetime.signal])),
    );
  }
  @Remote({ mode: 'stream' }) watchFileGrants(
    signal: AbortSignal,
  ): AsyncIterable<FileGrantsUpdate> {
    this.assert();
    return this.observation.watch(AbortSignal.any([signal, this.lifetime.signal]));
  }
  private assert(): void {
    if (!this.open)
      throw new RemoteError('files/failure', 'File services are closed', { reason: 'closed' });
  }
  private local<T>(
    operation: (app: LocalFileApplication, signal: AbortSignal) => Promise<T>,
    signal: AbortSignal,
  ): Promise<T> {
    return this.run(() =>
      operation(this.application, AbortSignal.any([signal, this.lifetime.signal])),
    );
  }
  private close(): Promise<void> {
    if (this.closing) return this.closing;
    this.open = false;
    const completion = Promise.withResolvers<void>();
    this.closing = completion.promise;
    this.lifetime.abort();
    void (async () => {
      // A failed disposer cannot prevent another owner from receiving shutdown.
      // Retain failed contributions and SQL ownership instead of reporting idle.
      const drains = await Promise.allSettled([
        Promise.resolve().then(() => this.comparisons.close()),
        Promise.resolve().then(() => this.externalEditors.close()),
        Promise.resolve().then(() => this.observation.dispose()),
        ...[...this.directories].map(async (observer) => {
          await observer.dispose();
          this.directories.delete(observer);
        }),
        ...[...this.httpStreams].map(async (stream) => {
          await stream.close();
          this.httpStreams.delete(stream);
        }),
        Promise.resolve().then(() => this.streaming.close()),
      ]);
      await Promise.allSettled([...this.pending]);
      const paths = await Promise.allSettled([this.inputPaths.close()]);
      const journal = await Promise.allSettled([
        Promise.resolve().then(() => this.journal.close()),
      ]);
      if ([...drains, ...paths, ...journal].some((result) => result.status === 'rejected'))
        throw new RemoteError('files/failure', 'File resources could not drain', {
          reason: 'unavailable',
        });
    })().then(completion.resolve, completion.reject);
    return this.closing;
  }
  private grants() {
    this.assert();
    const service = this.ctx.get('fileGrants');
    if (!service)
      throw new RemoteError('files/failure', 'Native file grants are unavailable', {
        reason: 'unavailable',
      });
    return service;
  }
  private async run<T>(operation: () => Promise<T>): Promise<T> {
    this.assert();
    if (this.pending.size >= 64)
      throw new RemoteError('files/failure', 'File request capacity exceeded', {
        reason: 'capacity',
      });
    const task = Promise.resolve().then(() => {
      this.assert();
      return operation();
    });
    this.pending.add(task);
    try {
      return await task;
    } catch (error) {
      const marked = remoteErrorOf(error);
      if (marked?.code === 'files/failure') throw marked;
      throw new RemoteError('files/failure', 'The file operation failed', {
        reason: error instanceof ZodError ? 'invalid-input' : 'unavailable',
      });
    } finally {
      this.pending.delete(task);
    }
  }
}

export const inject = ['runtimeIdentity', 'storage', 'storageDomain', 'desktopTaskInspection'];
export async function apply(ctx: Context, config: unknown): Promise<void> {
  const { profile } = z
    .object({ profile: z.string().min(1).max(128) })
    .strict()
    .parse(config);
  const streaming = new GrantedStreamingFiles(() => {
    const service = ctx.get('fileGrants');
    if (!service)
      throw new RemoteError('files/failure', 'Native file grants are unavailable', {
        reason: 'unavailable',
      });
    return service;
  });
  ctx.provide('files', streaming);
  const opening = ctx.storage.domain.open(productDomains.files);
  const owned: { journal?: FileCommandJournal } = {};
  let closeController: (() => Promise<void>) | undefined;
  ctx.effect(() => async () => {
    const drained = await Promise.allSettled([
      Promise.resolve().then(() => closeController?.()),
      Promise.resolve().then(() => streaming.close()),
      Promise.resolve().then(() => owned.journal?.close()),
    ]);
    if (drained.some((result) => result.status === 'rejected'))
      throw new RemoteError('files/failure', 'File resources could not drain', {
        reason: 'unavailable',
      });
    await (await opening.catch(() => undefined))?.close();
  });
  const domain = await opening;
  const journal = new FileCommandJournal(domain, profile, ctx.runtimeIdentity.generation);
  owned.journal = journal;
  const local = new GrantedLocalFiles(() => {
    const files = ctx.get('fileGrants');
    if (!files)
      throw new RemoteError('files/failure', 'Native file grants are unavailable', {
        reason: 'unavailable',
      });
    return files;
  });
  new FilesController(
    ctx,
    new LocalFileApplication(local, journal),
    journal,
    new RemoteFileApplication(() => {
      const connections = ctx.get('connections');
      if (!connections)
        throw new RemoteError('files/failure', 'Connections are unavailable', {
          reason: 'unavailable',
        });
      return connections;
    }, journal),
    streaming,
    (close) => {
      closeController = close;
    },
  );
}
