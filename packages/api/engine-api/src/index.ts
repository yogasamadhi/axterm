import type {} from '@deepseek-ai/cordis';
import { z } from 'zod';

export const engineIdSchema = z.string().regex(/^[a-z][a-z0-9.-]{0,127}$/);
const identity = z.string().min(1).max(256);
export const engineCapabilitiesSchema = z
  .object({
    cancellation: z.boolean(),
    tools: z.boolean(),
    resume: z.boolean(),
  })
  .strict();
export type EngineCapabilities = z.infer<typeof engineCapabilitiesSchema>;
export const engineDescriptorSchema = z
  .object({
    id: engineIdSchema,
    label: z.string().min(1).max(256),
    capabilities: engineCapabilitiesSchema,
    state: z.enum(['ready', 'draining', 'failed']),
  })
  .strict();
export type EngineDescriptor = z.infer<typeof engineDescriptorSchema>;
export const engineSessionInputSchema = z
  .object({
    sessionId: identity,
    /** Opaque execution handle only. Application messages/history remain application facts. */
    resumeHandle: z.string().min(1).max(2048).optional(),
  })
  .strict();
export type EngineSessionInput = z.infer<typeof engineSessionInputSchema>;
export const engineRunInputSchema = z
  .object({
    runId: identity,
    providerId: identity,
    model: z.string().min(1).max(512),
    system: z.string().max(131072),
    prompt: z.string().max(131072),
    context: z.string().max(131072),
    maxOutputTokens: z.number().int().min(1).max(32768).optional(),
    requireComplete: z.boolean().optional(),
    allowCommandProposal: z.boolean().optional(),
    /** Enables only the application-supplied tool callback; never grants approval. */
    tools: z.boolean().default(false),
    /** Application-selected tool names; no authorization is conveyed by these names. */
    toolNames: z.array(z.string().min(1).max(128)).max(32).optional(),
  })
  .strict();
export type EngineRunInput = z.infer<typeof engineRunInputSchema>;
/** Host execution metadata, separate from durable visible input. Values contain references, never resolved secrets. */
export const engineExecutionOptionsSchema = z
  .object({ configuration: z.json().optional() })
  .strict();
export type EngineExecutionOptions = z.infer<typeof engineExecutionOptionsSchema>;

export const engineEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('delta'), text: z.string().max(2 * 1024 * 1024) }).strict(),
  z.object({ type: z.literal('commandProposal'), command: z.string().min(1).max(8192) }).strict(),
  z
    .object({
      type: z.literal('usage'),
      inputTokens: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
      outputTokens: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    })
    .strict(),
  z.object({ type: z.literal('completed') }).strict(),
]);
export type EngineEvent = z.infer<typeof engineEventSchema>;
export const engineToolRequestSchema = z
  .object({
    callId: identity,
    name: z.string().min(1).max(128),
    arguments: z.record(z.string(), z.json()),
  })
  .strict();
export type EngineToolRequest = z.infer<typeof engineToolRequestSchema>;
export const engineToolResultSchema = z
  .object({
    text: z.string().max(16384),
    isError: z.boolean(),
  })
  .strict();
export type EngineToolResult = z.infer<typeof engineToolResultSchema>;
export const engineErrorCodeSchema = z.enum([
  'invalid',
  'missing',
  'duplicate',
  'unsupported',
  'closed',
  'busy',
  'capacity',
  'cancelled',
  'provider-failed',
  'drain-failed',
  'sink-failed',
  'backpressure',
  'tool-unavailable',
]);
export type EngineErrorCode = z.infer<typeof engineErrorCodeSchema>;
/** Stable errors intentionally omit provider causes, model content and credentials. */
export class EngineError extends Error {
  readonly code: EngineErrorCode;
  constructor(code: EngineErrorCode) {
    const safe = engineErrorCodeSchema.safeParse(code);
    const normalized = safe.success ? safe.data : 'invalid';
    super(`ENGINE_${normalized.toUpperCase().replaceAll('-', '_')}`);
    this.name = 'EngineError';
    this.code = normalized;
  }
}
export type EngineRunOutcome =
  | { readonly status: 'completed' }
  | { readonly status: 'cancelled' }
  | { readonly status: 'failed'; readonly code: EngineErrorCode };
/** Acknowledgment means the application has recorded the visible event. */
export interface EngineRunObserver {
  event(event: EngineEvent): Promise<void>;
  /** Application-owned tool/approval/budget/audit path. Missing means deny execution. */
  tool?(request: EngineToolRequest, signal: AbortSignal): Promise<EngineToolResult>;
}
export interface EngineRunHandle {
  readonly runId: string;
  readonly done: Promise<EngineRunOutcome>;
  /** Waits for actual provider settlement; unsupported cancellation rejects explicitly. */
  cancel(): Promise<void>;
}
export interface EngineSessionHandle {
  readonly sessionId: string;
  readonly engineId: string;
  run(
    input: EngineRunInput,
    observer: EngineRunObserver,
    options?: EngineExecutionOptions,
  ): EngineRunHandle;
  /** Stops admission, aborts work, closes the execution handle and drains all accepted work. */
  close(): Promise<void>;
}

declare module '@deepseek-ai/cordis' {
  interface Events {
    /** Registry metadata changed; no model content, execution handle or secret crosses this event. */
    'engines/changed'(id: string): void;
  }
}
