import { afterEach, describe, expect, it, vi } from 'vitest';
import type { McpToolGateway, RunningMcpServer } from '../../ports/widget-server';
import { NodeMcpServer } from './node-mcp-server';

const apiKey = 'local-test-mcp-token-1234567890';
const postHeaders = {
  Authorization: `Bearer ${apiKey}`,
  Accept: 'application/json, text/event-stream',
  'Content-Type': 'application/json',
};

describe('NodeMcpServer', () => {
  let server: RunningMcpServer | undefined;

  afterEach(async () => {
    await server?.stop();
  });

  it('serves an authenticated stateful MCP lifecycle and registered tools', async () => {
    const callTool = vi.fn(async (name: string) =>
      name === 'terminal.exec'
        ? {
            runId: '00000000-0000-4000-8000-000000000111',
            state: 'waiting_approval' as const,
            toolCallId: '00000000-0000-4000-8000-000000000112',
            approvalId: '00000000-0000-4000-8000-000000000113',
            argsHash: 'hash',
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
          }
        : {
            runId: '00000000-0000-4000-8000-000000000114',
            state: 'succeeded' as const,
            toolCallId: '00000000-0000-4000-8000-000000000115',
            result: { freeBytes: 42 },
          },
    );
    const gateway: McpToolGateway = {
      listTools: () => [
        {
          name: 'system.inspectMemory',
          title: 'Inspect memory',
          description: 'Read memory data.',
          inputSchema: { type: 'object', properties: {}, additionalProperties: false },
          risk: 'read_only',
        },
        {
          name: 'terminal.exec',
          title: 'Insert command',
          description: 'Insert after approval.',
          inputSchema: { type: 'object' },
          risk: 'mutating',
        },
      ],
      callTool,
    };
    server = await new NodeMcpServer().start({
      host: '127.0.0.1',
      port: 0,
      apiKey,
      enabledTools: ['system.inspectMemory', 'terminal.exec'],
      gateway,
    });

    expect((await fetch(server.url)).status).toBe(401);
    expect(
      (
        await fetch(server.url, {
          method: 'POST',
          headers: { ...postHeaders, Origin: 'https://attacker.example' },
          body: rpc(1, 'initialize', { protocolVersion: '2025-06-18' }),
        })
      ).status,
    ).toBe(403);

    const initialized = await fetch(server.url, {
      method: 'POST',
      headers: postHeaders,
      body: rpc(1, 'initialize', { protocolVersion: '2025-06-18' }),
    });
    expect(initialized.status).toBe(200);
    const sessionId = initialized.headers.get('mcp-session-id');
    expect(sessionId).toMatch(/^[0-9a-f-]{36}$/u);
    expect(await initialized.json()).toMatchObject({
      result: {
        protocolVersion: '2025-06-18',
        capabilities: { tools: { listChanged: false } },
      },
    });
    expect(server.status()).toMatchObject({ activeSessions: 1, toolCount: 2 });

    const sessionHeaders = {
      ...postHeaders,
      'Mcp-Session-Id': sessionId!,
      'MCP-Protocol-Version': '2025-06-18',
    };
    const notification = await fetch(server.url, {
      method: 'POST',
      headers: sessionHeaders,
      body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
    });
    expect(notification.status).toBe(202);

    const listed = await mcpCall(server.url, sessionHeaders, 2, 'tools/list');
    expect(listed.result.tools).toEqual([
      expect.objectContaining({
        name: 'system.inspectMemory',
        annotations: expect.objectContaining({ readOnlyHint: true }),
      }),
      expect.objectContaining({
        name: 'terminal.exec',
        annotations: expect.objectContaining({ readOnlyHint: false }),
      }),
    ]);

    const read = await mcpCall(server.url, sessionHeaders, 3, 'tools/call', {
      name: 'system.inspectMemory',
      arguments: {},
    });
    expect(read.result).toMatchObject({
      isError: false,
      structuredContent: { state: 'succeeded', result: { freeBytes: 42 } },
    });

    const mutation = await mcpCall(server.url, sessionHeaders, 4, 'tools/call', {
      name: 'terminal.exec',
      arguments: {
        terminalId: '00000000-0000-4000-8000-000000000116',
        command: 'printf ready',
      },
    });
    expect(mutation.result).toMatchObject({
      isError: false,
      structuredContent: {
        state: 'waiting_approval',
        approvalId: '00000000-0000-4000-8000-000000000113',
      },
    });
    expect(callTool).toHaveBeenCalledTimes(2);

    const stream = await fetch(server.url, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: 'text/event-stream',
        'Mcp-Session-Id': sessionId!,
      },
    });
    expect(stream.status).toBe(200);
    const reader = stream.body!.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toContain('connected');
    await reader.cancel();

    const deleted = await fetch(server.url, {
      method: 'DELETE',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Mcp-Session-Id': sessionId!,
      },
    });
    expect(deleted.status).toBe(204);
    expect(server.status().activeSessions).toBe(0);
  });

  it('rejects invalid lifecycle, protocol and disabled tools without executing them', async () => {
    const gateway: McpToolGateway = {
      listTools: () => [
        {
          name: 'system.inspectDisk',
          title: 'Inspect disk',
          description: 'Read disks.',
          inputSchema: { type: 'object' },
          risk: 'read_only',
        },
      ],
      callTool: vi.fn(),
    };
    server = await new NodeMcpServer().start({
      host: '127.0.0.1',
      port: 0,
      apiKey,
      enabledTools: ['system.inspectDisk'],
      gateway,
    });
    const initialized = await fetch(server.url, {
      method: 'POST',
      headers: postHeaders,
      body: rpc(1, 'initialize', { protocolVersion: '2099-01-01' }),
    });
    const sessionId = initialized.headers.get('mcp-session-id')!;
    expect(await initialized.json()).toMatchObject({
      result: { protocolVersion: '2025-11-25' },
    });
    const uninitialized = await mcpCall(
      server.url,
      { ...postHeaders, 'Mcp-Session-Id': sessionId },
      2,
      'tools/list',
    );
    expect(uninitialized.error.code).toBe(-32_002);
    const wrongProtocol = await mcpCall(
      server.url,
      {
        ...postHeaders,
        'Mcp-Session-Id': sessionId,
        'MCP-Protocol-Version': '2025-06-18',
      },
      3,
      'ping',
    );
    expect(wrongProtocol.error.code).toBe(-32_600);
  });
});

function rpc(id: number, method: string, params?: Record<string, unknown>): string {
  return JSON.stringify({ jsonrpc: '2.0', id, method, ...(params ? { params } : {}) });
}

async function mcpCall(
  url: string,
  headers: Record<string, string>,
  id: number,
  method: string,
  params?: Record<string, unknown>,
) {
  const response = await fetch(url, { method: 'POST', headers, body: rpc(id, method, params) });
  expect(response.status).toBe(200);
  return response.json() as Promise<TestMcpResponse>;
}

interface TestMcpResponse {
  result: {
    tools: Array<{ name: string }>;
    isError: boolean;
    structuredContent: Record<string, unknown>;
  };
  error: { code: number; message: string };
}
