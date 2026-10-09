import { randomUUID, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { Socket } from 'node:net';
import type {
  McpServerAdapter,
  McpServerOptions,
  McpToolInvocation,
  RunningMcpServer,
} from '../../ports/widget-server';

const latestProtocolVersion = '2025-11-25';
const supportedProtocolVersions = new Set([latestProtocolVersion, '2025-06-18', '2024-11-05']);
const maxRequestBytes = 256 * 1024;
const maxSessions = 32;
const sessionTtlMs = 30 * 60_000;

interface McpSession {
  id: string;
  protocolVersion: string;
  initialized: boolean;
  lastAccessAt: number;
  streams: Set<ServerResponse>;
}

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

export class NodeMcpServer implements McpServerAdapter {
  async start(options: McpServerOptions): Promise<RunningMcpServer> {
    if (!options.apiKey) throw new Error('MCP API key is required');
    const definitions = options.gateway
      .listTools()
      .filter((tool) => options.enabledTools.includes(tool.name));
    const tools = new Map(definitions.map((tool) => [tool.name, tool]));
    if (!tools.size) throw new Error('At least one MCP tool must be enabled');
    const sessions = new Map<string, McpSession>();
    const sockets = new Set<Socket>();
    const inFlight = new Map<string, Promise<McpToolInvocation>>();
    const server = createServer((request, response) => {
      void handleRequest(options, tools, sessions, inFlight, request, response).catch(() => {
        if (!response.headersSent)
          response.writeHead(500, { ...secureHeaders(), 'Content-Type': 'text/plain' });
        response.end('Internal Server Error');
      });
    });
    server.maxConnections = 64;
    server.headersTimeout = 5_000;
    server.requestTimeout = 30_000;
    server.keepAliveTimeout = 5_000;
    server.on('connection', (socket) => {
      sockets.add(socket);
      socket.once('close', () => sockets.delete(socket));
    });
    const maintenance = setInterval(() => {
      const now = Date.now();
      for (const session of sessions.values()) {
        if (now - session.lastAccessAt >= sessionTtlMs) closeSession(sessions, session.id);
        else for (const stream of session.streams) stream.write(': heartbeat\n\n');
      }
    }, 15_000);
    maintenance.unref();
    try {
      await new Promise<void>((resolve, reject) => {
        const fail = (error: Error) => reject(error);
        server.once('error', fail);
        server.listen(options.port, options.host, () => {
          server.off('error', fail);
          resolve();
        });
      });
    } catch (error) {
      clearInterval(maintenance);
      for (const socket of sockets) socket.destroy();
      server.close();
      throw error;
    }
    const address = server.address();
    if (!address || typeof address === 'string') {
      clearInterval(maintenance);
      server.close();
      throw new Error('MCP server did not bind TCP');
    }
    const host = options.host === 'localhost' ? '127.0.0.1' : options.host;
    const printableHost = host.includes(':') ? `[${host}]` : host;
    let closed: Promise<void> | undefined;
    return {
      host,
      port: address.port,
      url: `http://${printableHost}:${address.port}/mcp`,
      status: () => ({
        activeSessions: sessions.size,
        toolCount: tools.size,
        protocolVersion: latestProtocolVersion,
      }),
      stop: () => {
        closed ??= new Promise<void>((resolve) => {
          clearInterval(maintenance);
          for (const session of sessions.values()) closeSession(sessions, session.id);
          inFlight.clear();
          for (const socket of sockets) socket.destroy();
          server.close(() => resolve());
          if (!server.listening) resolve();
        });
        return closed;
      },
    };
  }
}

async function handleRequest(
  options: McpServerOptions,
  tools: Map<string, ReturnType<McpServerOptions['gateway']['listTools']>[number]>,
  sessions: Map<string, McpSession>,
  inFlight: Map<string, Promise<McpToolInvocation>>,
  request: IncomingMessage,
  response: ServerResponse,
) {
  if (!authenticate(request.headers.authorization, options.apiKey)) {
    response.writeHead(401, {
      ...secureHeaders(),
      'Content-Type': 'text/plain',
      'WWW-Authenticate': 'Bearer realm="Axterm MCP"',
    });
    response.end('Unauthorized');
    return;
  }
  if (!originAllowed(request.headers.origin)) {
    response.writeHead(403, { ...secureHeaders(), 'Content-Type': 'text/plain' });
    response.end('Forbidden');
    return;
  }
  const requestUrl = new URL(request.url ?? '/', 'http://mcp.local');
  if (requestUrl.pathname !== '/mcp') {
    response.writeHead(404, { ...secureHeaders(), 'Content-Type': 'text/plain' });
    response.end('Not Found');
    return;
  }
  if (request.method === 'GET') {
    openEventStream(sessions, request, response);
    return;
  }
  if (request.method === 'DELETE') {
    const session = requireSession(sessions, request, response);
    if (!session) return;
    closeSession(sessions, session.id);
    response.writeHead(204, secureHeaders());
    response.end();
    return;
  }
  if (request.method !== 'POST') {
    response.writeHead(405, { ...secureHeaders(), Allow: 'GET, POST, DELETE' });
    response.end('Method Not Allowed');
    return;
  }
  const accepts = String(request.headers.accept ?? '');
  if (!accepts.includes('application/json') || !accepts.includes('text/event-stream')) {
    response.writeHead(406, { ...secureHeaders(), 'Content-Type': 'text/plain' });
    response.end('MCP clients must accept application/json and text/event-stream');
    return;
  }
  if (
    !String(request.headers['content-type'] ?? '')
      .toLowerCase()
      .startsWith('application/json')
  ) {
    response.writeHead(415, { ...secureHeaders(), 'Content-Type': 'text/plain' });
    response.end('Expected application/json');
    return;
  }
  let message: JsonRpcRequest;
  try {
    message = parseJsonRpc(JSON.parse(await readBody(request)));
  } catch (error) {
    const tooLarge = error instanceof Error && error.message === 'PAYLOAD_TOO_LARGE';
    respondJsonRpc(
      response,
      null,
      undefined,
      {
        code: tooLarge ? -32_000 : -32_700,
        message: tooLarge ? 'Request body is too large' : 'Parse error',
      },
      tooLarge ? 413 : 400,
    );
    return;
  }
  if (message.method === 'initialize') {
    if (request.headers['mcp-session-id']) {
      respondJsonRpc(response, message.id ?? null, undefined, {
        code: -32_600,
        message: 'Initialize must not reuse an MCP session',
      });
      return;
    }
    if (sessions.size >= maxSessions) {
      response.writeHead(429, { ...secureHeaders(), 'Content-Type': 'text/plain' });
      response.end('MCP session limit reached');
      return;
    }
    const requested = String(message.params?.protocolVersion ?? '');
    const protocolVersion = supportedProtocolVersions.has(requested)
      ? requested
      : latestProtocolVersion;
    const session: McpSession = {
      id: randomUUID(),
      protocolVersion,
      initialized: false,
      lastAccessAt: Date.now(),
      streams: new Set(),
    };
    sessions.set(session.id, session);
    respondJsonRpc(
      response,
      message.id ?? null,
      {
        protocolVersion,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'Axterm MCP Server', version: '1.0.0' },
        instructions:
          'Read-only tools run immediately. Mutating tools create an approval card in Axterm.',
      },
      undefined,
      200,
      session.id,
    );
    return;
  }
  const session = requireSession(sessions, request, response);
  if (!session) return;
  const suppliedVersion = request.headers['mcp-protocol-version'];
  if (suppliedVersion && suppliedVersion !== session.protocolVersion) {
    respondJsonRpc(response, message.id ?? null, undefined, {
      code: -32_600,
      message: 'MCP protocol version does not match this session',
    });
    return;
  }
  session.lastAccessAt = Date.now();
  if (message.method === 'notifications/initialized') {
    session.initialized = true;
    response.writeHead(202, secureHeaders());
    response.end();
    return;
  }
  if (message.method === 'ping') {
    respondJsonRpc(response, message.id ?? null, {});
    return;
  }
  if (!session.initialized) {
    respondJsonRpc(response, message.id ?? null, undefined, {
      code: -32_002,
      message: 'MCP session is not initialized',
    });
    return;
  }
  if (message.method === 'tools/list') {
    respondJsonRpc(response, message.id ?? null, {
      tools: [...tools.values()].map((tool) => ({
        name: tool.name,
        title: tool.title,
        description: tool.description,
        inputSchema: tool.inputSchema,
        annotations: {
          readOnlyHint: tool.risk === 'read_only',
          destructiveHint: tool.risk === 'destructive',
          idempotentHint: tool.risk === 'read_only',
          openWorldHint: false,
        },
      })),
    });
    return;
  }
  if (message.method === 'tools/call') {
    if (message.id === undefined || message.id === null) {
      response.writeHead(400, { ...secureHeaders(), 'Content-Type': 'text/plain' });
      response.end('Tool calls require a JSON-RPC id');
      return;
    }
    const name = typeof message.params?.name === 'string' ? message.params.name : '';
    const args = isRecord(message.params?.arguments) ? message.params.arguments : {};
    const key = `mcp:${session.id}:${String(message.id)}`;
    let invocation: McpToolInvocation;
    try {
      if (!tools.has(name)) throw new Error('Tool is unavailable or disabled');
      const task = inFlight.get(key) ?? options.gateway.callTool(name, args, key);
      inFlight.set(key, task);
      invocation = await task;
      if (inFlight.size > 128) inFlight.delete(inFlight.keys().next().value!);
    } catch (error) {
      respondJsonRpc(response, message.id, toolError(error));
      return;
    }
    const waiting = invocation.state === 'waiting_approval';
    const failed = invocation.state === 'failed' || invocation.state === 'canceled';
    const text = waiting
      ? `Approval required in Axterm. Run ${invocation.runId}, approval ${invocation.approvalId ?? 'pending'}.`
      : failed
        ? `Axterm tool call ${invocation.state}: ${invocation.errorCode ?? 'execution failed'}.`
        : boundedJson(invocation.result ?? { state: invocation.state });
    respondJsonRpc(response, message.id, {
      content: [{ type: 'text', text }],
      structuredContent: invocation,
      isError: failed,
    });
    return;
  }
  respondJsonRpc(response, message.id ?? null, undefined, {
    code: -32_601,
    message: 'Method not found',
  });
}

function openEventStream(
  sessions: Map<string, McpSession>,
  request: IncomingMessage,
  response: ServerResponse,
) {
  const session = requireSession(sessions, request, response);
  if (!session) return;
  if (!String(request.headers.accept ?? '').includes('text/event-stream')) {
    response.writeHead(406, { ...secureHeaders(), 'Content-Type': 'text/plain' });
    response.end('Expected text/event-stream');
    return;
  }
  session.lastAccessAt = Date.now();
  response.writeHead(200, {
    ...secureHeaders(),
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
  });
  response.write(': connected\n\n');
  session.streams.add(response);
  response.once('close', () => session.streams.delete(response));
}

function requireSession(
  sessions: Map<string, McpSession>,
  request: IncomingMessage,
  response: ServerResponse,
): McpSession | undefined {
  const id = request.headers['mcp-session-id'];
  const session = typeof id === 'string' ? sessions.get(id) : undefined;
  if (!session) {
    response.writeHead(404, { ...secureHeaders(), 'Content-Type': 'text/plain' });
    response.end('MCP session not found');
    return undefined;
  }
  return session;
}

function closeSession(sessions: Map<string, McpSession>, id: string) {
  const session = sessions.get(id);
  if (!session) return;
  sessions.delete(id);
  for (const stream of session.streams) stream.end();
  session.streams.clear();
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.byteLength;
    if (bytes > maxRequestBytes) {
      throw new Error('PAYLOAD_TOO_LARGE');
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function parseJsonRpc(value: unknown): JsonRpcRequest {
  if (!isRecord(value) || value.jsonrpc !== '2.0' || typeof value.method !== 'string')
    throw new Error('INVALID_JSON_RPC');
  if (
    value.id !== undefined &&
    value.id !== null &&
    typeof value.id !== 'string' &&
    typeof value.id !== 'number'
  )
    throw new Error('INVALID_JSON_RPC');
  if (value.params !== undefined && !isRecord(value.params)) throw new Error('INVALID_JSON_RPC');
  return value as unknown as JsonRpcRequest;
}

function authenticate(header: string | undefined, expected: string): boolean {
  const match = /^Bearer (.+)$/u.exec(header ?? '');
  if (!match) return false;
  const supplied = Buffer.from(match[1]!, 'utf8');
  const secret = Buffer.from(expected, 'utf8');
  return supplied.byteLength === secret.byteLength && timingSafeEqual(supplied, secret);
}

function originAllowed(origin: string | undefined): boolean {
  if (!origin) return true;
  try {
    const parsed = new URL(origin);
    const hostname = parsed.hostname.replace(/^\[|\]$/gu, '');
    return (
      (parsed.protocol === 'http:' || parsed.protocol === 'https:') &&
      (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1')
    );
  } catch {
    return false;
  }
}

function respondJsonRpc(
  response: ServerResponse,
  id: string | number | null,
  result?: unknown,
  error?: { code: number; message: string },
  status = 200,
  sessionId?: string,
) {
  const body = JSON.stringify({ jsonrpc: '2.0', id, ...(error ? { error } : { result }) });
  response.writeHead(status, {
    ...secureHeaders(),
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
    ...(sessionId ? { 'Mcp-Session-Id': sessionId } : {}),
  });
  response.end(body);
}

function toolError(error: unknown) {
  const message = error instanceof Error ? error.message.slice(0, 1_000) : 'Tool call failed';
  return {
    content: [{ type: 'text', text: message }],
    isError: true,
  };
}

function boundedJson(value: unknown): string {
  const json = JSON.stringify(value);
  return json.length <= 131_072 ? json : `${json.slice(0, 131_040)}…[truncated]`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function secureHeaders() {
  return {
    'Content-Security-Policy': "default-src 'none'",
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
  };
}
