// Preserve the canonical Context augmentation in emitted declarations.
import '@deepseek-ai/cordis';
// Axterm first-party credential DTOs migrated from the frozen generation-2 Contract.
// Secret inputs are transient commands, never model baselines, events or receipts.
import { z } from 'zod';
export const savedCredentialRefSchema = z
  .string()
  .regex(/^cred_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
export const savedCredentialKindSchema = z.enum([
  'sshPassword',
  'privateKey',
  'privateKeyPassphrase',
  'sshCertificate',
  'protocolPassword',
  'proxyPassword',
  'aiApiKey',
  'mcpApiKey',
  'syncAccessToken',
  'syncEncryptionPassword',
]);
export const savedCredentialMetadataSchema = z
  .object({
    ref: savedCredentialRefSchema,
    // Existing/provider-owned kinds remain visible even when the product has no dedicated label.
    kind: z.string().max(4096),
    label: z.string().max(4096),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
    storage: z.literal('local'),
  })
  .strict();
export const createSavedCredentialSchema = z
  .object({
    kind: savedCredentialKindSchema,
    label: z.string().trim().min(1).max(100),
    secret: z.string().min(1).max(131072),
  })
  .strict();
export const createGrantedCredentialSchema = z
  .object({
    kind: z.enum(['privateKey', 'sshCertificate']),
    label: z.string().trim().min(1).max(100),
    grantId: z.string().min(1).max(256),
  })
  .strict();
export type CreateGrantedCredentialInput = z.infer<typeof createGrantedCredentialSchema>;
export const replaceSavedCredentialSchema = z
  .object({ secret: z.string().min(1).max(131072) })
  .strict();
/** Non-secret proof identifying one already accepted, generation-bound mutation. */
export const credentialMutationMarkerSchema = z
  .object({ generation: z.uuid(), commandId: z.uuid() })
  .strict();
export type SavedCredentialMetadata = z.infer<typeof savedCredentialMetadataSchema>;
export type CreateSavedCredentialInput = z.infer<typeof createSavedCredentialSchema>;
export type ReplaceSavedCredentialInput = z.infer<typeof replaceSavedCredentialSchema>;
export type CredentialMutationMarker = z.infer<typeof credentialMutationMarkerSchema>;
export interface SavedCredentialInspection {
  readonly metadata: SavedCredentialMetadata;
  readonly mutation?: CredentialMutationMarker;
}

export type SavedCredentialStorageFailure =
  'invalid' | 'not-found' | 'conflict' | 'closed' | 'unavailable';
/** Host storage failures omit native/filesystem causes and secret-bearing input. */
export class SavedCredentialStorageError extends Error {
  constructor(readonly code: SavedCredentialStorageFailure) {
    const safe = ['invalid', 'not-found', 'conflict', 'closed', 'unavailable'].includes(code)
      ? code
      : 'unavailable';
    super('SAVED_CREDENTIAL_' + safe.toUpperCase().replaceAll('-', '_'));
    this.code = safe;
    this.name = 'SavedCredentialStorageError';
  }
}
export type CredentialCommandOperation = 'create' | 'replace' | 'delete';
export type CredentialCommandFailure =
  | 'invalid-input'
  | 'stale-generation'
  | 'already-submitted'
  | 'not-found'
  | 'conflict'
  | 'closed'
  | 'capacity'
  | 'unavailable'
  | 'uncertain'
  | 'interrupted'
  | 'receipt-expired';
export interface CredentialCommandReceipt {
  readonly commandId: string;
  readonly generation: string;
  readonly operation: CredentialCommandOperation;
  readonly ref: string;
  readonly status: 'running' | 'completed' | 'failed' | 'uncertain' | 'interrupted' | 'expired';
  readonly metadata?: SavedCredentialMetadata;
  readonly reason?: CredentialCommandFailure;
}
declare module './types.ts' {
  interface RemoteErrorDetailsMap {
    'configuration/credentials-failure': { readonly reason: CredentialCommandFailure };
  }
}

export const CREDENTIALS_CHUNK_CHARACTERS = 16_384;
export const CREDENTIALS_MAX_SNAPSHOT_BYTES = 64 * 1024 * 1024;
export const savedCredentialsSnapshotSchema = z
  .object({
    credentials: z.array(savedCredentialMetadataSchema).max(100_000),
  })
  .strict();
export interface SavedCredentialsBaseline {
  readonly generation: string;
  readonly cursor: number;
  readonly credentials: readonly SavedCredentialMetadata[];
}
export type SavedCredentialsUpdate =
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

export interface CredentialSubmission {
  readonly commandId: string;
  readonly generation: string;
  readonly result: Promise<CredentialCommandReceipt>;
}
/** Selected Client commands. Only the Configuration owner owns generation, receipts and Vault RPC. */
export interface SavedCredentialActions {
  submitCreate(input: CreateSavedCredentialInput): CredentialSubmission;
  submitFromGrant(input: CreateGrantedCredentialInput, signal?: AbortSignal): CredentialSubmission;
  submitRemove(ref: string): CredentialSubmission;
  outcome(commandId: string): Promise<CredentialCommandReceipt>;
  create(input: CreateSavedCredentialInput): Promise<CredentialCommandReceipt>;
  remove(ref: string): Promise<CredentialCommandReceipt>;
}
declare module '@deepseek-ai/cordis' {
  interface Context {
    savedCredentialActions: SavedCredentialActions;
  }
}
