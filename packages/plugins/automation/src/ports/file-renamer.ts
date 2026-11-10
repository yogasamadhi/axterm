export interface RenameFile {
  readonly path: string;
  readonly type: 'file' | 'directory' | 'symlink' | 'other';
  readonly version: string;
  readonly timestamp: number;
}
/** Relative, grant-scoped IO. Native paths and file identities stay in the adapter. */
export interface RenameScope {
  readonly rootName: string;
  readonly identity: string;
  readonly signal: AbortSignal;
  list(path: string): Promise<readonly RenameFile[]>;
  inspect(path: string): Promise<RenameFile>;
  move(from: string, to: string, expectedVersion: string): Promise<void>;
  close(): Promise<void>;
}
export interface FileRenamePort {
  open(grantId: string): Promise<RenameScope>;
}
