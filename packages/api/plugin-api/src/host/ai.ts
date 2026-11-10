import type { AiRunEvent } from '../ai.ts';
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
  }
  interface Events {
    'ai/run-event'(event: AiRunEvent): void;
  }
}
