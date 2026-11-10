import type { Readable, Transform } from 'node:stream';
import type {
  LocalFileLease,
  LocalDirectoryWriter,
  RemoteFilesystem,
} from '@axterm/plugin-api/host';
import type { TransferConflictDecision } from '@axterm/plugin-api/transfers';
export interface ArchiveTransfers {
  transfer(input: {
    direction: 'upload' | 'download';
    local: LocalFileLease;
    localPath: string;
    remote: RemoteFilesystem;
    remotePath: string;
    signal: AbortSignal;
    progress(): Transform;
    setTotal(bytes: number): void;
    conflict(
      path: string,
      type: 'file' | 'directory' | 'unknown',
    ): Promise<TransferConflictDecision['strategy']>;
    exec(command: string): Promise<{ stdout: string; stderr: string; exitCode: number | null }>;
  }): Promise<void>;
  resourceCount?(): number;
  close?(): Promise<void>;
}
export interface PrivateArchive {
  readonly size: number;
  read(): Readable;
  close(): Promise<void>;
}
export interface ExtractedArchive {
  publish(files: LocalDirectoryWriter, signal: AbortSignal): Promise<void>;
  close(): Promise<void>;
}
export interface ArchiveStaging {
  pack(files: LocalFileLease, path: string, signal: AbortSignal): Promise<PrivateArchive>;
  unpack(source: Readable, rootName: string, signal: AbortSignal): Promise<ExtractedArchive>;
  resourceCount(): number;
  close(): Promise<void>;
}
