import { randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createRuntimeClient } from '../../packages/client/src/api-client';
import { startRuntime } from '../../packages/runtime/src/bootstrap/runtime';

const closers: Array<() => Promise<void>> = [];
const directories: string[] = [];

afterEach(async () => {
  await Promise.allSettled(closers.splice(0).map((close) => close()));
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe('Widget Runtime REST lifecycle', () => {
  it('starts, renames and stops a scoped server, then leaves no instance after restart', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'axterm-widget-runtime-'));
    directories.push(directory);
    await writeFile(join(directory, 'index.html'), 'widget-generation');
    const hostToken = `host-${randomUUID()}-${randomUUID()}`;
    const hostServer = createServer((request, response) => {
      const expected = Buffer.from(`Bearer ${hostToken}`);
      const actual = Buffer.from(request.headers.authorization ?? '');
      const authorized = expected.length === actual.length && timingSafeEqual(expected, actual);
      if (
        !authorized ||
        request.method !== 'POST' ||
        request.url !== '/host/v1/grants/grant_widget/resolve'
      ) {
        response.writeHead(authorized ? 404 : 401).end();
        return;
      }
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(
        JSON.stringify({
          grantId: 'grant_widget',
          kind: 'directory',
          name: 'Widget Fixture',
          permissions: ['read', 'write'],
          createdAt: new Date().toISOString(),
          path: directory,
        }),
      );
    });
    await new Promise<void>((resolve) => hostServer.listen(0, '127.0.0.1', resolve));
    const address = hostServer.address();
    if (!address || typeof address === 'string') throw new Error('Host fixture did not bind');
    closers.push(() => new Promise<void>((resolve) => hostServer.close(() => resolve())));

    let runtime = await startRuntime({
      generation: randomUUID(),
      appVersion: '0.10.0',
      mode: 'headless',
      hostCapabilityUrl: `http://127.0.0.1:${address.port}`,
      hostCapabilityToken: hostToken,
    });
    closers.push(runtime.close);
    const client = createRuntimeClient({ resolve: async () => runtime.bootstrap() });
    const instance = await client.startLocalFileServerWidget({
      grantId: 'grant_widget',
      title: 'Runtime fixture',
      port: 0,
    });
    expect(await (await fetch(instance.serverInfo!.url)).text()).toBe('widget-generation');
    expect(await client.widgetInstances()).toHaveLength(1);
    expect(
      (await client.renameWidgetInstance(instance.id, { title: 'Renamed fixture' })).title,
    ).toBe('Renamed fixture');

    await runtime.close();
    await expect(fetch(instance.serverInfo!.url)).rejects.toThrow();
    runtime = await startRuntime({
      generation: randomUUID(),
      appVersion: '0.10.0',
      mode: 'headless',
      hostCapabilityUrl: `http://127.0.0.1:${address.port}`,
      hostCapabilityToken: hostToken,
    });
    closers.push(runtime.close);
    await expect(client.widgetInstances()).rejects.toMatchObject({ code: 'RUNTIME_UNAVAILABLE' });
    expect(await client.widgetInstances()).toEqual([]);
    client.dispose();
  });

  it('exposes the Runtime tool registry through authenticated MCP and persisted approval', async () => {
    const hostToken = `host-${randomUUID()}-${randomUUID()}`;
    const credentials = new Map<string, string>();
    let deletedCredential = '';
    const hostServer = createServer((request, response) => {
      if (request.headers.authorization !== `Bearer ${hostToken}`) {
        response.writeHead(401).end();
        return;
      }
      if (request.method === 'POST' && request.url === '/host/v1/credentials') {
        let body = '';
        request.setEncoding('utf8');
        request.on('data', (chunk) => (body += String(chunk)));
        request.on('end', () => {
          const input = JSON.parse(body) as { kind: string; label: string; secret: string };
          credentials.set('cred_mcp_runtime', input.secret);
          const now = new Date().toISOString();
          response.writeHead(201, { 'Content-Type': 'application/json' });
          response.end(
            JSON.stringify({
              ref: 'cred_mcp_runtime',
              kind: input.kind,
              label: input.label,
              createdAt: now,
              updatedAt: now,
              storage: 'local',
            }),
          );
        });
        return;
      }
      if (
        request.method === 'POST' &&
        request.url === '/host/v1/credentials/cred_mcp_runtime/resolve'
      ) {
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ secret: credentials.get('cred_mcp_runtime') }));
        return;
      }
      if (request.method === 'DELETE' && request.url === '/host/v1/credentials/cred_mcp_runtime') {
        deletedCredential = 'cred_mcp_runtime';
        credentials.delete('cred_mcp_runtime');
        response.writeHead(204).end();
        return;
      }
      response.writeHead(404).end();
    });
    await new Promise<void>((resolve) => hostServer.listen(0, '127.0.0.1', resolve));
    const address = hostServer.address();
    if (!address || typeof address === 'string') throw new Error('Host fixture did not bind');
    closers.push(
      () =>
        new Promise<void>((resolve) => {
          hostServer.closeAllConnections();
          hostServer.close(() => resolve());
        }),
    );
    const runtime = await startRuntime({
      generation: randomUUID(),
      appVersion: '0.10.0',
      mode: 'headless',
      hostCapabilityUrl: `http://127.0.0.1:${address.port}`,
      hostCapabilityToken: hostToken,
    });
    closers.push(runtime.close);
    const client = createRuntimeClient({ resolve: async () => runtime.bootstrap() });
    const apiKey = 'runtime-mcp-api-key-1234567890';
    const credential = await client.createCredential({
      kind: 'mcpApiKey',
      label: 'Runtime MCP',
      secret: apiKey,
    });
    const instance = await client.startMcpServerWidget({
      credentialRef: credential.ref,
      port: 0,
      enabledTools: ['system.inspectMemory', 'terminal.exec'],
    });
    const initialized = await fetch(instance.serverInfo!.url, {
      method: 'POST',
      headers: mcpHeaders(apiKey),
      body: mcpRequest(1, 'initialize', { protocolVersion: '2025-06-18' }),
    });
    const sessionId = initialized.headers.get('mcp-session-id')!;
    expect(sessionId).toBeTruthy();
    expect(await initialized.json()).toMatchObject({
      result: { protocolVersion: '2025-06-18' },
    });
    const headers = {
      ...mcpHeaders(apiKey),
      'Mcp-Session-Id': sessionId,
      'MCP-Protocol-Version': '2025-06-18',
    };
    expect(
      (
        await fetch(instance.serverInfo!.url, {
          method: 'POST',
          headers,
          body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
        })
      ).status,
    ).toBe(202);
    const listed = await mcpPost(instance.serverInfo!.url, headers, 2, 'tools/list');
    expect(listed.result.tools.map((tool: { name: string }) => tool.name)).toEqual([
      'system.inspectMemory',
      'terminal.exec',
    ]);
    const memory = await mcpPost(instance.serverInfo!.url, headers, 3, 'tools/call', {
      name: 'system.inspectMemory',
      arguments: {},
    });
    expect(memory.result).toMatchObject({
      isError: false,
      structuredContent: { state: 'succeeded' },
    });
    const terminal = await client.createTerminal({ kind: 'local', cols: 80, rows: 24 });
    const mutation = await mcpPost(instance.serverInfo!.url, headers, 4, 'tools/call', {
      name: 'terminal.exec',
      arguments: { terminalId: terminal.id, command: 'printf mcp-runtime' },
    });
    expect(mutation.result.structuredContent).toMatchObject({
      state: 'waiting_approval',
      approvalId: expect.any(String),
      argsHash: expect.any(String),
    });
    const approval = (await client.aiApprovals()).find(
      ({ id }) => id === mutation.result.structuredContent.approvalId,
    )!;
    await client.decideApproval(approval.id, 'approve_once', approval.argsHash);
    expect((await client.aiRun(approval.runId)).state).toBe('succeeded');
    expect((await client.widgetInstance(instance.id)).serverInfo).toMatchObject({
      activeSessions: 1,
      toolCount: 2,
      authentication: 'bearer',
    });
    await client.stopWidgetInstance(instance.id);
    expect(deletedCredential).toBe('cred_mcp_runtime');
    await expect(fetch(instance.serverInfo!.url)).rejects.toThrow();
    client.dispose();
    await runtime.close();
  });
});

function mcpHeaders(apiKey: string) {
  return {
    Authorization: `Bearer ${apiKey}`,
    Accept: 'application/json, text/event-stream',
    'Content-Type': 'application/json',
  };
}

function mcpRequest(id: number, method: string, params?: Record<string, unknown>): string {
  return JSON.stringify({ jsonrpc: '2.0', id, method, ...(params ? { params } : {}) });
}

async function mcpPost(
  url: string,
  headers: Record<string, string>,
  id: number,
  method: string,
  params?: Record<string, unknown>,
) {
  const response = await fetch(url, {
    method: 'POST',
    headers,
    body: mcpRequest(id, method, params),
  });
  expect(response.status).toBe(200);
  return response.json() as Promise<TestMcpResponse>;
}

interface TestMcpResponse {
  result: {
    tools: Array<{ name: string }>;
    isError: boolean;
    structuredContent: {
      state: string;
      approvalId?: string;
      argsHash?: string;
    };
  };
}
