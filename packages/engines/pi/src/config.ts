import schema from '@deepseek-ai/schemastery';
import { z } from 'zod';
import { EngineError } from '@axterm/engine-api';
import { aiProviderSchema } from '@axterm/plugin-api/ai';
const ref = z
  .string()
  .regex(/^[A-Za-z_][A-Za-z0-9_]*$/)
  .max(2048);
const id = z.string().min(1).max(256);
const modelId = z.string().min(1).max(512);
const api = z.enum([
  'openai-completions',
  'openai-responses',
  'azure-openai-responses',
  'anthropic-messages',
  'google-generative-ai',
  'mistral-conversations',
  'pi-messages',
]);
const endpoint = z
  .url()
  .max(4096)
  .refine((value) => {
    const url = new URL(value);
    return (
      ['https:', 'http:'].includes(url.protocol) &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash
    );
  });
const modelFields = {
  name: z.string().min(1).max(512).optional(),
  api: api.optional(),
  baseUrl: endpoint.optional(),
  reasoning: z.boolean().optional(),
  input: z
    .array(z.enum(['text', 'image']))
    .min(1)
    .max(2)
    .optional(),
  cost: z
    .object({
      input: z.union([z.literal(-1), z.literal(-1000000), z.number().nonnegative()]),
      output: z.union([z.literal(-1), z.literal(-1000000), z.number().nonnegative()]),
      cacheRead: z.number().nonnegative(),
      cacheWrite: z.number().nonnegative(),
    })
    .strict()
    .optional(),
  contextWindow: z.number().int().positive().max(10000000).optional(),
  maxTokens: z.number().int().positive().max(10000000).optional(),
  compat: z
    .record(z.string().max(128), z.union([z.boolean(), z.string().max(4096), z.number().finite()]))
    .optional(),
};
const headerName = z
  .string()
  .regex(/^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,128}$/)
  .refine(
    (value) =>
      ![
        'host',
        'content-length',
        'connection',
        'transfer-encoding',
        'cookie',
        'set-cookie',
        'proxy-authorization',
      ].includes(value.toLowerCase()),
  );
export const piProviderConfigurationSchema = z
  .object({
    provider: id,
    api: api.optional(),
    baseUrl: endpoint,
    credentialRef: ref,
    headerCredentialRefs: z.record(headerName, ref).default({}),
    models: z
      .array(z.object({ id: modelId, ...modelFields }).strict())
      .max(500)
      .default([]),
    modelOverrides: z.record(modelId, z.object(modelFields).strict()).default({}),
    timeoutMs: z.number().int().min(100).max(300000).default(60000),
    /** Existing Axterm gateway behavior, separate from Pi provider metadata. */
    legacy: z
      .object({ apiPath: aiProviderSchema.shape.apiPath, auth: aiProviderSchema.shape.auth })
      .strict()
      .optional(),
    /** References only; the Connection owner resolves proxy credentials. */
    proxy: aiProviderSchema.shape.proxy.optional(),
  })
  .strict()
  .superRefine((entry, ctx) => {
    if (
      Object.keys(entry.modelOverrides).length > 500 ||
      Object.keys(entry.headerCredentialRefs).length > 32
    )
      ctx.addIssue({ code: 'custom', message: 'Provider configuration capacity exceeded' });
    if (new Set(entry.models.map((model) => model.id)).size !== entry.models.length)
      ctx.addIssue({ code: 'custom', message: 'Duplicate model' });
  });
export const piExecutionBindingSchema = z
  .object({
    kind: z.literal('pi-provider-v1'),
    providerId: id,
    provider: piProviderConfigurationSchema,
  })
  .strict();
export const piEngineConfigSchema = z
  .object({
    providers: z.record(id, piProviderConfigurationSchema).default({}),
  })
  .strict()
  .superRefine((config, ctx) => {
    if (Object.keys(config.providers).length > 16)
      ctx.addIssue({ code: 'custom', message: 'Provider capacity exceeded' });
  });
export type Config = z.infer<typeof piEngineConfigSchema>;
/** Schemastery is the Profile validator; the transform preserves strict, bounded provider schemas. */
export const Config: schema<Config> = schema.transform(schema.any(), (value) => {
  try {
    return piEngineConfigSchema.parse(value);
  } catch {
    throw new EngineError('invalid');
  }
});
