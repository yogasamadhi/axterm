import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rename, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import WebSocket from 'ws';
import { afterAll, describe, expect, it, vi } from 'vitest';
import type { CreateHostInput } from '@axterm/plugin-api/catalog';
import {
  TERMINAL_STREAM_PATH,
  TERMINAL_REPLAY_MAX_BYTES,
  terminalServerControlSchema,
} from '@axterm/plugin-api/terminals';
import type { ConnectionHandle } from '../../packages/infra/connection/src/client/index.ts';
import * as Connections from '../../packages/plugins/connections/src/client/index.ts';
import * as Terminals from '../../packages/plugins/terminals/src/client/index.ts';
import * as Transfers from '../../packages/plugins/transfers/src/client/index.ts';
import { WidgetModel } from '../../packages/plugins/automation/src/client/widgets.ts';
import fileRemote from '../../packages/plugins/files/lib/typert.remote-client.js';
import automationRemote from '../../packages/plugins/automation/lib/typert.remote-client.js';
import { TerminalInformationModel } from '../../packages/plugins/terminals/src/client/tools/information-model.ts';
import { TerminalOutputConsumer } from '../../packages/plugins/terminals/src/client/terminal-output-consumer.ts';
import { remoteProfile, remoteValue } from '../fixtures/level3-remote-profile.ts';
import { captureOwnedResourceWitness } from '../fixtures/level3-resource-witness.ts';
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
const profiles: Awaited<ReturnType<typeof remoteProfile>>[] = [];
const sockets = new Set<WebSocket>();

afterAll(async () => {
  for (const socket of sockets) socket.terminate();
  for (const f of profiles.splice(0).reverse()) await f.close();
  for (const path of temporaryDirectories.splice(0))
    await rm(path, { recursive: true, force: true });
});

describe.skipIf(!fixturePort)('Phase 21 mixed-workload soak', () => {
  it('keeps terminal, SSH, SFTP, transfer, tunnel, Widget, MCP and Remote resources bounded', async () => {
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
    const dataDirectory = join(workDirectory, 'data-v2');
    const widgetDirectory = join(workDirectory, 'workspace');
    const uploadPath = join(widgetDirectory, 'soak-upload.txt');
    await mkdir(widgetDirectory, { recursive: true });
    await writeFile(join(widgetDirectory, 'index.html'), 'phase21-soak-widget');
    await writeFile(uploadPath, 'phase21-soak-transfer\n'.repeat(1_024));

    const f = await remoteProfile(workDirectory, { application: true });
    profiles.push(f);
    await f.client.plugin(Connections);
    await f.client.plugin(Terminals);
    await f.client.plugin(Transfers);
    for (const descriptor of [fileRemote, automationRemote]) {
      const off = await f.client.remote.$mount(descriptor);
      f.client.effect(() => off);
    }
    const widgets = new WidgetModel(f.client);
    f.client.effect(() => () => widgets.dispose());
    await vi.waitFor(() => {
      expect(f.client.connectionsModel.getSnapshot().status).toBe('ready');
      expect(f.client.transfersModel.getSnapshot().status).toBe('ready');
      expect(f.client.terminalsModel.getSnapshot().status).toBe('ready');
      expect(widgets.getSnapshot().status).toBe('ready');
    });
    const connections = f.client.connectionsModel,
      transfers = f.client.transfersModel,
      generation = f.application.ctx.runtimeIdentity.generation;
    const carrier = f.client.get('connection') as unknown as ConnectionHandle;
    const resources = captureOwnedResourceWitness(f.application.ctx);
    const connectionFacts = () => {
      const state = connections.getSnapshot();
      if (state.status !== 'ready') throw Error('Connections baseline unavailable');
      return state.baseline;
    };
    const transferFacts = () => {
      const state = transfers.getSnapshot();
      if (state.status !== 'ready') throw Error('Transfers baseline unavailable');
      return state.baseline;
    };
    const createHost = async (input: CreateHostInput) => {
      const receipt = await remoteValue(f.client.remote.catalog.createHost(randomUUID(), input));
      return remoteValue(f.client.remote.catalog.getHost(receipt.ids[0]!));
    };
    const sshCredential = await remoteValue(
      f.client.remote.configuration.createCredential(randomUUID(), generation, {
        kind: 'sshPassword',
        label: 'OpenSSH soak',
        secret: 'axterm-fixture-password',
      }),
    );
    const mcpApiKey = 'SOAK_MCP_PRIVATE_KEY_CANARY_2026';
    const mcpCreationId = randomUUID();
    const mcpCredential = await remoteValue(
      f.client.remote.configuration.createCredential(mcpCreationId, generation, {
        kind: 'mcpApiKey',
        label: 'MCP soak',
        secret: mcpApiKey,
      }),
    );
    if (sshCredential.status !== 'completed' || mcpCredential.status !== 'completed')
      throw Error('Credential creation failed');
    const grant = await remoteValue(
      f.client.remote.files.createFileGrant({ kind: 'home-directory' }),
    );
    if (!grant) throw Error('Workspace grant unavailable');
    const grantId = grant.grantId;
    const localProfile = await f.client.terminalFactsModel.createTerminalProfile(randomUUID(), {
      name: 'Isolated soak PTY process',
      shell: process.execPath,
      shellArgs: ['-e', 'setInterval(() => {}, 1000)'],
      loginShell: false,
      cwd: workDirectory,
      env: { HOME: workDirectory, ZDOTDIR: workDirectory },
    });
    const localProfileId = localProfile.ids[0]!;
    const information = new TerminalInformationModel(f.client);
    f.client.effect(() => () => information.close());
    const sampleInformation = async (id: string) => {
      const stop = information.observe(id, generation);
      try {
        await vi.waitFor(() => expect(information.getSnapshot().status).toBe('ready'));
      } finally {
        stop();
      }
    };
    const host = await createHost({
      name: 'phase21-soak-openssh',
      hostname: '127.0.0.1',
      port: fixturePort,
      username: 'fixture',
      groupId: null,
      authType: 'password',
      credentialRef: sshCredential.ref,
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
    const connection = await connections.createConnection(randomUUID(), { hostId: host.id });
    await waitUntil(async () => {
      for (const interaction of await connectionFacts().interactions)
        if (interaction.kind === 'unknownHostKey')
          await connections.respondInteraction(interaction.id, { accepted: true, remember: true });
      return (
        (await connectionFacts().connections).find(({ id }) => id === connection.id)?.state ===
        'ready'
      );
    }, 30_000);

    const mcp = await widgets.startMcp({
      title: 'Phase 21 soak MCP',
      credentialRef: mcpCredential.ref,
      ownedCredential: { generation, commandId: mcpCreationId },
      port: 0,
      enabledTools: ['system.inspectMemory'],
    });
    const mcpSession = await initializeMcp(mcp.serverInfo!.url, mcpApiKey);

    const persistentTerminal = await f.client.terminalsModel.create({
      kind: 'ssh',
      connectionId: connection.id,
      cols: 80,
      rows: 24,
    });
    await sampleInformation(persistentTerminal.id);
    const terminalSocket = await openTerminalSocket(carrier, persistentTerminal.id);
    sockets.add(terminalSocket);
    // TransfersModel owns the separate real-time progress stream; metadata models own fact streams.
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
      baseline = await takeSample(resources, dataDirectory, resourcePeaks);
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
          finalSample = await takeSample(resources, dataDirectory, resourcePeaks);
          samples.push(finalSample);
          lastSampleAt = Date.now();
          await save('running');
        }
        await delay(Math.max(0, cycleIntervalMs - cycleElapsedMs));
        cycle += 1;
      }

      await widgets.stop(mcp.id);
      terminalSocket.close();
      await f.client.terminalsModel.close(persistentTerminal.id);
      await connections.closeConnection(connection.id);
      await remoteValue(f.client.remote.files.revokeFileGrant(grant.grantId));
      await f.close();
      for (const value of Object.values(resources())) expect(value).toBe(0);
      forceGarbageCollection();
      finalSample = await takeSample(resources, dataDirectory, resourcePeaks);
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
      terminalSocket.close();
      await f.close();
    }

    async function runCycle(cycle: number, countWork: boolean) {
      let localTerminalId: string | undefined;
      let widgetId: string | undefined;
      let tunnelId: string | undefined;
      let remotePath: string | undefined;
      try {
        const localTerminal = await f.client.terminalsModel.create({
          kind: 'local',
          profileId: localProfileId,
          cols: 80,
          rows: 24,
        });
        localTerminalId = localTerminal.id;
        await sampleInformation(persistentTerminal.id);

        const marker = `PHASE21_SOAK_${cycle}_${randomUUID().slice(0, 8)}`;
        await terminalRoundTrip(terminalSocket, marker);
        if (countWork) counters.terminalRoundTrips += 1;

        await remoteValue(
          f.client.remote.files.listRemoteDirectory(
            { protocol: 'sftp', connectionId: connection.id },
            '/config',
          ),
        );
        if (countWork) counters.sftpLists += 1;

        const widget = await widgets.startFile({
          grantId,
          title: `Phase 21 file server ${cycle}`,
          port: 0,
        });
        widgetId = widget.id;
        const widgetResponse = await fetch(widget.serverInfo!.url);
        if ((await widgetResponse.text()) !== 'phase21-soak-widget')
          throw new Error('Local file server returned unexpected content');
        await widgets.stop(widget.id);
        widgetId = undefined;
        if (countWork) counters.widgets += 1;

        if (cycle % 2 === 0) {
          remotePath = `/config/phase21-soak-${cycle}.txt`;
          const transfer = await transfers.create(randomUUID(), {
            target: { protocol: 'sftp', connectionId: connection.id },
            direction: 'upload',
            ...{
              grantId,
              localPath: 'soak-upload.txt',
              remotePath,
              recursive: false,
              conflict: 'overwrite',
            },
          });
          await waitUntil(async () => {
            const state = (await transferFacts().items).find(({ id }) => id === transfer.id)?.state;
            if (state === 'failed' || state === 'canceled')
              throw new Error(`Transfer ended in ${state}`);
            return state === 'succeeded';
          }, 15_000);
          await remoteValue(
            f.client.remote.files.deleteRemoteEntry(
              randomUUID(),
              { protocol: 'sftp', connectionId: connection.id },
              remotePath,
            ),
          );
          remotePath = undefined;
          await transfers.clearCompleted(randomUUID());
          if (countWork) counters.transfers += 1;
        }

        if (cycle % 3 === 0) {
          const tunnel = await connections.startTunnel(randomUUID(), {
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
          await connections.stopTunnel(tunnel.id);
          tunnelId = undefined;
          if (countWork) counters.tunnels += 1;
        }

        if (cycle % 5 === 0) {
          await callMcpMemory(mcp.serverInfo!.url, mcpSession, mcpApiKey, cycle);
          if (countWork) counters.mcpCalls += 1;
        }
      } finally {
        if (tunnelId) await connections.stopTunnel(tunnelId);
        if (widgetId) await widgets.stop(widgetId);
        if (remotePath)
          await remoteValue(
            f.client.remote.files.deleteRemoteEntry(
              randomUUID(),
              { protocol: 'sftp', connectionId: connection.id },
              remotePath,
            ),
          );
        if (localTerminalId) await f.client.terminalsModel.close(localTerminalId);
      }

      const counts = resources();
      assertResourceCeilings(counts);
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

async function openTerminalSocket(carrier: ConnectionHandle, terminalId: string) {
  const socket = carrier.openWebSocket(
    TERMINAL_STREAM_PATH + '?' + new URLSearchParams({ id: terminalId, clientId: randomUUID() }),
  );
  if (!(socket instanceof WebSocket)) throw Error('Actual Node socket required');
  const output = new TerminalOutputConsumer(
    {
      write(_bytes, done) {
        done();
      },
    },
    () => performance.now(),
    () => {},
    (streamId, consumedBytes) =>
      socket.send(JSON.stringify({ type: 'outputConsumed', streamId, consumedBytes })),
  );
  const ready = Promise.withResolvers<void>();
  socket.on('message', (data, binary) => {
    if (binary) {
      const bytes = Buffer.from(data as Buffer);
      output.write(() => bytes, bytes.length);
    } else {
      const control = terminalServerControlSchema.parse(
        JSON.parse(Buffer.from(data as Buffer).toString('utf8')),
      );
      if (control.type === 'ready' && control.outputFlow) {
        output.configureFlow(control.outputFlow);
        ready.resolve();
      }
    }
  });
  socket.on('error', ready.reject);
  socket.once('close', () => output.dispose());
  const timer = setTimeout(() => ready.reject(Error('Terminal channel unavailable')), 8000);
  try {
    await ready.promise;
    return socket;
  } catch (error) {
    socket.terminate();
    throw error;
  } finally {
    clearTimeout(timer);
  }
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
      output = (output + Buffer.from(data as Buffer).toString('utf8')).slice(
        -TERMINAL_REPLAY_MAX_BYTES,
      );
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

async function takeSample(
  resources: () => Readonly<Record<string, number>>,
  dataDirectory: string,
  resourcePeaks: Record<string, number>,
): Promise<SoakSample> {
  const memory = process.memoryUsage();
  const counts = resources();
  for (const [name, count] of Object.entries(counts))
    resourcePeaks[name] = Math.max(resourcePeaks[name] ?? 0, count);
  return {
    at: new Date().toISOString(),
    rssBytes: memory.rss,
    heapUsedBytes: memory.heapUsed,
    externalBytes: memory.external,
    arrayBuffersBytes: memory.arrayBuffers,
    databaseBytes: await databaseBytes(dataDirectory),
    resources: counts,
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
    ['terminalOutputConsumers', 1],
    ['terminalTransferResources', 1],
    ['terminalMetadataFollowers', 1],
    ['transferFactFollowers', 1],
    ['widgetFollowers', 1],
    ['widgetCommandReceipts', 2048],
    ['connectionFollowers', 1],
    ['connectionWork', 1],
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
