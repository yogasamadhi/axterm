import {
  grantedDirectoryPathSchema,
  grantedEntryPathSchema,
  grantedEntryCreateRequestSchema,
  grantedEntryRenameRequestSchema,
  grantedEntryChmodRequestSchema,
  grantedEntriesOperationRequestSchema,
  type GrantedDirectoryListing,
  type GrantedEntryCreate,
  type GrantedEntryRename,
  type GrantedEntryChmod,
  type GrantedEntriesOperation,
  type FileOperationReceipt,
} from '@axterm/plugin-api/files';
import type { LocalFiles } from '../ports/local-files.ts';
import type { FileCommands } from '../ports/commands.ts';
/** Validated intent and command ownership; native IO stays behind the selected port. */
export class LocalFileApplication {
  constructor(
    private readonly local: LocalFiles,
    private readonly commands: FileCommands,
  ) {}
  list(grantId: string, path: string, signal: AbortSignal): Promise<GrantedDirectoryListing> {
    return this.local.list(grantId, grantedDirectoryPathSchema.parse(path), signal);
  }
  create(
    key: string,
    grantId: string,
    input: GrantedEntryCreate,
    signal: AbortSignal,
  ): Promise<FileOperationReceipt> {
    const parsed = grantedEntryCreateRequestSchema.parse(input);
    return this.commands.execute(
      key,
      'createGrantedEntry',
      { grantId, input: parsed },
      (signal) => this.local.create(grantId, parsed, signal),
      signal,
    );
  }
  rename(
    key: string,
    grantId: string,
    input: GrantedEntryRename,
    signal: AbortSignal,
  ): Promise<FileOperationReceipt> {
    const parsed = grantedEntryRenameRequestSchema.parse(input);
    return this.commands.execute(
      key,
      'renameGrantedEntry',
      { grantId, input: parsed },
      (signal) => this.local.rename(grantId, parsed, signal),
      signal,
    );
  }
  remove(
    key: string,
    grantId: string,
    path: string,
    signal: AbortSignal,
  ): Promise<FileOperationReceipt> {
    const parsed = grantedEntryPathSchema.parse(path);
    return this.commands.execute(
      key,
      'deleteGrantedEntry',
      { grantId, path: parsed },
      (signal) => this.local.remove(grantId, parsed, signal),
      signal,
    );
  }
  chmod(
    key: string,
    grantId: string,
    input: GrantedEntryChmod,
    signal: AbortSignal,
  ): Promise<FileOperationReceipt> {
    const parsed = grantedEntryChmodRequestSchema.parse(input);
    return this.commands.execute(
      key,
      'chmodGrantedEntry',
      { grantId, input: parsed },
      (signal) => this.local.chmod(grantId, parsed, signal),
      signal,
    );
  }
  operate(
    key: string,
    grantId: string,
    input: GrantedEntriesOperation,
    signal: AbortSignal,
  ): Promise<FileOperationReceipt> {
    const parsed = grantedEntriesOperationRequestSchema.parse(input);
    return this.commands.execute(
      key,
      'operateGrantedEntries',
      { grantId, input: parsed },
      (signal) => this.local.operate(grantId, parsed, signal),
      signal,
    );
  }
}
