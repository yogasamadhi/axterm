import type { AiToolCall } from '@axterm/plugin-api/ai';
export interface AiToolIdentity {
  readonly id: string;
  readonly generation: string;
}
export interface AiModelToolProposal {
  readonly name: string;
  readonly args: Record<string, unknown>;
  readonly target: string;
}
export interface AiToolsPort {
  modelTools?(): readonly string[];
  modelProposal?(name: string, args: Record<string, unknown>): AiModelToolProposal;
  risk(name: string): AiToolCall['risk'];
  execute(
    name: string,
    args: Record<string, unknown>,
    target: string,
    signal?: AbortSignal,
    identity?: AiToolIdentity,
  ): Promise<unknown>;
}
