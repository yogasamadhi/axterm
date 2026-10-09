export interface ModelRequest {
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
