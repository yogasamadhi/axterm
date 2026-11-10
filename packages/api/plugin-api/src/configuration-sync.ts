import { z } from 'zod';
import {
  syncProfileSchema,
  testSyncProfileResultSchema,
  backupSyncRemoteResultSchema,
  syncComparisonSchema,
  syncRunResultSchema,
  axtermSyncDownloadPreviewResultSchema,
} from './schemas/data-sync.ts';
export * from './schemas/data-sync.ts';
export * from './schemas/axterm-sync.ts';
import type {} from './types.ts';
import type { SavedCredentialsUpdate } from './saved-credentials.ts';
export type SyncUpdate = SavedCredentialsUpdate;
export const SYNC_MAX_SNAPSHOT_BYTES = 4 * 1024 * 1024;
export const SYNC_CHUNK_CHARACTERS = 16_384;
import type { SyncProfile } from './schemas/data-sync.ts';
export type SyncOperation = 'test' | 'backup' | 'compare' | 'upload' | 'download-preview';
export type SyncFailure =
  | 'invalid-input'
  | 'stale-generation'
  | 'already-submitted'
  | 'not-found'
  | 'conflict'
  | 'closed'
  | 'capacity'
  | 'unavailable'
  | 'cancelled'
  | 'uncertain'
  | 'interrupted'
  | 'receipt-expired'
  | 'not-configured'
  | 'remote-conflict'
  | 'remote-invalid'
  | 'provider-failed'
  | 'gist-clone-required'
  | 'gitee-truncated';
export type SyncRunReceipt = z.infer<typeof syncRunReceiptSchema>;

export interface SyncFactReceipt {
  readonly id: string;
  readonly cursor: number;
  readonly version?: number;
}
export interface SyncBaseline {
  readonly generation: string;
  readonly cursor: number;
  readonly profiles: readonly SyncProfile[];
  readonly runs: readonly SyncRunReceipt[];
}
declare module './types.ts' {
  interface RemoteErrorDetailsMap {
    'configuration/sync-failure': { readonly reason: SyncFailure };
  }
}

export const syncFailureSchema = z.enum([
  'invalid-input',
  'stale-generation',
  'already-submitted',
  'not-found',
  'conflict',
  'closed',
  'capacity',
  'unavailable',
  'cancelled',
  'uncertain',
  'interrupted',
  'receipt-expired',
  'not-configured',
  'remote-conflict',
  'remote-invalid',
  'provider-failed',
  'gist-clone-required',
  'gitee-truncated',
]);
export const syncOperationSchema = z.enum([
  'test',
  'backup',
  'compare',
  'upload',
  'download-preview',
]);
export const syncRunReceiptSchema = z
  .object({
    ownerProfile: z.string().min(1).max(128),
    commandId: z.uuid(),
    generation: z.uuid(),
    profileId: z.uuid(),
    operation: syncOperationSchema,
    status: z.enum([
      'queued',
      'running',
      'completed',
      'failed',
      'uncertain',
      'interrupted',
      'expired',
    ]),
    reason: syncFailureSchema.optional(),
    cursor: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  })
  .strict();
export const syncOperationResultSchema = z.discriminatedUnion('operation', [
  z.object({ operation: z.literal('test'), value: testSyncProfileResultSchema }).strict(),
  z.object({ operation: z.literal('backup'), value: backupSyncRemoteResultSchema }).strict(),
  z.object({ operation: z.literal('compare'), value: syncComparisonSchema }).strict(),
  z.object({ operation: z.literal('upload'), value: syncRunResultSchema }).strict(),
  z
    .object({
      operation: z.literal('download-preview'),
      value: axtermSyncDownloadPreviewResultSchema,
    })
    .strict(),
]);
export type SyncOperationResult = z.infer<typeof syncOperationResultSchema>;
export const syncCommandOutcomeSchema = z
  .object({ receipt: syncRunReceiptSchema, result: syncOperationResultSchema.optional() })
  .strict();
export type SyncCommandOutcome = z.infer<typeof syncCommandOutcomeSchema>;
export const syncSnapshotSchema = z
  .object({
    profiles: z.array(syncProfileSchema).max(4),
    runs: z.array(syncRunReceiptSchema).max(2048),
  })
  .strict();
