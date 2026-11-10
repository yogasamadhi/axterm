import { remoteErrorOf } from '@axterm/plugin-api';
import type { Context } from '@deepseek-ai/cordis';
import type { FileGrant, FileGrantRequest } from '@axterm/plugin-api/files';
import type {} from '@axterm/plugin-api/configuration';
import type {} from '@axterm/plugin-api/connections';
import type {} from '@axterm/plugin-api/transfers';
import type {} from '@axterm/ui/workspace';
import type { FileGrantsModel } from '../index.ts';
import { LocalDirectoryGrantOwner } from './local-directory-grant-owner.ts';
import { FilePaneOwner } from './pane-owner.ts';
import type { TransferGrantHandoffs } from './transfer-grants.ts';
import { FilesUiCommands } from './commands.ts';
export class FilesSessionOwner {
  readonly externalSessions = new Set<string>();
  readonly cleanups = new Set<() => void>();
  readonly id = crypto.randomUUID();
  readonly externalObservers = new Set<{ dispose(): Promise<void> }>();
  container: HTMLElement | undefined;
  active = false;
  followTerminalDirectory: ((target: { connectionId: string; path: string }) => void) | undefined;
  readonly editors;
  readonly lifetime = new AbortController();
  readonly local: FilePaneOwner;
  readonly remote: FilePaneOwner;
  readonly commands: FilesUiCommands;
  private directory: LocalDirectoryGrantOwner;
  private readonly directories = new Set<LocalDirectoryGrantOwner>();
  private uploadAdmissions = 0;
  private readonly temporaryGrants = new Map<string, string>();
  private readonly pending = new Set<Promise<unknown>>();
  private readonly listeners = new Set<() => void>();
  private state: { readonly grant: FileGrant | undefined; readonly dropFailure: number } = {
    grant: undefined,
    dropFailure: 0,
  };
  private closing: Promise<void> | undefined;
  private generation: string | undefined;
  private readonly off: () => void;
  constructor(
    readonly ctx: Context,
    readonly files: FileGrantsModel,
    readonly handoffs: TransferGrantHandoffs,
    initialDirectory?: FileGrant,
  ) {
    this.editors = files.openExternalEditors();
    this.externalObservers.add(this.editors);
    window.addEventListener('message', this.directoryDrop);
    this.local = new FilePaneOwner(files);
    this.remote = new FilePaneOwner(files);
    this.commands = new FilesUiCommands(files, this.lifetime.signal);
    const fresh = (initial?: FileGrant) => {
      const owner = new LocalDirectoryGrantOwner(
        {
          create: (input, generation, signal) =>
            files.createInGeneration(input, generation, signal),
          revoke: (id, generation) => handoffs.release(id, generation),
        },
        () => this.currentGeneration(),
        initial,
      );
      this.directories.add(owner);
      return owner;
    };
    this.directory = fresh(initialDirectory);
    this.state = { grant: this.directory.current(), dropFailure: 0 };
    this.generation = this.currentGeneration();
    this.off = files.subscribe(() => {
      const next = this.currentGeneration();
      if (next === this.generation) return;
      this.generation = next;
      const old = this.directory;
      this.directory = fresh();
      this.publish(undefined);
      void this.track(async () => {
        await old.dispose();
        this.directories.delete(old);
      }).catch(() => {});
    });
  }
  registerDirectoryFollower(
    follow: (target: { connectionId: string; path: string }) => void,
  ): () => void {
    this.lifetime.signal.throwIfAborted();
    if (this.followTerminalDirectory) throw Error('FILES_DIRECTORY_FOLLOWER_EXISTS');
    this.followTerminalDirectory = follow;
    const dispose = () => {
      if (this.followTerminalDirectory === follow) this.followTerminalDirectory = undefined;
      this.cleanups.delete(dispose);
    };
    this.cleanups.add(dispose);
    return dispose;
  }
  acquireUpload(input: FileGrantRequest) {
    return this.track(async (signal) => {
      if (this.temporaryGrants.size + this.uploadAdmissions >= 16)
        throw Error('FILES_UPLOAD_GRANT_CAPACITY');
      this.uploadAdmissions++;
      try {
        const generation = this.requireGeneration();
        const grant = await this.files.createInGeneration(input, generation, signal);
        if (grant) this.temporaryGrants.set(grant.grantId, generation);
        if (generation !== this.currentGeneration()) throw Error('FILES_UPLOAD_GENERATION_CHANGED');
        return grant;
      } finally {
        this.uploadAdmissions--;
      }
    });
  }
  importUpload(file: File, signal: AbortSignal) {
    return this.track(async (owned) => {
      if (this.temporaryGrants.size + this.uploadAdmissions >= 16)
        throw Error('FILES_UPLOAD_GRANT_CAPACITY');
      this.uploadAdmissions++;
      try {
        const generation = this.requireGeneration();
        const grant = await this.files.importFile(file, false, AbortSignal.any([owned, signal]));
        this.temporaryGrants.set(grant.grantId, generation);
        if (generation !== this.currentGeneration()) throw Error('FILES_UPLOAD_GENERATION_CHANGED');
        return grant;
      } finally {
        this.uploadAdmissions--;
      }
    });
  }
  async releaseTemporary(id: string) {
    const generation = this.temporaryGrants.get(id);
    if (!generation) return;
    await this.handoffs.release(id, generation);
    this.temporaryGrants.delete(id);
  }
  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  async selectDirectory(
    intent:
      | 'home-directory'
      | 'downloads-directory'
      | 'open-directory'
      | 'directory-path'
      | 'dropped-directory',
    path?: string,
  ) {
    return this.track(async () => {
      if (this.commands.getSnapshot().length) throw Error('FILES_DIRECTORY_BUSY');
      await this.local.clear();
      const input: FileGrantRequest =
        intent === 'directory-path'
          ? { kind: intent, path: path ?? '' }
          : intent === 'dropped-directory'
            ? { kind: intent, ticket: path ?? '' }
            : { kind: intent };
      const directory = this.directory;
      const grant = await directory.select(input, this.lifetime.signal);
      if (grant && directory === this.directory && !this.lifetime.signal.aborted)
        this.publish(grant);
      return grant;
    });
  }
  track<T>(perform: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (this.lifetime.signal.aborted) return Promise.reject(Error('FILES_SESSION_CLOSED'));
    if (this.pending.size >= 32) return Promise.reject(Error('FILES_SESSION_CAPACITY'));
    const task = Promise.resolve().then(() => {
      this.lifetime.signal.throwIfAborted();
      return perform(this.lifetime.signal);
    });
    this.pending.add(task);
    void task.finally(() => this.pending.delete(task)).catch(() => {});
    return task;
  }
  dispose(): Promise<void> {
    if (this.closing) return this.closing;
    this.lifetime.abort();
    for (const cleanup of this.cleanups) cleanup();
    this.cleanups.clear();
    window.removeEventListener('message', this.directoryDrop);
    this.off();
    return (this.closing = (async () => {
      const results = await Promise.allSettled([
        this.local.dispose(),
        this.remote.dispose(),
        ...[...this.externalObservers].map(async (model) => {
          await model.dispose();
          this.externalObservers.delete(model);
        }),
      ]);
      await Promise.allSettled([...this.pending]);
      await this.commands.close();
      const cleanup = await Promise.allSettled([
        ...[...this.externalSessions].map(async (id) => {
          try {
            await this.files.closeExternalEditor(crypto.randomUUID(), id);
          } catch (error) {
            const marked = remoteErrorOf(error);
            if (marked?.code !== 'files/failure' || marked.details.reason !== 'not-found')
              throw error;
          }
          this.externalSessions.delete(id);
        }),
        ...[...this.temporaryGrants.keys()].map((id) => this.releaseTemporary(id)),
        ...[...this.directories].map(async (owner) => {
          await owner.dispose();
          this.directories.delete(owner);
        }),
      ]);
      this.listeners.clear();
      if (
        [...results, ...cleanup].some((result) => result.status === 'rejected') ||
        this.directories.size ||
        this.temporaryGrants.size ||
        this.externalSessions.size ||
        this.uploadAdmissions
      )
        throw Error('FILES_SESSION_UNDRAINED');
    })());
  }
  private readonly directoryDrop = (event: MessageEvent) => {
    if (
      !this.active ||
      event.source !== window ||
      event.origin !== location.origin ||
      !event.data ||
      event.data.type !== 'axterm:native-directory-drop' ||
      !!event.data.ownerToken
    )
      return;
    if (event.data.failed === true) {
      this.dropFailed();
      return;
    }
    const ticket = event.data.ticket;
    if (
      typeof ticket !== 'string' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(ticket)
    )
      return;
    void this.selectDirectory('dropped-directory', ticket).catch(() => this.dropFailed());
  };
  private dropFailed() {
    this.state = Object.freeze({ ...this.state, dropFailure: this.state.dropFailure + 1 });
    for (const listener of this.listeners) {
      try {
        listener();
      } catch {
        console.warn('FILES_SESSION_OBSERVER_FAILED');
      }
    }
  }
  private requireGeneration(): string {
    const generation = this.currentGeneration();
    if (!generation) throw Error('FILES_NOT_READY');
    return generation;
  }
  private currentGeneration() {
    const facts = this.files.getSnapshot();
    return facts.status === 'ready' ? facts.baseline.generation : undefined;
  }
  private publish(grant: FileGrant | undefined) {
    this.state = Object.freeze({ grant, dropFailure: this.state.dropFailure });
    for (const listener of this.listeners) {
      try {
        listener();
      } catch {
        console.warn('FILES_SESSION_OBSERVER_FAILED');
      }
    }
  }
}
