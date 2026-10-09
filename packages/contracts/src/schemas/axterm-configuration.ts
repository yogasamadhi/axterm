import { z } from 'zod';
import { bookmarkGroupSchema, bookmarkSchema } from './bookmarks';
import { connectionProfileSchema } from './connection-profiles';
import { terminalThemeSchema } from './terminal-themes';
import {
  hostGroupSchema,
  hostSchema,
  quickCommandGroupSchema,
  quickCommandSchema,
  settingsSchema,
  terminalProfileSchema,
  timestampSchema,
  triggerRuleSchema,
  tunnelProfileSchema,
} from './resources';

const maximumEntities = 5_000;
export const axtermConfigurationOmissionsSchema = z
  .object({
    fields: z.array(z.string().min(1).max(256)).max(50_000),
    excludedCollections: z.array(z.string().min(1).max(80)).max(32),
  })
  .strict();

export const axtermConfigurationDocumentSchema = z
  .object({
    format: z.literal('axterm-configuration'),
    formatVersion: z.literal(1),
    appVersion: z.string().min(1).max(80),
    exportedAt: timestampSchema,
    vaultSecretValues: z.literal('omitted'),
    data: z
      .object({
        hostGroups: hostGroupSchema.array().max(maximumEntities),
        hosts: hostSchema.array().max(maximumEntities),
        bookmarkGroups: bookmarkGroupSchema.array().max(maximumEntities),
        bookmarks: bookmarkSchema.array().max(maximumEntities),
        connectionProfiles: connectionProfileSchema.array().max(maximumEntities),
        terminalProfiles: terminalProfileSchema.array().max(maximumEntities),
        tunnelProfiles: tunnelProfileSchema.array().max(maximumEntities),
        quickCommandGroups: quickCommandGroupSchema.array().max(maximumEntities),
        quickCommands: quickCommandSchema.array().max(maximumEntities),
        terminalThemes: terminalThemeSchema.array().max(256),
        triggers: triggerRuleSchema.array().max(256),
        settings: settingsSchema,
      })
      .strict(),
    omissions: axtermConfigurationOmissionsSchema,
  })
  .strict()
  .superRefine((document, context) => {
    const inspect = (value: unknown, path: string): void => {
      if (Array.isArray(value)) {
        value.forEach((item, index) => inspect(item, `${path}[${index}]`));
        return;
      }
      if (!value || typeof value !== 'object') return;
      for (const [key, item] of Object.entries(value)) {
        const childPath = `${path}.${key}`;
        if (/credentialRef$/iu.test(key) && item !== null) {
          context.addIssue({
            code: 'custom',
            path: [childPath],
            message: 'Credential references are not portable',
          });
        } else inspect(item, childPath);
      }
    };
    inspect(document.data.hosts, 'data.hosts');
    inspect(document.data.bookmarks, 'data.bookmarks');
    inspect(document.data.connectionProfiles, 'data.connectionProfiles');
    inspect(document.data.settings.network, 'data.settings.network');
  });

export const axtermConfigurationExportRequestSchema = z
  .object({ grantId: z.string().min(1).max(256) })
  .strict();
export const axtermConfigurationExportResultSchema = z
  .object({
    bytes: z
      .number()
      .int()
      .positive()
      .max(16 * 1024 * 1024),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    entityCount: z.number().int().nonnegative(),
    omittedFieldCount: z.number().int().nonnegative(),
  })
  .strict();

export const axtermConfigurationInspectRequestSchema = axtermConfigurationExportRequestSchema;
export const axtermConfigurationInspectResultSchema = z
  .object({
    appVersion: z.string().min(1).max(80),
    exportedAt: timestampSchema,
    bytes: z
      .number()
      .int()
      .positive()
      .max(16 * 1024 * 1024),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    entityCount: z.number().int().nonnegative(),
    issues: z
      .array(
        z
          .object({
            kind: z.enum([
              'duplicate-id',
              'missing-reference',
              'reference-cycle',
              'target-conflict',
            ]),
            path: z.string().min(1).max(256),
          })
          .strict(),
      )
      .max(256),
    issueCount: z.number().int().nonnegative(),
    issuesTruncated: z.boolean(),
  })
  .strict();

const axtermConfigurationImportCountsSchema = z
  .object({
    create: z.number().int().nonnegative(),
    unchanged: z.number().int().nonnegative(),
    conflict: z.number().int().nonnegative(),
    skipped: z.number().int().nonnegative(),
  })
  .strict();

export const axtermConfigurationPreviewRequestSchema = axtermConfigurationInspectRequestSchema
  .extend({ applySettings: z.boolean().default(false) })
  .strict();
export const axtermConfigurationPreviewSchema = z
  .object({
    previewId: z.uuid(),
    expiresAt: timestampSchema,
    appVersion: z.string().min(1).max(80),
    exportedAt: timestampSchema,
    bytes: z
      .number()
      .int()
      .positive()
      .max(16 * 1024 * 1024),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    entityCount: z.number().int().nonnegative(),
    counts: axtermConfigurationImportCountsSchema,
    settings: z.enum(['preserved', 'will-apply']),
    canCommit: z.boolean(),
    issues: axtermConfigurationInspectResultSchema.shape.issues,
    issueCount: z.number().int().nonnegative(),
    issuesTruncated: z.boolean(),
  })
  .strict();

export const axtermConfigurationImportRequestSchema = z.object({ previewId: z.uuid() }).strict();
export const axtermConfigurationImportResultSchema = z
  .object({
    previewId: z.uuid(),
    entityCount: z.number().int().nonnegative(),
    counts: axtermConfigurationImportCountsSchema,
    settings: z.enum(['preserved', 'applied']),
  })
  .strict();

export type AxtermConfigurationDocument = z.infer<typeof axtermConfigurationDocumentSchema>;
export type AxtermConfigurationExportResult = z.infer<typeof axtermConfigurationExportResultSchema>;
export type AxtermConfigurationInspectResult = z.infer<
  typeof axtermConfigurationInspectResultSchema
>;
export type AxtermConfigurationPreview = z.infer<typeof axtermConfigurationPreviewSchema>;
export type AxtermConfigurationImportResult = z.infer<typeof axtermConfigurationImportResultSchema>;
