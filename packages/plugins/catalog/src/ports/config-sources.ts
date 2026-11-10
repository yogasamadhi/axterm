import type { GrantedDirectoryEntry, FilePermission } from '@axterm/plugin-api/files';
export interface ConfigSource {
  readonly name: string;
  readonly kind: 'file' | 'directory' | 'save-target';
  readonly permissions: readonly FilePermission[];
  readonly path: ConfigFile;
}
export interface ConfigFile {
  readonly name: string;
  readonly key: string;
  stat(): Promise<GrantedDirectoryEntry>;
  read(maxBytes: number): Promise<string>;
  list(): Promise<readonly ConfigFile[]>;
}
export interface ConfigSourceScope {
  resolveGrant(id: string): Promise<ConfigSource>;
}
export interface ConfigSources {
  run<T>(signal: AbortSignal, action: (scope: ConfigSourceScope) => Promise<T>): Promise<T>;
  dispose(): Promise<void>;
}
