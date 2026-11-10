import type { JsonValue } from './json-value.ts';
// Pure first-party AI contracts migrated from the frozen Axterm baseline.
import { z } from 'zod';
import {
  entityFields,
  idSchema,
  proxyEndpointSchema,
  timestampSchema,
} from './schemas/resources.ts';
import { terminalSessionSchema } from './terminals.ts';
const registeredAiToolNames = [
  'host.getSummary',
  'terminal.getRecentOutput',
  'terminal.execReadOnly',
  'sftp.list',
  'sftp.readText',
  'system.inspectDisk',
  'system.inspectMemory',
  'system.inspectProcesses',
  'system.inspectService',
  'terminal.exec',
] as const;

export const aiToolNameSchema = z.enum(registeredAiToolNames);

export const aiProviderProtocolSchema = z.enum(['openai-chat', 'openai-responses', 'anthropic']);

export const aiProviderAuthSchema = z.enum(['bearer', 'x-api-key']);

export const DEFAULT_AI_ROLE =
  'Terminal expert. Explain commands and effects clearly, prefer safe steps, and never claim a command was executed.';

const aiBaseUrlSchema = z
  .url()
  .trim()
  .max(2_048)
  .refine((input) => {
    const value = new URL(input);
    return (
      ['http:', 'https:'].includes(value.protocol) &&
      !!value.hostname &&
      !value.username &&
      !value.password &&
      !value.search &&
      !value.hash
    );
  }, 'AI base URL must be an HTTP(S) URL without credentials, query or fragment');

const aiApiPathSchema = z
  .string()
  .trim()
  .min(1)
  .max(512)
  .regex(/^\/[A-Za-z0-9._~!$&'()*+,;=:@%/-]+$/, 'AI API path must be an absolute URL path');

export const piApiSchema = z.enum([
  'openai-completions',
  'openai-responses',
  'azure-openai-responses',
  'anthropic-messages',
  'google-generative-ai',
  'mistral-conversations',
  'pi-messages',
]);

const piProviderIdSchema = z
  .string()
  .min(1)
  .max(120)
  .regex(/^[a-zA-Z0-9._-]+$/);

export const piModelConfigSchema = z
  .object({
    id: z.string().trim().min(1).max(512),
    name: z.string().trim().min(1).max(256).optional(),
    api: piApiSchema.optional(),
    baseUrl: aiBaseUrlSchema.optional(),
    reasoning: z.boolean().optional(),
    input: z
      .array(z.enum(['text', 'image']))
      .min(1)
      .max(2)
      .optional(),
    cost: z
      .object({
        input: z.union([z.literal(-1), z.literal(-1_000_000), z.number().nonnegative()]),
        output: z.union([z.literal(-1), z.literal(-1_000_000), z.number().nonnegative()]),
        cacheRead: z.number().nonnegative(),
        cacheWrite: z.number().nonnegative(),
      })
      .strict()
      .optional(),
    contextWindow: z.number().int().min(1).max(10_000_000).optional(),
    maxTokens: z.number().int().min(1).max(10_000_000).optional(),
    compat: z
      .record(z.string().max(64), z.union([z.boolean(), z.string().max(128), z.number().finite()]))
      .optional(),
  })
  .strict();

const piModelOverridesSchema = z.record(
  z.string().min(1).max(512),
  piModelConfigSchema.omit({ id: true }),
);

const piHeaderNameSchema = z.string().regex(/^[A-Za-z0-9-]{1,64}$/);

export const piProviderConfigSchema = z
  .object({
    id: piProviderIdSchema,
    api: piApiSchema.optional(),
    models: z.array(piModelConfigSchema).max(500).default([]),
    modelOverrides: piModelOverridesSchema.default({}),
    headerCredentialRefs: z.record(piHeaderNameSchema, z.string().min(1).max(256)).default({}),
  })
  .strict();

const piLiteralCredentialSchema = z
  .string()
  .max(16_384)
  .refine(
    (value) => !value.startsWith('!') && !/\$\{?[A-Za-z_]/u.test(value),
    'Credential commands and environment expressions are unsupported; enter a literal Vault credential',
  );

export const piModelsFileSchema = z
  .object({
    providers: z.record(
      piProviderIdSchema,
      z
        .object({
          baseUrl: aiBaseUrlSchema.optional(),
          api: piApiSchema.optional(),
          apiKey: piLiteralCredentialSchema.optional(),
          headers: z.record(piHeaderNameSchema, piLiteralCredentialSchema).optional(),
          models: z.array(piModelConfigSchema).max(500).default([]),
          modelOverrides: piModelOverridesSchema.default({}),
        })
        .strict(),
    ),
  })
  .strict()
  .refine(
    (value) => Object.keys(value.providers).length > 0 && Object.keys(value.providers).length <= 16,
    'Import between one and sixteen providers',
  );

export const piCatalogProviderSchema = z
  .object({
    id: piProviderIdSchema,
    name: z.string(),
    baseUrl: z.string(),
    apiKeyAvailable: z.boolean(),
    models: z.array(piModelConfigSchema),
  })
  .strict();

const aiProviderBaseSchema = z
  .object({
    ...entityFields,
    engineId: z
      .string()
      .regex(/^[a-z][a-z0-9.-]{0,127}$/)
      .default('pi'),
    name: z.string().trim().min(1).max(120),
    baseUrl: aiBaseUrlSchema.optional(),
    apiPath: aiApiPathSchema.default('/chat/completions'),
    protocol: aiProviderProtocolSchema.default('openai-chat'),
    auth: aiProviderAuthSchema.default('bearer'),
    role: z.string().trim().min(1).max(16_384).default(DEFAULT_AI_ROLE),
    proxy: proxyEndpointSchema.nullable().default(null),
    timeoutMs: z.number().int().min(1_000).max(300_000).default(60_000),
    credentialRef: z.string().min(1).max(256).optional(),
    enabled: z.boolean(),
    pi: piProviderConfigSchema.optional(),
  })
  .strict();

/** Only Pi uses the application HTTP/Vault transport. Other Engines own their Profile configuration. */
function requirePiTransport(
  value: {
    engineId?: string | undefined;
    baseUrl?: string | undefined;
    credentialRef?: string | undefined;
  },
  ctx: z.RefinementCtx,
): void {
  if ((value.engineId ?? 'pi') !== 'pi') return;
  for (const field of ['baseUrl', 'credentialRef'] as const)
    if (!value[field])
      ctx.addIssue({
        code: 'custom',
        path: [field],
        message: 'Pi transport configuration is required',
      });
}
export const aiProviderSchema = aiProviderBaseSchema.superRefine(requirePiTransport);
const aiProviderInputBaseSchema = aiProviderBaseSchema
  .omit({ id: true, createdAt: true, updatedAt: true, version: true })
  .strict();
export const aiProviderInputSchema = aiProviderInputBaseSchema.superRefine(requirePiTransport);
export const aiProviderPatchSchema = aiProviderInputBaseSchema.partial().strict();

export const aiModelSchema = z
  .object({
    ...entityFields,
    providerId: idSchema,
    name: z.string(),
    model: z.string(),
    capabilities: z.array(z.enum(['chat', 'tools'])),
  })
  .strict();

export const aiModelInputSchema = aiModelSchema
  .omit({ id: true, createdAt: true, updatedAt: true, version: true })
  .strict();

export const aiModelPatchSchema = aiModelInputSchema.partial().strict();

export const aiProviderTestResultSchema = z
  .object({
    providerId: idSchema,
    protocol: aiProviderProtocolSchema,
    ok: z.literal(true),
    latencyMs: z.number().int().nonnegative(),
    models: z.array(z.string().min(1).max(512)).max(500),
  })
  .strict();

export const aiWorkspaceSchema = z
  .object({
    terminalId: idSchema,
    terminalKind: terminalSessionSchema.shape.kind,
    workspaceDirectory: z.string().min(1).max(4096),
    commandDirectory: z.string().min(1).max(4096).nullable(),
    execution: z.enum(['local', 'ssh', 'unavailable']),
    connectionId: idSchema.optional(),
    sshTarget: z
      .object({
        hostname: z.string().min(1).max(255),
        port: z.number().int().min(1).max(65535),
        username: z.string().max(255),
        generation: z.number().int().min(1),
      })
      .strict()
      .optional(),
  })
  .strict();

export type AiWorkspace = z.infer<typeof aiWorkspaceSchema>;

export const aiUseCaseSchema = z.enum([
  'chat',
  'explainCommand',
  'explainOutput',
  'generateCommand',
  'createBookmark',
  'createTheme',
  'diagnose',
]);

export const aiModeSchema = z.enum(['chat', 'work']);

export type AiMode = z.infer<typeof aiModeSchema>;

export const aiSkillSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9-]{1,64}$/u),
    useCase: z.enum(['explainCommand', 'explainOutput', 'generateCommand', 'diagnose']),
    description: z.string().min(1).max(1024),
  })
  .strict();

export type AiSkill = z.infer<typeof aiSkillSchema>;

export const aiConversationInputSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    modelId: idSchema,
    useCase: aiUseCaseSchema.default('chat'),
    terminalId: idSchema.optional(),
  })
  .strict();

export const aiConversationPatchSchema = aiConversationInputSchema.partial().strict();

export const aiConversationSchema = z
  .object({
    ...entityFields,
    name: z.string().trim().min(1).max(120),
    modelId: idSchema,
    useCase: aiUseCaseSchema,
    terminalId: idSchema.optional(),
    messageCount: z.number().int().nonnegative(),
    lastMessageAt: timestampSchema.nullable(),
  })
  .strict();

export const aiMessageStateSchema = z.enum(['complete', 'failed', 'canceled']);

export const aiAttachmentMetadataSchema = z
  .object({
    name: z.string().trim().min(1).max(255),
    size: z
      .number()
      .int()
      .nonnegative()
      .max(100 * 1024),
    includedBytes: z
      .number()
      .int()
      .nonnegative()
      .max(50 * 1024),
    truncated: z.boolean(),
  })
  .strict();

export const aiAttachmentPreviewSchema = aiAttachmentMetadataSchema
  .extend({
    id: idSchema,
    preview: z.string().max(8 * 1024),
    redacted: z.boolean(),
    expiresAt: timestampSchema,
  })
  .strict();

export const aiAttachmentPrepareSchema = z.object({ grantId: z.string().min(1).max(256) }).strict();

export const aiMessageSchema = z
  .object({
    ...entityFields,
    conversationId: idSchema,
    runId: idSchema,
    role: z.enum(['user', 'assistant']),
    content: z.string().max(2 * 1024 * 1024),
    attachments: z.array(aiAttachmentMetadataSchema).max(8).default([]),
    state: aiMessageStateSchema,
    errorCode: z.string().max(160).optional(),
  })
  .strict();

export const aiConversationDetailSchema = z
  .object({ conversation: aiConversationSchema, messages: z.array(aiMessageSchema).max(1_000) })
  .strict();

const aiJsonValueSchema: z.ZodType<JsonValue, JsonValue> = z.json();

export const aiToolProposalSchema = z
  .object({
    name: z.enum([...registeredAiToolNames, 'workspace.exec']),
    args: z.record(z.string(), aiJsonValueSchema),
    target: z.string().min(1).max(512),
  })
  .strict();

export const aiRequestSchema = z
  .object({
    modelId: idSchema,
    conversationId: idSchema.optional(),
    mode: aiModeSchema.default('chat'),
    useCase: aiUseCaseSchema,
    prompt: z.string().max(16_384),
    context: z.string().max(131_072).default(''),
    attachmentIds: z.array(idSchema).max(8).default([]),
    terminalId: idSchema.optional(),
    includeConversationHistory: z.boolean().default(true),
    reviewReceipt: z
      .string()
      .regex(/^[a-f0-9]{64}$/u)
      .optional(),
    reviewExpiresAt: timestampSchema.optional(),
    tool: aiToolProposalSchema.optional(),
  })
  .strict();

export const aiContextPreviewRequestSchema = aiRequestSchema
  .omit({ tool: true, reviewReceipt: true, reviewExpiresAt: true })
  .strict();

export const aiContextSourceSchema = z
  .object({
    kind: z.enum(['system', 'prompt', 'history', 'context', 'attachment']),
    name: z.string().max(255).optional(),
    originalBytes: z.number().int().nonnegative(),
    includedBytes: z.number().int().nonnegative(),
    redacted: z.boolean(),
    truncated: z.boolean(),
    selectedItems: z.number().int().nonnegative().optional(),
    availableItems: z.number().int().nonnegative().optional(),
  })
  .strict();

export const aiContextPreviewSchema = z
  .object({
    request: aiContextPreviewRequestSchema,
    system: z.string().max(32_768),
    prompt: z.string().max(16_384),
    context: z.string().max(131_072),
    sources: z.array(aiContextSourceSchema).max(12),
    reviewReceipt: z.string().regex(/^[a-f0-9]{64}$/u),
    reviewExpiresAt: timestampSchema,
  })
  .strict();

export const aiUseCaseInputSchema = aiRequestSchema.omit({ useCase: true }).strict();

export const aiRunStateSchema = z.enum([
  'queued',
  'running',
  'waiting_approval',
  'succeeded',
  'failed',
  'canceled',
]);

export const aiRunSchema = z
  .object({
    ...entityFields,
    engineId: z
      .string()
      .regex(/^[a-z][a-z0-9.-]{0,127}$/)
      .default('pi'),
    conversationId: idSchema.optional(),
    state: aiRunStateSchema,
    useCase: aiUseCaseSchema,
    result: z.string().optional(),
    errorCode: z.string().optional(),
  })
  .strict();

export const aiToolRiskSchema = z.enum(['read_only', 'mutating', 'destructive', 'privileged']);

export const aiCommandReviewSchema = z
  .object({
    status: z.enum(['pending', 'completed', 'unavailable']),
    decision: z.enum(['auto_approve', 'ask_user', 'reject']),
    riskLevel: z.enum(['low', 'medium', 'high', 'critical']),
    userAuthorization: z.enum(['unknown', 'low', 'medium', 'high']),
    reason: z.string().max(600),
    source: z.enum(['rules', 'model', 'fallback']),
    policyVersion: z.string().max(80),
    modelId: idSchema.optional(),
    generation: z.string().max(80),
    expiresAt: timestampSchema,
  })
  .strict();

export type AiCommandReview = z.infer<typeof aiCommandReviewSchema>;

export const aiToolCallSchema = z
  .object({
    ...entityFields,
    runId: idSchema,
    toolName: z.string(),
    risk: aiToolRiskSchema,
    argsHash: z.string(),
    args: z.record(z.string(), aiJsonValueSchema),
    target: z.string(),
    state: z.enum(['proposed', 'waiting_approval', 'running', 'succeeded', 'failed', 'canceled']),
    resultMetadata: z.record(z.string(), aiJsonValueSchema).optional(),
    review: aiCommandReviewSchema.optional(),
    step: z.number().int().min(1).max(50).optional(),
    approvalSource: z.enum(['automatic', 'user']).optional(),
  })
  .strict();

export const aiApprovalSchema = z
  .object({
    ...entityFields,
    runId: idSchema,
    toolCallId: idSchema,
    argsHash: z.string(),
    target: z.string(),
    state: z.enum(['pending', 'approved', 'rejected', 'expired']),
    expiresAt: timestampSchema,
    decidedAt: timestampSchema.optional(),
  })
  .strict();

export const aiApprovalDecisionSchema = z
  .object({ decision: z.enum(['approve_once', 'reject']), argsHash: z.string() })
  .strict();

export const aiRunEventSchema = z.discriminatedUnion('type', [
  z.object({ runId: idSchema, type: z.literal('tool'), data: aiToolCallSchema }).strict(),
  z.object({ runId: idSchema, type: z.literal('snapshot'), data: aiRunSchema }).strict(),
  z
    .object({
      runId: idSchema,
      type: z.literal('state'),
      data: z.union([
        aiRunSchema,
        z
          .object({ run: aiRunSchema, approval: aiApprovalSchema, toolCall: aiToolCallSchema })
          .strict(),
      ]),
    })
    .strict(),
  z
    .object({
      runId: idSchema,
      type: z.literal('delta'),
      data: z.object({ text: z.string().max(2 * 1024 * 1024) }).strict(),
    })
    .strict(),
  z
    .object({
      runId: idSchema,
      type: z.literal('usage'),
      data: z
        .object({
          type: z.literal('usage'),
          inputTokens: z.number().nonnegative().optional(),
          outputTokens: z.number().nonnegative().optional(),
          purpose: z.enum(['execution', 'review']).optional(),
        })
        .strict(),
    })
    .strict(),
]);

export type AiRunEvent = z.infer<typeof aiRunEventSchema>;

export type AiRun = z.infer<typeof aiRunSchema>;

export type AiAttachmentMetadata = z.infer<typeof aiAttachmentMetadataSchema>;

export type AiAttachmentPreview = z.infer<typeof aiAttachmentPreviewSchema>;

export type AiContextPreview = z.infer<typeof aiContextPreviewSchema>;

export type AiContextSource = z.infer<typeof aiContextSourceSchema>;

export type AiContextPreviewInput = z.input<typeof aiContextPreviewRequestSchema>;

export type AiConversation = z.infer<typeof aiConversationSchema>;

export type AiConversationDetail = z.infer<typeof aiConversationDetailSchema>;

export type AiMessage = z.infer<typeof aiMessageSchema>;

export type AiProvider = z.infer<typeof aiProviderSchema>;

export type AiModel = z.infer<typeof aiModelSchema>;

export type AiProviderProtocol = z.infer<typeof aiProviderProtocolSchema>;

export type AiProviderAuth = z.infer<typeof aiProviderAuthSchema>;

export type AiProviderTestResult = z.infer<typeof aiProviderTestResultSchema>;

export type AiToolCall = z.infer<typeof aiToolCallSchema>;

export type AiApproval = z.infer<typeof aiApprovalSchema>;

export type AiProviderInput = z.input<typeof aiProviderInputSchema>;

export type AiProviderPatch = z.input<typeof aiProviderPatchSchema>;

export type AiModelInput = z.input<typeof aiModelInputSchema>;

export type AiModelPatch = z.input<typeof aiModelPatchSchema>;

export type AiRequestInput = z.input<typeof aiRequestSchema>;

export type AiConversationInput = z.input<typeof aiConversationInputSchema>;

export type AiConversationPatch = z.input<typeof aiConversationPatchSchema>;

export type PiCatalogProvider = z.infer<typeof piCatalogProviderSchema>;

export { aiBookmarkDraftSchema } from './schemas/bookmarks.ts';
export { aiTerminalThemeDraftSchema } from './schemas/terminal-themes.ts';

const aiLogText = z.string().max(128 * 1024);
/** An allowlist of visible facts. No provider events, reasoning or arbitrary audit objects. */
export const aiLogPayloadSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('input'), text: aiLogText }).strict(),
  z
    .object({
      kind: z.literal('output'),
      text: aiLogText,
      mode: z.enum(['append', 'replace']).optional(),
    })
    .strict(),
  z.object({ kind: z.literal('state'), run: aiRunSchema.omit({ result: true }).strict() }).strict(),
  z.object({ kind: z.literal('tool'), tool: aiToolCallSchema }).strict(),
  z.object({ kind: z.literal('approval'), approval: aiApprovalSchema }).strict(),
  z
    .object({
      kind: z.literal('usage'),
      purpose: z.enum(['execution', 'review']).optional(),
      inputTokens: z.number().int().nonnegative().optional(),
      outputTokens: z.number().int().nonnegative().optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('audit'),
      action: z.enum(['admitted', 'interrupted', 'approval-decided', 'tool-finished']),
      outcome: z.enum(['accepted', 'succeeded', 'failed', 'canceled', 'expired', 'interrupted']),
    })
    .strict(),
]);
export type AiLogPayload = z.infer<typeof aiLogPayloadSchema>;
export interface AiLogEntry {
  cursor: number;
  runId: string;
  createdAt: string;
  payload: AiLogPayload;
}

/** Complete bounded metadata indices. Large messages, Run output and provider detail use selected pages. */
export const aiProviderHeaderSchema = z
  .object({
    ...entityFields,
    name: z.string(),
    engineId: z.string().regex(/^[a-z][a-z0-9.-]{0,127}$/),
    enabled: z.boolean(),
  })
  .strict();
export const aiRunHeaderSchema = aiRunSchema
  .omit({ result: true })
  .extend({ hasResult: z.boolean() })
  .strict();
export const aiEngineHeaderSchema = z
  .object({
    id: z.string().regex(/^[a-z][a-z0-9.-]{0,127}$/),
    label: z.string().min(1).max(256),
    capabilities: z
      .object({ cancellation: z.boolean(), tools: z.boolean(), resume: z.boolean() })
      .strict(),
    state: z.enum(['ready', 'draining', 'failed']),
  })
  .strict();
export const AI_INDEX_MAX_ENTRIES = 100000;
export const AI_CHUNK_CHARACTERS = 16384;
export const AI_MAX_SNAPSHOT_BYTES = 64 * 1024 * 1024;
export type AiProviderHeader = z.infer<typeof aiProviderHeaderSchema>;
export type AiRunHeader = z.infer<typeof aiRunHeaderSchema>;
export type AiEngineHeader = z.infer<typeof aiEngineHeaderSchema>;
export type AiCollection =
  'providers' | 'models' | 'conversations' | 'runs' | 'approvals' | 'engines';
export interface AiBaseline {
  readonly generation: string;
  readonly cursor: number;
  readonly revision: number;
  readonly providers: readonly AiProviderHeader[];
  readonly models: readonly AiModel[];
  readonly conversations: readonly AiConversation[];
  readonly runs: readonly AiRunHeader[];
  /** Every pending authority, independent of recent history. Tool/Approval history is paged by Run. */
  readonly approvals: readonly AiApproval[];
  readonly engines: readonly AiEngineHeader[];
}
export type AiUpdate =
  | {
      readonly type: 'begin';
      readonly generation: string;
      readonly cursor: number;
      readonly revision: number;
      readonly mode: 'baseline' | 'delta';
      readonly collections: readonly AiCollection[];
    }
  | {
      readonly type: 'chunk';
      readonly collection: AiCollection;
      readonly offset: number;
      readonly text: string;
      readonly final: boolean;
    }
  | { readonly type: 'commit'; readonly cursor: number; readonly revision: number };
export interface AiReceipt {
  readonly ids: readonly string[];
  readonly cursor: number;
}
export interface AiLogPage {
  readonly entries: readonly AiLogEntry[];
  readonly nextCursor: number;
  readonly hasMore: boolean;
}
export interface AiMessagePage {
  readonly messages: readonly AiMessage[];
  readonly nextCursor: number;
  readonly hasMore: boolean;
}
export interface AiToolPage {
  readonly tools: readonly AiToolCall[];
  readonly approvals: readonly AiApproval[];
  readonly nextCursor: number;
  readonly hasMore: boolean;
}
export interface AiPageQuery {
  readonly after?: number;
  readonly limit?: number;
}
export type AiFailureReason =
  | 'not-found'
  | 'conflict'
  | 'precondition'
  | 'invalid'
  | 'unsupported'
  | 'capacity'
  | 'closed'
  | 'unavailable'
  | 'cancelled'
  | 'expired'
  | 'policy';
declare module './types.ts' {
  interface RemoteErrorDetailsMap {
    'ai/failure': { reason: AiFailureReason };
  }
}

export const aiGenerationSchema = z.uuid();

/** A selected UI window, independent of the forward-only application log cursor. */
export type AiMessageWindowQuery =
  | { readonly direction: 'latest'; readonly limit?: number }
  | { readonly direction: 'earlier' | 'later'; readonly cursor: number; readonly limit?: number };
export interface AiMessageWindow {
  readonly messages: readonly AiMessage[];
  readonly firstCursor: number;
  readonly lastCursor: number;
  readonly hasEarlier: boolean;
  readonly hasLater: boolean;
}

/** Readonly generation-local admission metadata; lookup never invokes an Engine. */
export type AiRunCommandOutcome =
  | { readonly status: 'accepted'; readonly id: string }
  | { readonly status: 'missing' | 'uncertain' };
