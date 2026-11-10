import { randomUUID } from 'node:crypto';
import { mkdtemp, open, readFile, rm, writeFile } from 'node:fs/promises';
import {
  createConnection as connectSocket,
  createServer as createTcpServer,
  type Socket,
} from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CreateHostInput } from '@axterm/plugin-api/catalog';
import {
  TERMINAL_STREAM_PATH,
  TERMINAL_REPLAY_MAX_BYTES,
  terminalServerControlSchema,
  type TerminalProfileInput,
} from '@axterm/plugin-api/terminals';
import type { ConnectionHandle } from '../../packages/infra/connection/src/client/index.ts';
import * as Connections from '../../packages/plugins/connections/src/client/index.ts';
import * as Terminals from '../../packages/plugins/terminals/src/client/index.ts';
import * as Transfers from '../../packages/plugins/transfers/src/client/index.ts';
import fileRemote from '../../packages/plugins/files/lib/typert.remote-client.js';
import { TerminalOutputConsumer } from '../../packages/plugins/terminals/src/client/terminal-output-consumer.ts';
import { TerminalInformationModel } from '../../packages/plugins/terminals/src/client/tools/information-model.ts';
import { remoteProfile, remoteValue } from '../fixtures/level3-remote-profile.ts';
const fixturePort = Number(process.env.AXTERM_SSH_FIXTURE_PORT ?? 0);
const hop2Host = process.env.AXTERM_SSH_HOP2_HOST ?? '';
const targetHost = process.env.AXTERM_SSH_TARGET_HOST ?? '';
const profiles: Awaited<ReturnType<typeof remoteProfile>>[] = [];
const sockets = new Set<WebSocket>();
const x11Sockets = new Set<Socket>();
const x11Servers: ReturnType<typeof createTcpServer>[] = [];
const temporaryDirectories: string[] = [];
afterEach(async () => {
  for (const socket of sockets) socket.terminate();
  sockets.clear();
  for (const socket of x11Sockets) socket.destroy();
  x11Sockets.clear();
  for (const profile of profiles.splice(0).reverse()) await profile.close();
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
    const home = await mkdtemp(join(tmpdir(), 'axterm-real-openssh-profile-'));
    temporaryDirectories.push(home);
    const localX11 = await startLocalX11Fixture();
    const f = await remoteProfile(home, { application: true });
    profiles.push(f);
    await f.client.plugin(Connections);
    await f.client.plugin(Terminals);
    await f.client.plugin(Transfers);
    const off = await f.client.remote.$mount(fileRemote);
    f.client.effect(() => off);
    await vi.waitFor(() => {
      expect(f.client.connectionsModel.getSnapshot().status).toBe('ready');
      expect(f.client.terminalFactsModel.getSnapshot().status).toBe('ready');
      expect(f.client.transfersModel.getSnapshot().status).toBe('ready');
    });
    const connections = f.client.connectionsModel,
      transfers = f.client.transfersModel,
      generation = f.application.ctx.runtimeIdentity.generation;
    const carrier = f.client.get('connection') as unknown as ConnectionHandle;
    const facts = () => {
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
    const createProfile = async (input: TerminalProfileInput) => {
      const receipt = await f.client.terminalFactsModel.createTerminalProfile(randomUUID(), input);
      return remoteValue(f.client.remote.terminals.getTerminalProfile(receipt.ids[0]!));
    };
    const credential = await remoteValue(
      f.client.remote.configuration.createCredential(randomUUID(), generation, {
        kind: 'sshPassword',
        label: 'Real OpenSSH fixture',
        secret: 'axterm-fixture-password',
      }),
    );
    if (credential.status !== 'completed') throw Error('Credential creation failed');
    const grant = await remoteValue(
      f.client.remote.files.createFileGrant({ kind: 'home-directory' }),
    );
    if (!grant) throw Error('Workspace grant unavailable');
    expect(grant.permissions).toEqual(expect.arrayContaining(['read', 'write']));
    const openTerminal = () => {
      const socket = carrier.openWebSocket(
        TERMINAL_STREAM_PATH +
          '?' +
          new URLSearchParams({ id: terminal.id, clientId: randomUUID() }),
      );
      if (!(socket instanceof WebSocket)) throw Error('Actual Node transport required');
      sockets.add(socket);
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
      socket.on('message', (data, binary) => {
        if (binary) {
          const bytes = Buffer.from(data as Buffer);
          output.write(() => bytes, bytes.length);
        } else {
          const control = terminalServerControlSchema.parse(
            JSON.parse(Buffer.from(data as Buffer).toString('utf8')),
          );
          if (control.type === 'ready' && control.outputFlow)
            expect(output.configureFlow(control.outputFlow)).toBe(true);
        }
      });
      socket.on('error', () => output.dispose());
      socket.once('close', () => {
        sockets.delete(socket);
        output.dispose();
      });
      return socket;
    };
    const host = await createHost({
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
    const connection = await connections.createConnection(randomUUID(), {
      hostId: host.id,
      temporarySecret: 'axterm-fixture-password',
    });
    let interaction: ReturnType<typeof facts>['interactions'][number] | undefined;
    await vi.waitFor(async () => {
      interaction = (await facts().interactions)[0];
      expect(interaction?.kind).toBe('unknownHostKey');
    });
    await connections.respondInteraction(interaction!.id, { accepted: true, remember: true });
    await vi.waitFor(async () => {
      expect((await facts().connections).find((item) => item.id === connection.id)?.state).toBe(
        'ready',
      );
    });
    const connectionHistory = await remoteValue(
      f.client.remote.catalog.listConnectionHistory(generation, {}),
    );
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

    const rejectedAlgorithmsHost = await createHost({
      name: 'docker-openssh-rejected-algorithms',
      hostname: '127.0.0.1',
      port: fixturePort,
      username: 'fixture',
      authType: 'password',
      connectionOptions: { algorithms: { kex: ['no-such-kex'] } },
    });
    const rejectedAlgorithms = await connections.createConnection(randomUUID(), {
      hostId: rejectedAlgorithmsHost.id,
      temporarySecret: 'axterm-fixture-password',
    });
    await vi.waitFor(async () => {
      expect(
        (await facts().connections).find(({ id }) => id === rejectedAlgorithms.id)?.state,
      ).toBe('failed');
    });
    await connections.closeConnection(rejectedAlgorithms.id);

    if (hop2Host && targetHost) {
      const jump1 = await createHost({
        name: 'fixture-jump-1',
        hostname: '127.0.0.1',
        port: fixturePort,
        username: 'fixture',
        authType: 'password',
        credentialRef: credential.ref,
      });
      const jump2 = await createHost({
        name: 'fixture-jump-2',
        hostname: hop2Host,
        port: 2222,
        username: 'fixture',
        authType: 'password',
        credentialRef: credential.ref,
      });
      const multiHopTarget = await createHost({
        name: 'fixture-multi-hop-target',
        hostname: targetHost,
        port: 2222,
        username: 'fixture',
        authType: 'password',
        credentialRef: credential.ref,
        jumpHostIds: [jump1.id, jump2.id],
      });
      const multiHop = await connections.createConnection(randomUUID(), {
        hostId: multiHopTarget.id,
      });
      await vi.waitFor(
        async () => {
          for (const pending of await facts().interactions)
            if (pending.kind === 'unknownHostKey')
              await connections.respondInteraction(pending.id, { accepted: true, remember: true });
          expect((await facts().connections).find(({ id }) => id === multiHop.id)?.state).toBe(
            'ready',
          );
        },
        { timeout: 30_000, interval: 50 },
      );
      expect(
        (
          await remoteValue(
            f.client.remote.files.listRemoteDirectory(
              { protocol: 'sftp', connectionId: multiHop.id },
              '/config',
            ),
          ).then((list) => list.entries)
        ).length,
      ).toBeGreaterThan(0);
      await connections.closeConnection(multiHop.id);
    }

    const proxyCommandHost = await createHost({
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
    const proxyCommandConnection = await connections.createConnection(randomUUID(), {
      hostId: proxyCommandHost.id,
      temporarySecret: 'axterm-fixture-password',
    });
    await vi.waitFor(async () => {
      expect(
        (await facts().connections).find((item) => item.id === proxyCommandConnection.id)?.state,
      ).toBe('ready');
    });
    await connections.closeConnection(proxyCommandConnection.id);

    const entries = await remoteValue(
      f.client.remote.files.listRemoteDirectory(
        { protocol: 'sftp', connectionId: connection.id },
        '/config',
        AbortSignal.timeout(5000),
      ),
    ).then((list) => list.entries);
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
      const tunnel = await connections
        .startTunnel(randomUUID(), { connectionId: connection.id, profile })
        .catch((error: unknown) => {
          throw new Error(`${profile.name}: ${error instanceof Error ? error.message : 'failed'}`, {
            cause: error,
          });
        });
      expect(tunnel.state).toBe('active');
      if (profile.type === 'local') expect(await readSshBanner(tunnel.bindPort)).toContain('SSH-');
      if (profile.type === 'dynamic')
        expect(await readSocksSshBanner(tunnel.bindPort)).toContain('SSH-');
      await connections.stopTunnel(tunnel.id);
    }
    expect(await connections.listTunnels()).toEqual([]);
    const terminalProfile = await createProfile({
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
    const settings = await remoteValue(f.client.remote.configuration.getSettings());
    await f.client.settingsModel.updateSettings(
      randomUUID(),
      { privacy: { commandHistoryEnabled: true } },
      '"v' + settings.version + '"',
    );

    const terminal = await f.client.terminalsModel.create({
      kind: 'ssh',
      connectionId: connection.id,
      profileId: terminalProfile.id,
      cols: 80,
      rows: 24,
    });
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
    const informationModel = new TerminalInformationModel(f.client);
    f.client.effect(() => () => informationModel.close());
    const stopInformation = informationModel.observe(terminal.id, generation);
    await vi.waitFor(() => expect(informationModel.getSnapshot().status).toBe('ready'));
    const infoState = informationModel.getSnapshot();
    if (infoState.status !== 'ready') throw Error('Information baseline unavailable');
    const information = infoState.baseline.snapshot;
    stopInformation();
    expect(information.groups.sysinfo).toMatchObject({
      state: 'ready',
      data: { os: expect.any(String), hostname: expect.any(String), arch: expect.any(String) },
    });
    expect(information.groups.cpu.state).toBe('ready');
    expect(information.groups.memory.data?.totalBytes).toBeGreaterThan(0);
    expect(information.groups.uptime.data?.seconds).toBeGreaterThan(0);
    expect(information.groups.disks.data?.length).toBeGreaterThan(0);
    expect(information.groups.activities.data?.length).toBeGreaterThan(0);
    const socket = openTerminal();
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

    const transferDirectory = join(home, 'workspace');
    const transferPath = join(transferDirectory, 'd12-channel.bin');
    const transferFile = await open(transferPath, 'w');
    const transferBytes = 256 * 1024 * 1024;
    await transferFile.truncate(transferBytes);
    await transferFile.close();
    const grantId = grant.grantId;
    carrier.reconnect();
    const concurrentTransfer = await transfers.create(randomUUID(), {
      target: { protocol: 'sftp', connectionId: connection.id },
      direction: 'upload',
      ...{
        grantId,
        localPath: 'd12-channel.bin',
        remotePath: '/config/d12-channel.bin',
        recursive: false,
        conflict: 'overwrite',
      },
    });
    await vi.waitFor(
      async () => {
        expect(
          (await transferFacts().items).find(({ id }) => id === concurrentTransfer.id)?.state,
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
    expect(
      (await transferFacts().items).find(({ id }) => id === concurrentTransfer.id)?.state,
    ).toBe('running');
    await vi.waitFor(
      async () => {
        expect(
          (await transferFacts().items).find(({ id }) => id === concurrentTransfer.id),
        ).toMatchObject({
          state: 'succeeded',
          bytesTransferred: transferBytes,
          totalBytes: transferBytes,
        });
      },
      { timeout: 30_000, interval: 50 },
    );
    await remoteValue(
      f.client.remote.files.deleteRemoteEntry(
        randomUUID(),
        { protocol: 'sftp', connectionId: connection.id },
        '/config/d12-channel.bin',
      ),
    );
    const binaryPath = join(transferDirectory, 'op04-source.bin');
    const binary = Buffer.from(Array.from({ length: 192 * 1024 }, (_, index) => index % 256));
    await writeFile(binaryPath, binary);
    const binaryGrant = grant.grantId;
    const remoteBinaryPath = '/config/op04-binary.bin';
    const upload = await transfers.create(randomUUID(), {
      target: { protocol: 'sftp', connectionId: connection.id },
      direction: 'upload',
      ...{
        grantId: binaryGrant,
        localPath: 'op04-source.bin',
        remotePath: remoteBinaryPath,
        recursive: false,
        conflict: 'ask',
      },
    });
    await vi.waitFor(async () =>
      expect((await transferFacts().items).find(({ id }) => id === upload.id)?.state).toBe(
        'succeeded',
      ),
    );
    const replacement = Buffer.from(binary.map((byte) => 255 - byte));
    await writeFile(binaryPath, replacement);
    const overwrite = await transfers.create(randomUUID(), {
      target: { protocol: 'sftp', connectionId: connection.id },
      direction: 'upload',
      ...{
        grantId: binaryGrant,
        localPath: 'op04-source.bin',
        remotePath: remoteBinaryPath,
        recursive: false,
        conflict: 'ask',
      },
    });
    await vi.waitFor(async () =>
      expect((await transferFacts().items).find(({ id }) => id === overwrite.id)?.state).toBe(
        'awaiting-decision',
      ),
    );
    await transfers.decideConflict(randomUUID(), overwrite.id, {
      strategy: 'overwrite',
      applyToAll: false,
    });
    await vi.waitFor(async () =>
      expect((await transferFacts().items).find(({ id }) => id === overwrite.id)).toMatchObject({
        state: 'succeeded',
        bytesTransferred: replacement.length,
      }),
    );
    const downloadedPath = join(transferDirectory, 'op04-download.bin');
    const downloadGrant = grant.grantId;
    const download = await transfers.create(randomUUID(), {
      target: { protocol: 'sftp', connectionId: connection.id },
      direction: 'download',
      ...{
        grantId: downloadGrant,
        localPath: 'op04-download.bin',
        remotePath: remoteBinaryPath,
        recursive: false,
        conflict: 'ask',
      },
    });
    await vi.waitFor(async () =>
      expect((await transferFacts().items).find(({ id }) => id === download.id)?.state).toBe(
        'succeeded',
      ),
    );
    expect(await readFile(downloadedPath)).toEqual(replacement);
    await remoteValue(
      f.client.remote.files.deleteRemoteEntry(
        randomUUID(),
        { protocol: 'sftp', connectionId: connection.id },
        remoteBinaryPath,
      ),
    );
    const liveEvents = osc633Events(terminalOutput);
    expect(liveEvents.some((event) => event.includes('FIXTURE_SECRET'))).toBe(true);
    await vi.waitFor(async () =>
      expect((await f.client.terminalFactsModel.listCommandHistory()).items).toContainEqual(
        expect.objectContaining({
          command: 'printf \'\\nSSH_FIXTURE_OK:%s:%s\\n\' "$TERM" "$LANG"',
          count: 1,
        }),
      ),
    );
    const history = await f.client.terminalFactsModel.listCommandHistory();
    expect(JSON.stringify(history)).not.toContain('credential-marker');
    expect(history.items.some((row) => row.command.includes('SSH_LEADING_HIDDEN'))).toBe(false);
    socket.close();
    expect(
      await remoteValue(f.client.remote.terminals.getTerminalSession(terminal.id)),
    ).toMatchObject({ state: 'ready' });
    const replaySocket = openTerminal();
    const replayOutput = await collectReplay(replaySocket);
    expect(osc633Events(replayOutput).length).toBeGreaterThan(0);
    expect((await f.client.terminalFactsModel.listCommandHistory()).items).toEqual(history.items);
    replaySocket.close();
    await f.client.terminalsModel.close(terminal.id);
    await connections.closeConnection(connection.id);
    expect(f.application.ctx.terminals.resourceCount()).toBe(0);
    await vi.waitFor(() => expect(facts().connections).toEqual([]));
    await remoteValue(f.client.remote.files.revokeFileGrant(grant.grantId));
    await f.close();
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
      x11Sockets.add(socket);
      socket.on('error', () => {});
      socket.once('close', () => x11Sockets.delete(socket));
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

function expectTerminal(socket: WebSocket, command: string, marker: string): Promise<string> {
  return new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => reject(new Error(`SSH terminal timeout: ${output}`)), 8_000);
    socket.on('open', () => socket.send(Buffer.from(command), { binary: true }));
    socket.on('message', (data, binary) => {
      if (!binary) return;
      output = (output + Buffer.from(data as Buffer).toString('utf8')).slice(
        -TERMINAL_REPLAY_MAX_BYTES,
      );
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
      output = (output + Buffer.from(data as Buffer).toString('utf8')).slice(
        -TERMINAL_REPLAY_MAX_BYTES,
      );
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
    const controls: string[] = [];
    const timer = setTimeout(
      () => reject(new Error(`SSH replay timeout controls=${controls.join(',')}: ${output}`)),
      8_000,
    );
    socket.once('close', (code) => {
      clearTimeout(timer);
      reject(new Error('SSH replay closed ' + code + ' controls=' + controls.join(',')));
    });
    socket.on('message', (data, binary) => {
      if (!binary) {
        const control = JSON.parse(Buffer.from(data as Buffer).toString('utf8')) as {
          type?: string;
          byteLength?: number;
        };
        controls.push(control.type ?? 'missing-type');
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
