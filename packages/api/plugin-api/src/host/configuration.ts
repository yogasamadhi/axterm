import type { RelationalParticipant } from '../storage.ts';
import type { Settings, UpdateSettingsInput } from '../configuration.ts';
import type { CredentialMutationMarker } from '../saved-credentials.ts';
/** Only the credential workflow may dispose an explicitly widget-created, unchanged token. */
export interface TemporaryCredentials {
  removeOwned(
    key: string,
    generation: string,
    ref: string,
    createdBy: CredentialMutationMarker,
  ): Promise<void>;
}
export type ConfigurationHistoryKind = 'connection-history' | 'command-history';
export interface ConfigurationHistorySource {
  readonly participant: RelationalParticipant;
  /** Synchronous owner operation, invoked only inside the configuration workflow's shared transaction. */
  purge(): { readonly deletedCount: number };
}
export interface ConfigurationHistory {
  register(kind: ConfigurationHistoryKind, source: ConfigurationHistorySource): () => Promise<void>;
}
export interface ConfigurationQueries {
  readonly participant: RelationalParticipant;
  getSettings(): Settings;
}
export type HistoryPrivacyPatch = UpdateSettingsInput['privacy'];
declare module '@deepseek-ai/cordis' {
  interface Context {
    configurationHistory: ConfigurationHistory;
    configuration: ConfigurationQueries;
    temporaryCredentials: TemporaryCredentials;
  }
}
