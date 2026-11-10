import type {
  AxtermConfigurationImportResult,
  AxtermConfigurationPreview,
} from '@axterm/plugin-api/configuration-portable';
import type {
  AxtermSyncDocument,
  SyncCategory,
  SyncProfile,
} from '@axterm/plugin-api/configuration-sync';

export interface AxtermSyncDataSource {
  snapshot(categories: readonly SyncCategory[]): AxtermSyncDocument | Promise<AxtermSyncDocument>;
  preview(
    document: AxtermSyncDocument,
    categories: readonly SyncCategory[],
  ): AxtermConfigurationPreview | Promise<AxtermConfigurationPreview>;
  getPreview(previewId: string): AxtermConfigurationPreview | null;
  commit<T>(
    previewId: string,
    operation: (importPreview: () => AxtermConfigurationImportResult) => T,
  ): T;
  cancel(previewId: string): void;
}

export interface SyncProviderContext {
  profile: SyncProfile;
  accessSecret: string;
}

export interface SyncRemoteObject {
  contents: string;
  revision: string;
  updatedAt: string;
}

export interface SyncProvider {
  readonly type: SyncProfile['provider'];
  load(context: SyncProviderContext, signal: AbortSignal): Promise<SyncRemoteObject | null>;
  /** Returns the selected remote document as provider-visible bytes without sync decoding. */
  readBackup(context: SyncProviderContext, signal: AbortSignal): Promise<Uint8Array | null>;
  save(
    context: SyncProviderContext,
    contents: string,
    expectedRevision: string | null,
    signal: AbortSignal,
  ): Promise<SyncRemoteObject>;
}

export interface SyncSecretResolver {
  resolve(ref: string): Promise<string>;
  delete?(ref: string): Promise<void>;
}
