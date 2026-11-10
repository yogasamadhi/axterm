import { z } from 'zod';
import type { Readable } from 'node:stream';
import {
  fileGrantSchema,
  type FileGrant,
  type GrantedDirectoryEntry,
  type FileGrantRequest,
  type ManagedFileImportInput,
  type FilePermission,
} from '../files.ts';
export const fileIdentitySchema = z
  .object({ device: z.string().regex(/^\d+$/).max(32), inode: z.string().regex(/^\d+$/).max(32) })
  .strict();
/** Native/Host-only proof. Browser metadata never substitutes for this authority. */
export const fileAuthoritySchema = z
  .object({
    grant: fileGrantSchema,
    generation: z.uuid(),
    rootPath: z.string().min(1).max(4096),
    rootIdentity: fileIdentitySchema,
    fileName: z
      .string()
      .min(1)
      .max(255)
      .refine((value) => value !== '.' && value !== '..' && !/[\\/\0]/u.test(value))
      .optional(),
    fileIdentity: fileIdentitySchema.optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (
      value.grant.kind === 'directory'
        ? value.fileName !== undefined || value.fileIdentity !== undefined
        : !value.fileName || (value.grant.kind === 'file' && !value.fileIdentity)
    )
      ctx.addIssue({ code: 'custom', message: 'File authority does not match its kind' });
  });
export type FileIdentity = z.infer<typeof fileIdentitySchema>;
export type FileAuthority = z.infer<typeof fileAuthoritySchema>;
export interface FileGrantPage {
  readonly revision: number;
  readonly items: readonly FileGrant[];
  readonly nextOffset: number | null;
}
export interface FileGrantLease {
  readonly authority: FileAuthority;
  readonly signal: AbortSignal;
  /** Checks generation, revocation, cancellation and expiry immediately before use. */
  assert(): void;
  dispose(): void;
}
export interface FileGrants {
  create(input: FileGrantRequest, signal?: AbortSignal): Promise<FileGrant | undefined>;
  list(signal?: AbortSignal): Promise<readonly FileGrant[]>;
  revoke(grantId: string, signal?: AbortSignal): Promise<void>;
  authorize(
    grantId: string,
    permission: FilePermission,
    signal?: AbortSignal,
  ): Promise<FileGrantLease>;
  resolveDirectory(grantId: string, path: string, signal?: AbortSignal): Promise<string>;
  readText(
    grantId: string,
    maxBytes: number,
    signal?: AbortSignal,
  ): Promise<{ name: string; content: string }>;
}
/** Native authority for owner-managed uploads. No filesystem path or bytes are accepted. */
export interface ManagedFileImports {
  prepare(input: ManagedFileImportInput, signal: AbortSignal): Promise<FileGrant>;
  commit(id: string, signal: AbortSignal): Promise<FileGrant>;
  discard(id: string): Promise<void>;
}
declare module '@deepseek-ai/cordis' {
  interface Context {
    fileGrants: FileGrants;
    fileImports: ManagedFileImports;
  }
}

/** Selected Host IO; paths are portable and relative to a live native authority. */
export interface LocalDirectoryWriter {
  readonly signal: AbortSignal;
  mkdir(path: string): Promise<void>;
  chmod(path: string, mode: number): Promise<void>;
  setTimes(path: string, times: { modifiedAt: number; accessedAt?: number }): Promise<void>;
  write(path: string, input: Readable, options?: { mode?: number }): Promise<void>;
}
export interface LocalFileLease {
  readonly path: string;
  readonly signal: AbortSignal;
  stat(path: string): Promise<GrantedDirectoryEntry>;
  list(path: string): Promise<readonly GrantedDirectoryEntry[]>;
  read(path: string, options?: { start?: number; end?: number }): Promise<Readable>;
  /** Stages exclusively and publishes only after the complete input has drained. */
  write(
    path: string,
    input: Readable,
    options?: { overwrite?: boolean; mode?: number },
  ): Promise<void>;
  /** Append a bounded stream to the pinned authorized file; preserve already-written log bytes on cancellation. */
  append(path: string, input: Readable): Promise<void>;
  writeDirectory(
    path: string,
    populate: (files: LocalDirectoryWriter) => Promise<void>,
    options?: { overwrite?: boolean },
  ): Promise<void>;
  mkdir(path: string): Promise<void>;
  chmod(path: string, mode: number): Promise<void>;
  setTimes(path: string, times: { modifiedAt: number; accessedAt?: number }): Promise<void>;
  move(from: string, to: string, options?: { overwrite?: boolean }): Promise<void>;
  remove(path: string, options?: { recursive?: boolean }): Promise<void>;
  close(): Promise<void>;
}
export interface HostFiles {
  open(grantId: string, permission: FilePermission, signal?: AbortSignal): Promise<LocalFileLease>;
}
declare module '@deepseek-ai/cordis' {
  interface Context {
    files: HostFiles;
  }
}

/** Desktop OS launch only. Native paths and executable selection never cross this public contract. */
export interface FileApplications {
  open(grantId: string, path: string, signal?: AbortSignal): Promise<void>;
  reveal(grantId: string, path: string, signal?: AbortSignal): Promise<void>;
}
declare module '@deepseek-ai/cordis' {
  interface Context {
    fileApplications: FileApplications;
  }
}
