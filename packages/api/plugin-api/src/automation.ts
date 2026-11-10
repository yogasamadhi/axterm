import { z } from 'zod';
import { entityFields, idSchema, timestampSchema } from './schemas/resources.ts';
import type { TypertResource } from './types.ts';
export const quickCommandStepSchema = z
  .object({
    id: idSchema,
    name: z.string().trim().max(100),
    command: z.string().min(1).max(16_384),
    delayMs: z.number().int().min(1).max(65_535),
  })
  .strict();
export const quickCommandSchema = z
  .object({
    ...entityFields,
    groupId: idSchema.nullable(),
    position: z.number().int().nonnegative(),
    name: z.string().trim().min(1).max(60),
    command: z.string().min(1).max(16_384),
    commands: z.array(quickCommandStepSchema).min(1).max(32),
    description: z.string().max(2_000),
    tags: z.array(z.string().trim().min(1).max(60)).max(32),
    shortcut: z.string().trim().min(1).max(100).nullable(),
    inputOnly: z.boolean(),
    clickCount: z.number().int().nonnegative(),
  })
  .strict();
export const quickCommandInputSchema = quickCommandSchema
  .omit({ id: true, createdAt: true, updatedAt: true, version: true, position: true })
  .strict();
export const quickCommandPatchSchema = quickCommandInputSchema
  .omit({ groupId: true })
  .partial()
  .strict();
export const quickCommandGroupSchema = z
  .object({
    ...entityFields,
    parentId: idSchema.nullable(),
    name: z.string().trim().min(1).max(60),
    position: z.number().int().nonnegative(),
  })
  .strict();
export const quickCommandTreeSchema = z
  .object({
    revision: z.number().int().positive(),
    etag: z.string().regex(/^"quick-command-tree-v\d+"$/),
    groups: z.array(quickCommandGroupSchema).max(5000),
    commands: z.array(quickCommandSchema).max(5000),
  })
  .strict();
export const quickCommandGroupInputSchema = z
  .object({ parentId: idSchema.nullable(), name: z.string().trim().min(1).max(60) })
  .strict();
export const quickCommandGroupPatchSchema = z
  .object({ name: z.string().trim().min(1).max(60) })
  .partial()
  .strict();
export const quickCommandTreeNodeSchema = z
  .object({ kind: z.enum(['group', 'command']), id: idSchema })
  .strict();
export const moveQuickCommandTreeNodeSchema = z
  .object({
    source: quickCommandTreeNodeSchema,
    target: quickCommandTreeNodeSchema,
    position: z.enum(['before', 'inside', 'after']),
  })
  .strict();

export const batchOperationStepInputSchema = z
  .object({
    id: idSchema,
    name: z.string().trim().min(1).max(100),
    command: z.string().min(1).max(16_384),
    delayMs: z.number().int().min(0).max(65_535).default(0),
    continueOnError: z.boolean().default(false),
  })
  .strict();
export const createBatchOperationSchema = z
  .object({
    name: z.string().trim().min(1).max(100),
    bookmarkIds: z.array(idSchema).min(1).max(64),
    steps: z.array(batchOperationStepInputSchema).min(1).max(32),
    concurrency: z.number().int().min(1).max(8).default(4),
    connectionTimeoutMs: z.number().int().min(1_000).max(120_000).default(30_000),
  })
  .strict()
  .superRefine((value, context) => {
    if (new Set(value.bookmarkIds).size !== value.bookmarkIds.length)
      context.addIssue({
        code: 'custom',
        path: ['bookmarkIds'],
        message: 'Bookmark IDs must be unique',
      });
    if (new Set(value.steps.map(({ id }) => id)).size !== value.steps.length)
      context.addIssue({ code: 'custom', path: ['steps'], message: 'Step IDs must be unique' });
  });
export const batchOperationStateSchema = z.enum([
  'queued',
  'running',
  'canceling',
  'succeeded',
  'failed',
  'canceled',
  'interrupted',
]);
export const batchOperationTargetStateSchema = z.enum([
  'queued',
  'connecting',
  'running',
  'succeeded',
  'failed',
  'canceled',
]);
export const batchOperationStepResultSchema = z
  .object({
    stepId: idSchema,
    name: z.string().trim().min(1).max(100),
    state: z.enum(['queued', 'running', 'succeeded', 'failed', 'skipped', 'canceled']),
    exitCode: z.number().int().nullable(),
    errorCode: z.string().max(100).optional(),
    startedAt: timestampSchema.optional(),
    finishedAt: timestampSchema.optional(),
  })
  .strict();
export const batchOperationTargetSchema = z
  .object({
    bookmarkId: idSchema,
    title: z.string().trim().min(1).max(100),
    state: batchOperationTargetStateSchema,
    errorCode: z.string().max(100).optional(),
    steps: z.array(batchOperationStepResultSchema).min(1).max(32),
    startedAt: timestampSchema.optional(),
    finishedAt: timestampSchema.optional(),
  })
  .strict();
export const batchOperationSchema = z
  .object({
    ...entityFields,
    name: z.string().trim().min(1).max(100),
    state: batchOperationStateSchema,
    concurrency: z.number().int().min(1).max(8),
    targetCount: z.number().int().min(1).max(64),
    completedCount: z.number().int().nonnegative().max(64),
    succeededCount: z.number().int().nonnegative().max(64),
    failedCount: z.number().int().nonnegative().max(64),
    canceledCount: z.number().int().nonnegative().max(64),
    targets: z.array(batchOperationTargetSchema).min(1).max(64),
  })
  .strict();
export const clearBatchOperationsResultSchema = z
  .object({ cleared: z.number().int().nonnegative() })
  .strict();

export const triggerMatchSchema = z
  .object({
    type: z.enum(['text', 'regex']),
    value: z.string().min(1).max(512),
    caseSensitive: z.boolean().default(false),
  })
  .strict();
export const triggerActionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('send'), value: z.string().max(16_384) }).strict(),
  z.object({ type: z.literal('notify'), value: z.literal('') }).strict(),
]);
export const triggerRuleSchema = z
  .object({
    ...entityFields,
    name: z.string().trim().min(1).max(100),
    enabled: z.boolean(),
    match: triggerMatchSchema,
    action: triggerActionSchema,
    sendEnter: z.boolean(),
    mode: z.enum(['repeat', 'once', 'cooldown']),
    cooldownMs: z.number().int().min(0).max(600_000),
  })
  .strict();
export const triggerRuleInputSchema = triggerRuleSchema
  .omit({ id: true, createdAt: true, updatedAt: true, version: true })
  .strict();
export const triggerRulePatchSchema = triggerRuleInputSchema.partial().strict();
export const replaceTriggersSchema = z.array(triggerRuleInputSchema).max(256);
export const triggerCollectionSchema = z
  .object({
    revision: z.number().int().positive(),
    etag: z.string().regex(/^"trigger-list-v\d+"$/),
    triggers: z.array(triggerRuleSchema).max(256),
  })
  .strict();

export type QuickCommand = z.infer<typeof quickCommandSchema>;
export type QuickCommandStep = z.infer<typeof quickCommandStepSchema>;
export type QuickCommandGroup = z.infer<typeof quickCommandGroupSchema>;
export type QuickCommandTree = z.infer<typeof quickCommandTreeSchema>;
export type QuickCommandTreeNode = z.infer<typeof quickCommandTreeNodeSchema>;
export type BatchOperation = z.infer<typeof batchOperationSchema>;
export type BatchOperationTarget = z.infer<typeof batchOperationTargetSchema>;
export type BatchOperationStepResult = z.infer<typeof batchOperationStepResultSchema>;
export type TriggerRule = z.infer<typeof triggerRuleSchema>;
export type TriggerRuleInput = z.input<typeof triggerRuleInputSchema>;
export type TriggerRulePatch = z.input<typeof triggerRulePatchSchema>;
export type TriggerCollection = z.infer<typeof triggerCollectionSchema>;
export type QuickCommandInput = z.infer<typeof quickCommandInputSchema>;
export type QuickCommandPatch = z.infer<typeof quickCommandPatchSchema>;
export type QuickCommandGroupInput = z.infer<typeof quickCommandGroupInputSchema>;
export type QuickCommandGroupPatch = z.infer<typeof quickCommandGroupPatchSchema>;
export type MoveQuickCommandTreeNodeInput = z.infer<typeof moveQuickCommandTreeNodeSchema>;
export type CreateBatchOperationInput = z.input<typeof createBatchOperationSchema>;
export type CreateBatchOperationRequest = z.infer<typeof createBatchOperationSchema>;
export type AutomationCollection = 'quickCommands' | 'triggers' | 'batches';
export interface AutomationBaseline {
  readonly generation: string;
  readonly cursor: number;
  readonly quickCommands: QuickCommandTree;
  readonly triggers: TriggerCollection;
  readonly batches: readonly BatchOperation[];
}
export type AutomationUpdate =
  | {
      readonly type: 'begin';
      readonly generation: string;
      readonly cursor: number;
      readonly mode: 'baseline' | 'delta';
      readonly collections: readonly AutomationCollection[];
    }
  | {
      readonly type: 'chunk';
      readonly collection: AutomationCollection;
      readonly offset: number;
      readonly text: string;
      readonly final: boolean;
    }
  | { readonly type: 'commit'; readonly cursor: number };
export interface AutomationReceipt {
  readonly ids: readonly string[];
  readonly cursor: number;
}
export const AUTOMATION_CHUNK_CHARACTERS = 16384;
export const AUTOMATION_MAX_SNAPSHOT_BYTES = 64 * 1024 * 1024;
export type AutomationFailureReason =
  | 'not-found'
  | 'precondition-required'
  | 'precondition-failed'
  | 'invalid-input'
  | 'conflict'
  | 'capacity'
  | 'closed'
  | 'receipt-expired'
  | 'unavailable'
  | 'uncertain'
  | 'cancelled';
declare module './types.ts' {
  interface RemoteErrorDetailsMap {
    'automation/failure': { readonly reason: AutomationFailureReason };
  }
}
declare module './index.ts' {
  interface TypertResourceMap {
    quickCommand: TypertResource<string>;
    quickCommandGroup: TypertResource<string>;
    trigger: TypertResource<string>;
    batchOperation: TypertResource<string>;
  }
}

export interface TriggerFired {
  readonly terminalId: string;
  readonly triggerId: string;
  readonly name: string;
  readonly actionType: 'send' | 'notify';
}
export interface TriggerSessionDisabled {
  readonly terminalId: string;
  readonly errorCode: string;
}
declare module '@deepseek-ai/cordis' {
  interface Events {
    'automation/trigger-fired'(event: TriggerFired): void;
    'automation/trigger-session-disabled'(event: TriggerSessionDisabled): void;
  }
}
declare module './index.ts' {
  interface TypertRemoteEventSelection {
    'automation/trigger-fired': true;
    'automation/trigger-session-disabled': true;
  }
}

const fileRenameTemplateSchema = z
  .string()
  .trim()
  .min(1)
  .max(255)
  .refine(
    (value) => !value.includes('/') && !value.includes('\\'),
    'Template cannot contain paths',
  );
export const previewFileRenameSchema = z
  .object({
    grantId: z.string().min(1).max(256),
    template: fileRenameTemplateSchema.default('{name}-{n}.{ext}'),
    includeSubfolders: z.boolean().default(false),
    fileTypes: z.string().trim().min(1).max(512).default('*'),
    startNumber: z.number().int().min(0).max(1_000_000).default(1),
    preserveCase: z.boolean().default(true),
  })
  .strict();
export const fileRenamePreviewItemSchema = z
  .object({
    source: z.string().min(1).max(4_096),
    target: z.string().min(1).max(4_096),
    state: z.enum(['ready', 'unchanged', 'conflict']),
  })
  .strict();
export const fileRenamePreviewSchema = z
  .object({
    id: z.uuid(),
    rootName: z.string().trim().min(1).max(255),
    createdAt: z.iso.datetime(),
    expiresAt: z.iso.datetime(),
    total: z.number().int().nonnegative().max(1_000),
    ready: z.number().int().nonnegative().max(1_000),
    conflicts: z.number().int().nonnegative().max(1_000),
    canRun: z.boolean(),
    items: z.array(fileRenamePreviewItemSchema).max(1_000),
  })
  .strict();
export const runFileRenameSchema = z.object({ previewId: z.uuid() }).strict();
export const fileRenameResultSchema = z
  .object({
    previewId: z.uuid(),
    renamed: z.number().int().nonnegative().max(1_000),
    items: z.array(fileRenamePreviewItemSchema).max(1_000),
    finishedAt: z.iso.datetime(),
  })
  .strict();

export type PreviewFileRenameInput = z.input<typeof previewFileRenameSchema>;
export type FileRenamePreview = z.infer<typeof fileRenamePreviewSchema>;
export type FileRenameResult = z.infer<typeof fileRenameResultSchema>;
export interface FileRenameRecovery {
  readonly previewId: string;
  readonly items: readonly { readonly source: string; readonly current: string }[];
}
export const renameRecoverySchema = z
  .object({
    previewId: z.uuid(),
    items: z
      .array(z.object({ source: z.string().max(4096), current: z.string().max(4096) }).strict())
      .max(1000),
  })
  .strict();
export const renameBaselineSchema = z
  .object({
    generation: z.uuid(),
    revision: z.number().int().nonnegative(),
    previews: z.array(fileRenamePreviewSchema).max(16),
    running: z.array(fileRenamePreviewSchema).max(1),
    recoveries: z.array(renameRecoverySchema).max(16),
  })
  .strict();
export type RenameBaseline = z.infer<typeof renameBaselineSchema>;
export type RenameUpdate =
  | { readonly type: 'begin'; readonly generation: string; readonly revision: number }
  | {
      readonly type: 'chunk';
      readonly offset: number;
      readonly text: string;
      readonly final: boolean;
    }
  | { readonly type: 'commit'; readonly revision: number };

export * from './widgets.ts';
