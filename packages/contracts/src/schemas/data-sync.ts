import { z } from 'zod';
import { electermDataImportResultSchema, electermDataPreviewSchema } from './electerm-data';
import { idSchema, timestampSchema } from './resources';

export const syncCategorySchema = z.enum([
  'settings',
  'bookmarks',
  'terminalThemes',
  'quickCommands',
  'profiles',
  'addressBookmarks',
  'workspaces',
  'triggers',
]);
export const syncCategoriesSchema = z
  .array(syncCategorySchema)
  .min(1)
  .max(syncCategorySchema.options.length)
  .refine((categories) => new Set(categories).size === categories.length);
export const syncProviderTypeSchema = z.enum(['github', 'gitee', 'webdav', 'custom']);
export const syncDirectionSchema = z.enum(['upload', 'download']);
export const syncProfileStateSchema = z.enum([
  'idle',
  'checking',
  'uploading',
  'download-preview',
  'failed',
]);

const syncEndpointSchema = z
  .url()
  .max(2_048)
  .refine((value) => {
    const url = new URL(value);
    const loopbackHttp =
      url.protocol === 'http:' &&
      ['127.0.0.1', '::1', '[::1]', 'localhost'].includes(url.hostname.toLocaleLowerCase());
    return (
      (url.protocol === 'https:' || loopbackHttp) &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash
    );
  }, 'Expected a credential-free HTTPS endpoint, or an HTTP loopback endpoint, without query or fragment');

const syncRemoteIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(256)
  .refine((value) => !/[\\/?#\0]/u.test(value), 'Remote ID cannot contain path or URL separators');

export const syncProfileInputSchema = z
  .object({
    provider: syncProviderTypeSchema,
    name: z.string().trim().min(1).max(100),
    endpointUrl: syncEndpointSchema,
    remoteId: syncRemoteIdSchema,
    username: z.string().trim().min(1).max(256).nullable().default(null),
    accessCredentialRef: z.string().min(1).max(256),
    encryptionCredentialRef: z.string().min(1).max(256).nullable().default(null),
    selectedCategories: syncCategoriesSchema,
    autoSyncEnabled: z.boolean().default(false),
    autoSyncIntervalMinutes: z.number().int().min(1).max(1_440).default(5),
    autoSyncDirection: syncDirectionSchema.default('upload'),
  })
  .strict();

export const syncProfilePatchSchema = z
  .object({
    name: syncProfileInputSchema.shape.name.optional(),
    endpointUrl: syncProfileInputSchema.shape.endpointUrl.optional(),
    remoteId: syncProfileInputSchema.shape.remoteId.optional(),
    username: syncProfileInputSchema.shape.username.removeDefault().optional(),
    accessCredentialRef: syncProfileInputSchema.shape.accessCredentialRef.optional(),
    clearAccessCredential: z.boolean().optional(),
    encryptionCredentialRef: syncProfileInputSchema.shape.encryptionCredentialRef
      .removeDefault()
      .optional(),
    clearEncryptionCredential: z.boolean().optional(),
    selectedCategories: syncCategoriesSchema.optional(),
    autoSyncEnabled: z.boolean().optional(),
    autoSyncIntervalMinutes: syncProfileInputSchema.shape.autoSyncIntervalMinutes
      .removeDefault()
      .optional(),
    autoSyncDirection: syncDirectionSchema.optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, 'Expected at least one sync profile change')
  .superRefine((value, context) => {
    if (value.accessCredentialRef && value.clearAccessCredential)
      context.addIssue({
        code: 'custom',
        path: ['accessCredentialRef'],
        message: 'Choose replace or clear',
      });
    if (value.encryptionCredentialRef && value.clearEncryptionCredential)
      context.addIssue({
        code: 'custom',
        path: ['encryptionCredentialRef'],
        message: 'Choose replace or clear',
      });
  });

export const syncProfileSchema = z
  .object({
    id: idSchema,
    provider: syncProviderTypeSchema,
    name: z.string(),
    endpointUrl: syncEndpointSchema,
    remoteId: z.string(),
    username: z.string().nullable(),
    accessCredentialConfigured: z.boolean(),
    encryptionConfigured: z.boolean(),
    selectedCategories: syncCategoriesSchema,
    autoSyncEnabled: z.boolean(),
    autoSyncIntervalMinutes: z.number().int().min(1).max(1_440),
    autoSyncDirection: syncDirectionSchema,
    state: syncProfileStateSchema,
    remoteRevision: z.string().max(512).nullable(),
    lastSyncAt: timestampSchema.nullable(),
    lastErrorCode: z.string().max(100).nullable(),
    pendingPreviewId: idSchema.nullable(),
    createdAt: timestampSchema,
    updatedAt: timestampSchema,
    version: z.number().int().positive(),
  })
  .strict();

export const syncCategoryComparisonSchema = z
  .object({
    category: syncCategorySchema,
    localCount: z.number().int().nonnegative(),
    remoteCount: z.number().int().nonnegative(),
    localHash: z.string().length(64),
    remoteHash: z.string().length(64).nullable(),
    state: z.enum(['equal', 'local-only', 'remote-only', 'different']),
  })
  .strict();
export const syncComparisonSchema = z
  .object({
    profileId: idSchema,
    remoteExists: z.boolean(),
    remoteRevision: z.string().max(512).nullable(),
    remoteUpdatedAt: timestampSchema.nullable(),
    deviceName: z.string().max(128).nullable(),
    appVersion: z.string().max(80).nullable(),
    categories: z.array(syncCategoryComparisonSchema).max(syncCategorySchema.options.length),
    checkedAt: timestampSchema,
  })
  .strict();

export const runDataSyncSchema = z.object({ direction: syncDirectionSchema }).strict();
export const syncRunResultSchema = z
  .object({
    profile: syncProfileSchema,
    direction: syncDirectionSchema,
    uploaded: z.boolean(),
    preview: electermDataPreviewSchema.nullable(),
  })
  .strict();
export const commitDataSyncSchema = z.object({ previewId: idSchema }).strict();
export const syncCommitResultSchema = z
  .object({ profile: syncProfileSchema, result: electermDataImportResultSchema })
  .strict();
export const testSyncProfileResultSchema = z
  .object({
    reachable: z.literal(true),
    remoteExists: z.boolean(),
    revision: z.string().nullable(),
  })
  .strict();

export type SyncCategory = z.infer<typeof syncCategorySchema>;
export type SyncProviderType = z.infer<typeof syncProviderTypeSchema>;
export type SyncDirection = z.infer<typeof syncDirectionSchema>;
export type SyncProfileInput = z.infer<typeof syncProfileInputSchema>;
export type SyncProfilePatch = z.infer<typeof syncProfilePatchSchema>;
export type SyncProfile = z.infer<typeof syncProfileSchema>;
export type SyncComparison = z.infer<typeof syncComparisonSchema>;
export type SyncRunResult = z.infer<typeof syncRunResultSchema>;
