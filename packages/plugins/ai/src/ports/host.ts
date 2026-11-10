/** Owned credentials and one-shot attachment authority. No native Host client crosses the application boundary. */
export interface AiHostPort {
  resolveCredential(ref: string, signal?: AbortSignal): Promise<string>;
  readGrantedTextPrefix(
    grantId: string,
    maxBytes: number,
    maxSourceBytes: number,
    signal: AbortSignal,
  ): Promise<{
    name: string;
    size: number;
    includedBytes: number;
    truncated: boolean;
    content: string;
  }>;
  revokeGrant(grantId: string): Promise<void>;
}
