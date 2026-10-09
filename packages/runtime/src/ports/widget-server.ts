export interface LocalFileServerOptions {
  rootPath: string;
  host: string;
  port: number;
  index: string;
  dotfiles: 'allow' | 'deny' | 'ignore';
  cacheControl: boolean;
  maxAgeMs: number;
  lastModified: boolean;
  etag: boolean;
  acceptRanges: boolean;
  redirect: boolean;
}

export interface RunningWidgetServer {
  host: string;
  port: number;
  url: string;
  stop(): Promise<void>;
}

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

export interface McpToolGateway {
  listTools(): McpToolDefinition[];
  callTool(
    name: string,
    args: Record<string, unknown>,
    idempotencyKey: string,
  ): Promise<McpToolInvocation>;
}

export interface McpServerOptions {
  host: 'localhost' | '127.0.0.1' | '::1';
  port: number;
  apiKey: string;
  enabledTools: string[];
  gateway: McpToolGateway;
}

export interface RunningMcpServer extends RunningWidgetServer {
  status(): {
    activeSessions: number;
    toolCount: number;
    protocolVersion: string;
  };
}

export interface McpServerAdapter {
  start(options: McpServerOptions): Promise<RunningMcpServer>;
}

export interface LocalFileServerAdapter {
  start(options: LocalFileServerOptions): Promise<RunningWidgetServer>;
}

export interface LocalFtpServerOptions {
  rootPath: string;
  host: string;
  port: number;
  anonymous: boolean;
  username: string;
  password?: string;
  passivePortStart: number;
  passivePortEnd: number;
}

export interface LocalFtpServerAdapter {
  start(options: LocalFtpServerOptions): Promise<RunningWidgetServer>;
}

export interface LocalSshServerOptions {
  rootPath: string;
  host: string;
  port: number;
  username: string;
  password: string;
}

export interface LocalSshServerAdapter {
  start(options: LocalSshServerOptions): Promise<RunningWidgetServer>;
}
