import type {
  GrantedDirectoryListing,
  GrantedEntryCreate,
  GrantedEntryRename,
  GrantedEntryChmod,
  GrantedEntriesOperation,
} from '@axterm/plugin-api/files';
export interface LocalFiles {
  list(grantId: string, path: string, signal: AbortSignal): Promise<GrantedDirectoryListing>;
  create(grantId: string, input: GrantedEntryCreate, signal: AbortSignal): Promise<number>;
  rename(grantId: string, input: GrantedEntryRename, signal: AbortSignal): Promise<number>;
  remove(grantId: string, path: string, signal: AbortSignal): Promise<number>;
  chmod(grantId: string, input: GrantedEntryChmod, signal: AbortSignal): Promise<number>;
  operate(grantId: string, input: GrantedEntriesOperation, signal: AbortSignal): Promise<number>;
}
