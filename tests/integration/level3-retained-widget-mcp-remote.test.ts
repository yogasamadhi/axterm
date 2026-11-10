import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import automationRemote from '../../packages/plugins/automation/lib/typert.remote-client.js';
import terminalsRemote from '../../packages/plugins/terminals/lib/typert.remote-client.js';
import { WidgetModel } from '../../packages/plugins/automation/src/client/widgets.ts';
import { aiRemoteProfile } from '../fixtures/level3-ai-remote-profile.ts';
import { remoteValue } from '../fixtures/level3-remote-profile.ts';
const profiles: Awaited<ReturnType<typeof aiRemoteProfile>>[] = [],
  homes: string[] = [];
afterEach(async () => {
  for (const f of profiles.splice(0).reverse()) await f.close();
  for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true });
});
async function fixture(home: string) {
  const f = await aiRemoteProfile(home);
  profiles.push(f);
  for (const descriptor of [automationRemote, terminalsRemote]) {
    const off = await f.client.remote.$mount(descriptor);
    f.client.effect(() => off);
  }
  const widgets = new WidgetModel(f.client);
  f.client.effect(() => () => widgets.dispose());
  await vi.waitFor(() => expect(widgets.getSnapshot().status).toBe('ready'));
  return { ...f, widgets };
}
type McpResponse = {
  result: {
    tools: { name: string }[];
    isError?: boolean;
    structuredContent: { state: string; runId: string; approvalId?: string; argsHash?: string };
  };
};
it('retains actual authenticated MCP, persisted approval, PTY execution, owned Vault cleanup and empty widgets after Profile restart', async () => {
  const home = await mkdtemp(join(tmpdir(), 'axterm-widget-mcp-remote-'));
  homes.push(home);
  let f = await fixture(home);
  const generation = f.widgets.generation(),
    commandId = randomUUID(),
    apiKey = 'runtime-mcp-api-key-1234567890';
  const credential = await remoteValue(
    f.client.remote.configuration.createCredential(commandId, generation, {
      kind: 'mcpApiKey',
      label: 'Runtime MCP',
      secret: apiKey,
    }),
  );
  if (credential.status !== 'completed') throw Error('Credential outcome unavailable');
  const instance = await f.widgets.startMcp({
    credentialRef: credential.ref,
    ownedCredential: { generation, commandId },
    port: 0,
    enabledTools: ['system.inspectMemory', 'terminal.exec'],
  });
  const url = instance.serverInfo!.url;
  expect(url).not.toContain(apiKey);
  const headers: Record<string, string> = {
    Authorization: `Bearer ${apiKey}`,
    Accept: 'application/json, text/event-stream',
    'Content-Type': 'application/json',
  };
  const init = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        clientInfo: { name: 'Axterm retained runtime', version: '1.0.0' },
        capabilities: {},
      },
    }),
  });
  expect(init.status).toBe(200);
  const sessionId = init.headers.get('mcp-session-id')!;
  expect(sessionId).toBeTruthy();
  expect(await init.json()).toMatchObject({ result: { protocolVersion: '2025-06-18' } });
  headers['Mcp-Session-Id'] = sessionId;
  headers['MCP-Protocol-Version'] = '2025-06-18';
  expect(
    (
      await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
      })
    ).status,
  ).toBe(202);
  async function post(id: number, method: string, params?: Record<string, unknown>) {
    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({ jsonrpc: '2.0', id, method, ...(params ? { params } : {}) }),
    });
    expect(response.status).toBe(200);
    return response.json() as Promise<McpResponse>;
  }
  const listed = await post(2, 'tools/list');
  expect(listed.result.tools.map((tool) => tool.name)).toEqual([
    'system.inspectMemory',
    'terminal.exec',
  ]);
  const memory = await post(3, 'tools/call', { name: 'system.inspectMemory', arguments: {} });
  expect(memory.result).toMatchObject({
    isError: false,
    structuredContent: { state: 'succeeded' },
  });
  const terminal = await remoteValue(
    f.client.remote.terminals.createTerminal(
      generation,
      randomUUID(),
      { kind: 'local', cols: 80, rows: 24 },
      new AbortController().signal,
    ),
  );
  const mutation = await post(4, 'tools/call', {
    name: 'terminal.exec',
    arguments: { terminalId: terminal.id, command: 'printf mcp-runtime' },
  });
  expect(mutation.result.structuredContent).toMatchObject({
    state: 'waiting_approval',
    approvalId: expect.any(String),
    argsHash: expect.any(String),
  });
  await vi.waitFor(() => {
    const state = f.model.getSnapshot();
    expect(
      state.status === 'ready' &&
        state.baseline.approvals.some(
          (approval) => approval.id === mutation.result.structuredContent.approvalId,
        ),
    ).toBe(true);
  });
  const state = f.model.getSnapshot();
  if (state.status !== 'ready') throw Error('AI baseline unavailable');
  const approval = state.baseline.approvals.find(
    (approval) => approval.id === mutation.result.structuredContent.approvalId,
  )!;
  const completed = await f.model.decideApproval(randomUUID(), approval.id, {
    decision: 'approve_once',
    argsHash: approval.argsHash,
  });
  expect(completed.state).toBe('succeeded');
  expect((await f.model.getRun(approval.runId)).state).toBe('succeeded');
  await vi.waitFor(() => {
    const state = f.widgets.getSnapshot();
    expect(
      state.status === 'ready' &&
        state.baseline.instances.find((row) => row.id === instance.id)?.serverInfo,
    ).toMatchObject({ activeSessions: 1, toolCount: 2, authentication: 'bearer' });
  });
  const renamed = await f.widgets.rename(instance.id, { title: 'Renamed fixture' });
  expect(renamed.title).toBe('Renamed fixture');
  await f.widgets.stop(instance.id);
  expect(
    (await remoteValue(f.client.remote.configuration.listCredentials())).some(
      (row) => row.ref === credential.ref,
    ),
  ).toBe(false);
  await expect(fetch(url)).rejects.toThrow();
  await remoteValue(f.client.remote.terminals.closeTerminal(generation, terminal.id));
  await f.close();
  f = await fixture(home);
  expect(f.widgets.generation()).not.toBe(generation);
  const next = f.widgets.getSnapshot();
  if (next.status !== 'ready') throw Error('Widget baseline unavailable');
  expect(next.baseline.instances).toEqual([]);
  expect(JSON.stringify(next)).not.toContain(apiKey);
  expect((await f.model.getRun(approval.runId)).state).toBe('succeeded');
}, 20000);
