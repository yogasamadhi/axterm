import type {
  AiConversation,
  AiConversationInput,
  AiConversationPatch,
  AiMessage,
  AiRun,
  AiApproval,
  AiToolCall,
} from '@axterm/plugin-api/ai';
/** Selected AI facts; application has no SQL or direct Run/Tool/Approval mutation authority. */
export interface AiRepositoryPort {
  listAiConversations(): AiConversation[];
  getAiConversation(id: string): AiConversation;
  createAiConversation(input: AiConversationInput): AiConversation;
  updateAiConversation(
    id: string,
    input: AiConversationPatch,
    ifMatch: string | undefined,
  ): AiConversation;
  deleteAiConversation(id: string, ifMatch: string | undefined): void;
  listAiContextMessages(id: string): {
    messages: Array<Pick<AiMessage, 'role' | 'content'>>;
    count: number;
  };
  listAiMessages(id: string): AiMessage[];
  listAiRuns(): AiRun[];
  getAiRun(id: string): AiRun;
  listToolCalls(runId?: string, id?: string): AiToolCall[];
  getToolCall(id: string): AiToolCall;
  listApprovals(id?: string): AiApproval[];
  pendingApprovals(runId?: string): AiApproval[];
  activeToolCalls(runId: string): AiToolCall[];
  getApproval(id: string): AiApproval;
  listJson<T>(table: 'ai_providers' | 'ai_models' | 'ai_conversations'): T[];
  getJson<T>(table: 'ai_providers' | 'ai_models' | 'ai_conversations', id: string): T;
}
