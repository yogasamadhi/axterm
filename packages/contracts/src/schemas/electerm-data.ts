import { z } from 'zod';
import { bookmarkTreeSchema, bookmarkTreeEtagSchema } from './bookmarks';
import { idSchema, timestampSchema } from './resources';

export const electermMigrationKindSchema = z.enum([
  'group',
  'profile',
  'sshBookmark',
  'bookmark',
  'quickCommand',
  'settings',
]);
export const electermMigrationActionSchema = z.enum(['create', 'unchanged', 'skip']);
export const electermMigrationEntrySchema = z
  .object({
    key: z.string().min(1).max(300),
    kind: electermMigrationKindSchema,
    sourceId: z.string().min(1).max(160),
    name: z.string().min(1).max(160),
    action: electermMigrationActionSchema,
    reasons: z.array(z.string().min(1).max(240)).max(16),
    mappedFields: z.array(z.string().min(1).max(80)).max(64),
    omittedFields: z.array(z.string().min(1).max(80)).max(64),
  })
  .strict();

export const electermMigrationCountsSchema = z
  .object({
    create: z.number().int().nonnegative(),
    unchanged: z.number().int().nonnegative(),
    skip: z.number().int().nonnegative(),
    groups: z.number().int().nonnegative(),
    profiles: z.number().int().nonnegative(),
    sshBookmarks: z.number().int().nonnegative(),
    quickCommands: z.number().int().nonnegative(),
    settings: z.number().int().min(0).max(1),
    credentialMetadata: z.number().int().nonnegative(),
  })
  .strict();

export const previewElectermDataSchema = z.object({ grantId: z.string().min(1).max(256) }).strict();
export const electermDataPreviewSchema = z
  .object({
    previewId: idSchema,
    sourceName: z.string().min(1).max(255),
    sourceVersion: z.string().max(80).nullable(),
    treeEtag: bookmarkTreeEtagSchema,
    expiresAt: timestampSchema,
    counts: electermMigrationCountsSchema,
    entries: z.array(electermMigrationEntrySchema).max(6_000),
  })
  .strict();

export const commitElectermDataSchema = z.object({ previewId: idSchema }).strict();
export const electermDataImportResultSchema = z
  .object({
    previewId: idSchema,
    counts: electermMigrationCountsSchema,
    createdCredentialCount: z.number().int().nonnegative(),
    settingsApplied: z.boolean(),
    credentialMetadataReported: z.number().int().nonnegative(),
    tree: bookmarkTreeSchema,
  })
  .strict();

export const exportElectermDataSchema = z.object({ grantId: z.string().min(1).max(256) }).strict();
export const electermDataExportResultSchema = z
  .object({
    bytes: z.number().int().nonnegative(),
    groups: z.number().int().nonnegative(),
    profiles: z.number().int().nonnegative(),
    sshBookmarks: z.number().int().nonnegative(),
    quickCommands: z.number().int().nonnegative(),
    omittedCredentialCount: z.number().int().nonnegative(),
    credentialMetadataCount: z.number().int().nonnegative(),
    settingsIncluded: z.literal(true),
    createdAt: timestampSchema,
  })
  .strict();

export type ElectermMigrationEntry = z.infer<typeof electermMigrationEntrySchema>;
export type ElectermMigrationAction = z.infer<typeof electermMigrationActionSchema>;
export type ElectermMigrationCounts = z.infer<typeof electermMigrationCountsSchema>;
export type ElectermDataPreview = z.infer<typeof electermDataPreviewSchema>;
export type ElectermDataImportResult = z.infer<typeof electermDataImportResultSchema>;
export type ElectermDataExportResult = z.infer<typeof electermDataExportResultSchema>;
