import type { AiCommandReview, AiWorkspace } from '@axterm/plugin-api/ai';
import type { ModelProvider } from './model-provider.ts';
export const COMMAND_POLICY_VERSION = 'axterm-command-review-v2';
export interface AiCommandReviewer {
  review(input: {
    command: string;
    workspace: AiWorkspace;
    modelId: string;
    model: string;
    generation: string;
    messages: readonly { role: string; content: string }[];
    adapter: ModelProvider;
    signal: AbortSignal;
    timeoutMs: number;
    secrets: readonly string[];
    usage(event: { inputTokens?: number | undefined; outputTokens?: number | undefined }): void;
  }): Promise<AiCommandReview>;
}
