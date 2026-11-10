import { z } from 'zod';
export const marketUrlSchema = z
  .string()
  .max(2048)
  .transform((value, ctx) => {
    try {
      const url = new URL(value);
      if (
        !['https:', 'http:'].includes(url.protocol) ||
        url.username ||
        url.password ||
        url.search ||
        url.hash
      )
        throw new Error();
      return url.href;
    } catch {
      ctx.addIssue({ code: 'custom', message: 'Invalid market URL' });
      return z.NEVER;
    }
  });
export const marketUrlsSchema = z
  .array(marketUrlSchema)
  .max(8)
  .refine((values) => new Set(values).size === values.length);
export const marketFailureSchema = z.enum([
  'invalid-input',
  'unknown-index',
  'invalid-index',
  'network',
  'capacity',
  'closed',
  'conflict',
  'stale-generation',
  'unavailable',
]);
export type MarketFailure = z.infer<typeof marketFailureSchema>;
export interface MarketConfigurationReceipt {
  readonly id: string;
  readonly generation: string;
  readonly revision: number;
}
export interface MarketBaseline {
  readonly generation: string;
  readonly revision: number;
  readonly indexes: readonly {
    readonly url: string;
    readonly title?: string;
    readonly fetchedAt?: string;
    readonly error?: MarketFailure;
  }[];
}
export type MarketUpdate = {
  readonly type: 'baseline' | 'replace';
  readonly cursor: number;
  readonly snapshot: MarketBaseline;
};
export const marketQuerySchema = z
  .object({
    url: marketUrlSchema,
    text: z.string().max(256),
    offset: z.number().int().min(0).max(512),
    limit: z.number().int().min(1).max(50),
    refresh: z.boolean(),
    fetchedAt: z.string().datetime().optional(),
  })
  .strict();
export type MarketQuery = z.infer<typeof marketQuerySchema>;
export interface MarketVersionView {
  readonly version: string;
  readonly publishTimestamp: number;
  readonly compatibility: 'compatible' | 'incompatible' | 'check-on-install';
  readonly install: { readonly spec: string; readonly registry?: string } | null;
}
export interface MarketEntry {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly versions: readonly MarketVersionView[];
  readonly installation:
    'not-installed' | 'installed' | 'update-available' | 'different-version' | 'provided';
  readonly installedVersion?: string;
}
export interface MarketPage {
  readonly url: string;
  readonly fetchedAt: string;
  readonly title: string;
  readonly total: number;
  readonly nextOffset: number | null;
  readonly entries: readonly MarketEntry[];
}
declare module './types.ts' {
  interface RemoteErrorDetailsMap {
    'market/failure': { readonly reason: MarketFailure };
  }
}
