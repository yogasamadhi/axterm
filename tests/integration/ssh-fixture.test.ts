import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, open, rm } from 'node:fs/promises';
import { createServer, type Server, type ServerResponse } from 'node:http';
import { createConnection as connectSocket } from 'node:net';
import { createServer as createTcpServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  bootstrapResponseSchema,
  commandHistoryPageSchema,
  recordCommandHistoryResultSchema,
  terminalInformationSnapshotSchema,
  terminalSessionSchema,
} from '../../packages/contracts/src/index';
import { createRuntimeClient } from '../../packages/client/src/api-client';
import { startRuntime } from '../../packages/runtime/src/bootstrap/runtime';
import { TerminalCommandTrackerAddon } from '../../apps/desktop/src/renderer/src/components/terminal-command-tracker';

const fixturePort = Number(process.env.AXTERM_SSH_FIXTURE_PORT ?? 0);
const hop2Host = process.env.AXTERM_SSH_HOP2_HOST ?? '';
const targetHost = process.env.AXTERM_SSH_TARGET_HOST ?? '';
const runtimes: Awaited<ReturnType<typeof startRuntime>>[] = [];
const credentialServers: Server[] = [];
const x11Servers: ReturnType<typeof createTcpServer>[] = [];
const temporaryDirectories: string[] = [];
afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.close()));
  await Promise.all(
    credentialServers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
          server.closeAllConnections();
        }),
    ),
  );
  await Promise.all(
    x11Servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
        }),
    ),
  );
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe.skipIf(!fixturePort)('real OpenSSH fixture', () => {
  it('covers password auth, host-key approval, SSH PTY, SFTP and all tunnel types', async () => {
    const capability = await startCredentialCapability();
    const localX11 = await startLocalX11Fixture();
    const runtime = await startRuntime({
      generation: randomUUID(),
      appVersion: '0.10.0',
      mode: 'headless',
      hostCapabilityUrl: capability.url,
      hostCapabilityToken: capability.token,
    });
    runtimes.push(runtime);
    const client = createRuntimeClient({ resolve: async () => runtime.bootstrap() });
    await client.status();
    const host = await client.createHost({
      name: 'docker-openssh',
      hostname: '127.0.0.1',
      port: fixturePort,
      username: 'fixture',
      groupId: null,
      authType: 'password',
      credentialRef: null,
      passphraseCredentialRef: null,
      jumpHostId: null,
      favorite: false,
      connectionOptions: {
        connectionTimeoutMs: 20_000,
        keepaliveIntervalMs: 1_000,
        keepaliveCountMax: 3,
        compression: false,
        algorithms: {
          kex: ['curve25519-sha256'],
          cipher: ['aes128-ctr'],
          serverHostKey: ['ssh-ed25519'],
          hmac: ['hmac-sha2-256-etm@openssh.com'],
        },
        reconnectPolicy: { mode: 'manual', delayMs: 3_000, maxAttempts: 10 },
      },
      startup: {
        directory: '/config',
        environment: { AXTERM_START_ENV: 'ENV_OK' },
        loginScripts: [{ command: 'export AXTERM_LOGIN=LOGIN_OK', delayMs: 50 }],
        runScripts: [
          {
            command:
              'printf \'\\nD09_STARTUP:%s:%s:%s\\n\' "$PWD" "$AXTERM_START_ENV" "$AXTERM_LOGIN"',
            delayMs: 0,
          },
          {
            command:
              'display_no="${DISPLAY#*:}"; display_no="${display_no%%.*}"; printf D10_X11_PIPE | nc 127.0.0.1 "$((6000+display_no))"',
            delayMs: 0,
          },
        ],
      },
      x11: { enabled: true, display: `localhost:${localX11.display}` },
    });
    const connection = await client.createConnection(host.id, 'axterm-fixture-password');
    let interaction = undefined as
      Awaited<ReturnType<typeof client.interactions>>[number] | undefined;
    await vi.waitFor(async () => {
      interaction = (await client.interactions())[0];
      expect(interaction?.kind).toBe('unknownHostKey');
    });
    await client.respondInteraction(interaction!.id, { accepted: true, remember: true });
    await vi.waitFor(async () => {
      expect((await client.connections()).find((item) => item.id === connection.id)?.state).toBe(
        'ready',
      );
    });
    const connectionHistory = await client.connectionHistory();
    expect(connectionHistory.items).toEqual([
      expect.objectContaining({
        hostId: host.id,
        hostname: '127.0.0.1',
        port: fixturePort,
        username: 'fixture',
        authType: 'password',
        count: 1,
      }),
    ]);
    expect(JSON.stringify(connectionHistory)).not.toContain('axterm-fixture-password');

    const rejectedAlgorithmsHost = await client.createHost({
      name: 'docker-openssh-rejected-algorithms',
      hostname: '127.0.0.1',
      port: fixturePort,
      username: 'fixture',
      authType: 'password',
      connectionOptions: { algorithms: { kex: ['no-such-kex'] } },
    });
    const rejectedAlgorithms = await client.createConnection(
      rejectedAlgorithmsHost.id,
      'axterm-fixture-password',
    );
    await vi.waitFor(async () => {
      expect(
        (await client.connections()).find(({ id }) => id === rejectedAlgorithms.id)?.state,
      ).toBe('failed');
    });
    await client.closeConnection(rejectedAlgorithms.id);

    if (hop2Host && targetHost) {
      const jump1 = await client.createHost({
        name: 'fixture-jump-1',
        hostname: '127.0.0.1',
        port: fixturePort,
        username: 'fixture',
        authType: 'password',
        credentialRef: 'fixture-password',
      });
      const jump2 = await client.createHost({
        name: 'fixture-jump-2',
        hostname: hop2Host,
        port: 2222,
        username: 'fixture',
        authType: 'password',
        credentialRef: 'fixture-password',
      });
      const multiHopTarget = await client.createHost({
        name: 'fixture-multi-hop-target',
        hostname: targetHost,
        port: 2222,
        username: 'fixture',
        authType: 'password',
        credentialRef: 'fixture-password',
        jumpHostIds: [jump1.id, jump2.id],
      });
      const multiHop = await client.createConnection(multiHopTarget.id);
      await vi.waitFor(
        async () => {
          for (const pending of await client.interactions())
            if (pending.kind === 'unknownHostKey')
              await client.respondInteraction(pending.id, { accepted: true, remember: true });
          expect((await client.connections()).find(({ id }) => id === multiHop.id)?.state).toBe(
            'ready',
          );
        },
        { timeout: 30_000, interval: 50 },
      );
      expect((await client.remoteFiles(multiHop.id, '/config')).length).toBeGreaterThan(0);
      await client.closeConnection(multiHop.id);
    }

    const proxyCommandHost = await client.createHost({
      name: 'docker-openssh-via-proxy-command',
      hostname: '127.0.0.1',
      port: fixturePort,
      username: 'fixture',
      authType: 'password',
      proxy: {
        mode: 'command',
        command: {
          executable: process.execPath,
          arguments: [
            '-e',
            [
              "const net=require('node:net')",
              'const socket=net.connect(Number(process.argv[2]),process.argv[1])',
              'process.stdin.pipe(socket)',
              'socket.pipe(process.stdout)',
              "socket.on('error',()=>process.exit(9))",
            ].join(';'),
            '%h',
            '%p',
          ],
        },
      },
    });
    const proxyCommandConnection = await client.createConnection(
      proxyCommandHost.id,
      'axterm-fixture-password',
    );
    await vi.waitFor(async () => {
      expect(
        (await client.connections()).find((item) => item.id === proxyCommandConnection.id)?.state,
      ).toBe('ready');
    });
    await client.closeConnection(proxyCommandConnection.id);

    const entries = await client.remoteFiles(connection.id, '/config');
    expect(entries.length).toBeGreaterThan(0);

    for (const profile of [
      {
        name: 'local',
        hostId: host.id,
        type: 'local' as const,
        bindHost: '127.0.0.1',
        bindPort: 0,
        targetHost: '127.0.0.1',
        targetPort: 2222,
        allowNonLoopback: false,
      },
      {
        name: 'dynamic',
        hostId: host.id,
        type: 'dynamic' as const,
        bindHost: '127.0.0.1',
        bindPort: 0,
        targetHost: null,
        targetPort: null,
        allowNonLoopback: false,
      },
      {
        name: 'remote',
        hostId: host.id,
        type: 'remote' as const,
        bindHost: '127.0.0.1',
        bindPort: 43891,
        targetHost: '127.0.0.1',
        targetPort: 9,
        allowNonLoopback: false,
      },
    ]) {
      const tunnel = await client
        .startTunnel({ connectionId: connection.id, profile })
        .catch((error: unknown) => {
          throw new Error(`${profile.name}: ${error instanceof Error ? error.message : 'failed'}`, {
            cause: error,
          });
        });
      expect(tunnel.state).toBe('active');
      if (profile.type === 'local') expect(await readSshBanner(tunnel.bindPort)).toContain('SSH-');
      if (profile.type === 'dynamic')
        expect(await readSocksSshBanner(tunnel.bindPort)).toContain('SSH-');
      await client.stopTunnel(tunnel.id);
    }
    expect(await client.tunnels()).toEqual([]);
    const terminalProfile = await client.createTerminalProfile({
      name: 'SSH profile fixture',
      shell: null,
      shellArgs: [],
      cwd: null,
      loginShell: false,
      env: {},
      term: 'screen-256color',
      lang: 'C.UTF-8',
      fontFamily: 'Iosevka, monospace',
      fontSize: 18,
      lineHeight: 1.25,
      cursorStyle: 'underline',
      cursorBlink: true,
    });
    const settings = await client.settings();
    await client.updateSettings(settings, { privacy: { commandHistoryEnabled: true } });

    let token = await login(runtime);
    const terminalResponse = await fetch(`${runtime.baseUrl}/api/v1/terminals`, {
      method: 'POST',
      headers: authHeaders(runtime, token, true),
      body: JSON.stringify({
        kind: 'ssh',
        connectionId: connection.id,
        profileId: terminalProfile.id,
        cols: 80,
        rows: 24,
      }),
    });
    expect(terminalResponse.status).toBe(201);
    const terminal = terminalSessionSchema.parse(await terminalResponse.json());
    expect(terminal).toMatchObject({
      profileId: terminalProfile.id,
      appearance: {
        fontFamily: 'Iosevka, monospace',
        fontSize: 18,
        lineHeight: 1.25,
        cursorStyle: 'underline',
        cursorBlink: true,
      },
    });
    const informationResponse = await fetch(
      `${runtime.baseUrl}/api/v1/terminals/${terminal.id}/information`,
      { headers: authHeaders(runtime, token) },
    );
    expect(informationResponse.status).toBe(200);
    const information = terminalInformationSnapshotSchema.parse(await informationResponse.json());
    expect(information.groups.sysinfo).toMatchObject({
      state: 'ready',
      data: { os: expect.any(String), hostname: expect.any(String), arch: expect.any(String) },
    });
    expect(information.groups.cpu.state).toBe('ready');
    expect(information.groups.memory.data?.totalBytes).toBeGreaterThan(0);
    expect(information.groups.uptime.data?.seconds).toBeGreaterThan(0);
    expect(information.groups.disks.data?.length).toBeGreaterThan(0);
    expect(information.groups.activities.data?.length).toBeGreaterThan(0);
    const url = new URL(`/api/v1/terminals/${terminal.id}/stream`, runtime.baseUrl);
    url.protocol = 'ws:';
    const socket = new WebSocket(
      url,
      ['terminal.v1', `terminal-client.${randomUUID()}`, `auth.${token}`],
      {
        origin: runtime.baseUrl,
      },
    );
    const terminalOutput = await expectTerminal(
      socket,
      [
        'printf \'\\nSSH_FIXTURE_OK:%s:%s\\n\' "$TERM" "$LANG"',
        ' echo SSH_LEADING_HIDDEN',
        "export FIXTURE_SECRET=credential-marker; printf '\\nSSH_SENSITIVE_%s\\n' FINISHED",
        '',
      ].join('\n'),
      'SSH_SENSITIVE_FINISHED',
    );
    expect(terminalOutput).toContain('SSH_FIXTURE_OK:screen-256color:C.UTF-8');
    expect(terminalOutput).toContain('D09_STARTUP:/config:ENV_OK:LOGIN_OK');
    await expect(localX11.payload).resolves.toContain('D10_X11_PIPE');

    const transferDirectory = await mkdtemp(join(tmpdir(), 'axterm-d12-channel-'));
    temporaryDirectories.push(transferDirectory);
    const transferPath = join(transferDirectory, 'd12-channel.bin');
    const transferFile = await open(transferPath, 'w');
    const transferBytes = 256 * 1024 * 1024;
    await transferFile.truncate(transferBytes);
    await transferFile.close();
    const grantId = capability.registerFileGrant(transferPath, 'd12-channel.bin');
    client.reconnect();
    const concurrentTransfer = await client.createTransfer(connection.id, 'upload', {
      grantId,
      remotePath: '/config/d12-channel.bin',
      recursive: false,
      conflict: 'overwrite',
    });
    await vi.waitFor(
      async () => {
        expect(
          (await client.transfers()).find(({ id }) => id === concurrentTransfer.id)?.state,
        ).toBe('running');
      },
      { timeout: 10_000, interval: 20 },
    );
    const markerSuffix = randomUUID().replaceAll('-', '');
    const marker = `D12_INTERACTIVE_${markerSuffix}`;
    const latencyMs = await terminalRoundTrip(
      socket,
      `printf '\\nD12_INTERACTIVE_%s\\n' '${markerSuffix}'\n`,
      marker,
    );
    expect(latencyMs).toBeLessThan(1_500);
    expect((await client.transfers()).find(({ id }) => id === concurrentTransfer.id)?.state).toBe(
      'running',
    );
    await vi.waitFor(
      async () => {
        expect(
          (await client.transfers()).find(({ id }) => id === concurrentTransfer.id),
        ).toMatchObject({
          state: 'succeeded',
          bytesTransferred: transferBytes,
          totalBytes: transferBytes,
        });
      },
      { timeout: 30_000, interval: 50 },
    );
    await client.deleteRemotePath(connection.id, '/config/d12-channel.bin');
    token = await login(runtime);

    const recordRequests: Array<Promise<unknown>> = [];
    const tracker = new TerminalCommandTrackerAddon(
      (command) => recordRequests.push(recordCommandHistory(runtime, token, terminal.id, command)),
      () => {},
    );
    tracker.setState('active');
    const liveEvents = osc633Events(terminalOutput);
    for (const event of liveEvents) tracker.handle(event);
    await Promise.all(recordRequests);
    expect(liveEvents.some((event) => event.includes('FIXTURE_SECRET'))).toBe(true);
    expect((await listCommandHistory(runtime, token)).items).toContainEqual(
      expect.objectContaining({
        command: 'printf \'\\nSSH_FIXTURE_OK:%s:%s\\n\' "$TERM" "$LANG"',
        count: 1,
      }),
    );
    socket.close();

    const replaySocket = new WebSocket(
      url,
      ['terminal.v1', `terminal-client.${randomUUID()}`, `auth.${token}`],
      { origin: runtime.baseUrl },
    );
    const replayOutput = await collectReplay(replaySocket);
    tracker.beginReplay();
    for (const event of osc633Events(replayOutput)) tracker.handle(event);
    tracker.endReplay();
    await Promise.all(recordRequests);
    expect((await listCommandHistory(runtime, token)).items[0]?.count).toBe(1);
    replaySocket.close();
    tracker.dispose();
    expect(
      (
        await fetch(`${runtime.baseUrl}/api/v1/terminals/${terminal.id}`, {
          method: 'DELETE',
          headers: authHeaders(runtime, token),
        })
      ).status,
    ).toBe(204);
    expect(
      (
        await fetch(`${runtime.baseUrl}/api/v1/connections/${connection.id}`, {
          method: 'DELETE',
          headers: authHeaders(runtime, token),
        })
      ).status,
    ).toBe(204);
    client.dispose();
  }, 90_000);
});

async function startLocalX11Fixture(): Promise<{
  display: number;
  payload: Promise<string>;
}> {
  let resolvePayload!: (value: string) => void;
  const payload = new Promise<string>((resolve) => {
    resolvePayload = resolve;
  });
  for (let display = 20; display < 40; display += 1) {
    const server = createTcpServer((socket) => {
      let input = '';
      socket.on('data', (chunk) => {
        input += chunk.toString('utf8');
        if (input.includes('D10_X11_PIPE')) {
          resolvePayload(input);
          socket.end();
        }
      });
    });
    const listening = await new Promise<boolean>((resolve) => {
      server.once('error', () => resolve(false));
      server.listen(6_000 + display, '127.0.0.1', () => resolve(true));
    });
    if (listening) {
      x11Servers.push(server);
      return { display, payload };
    }
    server.close();
  }
  throw new Error('No local X11 fixture port is available');
}

async function startCredentialCapability(): Promise<{
  url: string;
  token: string;
  registerFileGrant(path: string, name: string): string;
}> {
  const token = randomUUID();
  const grants = new Map<string, { path: string; name: string }>();
  const server = createServer((request, response) => {
    if (request.headers.authorization !== `Bearer ${token}` || request.method !== 'POST') {
      response.writeHead(404).end();
      return;
    }
    if (/^\/host\/v1\/credentials\/[^/]+\/resolve$/u.test(request.url ?? ''))
      return sendCapability(response, { secret: 'axterm-fixture-password' });
    const grantMatch = /^\/host\/v1\/grants\/([^/]+)\/resolve$/u.exec(request.url ?? '');
    const grant = grantMatch?.[1] ? grants.get(grantMatch[1]) : undefined;
    if (grantMatch?.[1] && grant)
      return sendCapability(response, {
        grantId: grantMatch[1],
        kind: 'file',
        name: grant.name,
        permissions: ['read'],
        createdAt: new Date().toISOString(),
        path: grant.path,
      });
    response.writeHead(404).end();
  });
  credentialServers.push(server);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Credential fixture did not bind');
  return {
    url: `http://127.0.0.1:${address.port}`,
    token,
    registerFileGrant(path, name) {
      const grantId = `grant_${randomUUID()}`;
      grants.set(grantId, { path, name });
      return grantId;
    },
  };
}

function sendCapability(response: ServerResponse, body: unknown) {
  response.writeHead(200, {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
  });
  response.end(JSON.stringify(body));
}

async function login(runtime: Awaited<ReturnType<typeof startRuntime>>) {
  const response = await fetch(`${runtime.baseUrl}/api/v1/auth/bootstrap`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ bootstrapToken: runtime.bootstrap().bootstrapToken }),
  });
  return bootstrapResponseSchema.parse(await response.json()).sessionToken;
}

function readSshBanner(port: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connectSocket({ host: '127.0.0.1', port });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error('Tunnel timed out'));
    }, 3_000);
    socket.once('data', (data) => {
      clearTimeout(timer);
      socket.destroy();
      resolve(data.toString());
    });
    socket.once('error', reject);
  });
}

function readSocksSshBanner(port: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connectSocket({ host: '127.0.0.1', port });
    let stage = 0;
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error('SOCKS tunnel timed out'));
    }, 3_000);
    socket.on('connect', () => socket.write(Buffer.from([5, 1, 0])));
    socket.on('data', (data) => {
      if (stage === 0) {
        if (data[0] !== 5 || data[1] !== 0) return reject(new Error('SOCKS greeting failed'));
        stage = 1;
        socket.write(Buffer.from([5, 1, 0, 1, 127, 0, 0, 1, 0x08, 0xae]));
        return;
      }
      if (stage === 1) {
        if (data[1] !== 0) return reject(new Error('SOCKS connect failed'));
        stage = 2;
        return;
      }
      clearTimeout(timer);
      socket.destroy();
      resolve(data.toString());
    });
    socket.once('error', reject);
  });
}

function authHeaders(
  runtime: Awaited<ReturnType<typeof startRuntime>>,
  token: string,
  json = false,
) {
  return {
    Authorization: `Bearer ${token}`,
    'X-Runtime-Generation': runtime.metadata.generation,
    ...(json ? { 'Content-Type': 'application/json' } : {}),
  };
}

async function recordCommandHistory(
  runtime: Awaited<ReturnType<typeof startRuntime>>,
  token: string,
  terminalId: string,
  command: string,
) {
  const response = await fetch(`${runtime.baseUrl}/api/v1/command-history`, {
    method: 'POST',
    headers: {
      ...authHeaders(runtime, token, true),
      'Idempotency-Key': randomUUID(),
    },
    body: JSON.stringify({ terminalId, command, source: 'shellIntegration' }),
  });
  expect(response.status).toBe(200);
  return recordCommandHistoryResultSchema.parse(await response.json());
}

async function listCommandHistory(
  runtime: Awaited<ReturnType<typeof startRuntime>>,
  token: string,
) {
  const response = await fetch(`${runtime.baseUrl}/api/v1/command-history`, {
    headers: authHeaders(runtime, token),
  });
  expect(response.status).toBe(200);
  return commandHistoryPageSchema.parse(await response.json());
}

function expectTerminal(socket: WebSocket, command: string, marker: string): Promise<string> {
  return new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => reject(new Error(`SSH terminal timeout: ${output}`)), 8_000);
    socket.on('open', () => socket.send(Buffer.from(command), { binary: true }));
    socket.on('message', (data, binary) => {
      if (!binary) return;
      output += Buffer.from(data as Buffer).toString('utf8');
      if (output.includes(marker)) {
        clearTimeout(timer);
        resolve(output);
      }
    });
    socket.on('error', reject);
  });
}

function terminalRoundTrip(socket: WebSocket, command: string, marker: string): Promise<number> {
  return new Promise((resolve, reject) => {
    let output = '';
    const startedAt = performance.now();
    const timer = setTimeout(
      () => finish(new Error(`Terminal round trip timed out: ${output}`)),
      5_000,
    );
    const onMessage = (data: WebSocket.RawData, binary: boolean) => {
      if (!binary) return;
      output += Buffer.from(data as Buffer).toString('utf8');
      if (output.includes(marker)) finish();
    };
    const finish = (error?: Error) => {
      clearTimeout(timer);
      socket.off('message', onMessage);
      if (error) reject(error);
      else resolve(performance.now() - startedAt);
    };
    socket.on('message', onMessage);
    socket.send(Buffer.from(command), { binary: true }, (error) => {
      if (error) finish(error);
    });
  });
}

function collectReplay(socket: WebSocket): Promise<string> {
  return new Promise((resolve, reject) => {
    let expected: number | undefined;
    let received = 0;
    let output = '';
    const timer = setTimeout(() => reject(new Error(`SSH replay timeout: ${output}`)), 8_000);
    socket.on('message', (data, binary) => {
      if (!binary) {
        const control = JSON.parse(Buffer.from(data as Buffer).toString('utf8')) as {
          type?: string;
          byteLength?: number;
        };
        if (control.type === 'replay') {
          expected = control.byteLength ?? 0;
          if (!expected) {
            clearTimeout(timer);
            resolve(output);
          }
        }
        return;
      }
      if (expected === undefined) return;
      const chunk = Buffer.from(data as Buffer);
      output += chunk.toString('utf8');
      received += chunk.length;
      if (received >= expected) {
        clearTimeout(timer);
        resolve(output);
      }
    });
    socket.on('error', reject);
  });
}

function osc633Events(output: string): string[] {
  const escape = String.fromCharCode(27);
  const bell = String.fromCharCode(7);
  const pattern = new RegExp(`${escape}\\]633;([^${bell}]*)${bell}`, 'gu');
  return [...output.matchAll(pattern)].map((match) => match[1]!);
}
