import { hostname } from 'node:os';
import {
  axtermSyncDocumentSchema,
  syncCategorySchema,
  type AxtermConfigurationDocument,
  type AxtermSyncDocument,
  type SyncCategory,
} from '@workspace/contracts';
import { ApplicationError } from '../../application/errors';
import { stableHash } from '../sqlite/product-repository';

export function axtermSyncDocumentFromSnapshot(
  snapshot: AxtermConfigurationDocument,
  selectedCategories: readonly SyncCategory[],
  input: { deviceName?: string; generatedAt?: string } = {},
): AxtermSyncDocument {
  const values = Object.fromEntries(
    selectedCategories.map((category) => {
      const value = categoryValue(snapshot, category);
      return [category, { count: categoryCount(category, value), hash: stableHash(value), value }];
    }),
  ) as AxtermSyncDocument['categories'];
  return axtermSyncDocumentSchema.parse({
    format: 'axterm-sync',
    formatVersion: 1,
    deviceName: boundedDeviceName(input.deviceName),
    appVersion: snapshot.appVersion,
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    categories: values,
    omissions: structuredClone(snapshot.omissions),
  });
}

export function parseAxtermSyncDocument(value: unknown): AxtermSyncDocument {
  const document = axtermSyncDocumentSchema.parse(value);
  for (const [name, item] of Object.entries(document.categories)) {
    const category = syncCategorySchema.parse(name);
    if (
      !item ||
      item.count !== categoryCount(category, item.value) ||
      item.hash !== stableHash(item.value)
    )
      throw new ApplicationError(
        'SYNC_REMOTE_INVALID',
        `Axterm sync category ${name} is invalid`,
        409,
      );
  }
  return document;
}

function categoryValue(snapshot: AxtermConfigurationDocument, category: SyncCategory): unknown {
  const { data } = snapshot;
  if (category === 'settings') return { settings: data.settings };
  if (category === 'bookmarks')
    return {
      hostGroups: data.hostGroups,
      hosts: data.hosts,
      bookmarkGroups: data.bookmarkGroups,
      bookmarks: data.bookmarks,
    };
  if (category === 'profiles')
    return {
      connectionProfiles: data.connectionProfiles,
      terminalProfiles: data.terminalProfiles,
      tunnelProfiles: data.tunnelProfiles,
    };
  if (category === 'terminalThemes') return { terminalThemes: data.terminalThemes };
  if (category === 'quickCommands')
    return { quickCommandGroups: data.quickCommandGroups, quickCommands: data.quickCommands };
  if (category === 'addressBookmarks')
    return { addressBookmarks: data.settings.fileManager.remoteAddressBookmarks };
  if (category === 'workspaces') return { workspace: data.settings.workspace };
  return { triggers: data.triggers };
}

function categoryCount(category: SyncCategory, value: unknown): number {
  const record = value as Record<string, unknown>;
  if (category === 'bookmarks')
    return (
      arrayCount(record.hostGroups) +
      arrayCount(record.hosts) +
      arrayCount(record.bookmarkGroups) +
      arrayCount(record.bookmarks)
    );
  if (category === 'profiles')
    return (
      arrayCount(record.connectionProfiles) +
      arrayCount(record.terminalProfiles) +
      arrayCount(record.tunnelProfiles)
    );
  if (category === 'terminalThemes') return arrayCount(record.terminalThemes);
  if (category === 'quickCommands')
    return arrayCount(record.quickCommandGroups) + arrayCount(record.quickCommands);
  if (category === 'addressBookmarks') return arrayCount(record.addressBookmarks);
  if (category === 'workspaces')
    return arrayCount((record.workspace as { namedWorkspaces?: unknown })?.namedWorkspaces);
  if (category === 'triggers') return arrayCount(record.triggers);
  return 1;
}

function arrayCount(value: unknown): number {
  return Array.isArray(value) ? value.length : 0;
}

function boundedDeviceName(value = hostname()): string {
  const normalized = value.trim().slice(0, 128);
  return normalized || 'unknown';
}
