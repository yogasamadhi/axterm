import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, mkdtemp, rename, rm, stat, writeFile } from 'node:fs/promises';
import { createServer, type Server, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import WebSocket from 'ws';
import { afterAll, describe, expect, it } from 'vitest';
import { bootstrapResponseSchema } from '../../packages/contracts/src/index';
import { createRuntimeClient } from '../../packages/client/src/api-client';
import { startRuntime } from '../../packages/runtime/src/bootstrap/runtime';

const fixturePort = Number(process.env.AXTERM_SSH_FIXTURE_PORT ?? 0);
const durationMs = Number(process.env.AXTERM_SOAK_DURATION_MS ?? 60_000);
const cycleIntervalMs = Number(process.env.AXTERM_SOAK_CYCLE_INTERVAL_MS ?? 1_000);
const resultPath =
  process.env.AXTERM_SOAK_RESULT ?? join(process.cwd(), 'test-results/phase21-soak/latest.json');
const certificationDurationMs = 30 * 60 * 1_000;
const sampleIntervalMs = durationMs >= certificationDurationMs ? 60_000 : 5_000;

const ceilings = {
  rssGrowthBytes: 256 * 1024 * 1024,
  heapGrowthBytes: 128 * 1024 * 1024,
  databaseGrowthBytes: 128 * 1024 * 1024,
  eventLoopP99Ms: 500,
  operationP95Ms: 8_000,
} as const;

const temporaryDirectories: string[] = [];
const servers: Server[] = [];
const runtimes: Awaited<ReturnType<typeof startRuntime>>[] = [];

afterAll(async () => {
  await Promise.allSettled(runtimes.splice(0).map((runtime) => runtime.close()));
  await Promise.allSettled(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        }),
    ),
  );
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe.skipIf(!fixturePort)('Phase 21 mixed-workload soak', () => {
  it('keeps terminal, SSH, SFTP, transfer, tunnel, Widget, MCP and SSE resources bounded', async () => {
    if (
      !Number.isSafeInteger(durationMs) ||
      durationMs < 10_000 ||
      durationMs > certificationDurationMs
    )
      throw new Error('AXTERM_SOAK_DURATION_MS must be between 10000 and 1800000');
    if (!Number.isSafeInteger(cycleIntervalMs) || cycleIntervalMs < 100 || cycleIntervalMs > 60_000)
      throw new Error('AXTERM_SOAK_CYCLE_INTERVAL_MS must be between 100 and 60000');

    const startedAt = new Date().toISOString();
    const workDirectory = await mkdtemp(join(tmpdir(), 'axterm-phase21-soak-'));
    temporaryDirectories.push(workDirectory);
    const dataDirectory = join(workDirectory, 'runtime');
    const widgetDirectory = join(workDirectory, 'widget');
    const uploadPath = join(workDirectory, 'soak-upload.txt');
    await mkdir(widgetDirectory, { recursive: true });
    await writeFile(join(widgetDirectory, 'index.html'), 'phase21-soak-widget');
    await writeFile(uploadPath, 'phase21-soak-transfer\n'.repeat(1_024));

    const capability = await startHostCapability(widgetDirectory, uploadPath);
    const runtime = await startRuntime({
      generation: randomUUID(),
      appVersion: '0.10.0',
      mode: 'headless',
      dataDirectory,
      hostCapabilityUrl: capability.url,
      hostCapabilityToken: capability.token,
    });
    runtimes.push(runtime);
    const client = createRuntimeClient({ resolve: async () => runtime.bootstrap() });
    await client.status();

    const host = await client.createHost({
      name: 'phase21-soak-openssh',
      hostname: '127.0.0.1',
      port: fixturePort,
      username: 'fixture',
      groupId: null,
      authType: 'password',
      credentialRef: 'cred_soak_ssh',
      passphraseCredentialRef: null,
      jumpHostId: null,
      favorite: false,
      connectionOptions: {
        connectionTimeoutMs: 20_000,
        keepaliveIntervalMs: 1_000,
        keepaliveCountMax: 3,
        compression: false,
        reconnectPolicy: { mode: 'manual', delayMs: 3_000, maxAttempts: 3 },
      },
    });
    const connection = await client.createConnection(host.id);
    await waitUntil(async () => {
      for (const interaction of await client.interactions())
        if (interaction.kind === 'unknownHostKey')
          await client.respondInteraction(interaction.id, { accepted: true, remember: true });
      return (await client.connections()).find(({ id }) => id === connection.id)?.state === 'ready';
    }, 30_000);

    const mcp = await client.startMcpServerWidget({
      title: 'Phase 21 soak MCP',
      credentialRef: 'cred_soak_mcp',
      port: 0,
      enabledTools: ['system.inspectMemory'],
    });
    const mcpSession = await initializeMcp(mcp.serverInfo!.url, capability.mcpApiKey);

    const persistentTerminal = await client.createTerminal({
      kind: 'ssh',
      connectionId: connection.id,
      cols: 80,
      rows: 24,
    });
    await client.terminalInformation(persistentTerminal.id);
    const socketToken = await login(runtime);
    const terminalSocket = await openTerminalSocket(runtime, persistentTerminal.id, socketToken);
    client.reconnect();

    const realtimeAbort = new AbortController();
    const realtimeToken = await login(runtime);
    const realtimeResponse = await fetch(`${runtime.baseUrl}/api/v1/events/realtime`, {
      headers: authHeaders(runtime, realtimeToken),
      signal: realtimeAbort.signal,
    });
    if (!realtimeResponse.ok || !realtimeResponse.body)
      throw new Error(`Realtime SSE failed with ${realtimeResponse.status}`);
    const realtimeDrain = drain(realtimeResponse.body, realtimeAbort.signal).catch(() => undefined);
    client.reconnect();

    const histogram = monitorEventLoopDelay({ resolution: 20 });
    histogram.enable();
    const latencies: number[] = [];
    const resourcePeaks: Record<string, number> = {};
    const samples: SoakSample[] = [];
    const counters = {
      cycles: 0,
      terminalRoundTrips: 0,
      sftpLists: 0,
      transfers: 0,
      tunnels: 0,
      widgets: 0,
      mcpCalls: 0,
    };
    let lastSampleAt = 0;
    let baseline: SoakSample | undefined;
    let finalSample: SoakSample | undefined;

    const save = async (state: 'running' | 'passed' | 'failed', error?: unknown) => {
      const operationP95Ms = percentile(latencies, 0.95);
      const eventLoopP99Ms = histogram.percentile(99) / 1_000_000;
      const latest = finalSample ?? samples.at(-1) ?? baseline;
      const rssPeakBytes = Math.max(
        ...samples.map(({ rssBytes }) => rssBytes),
        baseline?.rssBytes ?? 0,
      );
      const heapPeakBytes = Math.max(
        ...samples.map(({ heapUsedBytes }) => heapUsedBytes),
        baseline?.heapUsedBytes ?? 0,
      );
      const databasePeakBytes = Math.max(
        ...samples.map(({ databaseBytes }) => databaseBytes),
        baseline?.databaseBytes ?? 0,
      );
      const rssGrowthBytes = baseline ? Math.max(0, rssPeakBytes - baseline.rssBytes) : 0;
      const heapGrowthBytes = baseline ? Math.max(0, heapPeakBytes - baseline.heapUsedBytes) : 0;
      const databaseGrowthBytes = baseline
        ? Math.max(0, databasePeakBytes - baseline.databaseBytes)
        : 0;
      const violations = [
        ...(rssGrowthBytes > ceilings.rssGrowthBytes ? ['rssGrowthBytes'] : []),
        ...(heapGrowthBytes > ceilings.heapGrowthBytes ? ['heapGrowthBytes'] : []),
        ...(databaseGrowthBytes > ceilings.databaseGrowthBytes ? ['databaseGrowthBytes'] : []),
        ...(eventLoopP99Ms > ceilings.eventLoopP99Ms ? ['eventLoopP99Ms'] : []),
        ...(operationP95Ms > ceilings.operationP95Ms ? ['operationP95Ms'] : []),
      ];
      await writeJsonAtomic(resultPath, {
        schemaVersion: 1,
        state,
        evidenceKind: durationMs === certificationDurationMs ? '30-minute-certification' : 'smoke',
        environment: {
          platform: process.platform,
          architecture: process.arch,
          node: process.version,
          appVersion: '0.10.0',
        },
        startedAt,
        finishedAt: state === 'running' ? null : new Date().toISOString(),
        targetDurationMs: durationMs,
        cycleIntervalMs,
        elapsedMs: baseline ? Date.now() - Date.parse(baseline.at) : 0,
        counters,
        ceilings,
        measurements: {
          baseline,
          latest,
          samples,
          resourcePeaks,
          rssPeakBytes,
          heapPeakBytes,
          databasePeakBytes,
          rssGrowthBytes,
          heapGrowthBytes,
          databaseGrowthBytes,
          eventLoopP99Ms,
          operationP95Ms,
        },
        violations,
        error: error instanceof Error ? { name: error.name, message: error.message } : undefined,
      });
      return violations;
    };

    try {
      await runCycle(0, false);
      forceGarbageCollection();
      baseline = await takeSample(client, dataDirectory, resourcePeaks);
      samples.push(baseline);
      await save('running');
      const deadline = Date.now() + durationMs;
      let cycle = 1;
      while (Date.now() < deadline) {
        const cycleStarted = performance.now();
        await runCycle(cycle, true);
        const cycleElapsedMs = performance.now() - cycleStarted;
        latencies.push(cycleElapsedMs);
        counters.cycles += 1;
        if (Date.now() - lastSampleAt >= sampleIntervalMs) {
          forceGarbageCollection();
          finalSample = await takeSample(client, dataDirectory, resourcePeaks);
          samples.push(finalSample);
          lastSampleAt = Date.now();
          await save('running');
        }
        await delay(Math.max(0, cycleIntervalMs - cycleElapsedMs));
        cycle += 1;
      }

      await client.stopWidgetInstance(mcp.id);
      realtimeAbort.abort();
      await realtimeDrain;
      terminalSocket.close();
      await client.closeTerminal(persistentTerminal.id);
      await client.closeConnection(connection.id);
      await waitUntil(async () => {
        const resources = (await client.diagnostics()).resources;
        return Object.entries(resources).every(
          ([name, count]) => count === 0 || (name === 'desktopLifecycle' && count <= 1),
        );
      }, 10_000);
      forceGarbageCollection();
      finalSample = await takeSample(client, dataDirectory, resourcePeaks);
      samples.push(finalSample);
      const violations = await save('running');
      if (violations.length) throw new Error(`Long-run budget exceeded: ${violations.join(', ')}`);
      await save('passed');
      expect(counters.cycles).toBeGreaterThan(0);
      expect(finalSample.resources).toMatchObject({
        terminals: 0,
        connections: 0,
        transfers: 0,
        tunnels: 0,
        widgetInstances: 0,
        realtimeSubscribers: 0,
      });
    } catch (error) {
      await save('failed', error);
      throw error;
    } finally {
      histogram.disable();
      realtimeAbort.abort();
      terminalSocket.close();
      client.dispose();
    }

    async function runCycle(cycle: number, countWork: boolean) {
      let localTerminalId: string | undefined;
      let widgetId: string | undefined;
      let tunnelId: string | undefined;
      let remotePath: string | undefined;
      try {
        const localTerminal = await client.createTerminal({ kind: 'local', cols: 80, rows: 24 });
        localTerminalId = localTerminal.id;
        await client.terminalInformation(persistentTerminal.id);

        const marker = `PHASE21_SOAK_${cycle}_${randomUUID().slice(0, 8)}`;
        await terminalRoundTrip(terminalSocket, marker);
        if (countWork) counters.terminalRoundTrips += 1;

        await client.remoteFiles(connection.id, '/config');
        if (countWork) counters.sftpLists += 1;

        const widget = await client.startLocalFileServerWidget({
          grantId: 'grant_soak_widget',
          title: `Phase 21 file server ${cycle}`,
          port: 0,
        });
        widgetId = widget.id;
        const widgetResponse = await fetch(widget.serverInfo!.url);
        if ((await widgetResponse.text()) !== 'phase21-soak-widget')
          throw new Error('Local file server returned unexpected content');
        await client.stopWidgetInstance(widget.id);
        widgetId = undefined;
        if (countWork) counters.widgets += 1;

        if (cycle % 2 === 0) {
          remotePath = `/config/phase21-soak-${cycle}.txt`;
          const transfer = await client.createTransfer(connection.id, 'upload', {
            grantId: 'grant_soak_upload',
            remotePath,
            recursive: false,
            conflict: 'overwrite',
          });
          await waitUntil(async () => {
            const state = (await client.transfers()).find(({ id }) => id === transfer.id)?.state;
            if (state === 'failed' || state === 'canceled')
              throw new Error(`Transfer ended in ${state}`);
            return state === 'succeeded';
          }, 15_000);
          await client.deleteRemotePath(connection.id, remotePath);
          remotePath = undefined;
          await client.clearCompletedTransfers();
          if (countWork) counters.transfers += 1;
        }

        if (cycle % 3 === 0) {
          const tunnel = await client.startTunnel({
            connectionId: connection.id,
            profile: {
              name: `Phase 21 dynamic ${cycle}`,
              hostId: host.id,
              type: 'dynamic',
              bindHost: '127.0.0.1',
              bindPort: 0,
              targetHost: null,
              targetPort: null,
              allowNonLoopback: false,
            },
          });
          tunnelId = tunnel.id;
          await client.stopTunnel(tunnel.id);
          tunnelId = undefined;
          if (countWork) counters.tunnels += 1;
        }

        if (cycle % 5 === 0) {
          await callMcpMemory(mcp.serverInfo!.url, mcpSession, capability.mcpApiKey, cycle);
          if (countWork) counters.mcpCalls += 1;
        }
      } finally {
        if (tunnelId) await client.stopTunnel(tunnelId).catch(() => undefined);
        if (widgetId) await client.stopWidgetInstance(widgetId).catch(() => undefined);
        if (remotePath)
          await client.deleteRemotePath(connection.id, remotePath).catch(() => undefined);
        if (localTerminalId) await client.closeTerminal(localTerminalId).catch(() => undefined);
      }

      const resources = (await client.diagnostics()).resources;
      assertResourceCeilings(resources);
    }
  });
});

interface SoakSample {
  at: string;
  rssBytes: number;
  heapUsedBytes: number;
  externalBytes: number;
  arrayBuffersBytes: number;
  databaseBytes: number;
  resources: Record<string, number>;
}

async function startHostCapability(widgetPath: string, uploadPath: string) {
  const token = randomUUID();
  const mcpApiKey = `phase21-soak-${randomUUID()}-${randomUUID()}`;
  const credentials = new Map([
    ['cred_soak_ssh', 'axterm-fixture-password'],
    ['cred_soak_mcp', mcpApiKey],
  ]);
  const grants = new Map([
    [
      'grant_soak_widget',
      {
        kind: 'directory' as const,
        name: 'Phase 21 Widget',
        path: widgetPath,
        permissions: ['read', 'write'],
      },
    ],
    [
      'grant_soak_upload',
      { kind: 'file' as const, name: 'soak-upload.txt', path: uploadPath, permissions: ['read'] },
    ],
  ]);
  const server = createServer((request, response) => {
    if (request.headers.authorization !== `Bearer ${token}`) return response.writeHead(401).end();
    if (request.method === 'GET' && request.url === '/host/v1/updater/status')
      return sendJson(response, { state: 'disabled' });
    if (request.method === 'GET' && request.url === '/host/v1/desktop/lifecycle')
      return sendJson(response, {
        revision: 0,
        state: 'active',
        lastEvent: 'started',
        changedAt: new Date().toISOString(),
      });
    const credentialMatch = /^\/host\/v1\/credentials\/([^/]+)\/resolve$/u.exec(request.url ?? '');
    if (request.method === 'POST' && credentialMatch?.[1] && credentials.has(credentialMatch[1]))
      return sendJson(response, { secret: credentials.get(credentialMatch[1]) });
    const credentialDelete = /^\/host\/v1\/credentials\/([^/]+)$/u.exec(request.url ?? '');
    if (request.method === 'DELETE' && credentialDelete?.[1]) {
      credentials.delete(credentialDelete[1]);
      return response.writeHead(204).end();
    }
    const grantMatch = /^\/host\/v1\/grants\/([^/]+)\/resolve$/u.exec(request.url ?? '');
    const grant = grantMatch?.[1] ? grants.get(grantMatch[1]) : undefined;
    if (request.method === 'POST' && grantMatch?.[1] && grant)
      return sendJson(response, {
        grantId: grantMatch[1],
        kind: grant.kind,
        name: grant.name,
        permissions: grant.permissions,
        createdAt: new Date().toISOString(),
        path: grant.path,
      });
    response.writeHead(404).end();
  });
  servers.push(server);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('Host capability fixture did not bind');
  return { url: `http://127.0.0.1:${address.port}`, token, mcpApiKey };
}

function sendJson(response: ServerResponse, value: unknown) {
  response.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify(value));
}

async function login(runtime: Awaited<ReturnType<typeof startRuntime>>) {
  const response = await fetch(`${runtime.baseUrl}/api/v1/auth/bootstrap`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ bootstrapToken: runtime.bootstrap().bootstrapToken }),
  });
  if (!response.ok) throw new Error(`Runtime login failed with ${response.status}`);
  return bootstrapResponseSchema.parse(await response.json()).sessionToken;
}

function authHeaders(runtime: Awaited<ReturnType<typeof startRuntime>>, token: string) {
  return {
    Authorization: `Bearer ${token}`,
    'X-Runtime-Generation': runtime.metadata.generation,
  };
}

async function openTerminalSocket(
  runtime: Awaited<ReturnType<typeof startRuntime>>,
  terminalId: string,
  token: string,
) {
  const url = new URL(`/api/v1/terminals/${terminalId}/stream`, runtime.baseUrl);
  url.protocol = 'ws:';
  const socket = new WebSocket(
    url,
    ['terminal.v1', `terminal-client.${randomUUID()}`, `auth.${token}`],
    { origin: runtime.baseUrl },
  );
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Terminal WebSocket did not open')), 8_000);
    socket.once('open', () => {
      clearTimeout(timer);
      resolve();
    });
    socket.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
  return socket;
}

async function terminalRoundTrip(socket: WebSocket, marker: string) {
  await new Promise<void>((resolve, reject) => {
    let output = '';
    const timer = setTimeout(
      () => finish(new Error(`Terminal marker timed out: ${output.slice(-500)}`)),
      8_000,
    );
    const onMessage = (data: WebSocket.RawData, binary: boolean) => {
      if (!binary) return;
      output += Buffer.from(data as Buffer).toString('utf8');
      if (output.includes(marker)) finish();
    };
    const onError = (error: Error) => finish(error);
    const finish = (error?: Error) => {
      clearTimeout(timer);
      socket.off('message', onMessage);
      socket.off('error', onError);
      if (error) reject(error);
      else resolve();
    };
    socket.on('message', onMessage);
    socket.on('error', onError);
    socket.send(Buffer.from(`printf '\\n${marker}\\n'\n`), { binary: true }, (error) => {
      if (error) finish(error);
    });
  });
}

async function initializeMcp(url: string, apiKey: string) {
  const response = await fetch(url, {
    method: 'POST',
    headers: mcpHeaders(apiKey),
    body: mcpRequest(1, 'initialize', { protocolVersion: '2025-06-18' }),
  });
  if (!response.ok) throw new Error(`MCP initialize failed with ${response.status}`);
  await response.arrayBuffer();
  const sessionId = response.headers.get('mcp-session-id');
  if (!sessionId) throw new Error('MCP did not return a session id');
  const initialized = await fetch(url, {
    method: 'POST',
    headers: {
      ...mcpHeaders(apiKey),
      'Mcp-Session-Id': sessionId,
      'MCP-Protocol-Version': '2025-06-18',
    },
    body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
  });
  if (initialized.status !== 202)
    throw new Error(`MCP initialized notification failed with ${initialized.status}`);
  return sessionId;
}

async function callMcpMemory(url: string, sessionId: string, apiKey: string, id: number) {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      ...mcpHeaders(apiKey),
      'Mcp-Session-Id': sessionId,
      'MCP-Protocol-Version': '2025-06-18',
    },
    body: mcpRequest(id + 10, 'tools/call', { name: 'system.inspectMemory', arguments: {} }),
  });
  if (!response.ok) throw new Error(`MCP memory call failed with ${response.status}`);
  const payload = (await response.json()) as { result?: { isError?: boolean } };
  if (payload.result?.isError !== false)
    throw new Error(`MCP memory call returned an error: ${JSON.stringify(payload)}`);
}

function mcpHeaders(apiKey: string) {
  return {
    Authorization: `Bearer ${apiKey}`,
    Accept: 'application/json, text/event-stream',
    'Content-Type': 'application/json',
  };
}

function mcpRequest(id: number, method: string, params?: Record<string, unknown>) {
  return JSON.stringify({ jsonrpc: '2.0', id, method, ...(params ? { params } : {}) });
}

async function drain(stream: ReadableStream<Uint8Array>, signal: AbortSignal) {
  const reader = stream.getReader();
  try {
    while (!signal.aborted) {
      const result = await reader.read();
      if (result.done) return;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

async function takeSample(
  client: ReturnType<typeof createRuntimeClient>,
  dataDirectory: string,
  resourcePeaks: Record<string, number>,
): Promise<SoakSample> {
  const memory = process.memoryUsage();
  const resources = (await client.diagnostics()).resources;
  for (const [name, count] of Object.entries(resources))
    resourcePeaks[name] = Math.max(resourcePeaks[name] ?? 0, count);
  return {
    at: new Date().toISOString(),
    rssBytes: memory.rss,
    heapUsedBytes: memory.heapUsed,
    externalBytes: memory.external,
    arrayBuffersBytes: memory.arrayBuffers,
    databaseBytes: await databaseBytes(dataDirectory),
    resources,
  };
}

function assertResourceCeilings(resources: Record<string, number>) {
  const allowed = new Map<string, number>([
    ['terminals', 1],
    ['triggerSessions', 1],
    ['connections', 1],
    ['widgetInstances', 1],
    ['realtimeSubscribers', 1],
    ['terminalInformationCaches', 64],
    ['desktopLifecycle', 1],
  ]);
  const violations = Object.entries(resources).filter(
    ([name, count]) => count > (allowed.get(name) ?? 0),
  );
  if (violations.length)
    throw new Error(`Runtime resource ceiling exceeded: ${JSON.stringify(violations)}`);
}

async function databaseBytes(dataDirectory: string) {
  return (
    (await fileSize(join(dataDirectory, 'axterm.sqlite'))) +
    (await fileSize(join(dataDirectory, 'axterm.sqlite-wal'))) +
    (await fileSize(join(dataDirectory, 'axterm.sqlite-shm')))
  );
}

async function fileSize(path: string) {
  return stat(path).then(
    (value) => value.size,
    () => 0,
  );
}

function forceGarbageCollection() {
  globalThis.gc?.();
}

function percentile(values: number[], proportion: number) {
  if (!values.length) return 0;
  return values.toSorted((left, right) => left - right)[
    Math.min(values.length - 1, Math.floor(values.length * proportion))
  ]!;
}

async function waitUntil(predicate: () => Promise<boolean>, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      if (await predicate()) return;
    } catch (error) {
      lastError = error;
    }
    await delay(50);
  }
  throw lastError ?? new Error(`Condition did not become true within ${timeoutMs} ms`);
}

function delay(milliseconds: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}

async function writeJsonAtomic(path: string, value: unknown) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`);
  await rename(temporary, path);
}
