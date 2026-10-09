export interface ModelRequest {
  executeCommand?:
    | ((
        command: string,
        toolCallId: string,
        signal: AbortSignal,
      ) => Promise<{ text: string; isError: boolean }>)
    | undefined;
  maxOutputTokens?: number | undefined;
  requireComplete?: boolean | undefined;
  allowCommandProposal?: boolean;
  model: string;
  system: string;
  prompt: string;
  context: string;
  signal: AbortSignal;
}
export type ModelEvent =
  | { type: 'commandProposal'; command: string }
  | { type: 'delta'; text: string }
  | { type: 'completed' }
  | { type: 'usage'; inputTokens?: number | undefined; outputTokens?: number | undefined };
export interface ModelProvider {
  stream(input: ModelRequest): AsyncIterable<ModelEvent>;
}
