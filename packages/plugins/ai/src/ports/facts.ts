import type { AiRun, AiToolCall, AiApproval, AiAttachmentMetadata } from '@axterm/plugin-api/ai';
export interface AiAdmission {
  operation?: 'run' | 'mcp-tool';
  sourceId?: string;
  engineId: string;
  useCase: AiRun['useCase'];
  prompt: string;
  context?: string;
  system?: string;
  conversationId?: string;
  attachments?: AiAttachmentMetadata[];
  selection?: {
    providerId: string;
    providerVersion: number;
    modelId: string;
    modelVersion: number;
  };
}
/** Each mutation commits its selected fact and durable log/outbox atomically. */
export interface AiFactsPort {
  lookup(key: string, generation: string, original: unknown): AiRun | undefined;
  admit(
    key: string,
    generation: string,
    input: AiAdmission,
    original: unknown,
  ): { run: AiRun; admitted: boolean };
  updateAiRun(id: string, state: AiRun['state'], result?: string, errorCode?: string): AiRun;
  output(runId: string, text: string): void;
  usage(
    runId: string,
    input: {
      purpose?: 'execution' | 'review' | undefined;
      inputTokens?: number | undefined;
      outputTokens?: number | undefined;
    },
  ): void;
  createToolCall(
    input: Pick<
      AiToolCall,
      'runId' | 'toolName' | 'risk' | 'argsHash' | 'args' | 'target' | 'state'
    >,
  ): AiToolCall;
  updateToolCall(
    id: string,
    state: AiToolCall['state'],
    metadata?: Record<string, unknown>,
  ): AiToolCall;
  updateCommandCall(
    id: string,
    patch: Partial<Pick<AiToolCall, 'risk' | 'argsHash' | 'review' | 'step' | 'approvalSource'>>,
  ): AiToolCall;
  createApproval(
    input: Pick<AiApproval, 'runId' | 'toolCallId' | 'argsHash' | 'target' | 'expiresAt'>,
  ): AiApproval;
  lookupApproval(
    key: string,
    input: { id: string; argsHash: string; decision: 'approve_once' | 'reject' },
  ): AiApproval | undefined;
  decideApproval(
    id: string,
    state: 'approved' | 'rejected' | 'expired',
    commandId?: string,
  ): AiApproval;
}
