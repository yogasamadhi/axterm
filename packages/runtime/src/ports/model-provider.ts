export interface ModelRequest {
  model: string;
  system: string;
  prompt: string;
  context: string;
  signal: AbortSignal;
}
export type ModelEvent =
  | { type: 'delta'; text: string }
  | {
      type: 'toolCallDelta';
      index: number;
      id?: string | undefined;
      name?: string | undefined;
      arguments?: string | undefined;
    }
  | { type: 'completed' }
  | { type: 'usage'; inputTokens?: number | undefined; outputTokens?: number | undefined };
export interface ModelProvider {
  stream(input: ModelRequest): AsyncIterable<ModelEvent>;
}
