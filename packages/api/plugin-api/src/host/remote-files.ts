import type { RemoteFileTarget, RemoteDirectoryListing, RemoteText } from '../files.ts';
import type { Readable, Writable } from 'node:stream';
export interface RemoteFileAttributes {
  size: number;
  mode: number;
  atime: number;
  mtime: number;
  uid: number;
  gid: number;
  isFile: boolean;
  isDirectory: boolean;
  isSymbolicLink: boolean;
}
export interface RemoteFilesystemEntry {
  filename: string;
  attrs: RemoteFileAttributes;
}
export class RemoteFileCapabilityUnavailableError extends Error {
  constructor(readonly capability: 'atomic-replace') {
    super(`Remote file capability is unavailable: ${capability}`);
    this.name = 'RemoteFileCapabilityUnavailableError';
  }
}
export interface RemoteFilesystem {
  realpath(path: string): Promise<string>;
  list(path: string): Promise<RemoteFilesystemEntry[]>;
  stat(path: string): Promise<RemoteFileAttributes>;
  lstat(path: string): Promise<RemoteFileAttributes>;
  mkdir(path: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  replace(from: string, to: string): Promise<void>;
  unlink(path: string): Promise<void>;
  rmdir(path: string): Promise<void>;
  chmod(path: string, mode: number): Promise<void>;
  readStream(path: string, options?: { start?: number; end?: number }): Readable;
  writeStream(path: string, options?: { flags?: 'w' | 'wx' | 'a'; mode?: number }): Writable;
  close(): Promise<void>;
}

/** A bounded transport-independent channel; the connection owner retains native resources. */
export interface RemoteFileLease {
  readonly filesystem: RemoteFilesystem;
  readonly signal: AbortSignal;
  close(): Promise<void>;
}

/** Selected reads owned by the Files plugin, including its cancellation and live protocol leases. */
export interface RemoteFilesQueries {
  list(
    target: RemoteFileTarget,
    path: string,
    signal: AbortSignal,
  ): Promise<RemoteDirectoryListing>;
  readText(target: RemoteFileTarget, path: string, signal: AbortSignal): Promise<RemoteText>;
}
declare module '@deepseek-ai/cordis' {
  interface Context {
    remoteFiles: RemoteFilesQueries;
  }
}
