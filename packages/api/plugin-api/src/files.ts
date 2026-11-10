import type { CreateTransferInput, Transfer } from './transfers.ts';
import { z } from 'zod';
import type { TypertResource } from './types.ts';
export const fileGrantSchema = z
  .object({
    grantId: z.string().min(1).max(256),
    kind: z.enum(['file', 'directory', 'save-target']),
    name: z.string().max(4096),
    rootPath: z.string().min(1).max(4096).optional(),
    permissions: z
      .array(z.enum(['read', 'write']))
      .min(1)
      .max(2),
    createdAt: z.iso.datetime(),
    expiresAt: z.iso.datetime().optional(),
  })
  .strict();
export const fileGrantRequestSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.enum(['open-file', 'open-directory', 'save-file']) }).strict(),
  z.object({ kind: z.enum(['home-directory', 'downloads-directory']) }).strict(),
  z.object({ kind: z.literal('dropped-directory'), ticket: z.uuid() }).strict(),
  z
    .object({ kind: z.literal('directory-path'), path: z.string().trim().min(1).max(4096) })
    .strict(),
]);
export const grantedDirectoryPathSchema = z
  .string()
  .max(4096)
  .refine(
    (value) =>
      !value.startsWith('/') &&
      !value.startsWith('\\') &&
      !value.includes('\\') &&
      !value.includes('\0') &&
      value.split('/').every((segment) => segment !== '.' && segment !== '..' && !!segment),
  )
  .or(z.literal(''));
export type FileGrant = z.infer<typeof fileGrantSchema>;
export type FileGrantRequest = z.input<typeof fileGrantRequestSchema>;
export type FilePermission = 'read' | 'write';
export const filesFailureReasonSchema = z.enum([
  'invalid-input',
  'not-found',
  'forbidden',
  'stale',
  'closed',
  'cancelled',
  'capacity',
  'unavailable',
  'unsupported-destination',
  'conflict',
  'uncertain',
  'receipt-expired',
]);
export type FilesFailureReason = z.infer<typeof filesFailureReasonSchema>;
export const FILE_GRANTS_CHUNK_CHARACTERS = 16_384;
export const FILE_GRANTS_MAX_SNAPSHOT_BYTES = 64 * 1024 * 1024;
export const fileGrantsContentSchema = z
  .object({ grants: z.array(fileGrantSchema).max(16_384) })
  .strict();
export type FileGrantsContent = z.infer<typeof fileGrantsContentSchema>;
export interface FileGrantsBaseline {
  readonly generation: string;
  readonly cursor: number;
  readonly grants: readonly FileGrant[];
}
export type FileGrantsUpdate =
  | {
      readonly type: 'begin';
      readonly mode: 'baseline' | 'replace';
      readonly generation: string;
      readonly cursor: number;
    }
  | {
      readonly type: 'chunk';
      readonly offset: number;
      readonly text: string;
      readonly final: boolean;
    }
  | { readonly type: 'commit'; readonly cursor: number };
declare module './types.ts' {
  interface RemoteErrorDetailsMap {
    'files/failure': { readonly reason: FilesFailureReason };
  }
}
declare module './index.ts' {
  interface TypertResourceMap {
    fileGrant: TypertResource<string>;
  }
}

export const grantedEntryNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(255)
  .refine(
    (value) =>
      value !== '.' &&
      value !== '..' &&
      !value.includes('/') &&
      !value.includes('\\') &&
      !value.includes('\0'),
    'Expected a portable file name',
  );
/** Retained product import limits; files stream through their owner, never JSON/native IPC. */
export const MANAGED_FILE_IMPORT_PATH = '/api/files/import';
export const MANAGED_FILE_IMPORT_MAX_BYTES = 4 * 1024 * 1024 * 1024;
export const MANAGED_EDITABLE_IMPORT_MAX_BYTES = 2 * 1024 * 1024;
export const managedFileImportSchema = z
  .object({
    name: z
      .string()
      .min(1)
      .max(255)
      .refine(
        (value) =>
          value !== '.' &&
          value !== '..' &&
          !/[\\/"']/u.test(value) &&
          !Array.from(value).some(
            (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
          ),
      ),
    size: z.number().int().min(0).max(MANAGED_FILE_IMPORT_MAX_BYTES),
    editable: z.boolean(),
    editableDirectory: z.boolean().optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.editableDirectory && !value.editable)
      ctx.addIssue({
        code: 'custom',
        path: ['editableDirectory'],
        message: 'Editor directory requires editable import',
      });
    if (value.editable && value.size > MANAGED_EDITABLE_IMPORT_MAX_BYTES)
      ctx.addIssue({
        code: 'custom',
        path: ['size'],
        message: 'Editable file exceeds the import limit',
      });
  });
export type ManagedFileImportInput = z.infer<typeof managedFileImportSchema>;
export const grantedEntryPathSchema = grantedDirectoryPathSchema.refine(
  (value) => value.length > 0,
  'Expected a path to an entry inside the granted directory',
);
export const grantedEntryCreateRequestSchema = z
  .object({
    path: grantedDirectoryPathSchema.default(''),
    name: grantedEntryNameSchema,
    type: z.enum(['file', 'directory']),
  })
  .strict();
export const grantedEntryRenameRequestSchema = z
  .object({ path: grantedEntryPathSchema, name: grantedEntryNameSchema })
  .strict();
export const grantedEntryChmodRequestSchema = z
  .object({ path: grantedEntryPathSchema, mode: z.number().int().min(0).max(0o7777) })
  .strict();
export const grantedEntryPathRequestSchema = z.object({ path: grantedEntryPathSchema }).strict();
export const grantedFileOpenRequestSchema = z
  .object({ editorExecutable: z.string().trim().min(1).max(4_096).optional() })
  .strict();
export const grantedEntryPathsRequestSchema = z
  .object({ paths: z.array(grantedEntryPathSchema).min(1).max(10_000) })
  .strict();
export const grantedEntriesOperationRequestSchema = z
  .object({
    paths: z.array(grantedEntryPathSchema).min(1).max(1_000),
    destination: grantedDirectoryPathSchema,
    operation: z.enum(['copy', 'move']),
    conflict: z.enum(['skip', 'overwrite', 'rename']).default('rename'),
  })
  .strict();
export const grantedTransferPathRequestSchema = z
  .object({
    path: grantedDirectoryPathSchema,
    intent: z.enum(['read', 'write-target']),
  })
  .strict();
export const grantedDirectoryEntrySchema = z
  .object({
    name: z.string().min(1).max(1_024),
    path: grantedDirectoryPathSchema,
    type: z.enum(['file', 'directory', 'symlink', 'other']),
    size: z.number().int().nonnegative(),
    mode: z.number().int().nonnegative().optional(),
    modifiedAt: z.iso.datetime().optional(),
    accessedAt: z.iso.datetime().optional(),
    owner: z.string().optional(),
    group: z.string().optional(),
  })
  .strict();
export const grantedDirectoryListingSchema = z
  .object({
    grantId: z.string().min(1),
    rootName: z.string().min(1),
    path: grantedDirectoryPathSchema,
    entries: z.array(grantedDirectoryEntrySchema).max(10_000),
    truncated: z.boolean(),
  })
  .strict();
export const grantedTextSchema = z
  .object({
    name: z.string().min(1),
    content: z.string().max(2 * 1024 * 1024),
  })
  .strict();

export type GrantedDirectoryEntry = z.infer<typeof grantedDirectoryEntrySchema>;
export type GrantedDirectoryListing = z.infer<typeof grantedDirectoryListingSchema>;
export type GrantedEntryCreate = z.input<typeof grantedEntryCreateRequestSchema>;
export type GrantedEntryRename = z.input<typeof grantedEntryRenameRequestSchema>;
export type GrantedEntryChmod = z.input<typeof grantedEntryChmodRequestSchema>;
export type GrantedEntriesOperation = z.input<typeof grantedEntriesOperationRequestSchema>;
export const fileOperationReceiptSchema = z
  .object({
    id: z.uuid(),
    operation: z.string().min(1).max(128),
    cursor: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    changedCount: z.number().int().min(0).max(20_000),
  })
  .strict();
export type FileOperationReceipt = z.infer<typeof fileOperationReceiptSchema>;

export interface FileDirectoryBaseline {
  readonly grantId: string;
  readonly rootName: string;
  readonly path: string;
  readonly entries: readonly GrantedDirectoryEntry[];
  readonly truncated: boolean;
  readonly generation: string;
  readonly cursor: number;
}
export type FileDirectoryUpdate = FileGrantsUpdate;

/** Absolute POSIX paths used by remote file protocols. */
export const remoteFilePathSchema = z
  .string()
  .min(1)
  .max(4096)
  .refine(
    (value) => value.startsWith('/') && !value.includes('\0'),
    'Remote path must be absolute',
  );
export const remoteFileEntrySchema = z
  .object({
    name: z.string(),
    path: remoteFilePathSchema,
    type: z.enum(['file', 'directory', 'symlink', 'other']),
    size: z.number().int().nonnegative(),
    mode: z.number().int().nonnegative().optional(),
    modifiedAt: z.iso.datetime().optional(),
    accessedAt: z.iso.datetime().optional(),
    owner: z.string().optional(),
    group: z.string().optional(),
    revision: z.string(),
  })
  .strict();
export const pathInputSchema = z.object({ path: remoteFilePathSchema }).strict();
export const renamePathSchema = z
  .object({ from: remoteFilePathSchema, to: remoteFilePathSchema })
  .strict();
export const chmodPathSchema = z
  .object({ path: remoteFilePathSchema, mode: z.number().int().min(0).max(0o7777) })
  .strict();
export const remoteTextSchema = z
  .object({
    path: remoteFilePathSchema,
    content: z.string().max(2 * 1024 * 1024),
    revision: z.string(),
    lineEnding: z.enum(['lf', 'crlf']),
  })
  .strict();
export const writeRemoteTextSchema = remoteTextSchema
  .extend({ overwriteRevision: z.string() })
  .omit({ revision: true })
  .strict();
export const remoteEntriesOperationRequestSchema = z
  .object({
    paths: z.array(remoteFilePathSchema).min(1).max(1_000),
    destination: remoteFilePathSchema,
    operation: z.enum(['copy', 'move']),
    conflict: z.enum(['skip', 'overwrite', 'rename']).default('rename'),
  })
  .strict();
export type RemoteEntriesOperationRequest = z.infer<typeof remoteEntriesOperationRequestSchema>;

export type RemoteFileEntry = z.infer<typeof remoteFileEntrySchema>;
export type RemoteText = z.infer<typeof remoteTextSchema>;
export type WriteRemoteText = z.input<typeof writeRemoteTextSchema>;
export type RemoteEntriesOperation = z.input<typeof remoteEntriesOperationRequestSchema>;

export const remoteEntryCreateSchema = z
  .object({ path: remoteFilePathSchema, type: z.enum(['file', 'directory']) })
  .strict();
export type RemoteEntryCreate = z.input<typeof remoteEntryCreateSchema>;
export type RemoteEntryRename = z.input<typeof renamePathSchema>;
export type RemoteEntryChmod = z.input<typeof chmodPathSchema>;
export const remoteFileTargetSchema = z
  .object({ protocol: z.enum(['sftp', 'ftp']), connectionId: z.uuid() })
  .strict();
export type RemoteFileTarget = z.infer<typeof remoteFileTargetSchema>;
export const remoteDirectoryListingSchema = z
  .object({
    target: remoteFileTargetSchema,
    path: remoteFilePathSchema,
    entries: z.array(remoteFileEntrySchema).max(20_000),
  })
  .strict();
export type RemoteDirectoryListing = z.infer<typeof remoteDirectoryListingSchema>;
export interface RemoteDirectoryBaseline {
  readonly target: Readonly<RemoteFileTarget>;
  readonly path: string;
  readonly entries: readonly RemoteFileEntry[];
  readonly generation: string;
  readonly cursor: number;
}
export type RemoteDirectoryUpdate = FileGrantsUpdate;

/** Owner-registered bulk HTTP routes; authentication stays on the Connection carrier. */
export const LOCAL_FILE_READ_PATH = '/api/files/read';
export const LOCAL_FILE_WRITE_PATH = '/api/files/write';
export const MAX_FILE_HTTP_BYTES = 4 * 1024 ** 3;
const fileHttpInteger = z
  .string()
  .regex(/^(?:0|[1-9]\d{0,15})$/)
  .transform(Number)
  .pipe(z.number().int().min(0).max(Number.MAX_SAFE_INTEGER));
export const localFileReadQuerySchema = z
  .object({
    grantId: z.string().min(1).max(256),
    path: grantedDirectoryPathSchema.refine((value) => value.length > 0),
    start: fileHttpInteger.optional(),
    end: fileHttpInteger.optional(),
  })
  .strict()
  .refine((value) => value.end === undefined || value.end >= (value.start ?? 0));
export const localFileWriteQuerySchema = z
  .object({
    grantId: z.string().min(1).max(256),
    path: grantedDirectoryPathSchema.refine((value) => value.length > 0),
    overwrite: z
      .enum(['true', 'false'])
      .default('false')
      .transform((value) => value === 'true'),
    mode: fileHttpInteger.pipe(z.number().max(0o7777)).default(0o600),
  })
  .strict();
export const localFileWriteHeadersSchema = z
  .object({
    key: z.uuid().transform((value) => value.toLowerCase()),
    bytes: fileHttpInteger.pipe(z.number().max(MAX_FILE_HTTP_BYTES)),
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .strict();

/** Selected Client actions. The Files owner still owns generated Remote and native authority. */
export interface FileGrantActions {
  importFileInGeneration?(file: File, generation: string, signal?: AbortSignal): Promise<FileGrant>;
  prepareInputPathsInGeneration?(
    ids: readonly string[],
    generation: string,
    signal?: AbortSignal,
  ): Promise<readonly string[]>;

  createInGeneration?(
    input: FileGrantRequest,
    generation: string,
    signal?: AbortSignal,
  ): Promise<FileGrant | undefined>;
  readInGeneration?(
    id: string,
    maxBytes: number,
    generation: string,
    signal?: AbortSignal,
  ): Promise<{ name: string; content: string }>;
  revokeInGeneration?(id: string, generation: string, signal?: AbortSignal): Promise<void>;
  create(input: FileGrantRequest, signal?: AbortSignal): Promise<FileGrant | undefined>;
  importFile(file: File, editable?: boolean, signal?: AbortSignal): Promise<FileGrant>;
  revoke(id: string, signal?: AbortSignal): Promise<void>;
}
declare module '@deepseek-ai/cordis' {
  interface Context {
    fileGrantActions: FileGrantActions;
  }
}

/** Transient, bounded comparison output; file bodies are never directory facts or durable events. */
export const MAX_FILE_COMPARISON_BYTES = 2 * 1024 * 1024;
export const MAX_FILE_COMPARISON_LINES = 10_000;
export const fileComparisonSourceSchema = z.discriminatedUnion('scope', [
  z
    .object({
      scope: z.literal('local'),
      grantId: z.string().min(1).max(256),
      path: grantedDirectoryPathSchema,
    })
    .strict(),
  z
    .object({
      scope: z.literal('remote'),
      target: remoteFileTargetSchema,
      path: remoteFilePathSchema,
    })
    .strict(),
]);
export const createFileComparisonSchema = z
  .object({ left: fileComparisonSourceSchema, right: fileComparisonSourceSchema })
  .strict();
export const fileComparisonEntrySchema = z
  .object({
    scope: z.enum(['local', 'remote']),
    name: z.string().min(1).max(1024),
    path: z.string().min(1).max(4096),
    size: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    mode: z.number().int().nonnegative().optional(),
    modifiedAt: z.iso.datetime().optional(),
    accessedAt: z.iso.datetime().optional(),
    owner: z.string().optional(),
    group: z.string().optional(),
    content: z.string().max(MAX_FILE_COMPARISON_BYTES).optional(),
    lineCount: z.number().int().nonnegative().max(MAX_FILE_COMPARISON_LINES).optional(),
  })
  .strict();
export const fileComparisonSchema = z
  .object({
    status: z.enum(['equal', 'different', 'unsupported', 'too-large']),
    reason: z.enum(['binary', 'directory', 'too-many-bytes', 'too-many-lines']).optional(),
    left: fileComparisonEntrySchema,
    right: fileComparisonEntrySchema,
  })
  .strict();
export type FileComparisonSource = z.infer<typeof fileComparisonSourceSchema>;
export type CreateFileComparison = z.infer<typeof createFileComparisonSchema>;
export type FileComparison = z.infer<typeof fileComparisonSchema>;

const fileOutcomeIdentity = {
  id: z.uuid(),
  generation: z.uuid(),
  operation: z.string().min(1).max(128),
};
export const fileOperationOutcomeSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('missing'), id: z.uuid() }).strict(),
  z.object({ status: z.literal('running'), ...fileOutcomeIdentity }).strict(),
  z
    .object({
      status: z.literal('completed'),
      ...fileOutcomeIdentity,
      receipt: fileOperationReceiptSchema,
    })
    .strict(),
  z
    .object({
      status: z.literal('failed'),
      ...fileOutcomeIdentity,
      reason: filesFailureReasonSchema,
    })
    .strict(),
  z
    .object({
      status: z.literal('interrupted'),
      ...fileOutcomeIdentity,
      reason: z.literal('uncertain'),
    })
    .strict(),
  z.object({ status: z.literal('expired'), ...fileOutcomeIdentity }).strict(),
]);
export type FileOperationOutcome = z.infer<typeof fileOperationOutcomeSchema>;

export const nativeFileOperationSchema = z
  .object({
    grantId: z.string().min(1).max(256),
    path: grantedDirectoryPathSchema,
    action: z.enum(['open', 'reveal']),
  })
  .strict();
export type NativeFileOperation = z.infer<typeof nativeFileOperationSchema>;

export const createExternalEditorSchema = z
  .object({ generation: z.uuid(), target: remoteFileTargetSchema, path: remoteFilePathSchema })
  .strict();
export type CreateExternalEditor = z.infer<typeof createExternalEditorSchema>;
export const externalEditorSessionSchema = z
  .object({
    id: z.uuid(),
    target: remoteFileTargetSchema,
    remotePath: remoteFilePathSchema,
    fileName: grantedEntryNameSchema,
    state: z.enum(['watching', 'changed', 'saved', 'conflict', 'error']),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
    expiresAt: z.iso.datetime(),
    reason: filesFailureReasonSchema.optional(),
  })
  .strict();
export type ExternalEditorSession = z.infer<typeof externalEditorSessionSchema>;
export const externalEditorsContentSchema = z
  .object({ sessions: z.array(externalEditorSessionSchema).max(8) })
  .strict();
export interface ExternalEditorsBaseline {
  readonly generation: string;
  readonly cursor: number;
  readonly sessions: readonly ExternalEditorSession[];
}
export type ExternalEditorsUpdate = FileGrantsUpdate;

/** Files retains grant ownership while the existing Transfers owner runs the actual queue. */
export interface FileTransferActions {
  create(generation: string, key: string, input: CreateTransferInput): Promise<Transfer>;
  release(grantId: string, generation: string): Promise<void>;
}
declare module '@deepseek-ai/cordis' {
  interface Context {
    fileTransferActions: FileTransferActions;
  }
}
