import { z } from 'zod';
import {
  grantedDirectoryPathSchema,
  remoteFilePathSchema,
  remoteFileTargetSchema,
  type FileGrantsUpdate,
} from './files.ts';
import type { TypertResource, ClientFactsView } from './types.ts';
export const transferSchema = z
  .object({
    id: z.uuid(),
    connectionId: z.uuid(),
    direction: z.enum(['upload', 'download', 'remote-copy']),
    state: z.enum([
      'queued',
      'preparing',
      'running',
      'paused',
      'awaiting-decision',
      'succeeded',
      'failed',
      'canceled',
    ]),
    bytesTransferred: z.number().int().nonnegative(),
    totalBytes: z.number().int().nonnegative().optional(),
    bytesPerSecond: z.number().nonnegative().optional(),
    errorCode: z.string().optional(),
    // Derived from the current Runtime generation; never persisted as a grant.
    retryAvailability: z
      .enum(['available', 'request-expired', 'connection-unavailable', 'not-terminal'])
      .optional(),
    source: z.string().max(8_192).optional(),
    destination: z.string().max(8_192).optional(),
    conflict: z
      .object({
        path: z.string().min(1).max(4_096),
        type: z.enum(['file', 'directory', 'unknown']),
      })
      .strict()
      .optional(),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  })
  .strict();

export type Transfer = z.infer<typeof transferSchema>;
export const transferConflictPolicySchema = z.enum(['skip', 'overwrite', 'rename', 'ask']);
export const transferConflictDecisionSchema = z
  .object({
    strategy: z.enum(['skip', 'overwrite', 'rename']),
    applyToAll: z.boolean().default(false),
  })
  .strict();
export type TransferConflictDecision = z.input<typeof transferConflictDecisionSchema>;
const localRequestSchema = z
  .object({
    target: remoteFileTargetSchema,
    direction: z.enum(['upload', 'download']),
    grantId: z.string().min(1).max(256),
    localPath: grantedDirectoryPathSchema.optional(),
    remotePath: remoteFilePathSchema,
    recursive: z.boolean().default(false),
    archive: z.boolean().default(false),
    conflict: transferConflictPolicySchema.default('skip'),
  })
  .strict();
const copyRequestSchema = z
  .object({
    direction: z.literal('remote-copy'),
    source: remoteFileTargetSchema,
    target: remoteFileTargetSchema,
    sourcePath: remoteFilePathSchema,
    targetPath: remoteFilePathSchema,
    recursive: z.boolean().default(false),
    conflict: transferConflictPolicySchema.default('skip'),
  })
  .strict();
export const createTransferSchema = z.union([localRequestSchema, copyRequestSchema]);
export type TransferRequest = z.infer<typeof createTransferSchema>;
export type CreateTransferInput = z.input<typeof createTransferSchema>;
export const transfersBaselineSchema = z
  .object({
    items: z.array(transferSchema).max(500),
    factCursor: z.number().int().min(0),
    hasMore: z.boolean(),
    limit: z.literal(500),
  })
  .strict();
export type TransfersBaseline = z.infer<typeof transfersBaselineSchema> & {
  readonly generation: string;
  readonly revision: number;
};
export type TransfersUpdate = FileGrantsUpdate;
export type TransfersFailureReason =
  | 'invalid-input'
  | 'not-found'
  | 'conflict'
  | 'capacity'
  | 'cancelled'
  | 'closed'
  | 'receipt-expired'
  | 'unavailable';
declare module './types.ts' {
  interface RemoteErrorDetailsMap {
    'transfers/failure': { readonly reason: TransfersFailureReason };
  }
}
declare module './index.ts' {
  interface TypertResourceMap {
    transfer: TypertResource<string>;
  }
}

export const transferProgressSnapshotSchema = z
  .object({
    generation: z.uuid(),
    revision: z.number().int().min(0),
    factCursor: z.number().int().min(0),
    items: z
      .array(
        transferSchema.pick({
          id: true,
          state: true,
          bytesTransferred: true,
          totalBytes: true,
          bytesPerSecond: true,
          conflict: true,
          updatedAt: true,
        }),
      )
      .max(32),
  })
  .strict();
export type TransferProgressSnapshot = z.infer<typeof transferProgressSnapshotSchema>;

/** Selected commands and accepted facts; implementation and protocol IO remain private. */
export interface TransferClientActions extends ClientFactsView<TransfersBaseline> {
  getCommandOutcome(generation: string, key: string): Promise<TransferCommandOutcome>;
  create(key: string, input: CreateTransferInput): Promise<Transfer>;
  get(id: string): Promise<Transfer>;
  cancel(key: string, id: string): Promise<void>;
  pause(key: string, id: string): Promise<void>;
  resume(key: string, id: string): Promise<void>;
  retryTransfer(key: string, id: string): Promise<Transfer>;
  decideConflict(key: string, id: string, input: TransferConflictDecision): Promise<void>;
  clearCompleted(key: string): Promise<number>;
}
declare module '@deepseek-ai/cordis' {
  interface Context {
    transferActions: TransferClientActions;
  }
}

export const transferCommandOutcomeSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('missing') }).strict(),
  z.object({ status: z.literal('expired') }).strict(),
  z.object({ status: z.literal('accepted'), transfer: transferSchema }).strict(),
]);
export type TransferCommandOutcome = z.infer<typeof transferCommandOutcomeSchema>;
