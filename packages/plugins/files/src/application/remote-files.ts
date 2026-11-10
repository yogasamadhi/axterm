import { createHash } from 'node:crypto';
import { RemoteError, remoteErrorOf } from '@axterm/plugin-api';
import * as Contract from '@axterm/plugin-api/files';
import type { ConnectionsApplication } from '@axterm/plugin-api/host';
import { RemoteFileService } from './remote-file-service.ts';
import { ApplicationError } from './errors.ts';
import type { FileCommands } from '../ports/commands.ts';
/** Remote protocol access stays with connections; all file intent and receipts belong here. */
export class RemoteFileApplication {
  constructor(
    private readonly connections: () => Pick<ConnectionsApplication, 'openFiles'>,
    private readonly commands: FileCommands,
  ) {}
  home(target: Contract.RemoteFileTarget, signal: AbortSignal): Promise<{ path: string }> {
    return this.run(target, signal, (service) => service.home(target));
  }
  list(
    target: Contract.RemoteFileTarget,
    path: string,
    signal: AbortSignal,
  ): Promise<Contract.RemoteDirectoryListing> {
    path = Contract.remoteFilePathSchema.parse(path);
    return this.run(target, signal, async (service) =>
      Contract.remoteDirectoryListingSchema.parse({
        target,
        path,
        entries: await service.list(target, path),
      }),
    );
  }
  stat(
    target: Contract.RemoteFileTarget,
    path: string,
    signal: AbortSignal,
  ): Promise<Contract.RemoteFileEntry> {
    path = Contract.remoteFilePathSchema.parse(path);
    return this.run(target, signal, async (service) =>
      Contract.remoteFileEntrySchema.parse(await service.stat(target, path)),
    );
  }
  readText(
    target: Contract.RemoteFileTarget,
    path: string,
    signal: AbortSignal,
  ): Promise<Contract.RemoteText> {
    path = Contract.remoteFilePathSchema.parse(path);
    return this.run(target, signal, async (service) =>
      Contract.remoteTextSchema.parse(await service.readText(target, path)),
    );
  }
  readForComparison(
    target: Contract.RemoteFileTarget,
    path: string,
    maxBytes: number,
    signal: AbortSignal,
  ) {
    path = Contract.remoteFilePathSchema.parse(path);
    return this.run(target, signal, (service) => service.readForComparison(target, path, maxBytes));
  }
  create(
    key: string,
    target: Contract.RemoteFileTarget,
    input: Contract.RemoteEntryCreate,
    signal: AbortSignal,
  ): Promise<Contract.FileOperationReceipt> {
    const parsed = Contract.remoteEntryCreateSchema.parse(input);
    return this.mutate(key, 'createRemoteEntry', target, parsed, signal, (service) =>
      parsed.type === 'file'
        ? service.touch(target, parsed.path)
        : service.mkdir(target, parsed.path),
    );
  }
  rename(
    key: string,
    target: Contract.RemoteFileTarget,
    input: Contract.RemoteEntryRename,
    signal: AbortSignal,
  ): Promise<Contract.FileOperationReceipt> {
    const parsed = Contract.renamePathSchema.parse(input);
    return this.mutate(key, 'renameRemoteEntry', target, parsed, signal, (service) =>
      service.rename(target, parsed.from, parsed.to),
    );
  }
  remove(
    key: string,
    target: Contract.RemoteFileTarget,
    path: string,
    signal: AbortSignal,
  ): Promise<Contract.FileOperationReceipt> {
    path = Contract.remoteFilePathSchema.parse(path);
    return this.mutate(key, 'deleteRemoteEntry', target, { path }, signal, (service) =>
      service.delete(target, path),
    );
  }
  chmod(
    key: string,
    target: Contract.RemoteFileTarget,
    input: Contract.RemoteEntryChmod,
    signal: AbortSignal,
  ): Promise<Contract.FileOperationReceipt> {
    const parsed = Contract.chmodPathSchema.parse(input);
    return this.mutate(key, 'chmodRemoteEntry', target, parsed, signal, (service) =>
      service.chmod(target, parsed.path, parsed.mode),
    );
  }
  operate(
    key: string,
    target: Contract.RemoteFileTarget,
    input: Contract.RemoteEntriesOperation,
    signal: AbortSignal,
  ): Promise<Contract.FileOperationReceipt> {
    const parsed = Contract.remoteEntriesOperationRequestSchema.parse(input);
    return this.mutate(key, 'operateRemoteEntries', target, parsed, signal, (service) =>
      service.operate(target, parsed),
    );
  }
  writeText(
    key: string,
    target: Contract.RemoteFileTarget,
    input: Contract.WriteRemoteText,
    signal: AbortSignal,
  ): Promise<Contract.FileOperationReceipt> {
    const parsed = Contract.writeRemoteTextSchema.parse(input);
    // Keep full text out of receipts/outbox and the bounded canonical command encoder.
    const { content, ...metadata } = parsed;
    const payload = {
      ...metadata,
      contentHash: createHash('sha256').update(content).digest('hex'),
    };
    return this.mutate(key, 'writeRemoteText', target, payload, signal, async (service) => {
      await service.writeText(target, parsed);
    });
  }
  /** Called only inside the external-edit owner's journaled explicit push. */
  saveExternalText(
    target: Contract.RemoteFileTarget,
    input: Contract.WriteRemoteText,
    signal: AbortSignal,
  ): Promise<Contract.RemoteText> {
    const parsed = Contract.writeRemoteTextSchema.parse(input);
    return this.run(target, signal, async (service) =>
      Contract.remoteTextSchema.parse(await service.writeText(target, parsed)),
    );
  }
  private mutate(
    key: string,
    operation: string,
    target: Contract.RemoteFileTarget,
    input: unknown,
    signal: AbortSignal,
    perform: (service: RemoteFileService) => Promise<void | number>,
  ): Promise<Contract.FileOperationReceipt> {
    target = Contract.remoteFileTargetSchema.parse(target);
    return this.commands.execute(
      key,
      operation,
      { target, input },
      (owned) =>
        this.run(target, owned, async (service) => {
          const changed = await perform(service);
          return changed ?? 1;
        }),
      signal,
    );
  }
  private async run<T>(
    target: Contract.RemoteFileTarget,
    signal: AbortSignal,
    perform: (service: RemoteFileService) => Promise<T>,
  ): Promise<T> {
    Contract.remoteFileTargetSchema.parse(target);
    signal.throwIfAborted();
    try {
      return await perform(new RemoteFileService(this.connections(), signal));
    } catch (error) {
      const marked = remoteErrorOf(error);
      if (marked?.code === 'files/failure') throw marked;
      let reason: Contract.FilesFailureReason = signal.aborted ? 'cancelled' : 'unavailable';
      if (!signal.aborted) {
        if (error instanceof ApplicationError) {
          const reasons: Record<string, Contract.FilesFailureReason> = {
            VALIDATION_ERROR: 'invalid-input',
            REMOTE_EDIT_CONFLICT: 'conflict',
            CONFLICT: 'conflict',
            PAYLOAD_TOO_LARGE: 'capacity',
          };
          reason = reasons[error.code] ?? 'unavailable';
        } else if (marked?.code === 'connections/failure') {
          const selected = marked.details.reason;
          reason =
            selected === 'not-found'
              ? 'not-found'
              : selected === 'cancelled'
                ? 'cancelled'
                : selected === 'capacity'
                  ? 'capacity'
                  : 'unavailable';
        } else if (error instanceof Error && 'code' in error) {
          const codes: Record<string, Contract.FilesFailureReason> = {
            '2': 'not-found',
            '3': 'forbidden',
            '4': 'unavailable',
            '11': 'conflict',
            CAPACITY_EXCEEDED: 'capacity',
            NOT_FOUND: 'not-found',
            CONFLICT: 'conflict',
            VALIDATION_ERROR: 'invalid-input',
          };
          reason = codes[String(error.code)] ?? 'unavailable';
        }
      }
      throw new RemoteError('files/failure', 'The remote file operation failed', { reason });
    }
  }
}
