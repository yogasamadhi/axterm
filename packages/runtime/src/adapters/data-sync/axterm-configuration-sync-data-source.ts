import { hostname } from 'node:os';
import {
  axtermConfigurationDocumentSchema,
  type AxtermConfigurationDocument,
  type AxtermConfigurationImportResult,
  type AxtermConfigurationPreview,
  type AxtermSyncDocument,
  type SyncCategory,
} from '@workspace/contracts';
import { axtermSyncDocumentFromSnapshot, parseAxtermSyncDocument } from './axterm-sync-document';
import type { AxtermConfigurationService } from '../../application/axterm-configuration-service';
import { ApplicationError, isApplicationError } from '../../application/errors';

type ConfigurationSyncService = Pick<
  AxtermConfigurationService,
  'snapshot' | 'previewDocument' | 'commit' | 'cancelPreview' | 'getPreview'
>;

/**
 * The independent sync source deliberately composes the typed Axterm
 * configuration transaction. It does not read a File Grant: providers supply
 * the already-bounded remote document and the
 * configuration service retains preview/commit atomicity.
 */
export class AxtermConfigurationSyncDataSource {
  constructor(
    private readonly configuration: ConfigurationSyncService,
    private readonly deviceName = hostname().trim().slice(0, 128) || 'unknown',
  ) {}

  snapshot(categories: readonly SyncCategory[]): AxtermSyncDocument {
    return axtermSyncDocumentFromSnapshot(this.configuration.snapshot(), categories, {
      deviceName: this.deviceName,
    });
  }

  preview(
    remote: AxtermSyncDocument,
    categories: readonly SyncCategory[],
  ): AxtermConfigurationPreview {
    const document = parseAxtermSyncDocument(remote);
    const merged = structuredClone(this.configuration.snapshot());
    try {
      // Settings contains snapshots of these two collections as well as their
      // dedicated categories. Apply dedicated categories last so selection
      // order cannot make an older Settings copy overwrite selected data.
      const orderedCategories = [...categories].sort((left, right) => {
        const leftDedicated = left === 'addressBookmarks' || left === 'workspaces';
        const rightDedicated = right === 'addressBookmarks' || right === 'workspaces';
        return Number(leftDedicated) - Number(rightDedicated);
      });
      for (const category of orderedCategories) {
        const item = document.categories[category];
        if (!item)
          throw new ApplicationError(
            'SYNC_REMOTE_INVALID',
            `Remote Axterm sync document has no ${category} category`,
            409,
          );
        mergeCategory(merged, category, item.value);
      }
      merged.appVersion = document.appVersion;
      merged.exportedAt = document.generatedAt;
      merged.omissions = structuredClone(document.omissions);
      return this.configuration.previewDocument(
        axtermConfigurationDocumentSchema.parse(merged),
        categories.some((category) =>
          ['settings', 'addressBookmarks', 'workspaces'].includes(category),
        ),
      );
    } catch (cause) {
      if (isApplicationError(cause)) throw cause;
      throw new ApplicationError(
        'SYNC_REMOTE_INVALID',
        'Remote Axterm sync document is invalid',
        409,
      );
    }
  }

  commit(previewId: string): AxtermConfigurationImportResult {
    return this.configuration.commit(previewId);
  }

  getPreview(previewId: string): AxtermConfigurationPreview | null {
    return this.configuration.getPreview(previewId);
  }

  cancel(previewId: string): void {
    this.configuration.cancelPreview(previewId);
  }
}

function mergeCategory(
  document: AxtermConfigurationDocument,
  category: SyncCategory,
  value: unknown,
): void {
  const record = asRecord(value);
  if (!record)
    throw new ApplicationError(
      'SYNC_REMOTE_INVALID',
      `Remote ${category} category is invalid`,
      409,
    );
  if (category === 'settings') {
    document.data.settings = record.settings as AxtermConfigurationDocument['data']['settings'];
    return;
  }
  if (category === 'bookmarks') {
    document.data.hostGroups =
      record.hostGroups as AxtermConfigurationDocument['data']['hostGroups'];
    document.data.hosts = record.hosts as AxtermConfigurationDocument['data']['hosts'];
    document.data.bookmarkGroups =
      record.bookmarkGroups as AxtermConfigurationDocument['data']['bookmarkGroups'];
    document.data.bookmarks = record.bookmarks as AxtermConfigurationDocument['data']['bookmarks'];
    return;
  }
  if (category === 'profiles') {
    document.data.connectionProfiles =
      record.connectionProfiles as AxtermConfigurationDocument['data']['connectionProfiles'];
    document.data.terminalProfiles =
      record.terminalProfiles as AxtermConfigurationDocument['data']['terminalProfiles'];
    document.data.tunnelProfiles =
      record.tunnelProfiles as AxtermConfigurationDocument['data']['tunnelProfiles'];
    return;
  }
  if (category === 'terminalThemes') {
    document.data.terminalThemes =
      record.terminalThemes as AxtermConfigurationDocument['data']['terminalThemes'];
    return;
  }
  if (category === 'quickCommands') {
    document.data.quickCommandGroups =
      record.quickCommandGroups as AxtermConfigurationDocument['data']['quickCommandGroups'];
    document.data.quickCommands =
      record.quickCommands as AxtermConfigurationDocument['data']['quickCommands'];
    return;
  }
  if (category === 'addressBookmarks') {
    document.data.settings.fileManager.remoteAddressBookmarks =
      record.addressBookmarks as typeof document.data.settings.fileManager.remoteAddressBookmarks;
    return;
  }
  if (category === 'workspaces') {
    document.data.settings.workspace = record.workspace as typeof document.data.settings.workspace;
    return;
  }
  document.data.triggers = record.triggers as AxtermConfigurationDocument['data']['triggers'];
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
