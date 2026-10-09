export type PiApi =
  | 'openai-completions'
  | 'openai-responses'
  | 'azure-openai-responses'
  | 'anthropic-messages'
  | 'google-generative-ai'
  | 'mistral-conversations'
  | 'pi-messages';

export interface PiModelConfig {
  id: string;
  name?: string | undefined;
  api?: PiApi | undefined;
  baseUrl?: string | undefined;
  reasoning?: boolean | undefined;
  input?: ('text' | 'image')[] | undefined;
  cost?: { input: number; output: number; cacheRead: number; cacheWrite: number } | undefined;
  contextWindow?: number | undefined;
  maxTokens?: number | undefined;
  compat?: Record<string, boolean | string | number> | undefined;
}

export interface PiProviderConfig {
  id: string;
  api?: PiApi | undefined;
  models: PiModelConfig[];
  modelOverrides: Record<string, Omit<PiModelConfig, 'id'>>;
}

export interface PiCatalogProvider {
  id: string;
  name: string;
  baseUrl: string;
  apiKeyAvailable: boolean;
  models: PiModelConfig[];
}

export interface PiEngineRequest {
  allowCommandProposal?: boolean;
  provider: PiProviderConfig;
  baseUrl: string;
  model: string;
  apiKey: string;
  system: string;
  prompt: string;
  context: string;
  signal: AbortSignal;
  fetch: typeof globalThis.fetch;
  headers: Record<string, string | null>;
  timeoutMs: number;
}

export type PiEngineEvent =
  | { type: 'commandProposal'; command: string }
  | { type: 'delta'; text: string }
  | { type: 'usage'; inputTokens: number; outputTokens: number }
  | { type: 'completed' };

export declare function piCatalog(): PiCatalogProvider[];
export declare function piSkills(): Array<{
  id: string;
  useCase: string;
  description: string;
  body: string;
}>;
export declare function streamPiAgent(request: PiEngineRequest): AsyncIterable<PiEngineEvent>;
