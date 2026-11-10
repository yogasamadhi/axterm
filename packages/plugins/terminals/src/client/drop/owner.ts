import type {} from '../locales.ts';
import type { FileGrant, FileGrantActions, FileTransferActions } from '@axterm/plugin-api/files';
import { remoteErrorOf } from '@axterm/plugin-api';
import type { TranslateNS } from '@axterm/ui';
import {
  terminalDroppedFilesError,
  terminalDropRemotePath,
  quoteTerminalDroppedPaths,
  type TerminalDropBehavior,
  type TerminalDroppedFilesErrorCode,
} from './model.ts';
export interface TerminalDropTarget {
  generation: string;
  id: string;
  kind: string;
  connectionId?: string;
  cwd: string;
  behavior: TerminalDropBehavior;
}
interface Batch {
  action?: 'upload' | 'path-insert';
  readonly target: TerminalDropTarget;
  readonly abort: AbortController;
  readonly ids: string[];
  readonly names: string[];
}
interface OwnedGrant {
  readonly grant: FileGrant;
  readonly generation: string;
  handoff?: FileTransferActions;
}
export interface TerminalDropState {
  readonly phase: 'idle' | 'preparing' | 'asking' | 'acting';
  readonly names: readonly string[];
  readonly canUpload: boolean;
}
interface Ports {
  target(): TerminalDropTarget | undefined;
  files: FileGrantActions;
  handoff(): FileTransferActions | undefined;
  send(text: string): boolean;
  notify(key: Parameters<TranslateNS<'terminals'>>[0], params?: Record<string, unknown>): void;
  changed(state: TerminalDropState): void;
}
const errorKeys: Record<TerminalDroppedFilesErrorCode, Parameters<TranslateNS<'terminals'>>[0]> = {
  DIRECTORY_UNSUPPORTED: 'dropDirectoryUnsupported',
  NO_FILES: 'dropNoFiles',
  TOO_MANY_FILES: 'dropTooManyFiles',
  UNSAFE_FILE_NAME: 'dropUnsafeFileName',
  INVALID_FILE_SIZE: 'dropInvalidFileSize',
  FILE_TOO_LARGE: 'dropFileTooLarge',
  TOTAL_TOO_LARGE: 'dropTotalTooLarge',
};
/** Private authorities and UI intent only. IO, queue facts and stdin stay with their existing owners. */
export class TerminalFileDropOwner {
  private readonly grants = new Map<string, OwnedGrant>();
  private batch: Batch | undefined;
  private pending: Promise<void> | undefined;
  private closing: Promise<void> | undefined;
  constructor(private readonly ports: Ports) {
    if (
      !ports.files.importFileInGeneration ||
      !ports.files.prepareInputPathsInGeneration ||
      !ports.files.createInGeneration ||
      !ports.files.revokeInGeneration
    )
      throw Error('TERMINAL_DROP_CAPABILITY_UNAVAILABLE');
  }
  private start(names: readonly string[]): Batch {
    if (this.closing || this.pending || this.batch || this.grants.size + names.length > 64)
      throw Error('TERMINAL_DROP_BUSY');
    const target = this.ports.target();
    if (!target) throw Error('TERMINAL_DROP_NOT_READY');
    const batch = {
      target: { ...target },
      abort: new AbortController(),
      ids: [],
      names: [...names],
    };
    this.batch = batch;
    this.publish('preparing', batch);
    return batch;
  }
  files(files: readonly File[], directory = false): Promise<void> {
    const error = terminalDroppedFilesError(files, directory);
    if (error) {
      this.ports.notify(errorKeys[error], { limit: 32 });
      return Promise.resolve();
    }
    const batch = this.start(files.map((file) => file.name));
    return this.track(batch, async () => {
      if (batch.target.behavior === 'upload' && !this.canUpload(batch)) throw Error('NO_SFTP');
      for (const file of files) {
        this.check(batch);
        const grant = await this.ports.files.importFileInGeneration!(
          file,
          batch.target.generation,
          batch.abort.signal,
        );
        this.grants.set(grant.grantId, { grant, generation: batch.target.generation });
        batch.ids.push(grant.grantId);
        this.check(batch);
      }
      if (batch.target.behavior === 'ask') this.publish('asking', batch);
      else await this.perform(batch, batch.target.behavior);
    });
  }
  directories(tickets: readonly string[]): Promise<void> {
    if (
      !tickets.length ||
      tickets.length > 32 ||
      new Set(tickets).size !== tickets.length ||
      tickets.some(
        (ticket) => !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(ticket),
      )
    )
      throw Error('TERMINAL_DROP_TICKET_INVALID');
    const batch = this.start(tickets.map(() => ''));
    return this.track(batch, async () => {
      for (const ticket of tickets) {
        this.check(batch);
        const grant = await this.ports.files.createInGeneration!(
          { kind: 'dropped-directory', ticket },
          batch.target.generation,
          batch.abort.signal,
        );
        if (!grant) throw Error('TERMINAL_DROP_DIRECTORY_UNAVAILABLE');
        this.grants.set(grant.grantId, { grant, generation: batch.target.generation });
        batch.ids.push(grant.grantId);
        this.check(batch);
      }
      await this.perform(batch, 'path-insert');
    });
  }
  select(action: 'upload' | 'path-insert'): Promise<void> {
    const batch = this.batch;
    if (!batch || this.pending || this.closing) throw Error('TERMINAL_DROP_NOT_REVIEWED');
    return this.track(batch, () => this.perform(batch, action));
  }
  private canUpload(batch: Batch): boolean {
    return batch.target.kind === 'ssh' && !!batch.target.connectionId;
  }
  private check(batch: Batch): void {
    batch.abort.signal.throwIfAborted();
    const now = this.ports.target();
    if (
      this.closing ||
      !now ||
      now.generation !== batch.target.generation ||
      now.id !== batch.target.id ||
      now.connectionId !== batch.target.connectionId
    )
      throw Error('TERMINAL_DROP_RETIRED');
  }
  private async perform(batch: Batch, action: 'upload' | 'path-insert'): Promise<void> {
    batch.action = action;
    this.check(batch);
    this.publish('acting', batch);
    if (action === 'path-insert') {
      const paths = await this.ports.files.prepareInputPathsInGeneration!(
        batch.ids,
        batch.target.generation,
        batch.abort.signal,
      );
      this.check(batch);
      if (paths.length !== batch.ids.length || !this.ports.send(quoteTerminalDroppedPaths(paths)))
        throw Error('TERMINAL_DROP_INPUT_REJECTED');
      const directories = batch.ids.every((id) => this.grants.get(id)?.grant.kind === 'directory');
      for (const id of batch.ids) {
        // Files Host now owns temporary file lifetime. Native original directories can release immediately.
        if (this.grants.get(id)?.grant.kind === 'directory') await this.release(id);
        else this.grants.delete(id);
      }
      this.ports.notify(directories ? 'insertedDirectoryPaths' : 'insertedTemporaryPaths', {
        count: batch.ids.length,
      });
    } else {
      if (!this.canUpload(batch)) throw Error('NO_SFTP');
      const handoff = this.ports.handoff();
      if (!handoff) throw Error('NO_SFTP');
      for (const id of batch.ids) {
        this.check(batch);
        const owned = this.grants.get(id);
        if (!owned) throw Error('TERMINAL_DROP_GRANT_MISSING');
        owned.handoff = handoff;
        await handoff.create(batch.target.generation, crypto.randomUUID(), {
          direction: 'upload',
          target: { protocol: 'sftp', connectionId: batch.target.connectionId! },
          grantId: id,
          remotePath: terminalDropRemotePath(batch.target.cwd, owned.grant.name),
          recursive: false,
          conflict: 'skip',
        });
        await this.release(id);
      }
      this.ports.notify('queuedUploads', { count: batch.ids.length });
    }
    if (this.batch === batch) this.batch = undefined;
    this.publish('idle');
  }
  private track(batch: Batch, work: () => Promise<void>): Promise<void> {
    const task = Promise.resolve()
      .then(work)
      .catch(async () => {
        await Promise.allSettled(batch.ids.map((id) => this.release(id)));
        if (this.batch === batch) this.batch = undefined;
        if (!this.closing)
          this.ports.notify(
            batch.abort.signal.aborted
              ? 'dropCanceled'
              : batch.action === 'upload'
                ? 'createUploadError'
                : batch.action === 'path-insert'
                  ? 'insertPathsError'
                  : batch.target.behavior === 'upload' && !this.canUpload(batch)
                    ? 'noSftpConnection'
                    : 'dropReadError',
          );
        this.publish('idle');
      })
      .finally(() => {
        if (this.pending === task) this.pending = undefined;
      });
    this.pending = task;
    return task;
  }
  private async release(id: string): Promise<void> {
    const owned = this.grants.get(id);
    if (!owned) return;
    if (owned.handoff) await owned.handoff.release(id, owned.generation);
    else {
      try {
        await this.ports.files.revokeInGeneration!(id, owned.generation);
      } catch (error) {
        const marked = remoteErrorOf(error),
          now = this.ports.target();
        if (
          marked?.code !== 'files/failure' ||
          marked.details.reason !== 'not-found' ||
          now?.generation !== owned.generation
        )
          throw error;
      }
    }
    this.grants.delete(id);
  }
  async cancel(): Promise<void> {
    const batch = this.batch;
    batch?.abort.abort();
    await this.pending;
    if (batch) {
      await Promise.allSettled(batch.ids.map((id) => this.release(id)));
      if (this.batch === batch) this.batch = undefined;
      if (batch.ids.some((id) => this.grants.has(id))) throw Error('TERMINAL_DROP_UNDRAINED');
    }
    this.publish('idle');
  }
  private publish(phase: TerminalDropState['phase'], batch?: Batch): void {
    if (!this.closing)
      this.ports.changed({
        phase,
        names: batch?.names ?? [],
        canUpload: !!batch && this.canUpload(batch),
      });
  }
  close(): Promise<void> {
    return (this.closing ??= (async () => {
      this.batch?.abort.abort();
      await this.pending;
      await Promise.allSettled([...this.grants.keys()].map((id) => this.release(id)));
      this.batch = undefined;
      if (this.grants.size) throw Error('TERMINAL_DROP_UNDRAINED');
    })());
  }
}
