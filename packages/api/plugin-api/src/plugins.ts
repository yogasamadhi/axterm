import type { ClientFactsView } from './types.ts';
/** Selected package metadata, never an implementation import or an execution authority. */
export interface PluginManifestMetadata {
  readonly name: string;
  readonly version: string;
  readonly description?: string;
  readonly engines?: Readonly<Record<string, string>>;
  readonly peerDependencies?: Readonly<Record<string, string>>;
  readonly scripts?: Readonly<Record<string, string>>;
  readonly axterm?: {
    readonly bundle?: {
      readonly patch: string | readonly string[];
      readonly platforms?: readonly string[];
    };
  };
}
export interface PluginInspection {
  readonly manifest: PluginManifestMetadata;
  readonly spec: string;
  readonly registry?: string;
}
export interface ManagedPluginPackage {
  readonly name: string;
  readonly version: string;
  readonly installed: boolean;
  readonly enabled: boolean;
  readonly bundle: boolean;
  readonly problem?: 'unavailable' | 'invalid' | 'incompatible';
}
export interface ManagedPluginEntry {
  readonly id: string;
  readonly name: string;
  readonly disabled: boolean;
  readonly state?:
    'active' | 'loading' | 'failed' | 'pending' | 'unloading' | 'not-running' | 'offline';
}
export interface PluginChange {
  readonly changed: boolean;
  readonly application: 'applied' | 'overridden' | 'restart-required' | 'failed';
  readonly restartReason?: string;
}
/** Exact installed dependency/source identity; an upgrade never inherits this approval. */
export interface PendingPluginBuild {
  readonly id: string;
  readonly name: string;
  readonly version: string;
}

import { z } from 'zod';
const name = z
  .string()
  .max(214)
  .regex(/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/u);
const spec = z
  .string()
  .max(512)
  .regex(/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*(?:@[a-zA-Z0-9.*^~+<>=|_-]+)?$/u);
export const pluginRegistrySchema = z
  .string()
  .max(2048)
  .refine((value) => {
    try {
      const url = new URL(value);
      return (
        ['http:', 'https:'].includes(url.protocol) &&
        !url.username &&
        !url.password &&
        !url.search &&
        !url.hash
      );
    } catch {
      return false;
    }
  }, 'Invalid registry URL');
export const pluginCommandInputSchema = z.discriminatedUnion('operation', [
  z
    .object({
      operation: z.literal('install'),
      spec,
      registry: pluginRegistrySchema.optional(),
      replace: z.boolean(),
      enabled: z.boolean(),
    })
    .strict(),
  z.object({ operation: z.literal('remove'), name }).strict(),
  z.object({ operation: z.literal('bundle'), name, enabled: z.boolean() }).strict(),
  z
    .object({ operation: z.literal('entry'), id: z.string().min(1).max(256), enabled: z.boolean() })
    .strict(),
  z
    .object({
      operation: z.literal('compatibility'),
      packageVersion: z.string().min(1).max(512),
      runtimeVersion: z.string().min(1).max(128),
      enabled: z.boolean(),
      acceptRisk: z.boolean(),
    })
    .strict(),
  z
    .object({
      operation: z.literal('build'),
      ids: z
        .array(z.string().regex(/^[a-f0-9]{64}$/u))
        .min(1)
        .max(64),
      confirmed: z.literal(true),
    })
    .strict(),
]);
export type PluginCommandInput = z.infer<typeof pluginCommandInputSchema>;
export const pluginFailureSchema = z.enum([
  'invalid-input',
  'capacity',
  'closed',
  'timeout',
  'cancelled',
  'not-found',
  'network',
  'disk-full',
  'permission',
  'unavailable',
  'conflict',
  'stale-generation',
  'interrupted',
]);
export type PluginFailure = z.infer<typeof pluginFailureSchema>;
export const pluginCommandReceiptSchema = z
  .object({
    id: z.uuid(),
    generation: z.string().min(1).max(256),
    operation: z.enum(['install', 'remove', 'bundle', 'entry', 'compatibility', 'build']),
    target: z.string().max(512).optional(),
    status: z.enum(['running', 'completed', 'failed', 'uncertain', 'interrupted']),
    result: z
      .object({
        changed: z.boolean(),
        application: z.enum(['applied', 'overridden', 'restart-required', 'failed']),
        restartReason: z.string().max(256).optional(),
      })
      .strict()
      .optional(),
    reason: pluginFailureSchema.optional(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .strict();
export type PluginCommandReceipt = z.infer<typeof pluginCommandReceiptSchema>;
export interface PluginManagementSnapshot {
  readonly generation: string;
  readonly runtimeVersion?: string;
  readonly inventory: null | {
    readonly packages: readonly ManagedPluginPackage[];
    readonly entries: readonly ManagedPluginEntry[];
    readonly builds: readonly PendingPluginBuild[];
    readonly transactions: readonly string[];
  };
  readonly commands: readonly PluginCommandReceipt[];
}
export type PluginManagementUpdate = {
  readonly type: 'baseline' | 'replace';
  readonly cursor: number;
  readonly snapshot: PluginManagementSnapshot;
};
export interface PluginCommandOutcome {
  readonly status: 'missing' | 'known';
  readonly receipt?: PluginCommandReceipt;
}
declare module './types.ts' {
  interface RemoteErrorDetailsMap {
    'plugins/failure': { readonly reason: PluginFailure };
  }
}

/** Selected Client facts and explicit actions; admitted Host operations remain owned after caller cancellation. */
export interface PluginClientActions extends ClientFactsView<PluginManagementSnapshot> {
  execute(input: PluginCommandInput, signal?: AbortSignal): Promise<PluginCommandReceipt>;
}
declare module '@deepseek-ai/cordis' {
  interface Context {
    pluginActions: PluginClientActions;
  }
}

/** Model requests are data only; every invocation requires independent application approval. */
export const pluginToolInputSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('command'), request: pluginCommandInputSchema }).strict(),
  z.object({ action: z.literal('snapshot') }).strict(),
  z
    .object({ action: z.literal('inspect'), spec, registry: pluginRegistrySchema.optional() })
    .strict(),
  z.object({ action: z.literal('outcome'), id: z.uuid() }).strict(),
]);
export type PluginToolInput = z.infer<typeof pluginToolInputSchema>;
