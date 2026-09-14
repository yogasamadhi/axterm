import type {
  ElectermDataImportResult,
  ElectermDataPreview,
  SyncCategory,
  SyncProfile,
} from '@workspace/contracts';

export interface SyncCategoryDocument {
  count: number;
  hash: string;
  value: unknown;
}

export interface SyncDataDocument {
  formatVersion: 1;
  deviceName: string;
  appVersion: string;
  generatedAt: string;
  categories: Partial<Record<SyncCategory, SyncCategoryDocument>>;
}

export interface SyncDataSource {
  snapshot(categories: readonly SyncCategory[]): Promise<SyncDataDocument>;
  preview(
    document: SyncDataDocument,
    categories: readonly SyncCategory[],
  ): Promise<ElectermDataPreview>;
  getPreview(previewId: string): ElectermDataPreview | null;
  commit(previewId: string, treeEtag: string): Promise<ElectermDataImportResult>;
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
