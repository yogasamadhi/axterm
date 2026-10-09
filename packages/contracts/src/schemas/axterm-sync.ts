import { z } from 'zod';
import { axtermConfigurationOmissionsSchema } from './axterm-configuration';
import { syncCategorySchema } from './data-sync';
import { timestampSchema } from './resources';

const maxCategoryEntries = 100_000;

export const axtermSyncCategoryDocumentSchema = z
  .object({
    count: z.number().int().nonnegative().max(maxCategoryEntries),
    hash: z.string().regex(/^[a-f0-9]{64}$/),
    value: z.unknown().refine((value) => value !== undefined, 'Category value is required'),
  })
  .strict();

export const axtermSyncDocumentSchema = z
  .object({
    format: z.literal('axterm-sync'),
    formatVersion: z.literal(1),
    deviceName: z.string().trim().min(1).max(128),
    appVersion: z.string().min(1).max(80),
    generatedAt: timestampSchema,
    categories: z
      .partialRecord(syncCategorySchema, axtermSyncCategoryDocumentSchema)
      .refine(
        (categories) => Object.keys(categories).length > 0,
        'At least one category is required',
      ),
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
    inspect(document.categories, 'categories');
  });

export type AxtermSyncCategoryDocument = z.infer<typeof axtermSyncCategoryDocumentSchema>;
export type AxtermSyncDocument = z.infer<typeof axtermSyncDocumentSchema>;
