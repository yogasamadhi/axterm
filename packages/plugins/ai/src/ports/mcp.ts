export interface McpToolDefinition {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  risk: 'read_only' | 'mutating' | 'destructive' | 'privileged';
}
export interface McpToolInvocation {
  runId: string;
  state: 'queued' | 'running' | 'waiting_approval' | 'succeeded' | 'failed' | 'canceled';
  toolCallId?: string;
  approvalId?: string;
  argsHash?: string;
  expiresAt?: string;
  result?: unknown;
  errorCode?: string;
}
