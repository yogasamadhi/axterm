/** Plaintext is transient Host execution data, never a model or journal value. */
export interface CredentialAccess {
  resolveCredential(ref: string, signal?: AbortSignal): Promise<string>;
  readGrantedText(id: string, signal?: AbortSignal): Promise<{ content: string }>;
  revokeGrant(id: string): Promise<void>;
}
