import type {
  CredentialCommandOperation,
  CredentialCommandReceipt,
  CredentialCommandFailure,
  SavedCredentialMetadata,
} from '@axterm/plugin-api/saved-credentials';
export interface CredentialIntent extends CredentialCommandReceipt {
  readonly descriptor: { readonly kind?: string; readonly label?: string };
}
/** Only a deliberately constructed non-secret descriptor crosses this port. */
export interface CredentialIntentStore {
  reserve(
    commandId: string,
    operation: CredentialCommandOperation,
    ref: string,
    descriptor: { kind?: string; label?: string },
  ): CredentialIntent;
  get(commandId: string): CredentialIntent | undefined;
  finish(
    commandId: string,
    status: 'completed' | 'failed' | 'uncertain',
    metadata?: SavedCredentialMetadata,
    reason?: CredentialCommandFailure,
  ): CredentialCommandReceipt;
}

/** File authority stays in Files; this port never exposes a physical path to the workflow. */
export type CredentialFileReader = (
  grantId: string,
  maxBytes: number,
  signal: AbortSignal,
) => Promise<string>;
