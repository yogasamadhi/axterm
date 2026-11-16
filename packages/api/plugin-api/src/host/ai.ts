import type { AiRunEvent, PiLoginState } from '../ai.ts';
export interface PiProviderAuth {
  begin(provider: string, method: 'api_key' | 'oauth'): PiLoginState;
  get(id: string): PiLoginState;
  respond(id: string, promptId: string, value: string): void;
  cancel(id: string): Promise<void>;
  secrets(provider: string, reference: string): Promise<readonly string[]>;
}
import type { WidgetMcpTool, WidgetMcpInvocation } from '../widgets.ts';
export interface AiMcpToolSource {
  listTools(): readonly WidgetMcpTool[];
  callTool(name: string, args: Record<string, unknown>, key: string): Promise<WidgetMcpInvocation>;
  close(): Promise<void>;
}
export interface AiMcpTools {
  registerSource(id: string): AiMcpToolSource;
  listTools(): readonly WidgetMcpTool[];
}
/** Ephemeral, already-redacted observations; durable facts have independent outbox/log cursors. */
declare module '@deepseek-ai/cordis' {
  interface Context {
    aiMcpTools: AiMcpTools;
    piProviderAuth: PiProviderAuth;
  }
  interface Events {
    'ai/run-event'(event: AiRunEvent): void;
  }
}
