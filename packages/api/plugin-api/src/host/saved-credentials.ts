import type {
  SavedCredentialMetadata,
  SavedCredentialInspection,
  CreateSavedCredentialInput,
  CredentialMutationMarker,
} from '../saved-credentials.ts';
/** Host storage port. Product actions first reserve their durable one-shot intent. */
export interface SavedCredentialsService {
  list(): Promise<readonly SavedCredentialMetadata[]>;
  inspect(ref: string): Promise<SavedCredentialInspection | undefined>;
  /** Allocated by the workflow before IO; existing references are never replaced by create. */
  createAt(
    ref: string,
    input: CreateSavedCredentialInput,
    mutation: CredentialMutationMarker,
  ): Promise<SavedCredentialMetadata>;
  replace(
    ref: string,
    secret: string,
    mutation: CredentialMutationMarker,
  ): Promise<SavedCredentialMetadata>;
  remove(ref: string): Promise<void>;
  /** Atomic comparison and removal in the Vault's cross-process write lock. */
  removeOwned?(
    ref: string,
    expected: CredentialMutationMarker,
  ): Promise<'deleted' | 'missing' | 'changed'>;
}
