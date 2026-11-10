import catalogDescriptor from '../../packages/plugins/catalog/lib/typert.remote-client.js';
import type {} from '../../packages/infra/web-startup/src/index.ts';
import * as Automation from '../../packages/plugins/automation/src/client/index.ts';
import { EncryptedVault } from '@axterm/infra-credential-vault';
import { Context } from '@deepseek-ai/cordis';
import { randomUUID, createHash } from 'node:crypto';
import { createServer as createTcpServer, createConnection, type Socket } from 'node:net';
import { installSshForwardingWire } from '../fixtures/ssh-forwarding-wire.ts';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type * as Ssh2 from 'ssh2';
import WebSocket from 'ws';
import { expect, it, vi } from 'vitest';
import Registry from '@axterm/infra-typert-registry';
import {
  installConnection,
  type ConnectionWebSocket,
  type ConnectionHandle,
} from '../../packages/infra/connection/src/client/index.ts';
import * as ClientGateway from '../../packages/infra/gateway/src/client/index.ts';
import * as Connections from '../../packages/plugins/connections/src/client/index.ts';
import { installSftpWire } from '../fixtures/sftp-wire.ts';
import * as Catalog from '../../packages/plugins/catalog/src/client/index.ts';
import * as Files from '../../packages/plugins/files/src/client/index.ts';
import * as Terminals from '../../packages/plugins/terminals/src/client/index.ts';
import { runProfile } from '../../apps/cli/src/profile-boot.ts';

const ssh = createRequire(resolve('packages/plugins/connections/package.json'))(
  'ssh2',
) as typeof Ssh2;
it('runs real SSH through generated Remote, visible host-key approval, owned storage, binary terminals and unload', async () => {
  const secret = 'controlled-session-password';
  let remoteRoot = '';
  const sftpChannels = new Set<ReturnType<typeof installSftpWire>>();
  const peers = new Set<Ssh2.Connection>();
  const forwardings = new Set<ReturnType<typeof installSshForwardingWire>>();
  const echoPeers = new Set<Socket>();
  const echo = createTcpServer({ allowHalfOpen: true }, (socket) => {
    echoPeers.add(socket);
    socket.on('error', () => {});
    socket.once('close', () => echoPeers.delete(socket));
    socket.pipe(socket);
  });
  echo.listen(0, '127.0.0.1');
  await once(echo, 'listening');
  const echoAddress = echo.address();
  if (!echoAddress || typeof echoAddress === 'string') throw new Error('Echo fixture did not bind');
  let authentications = 0;
  const executionCommands: string[] = [];
  let terminalType: string | undefined;
  const terminalEnvironment: Record<string, string> = {};
  const createServer = () =>
    new ssh.Server(
      { hostKeys: [ssh.utils.generateKeyPairSync('ecdsa', { bits: 256 }).private] },
      (peer) => {
        peers.add(peer);
        const forwarding = installSshForwardingWire(peer);
        forwardings.add(forwarding);
        peer.once('close', () => {
          void forwarding.close().then(() => forwardings.delete(forwarding));
        });
        peer.on('error', () => {});
        peer.once('close', () => peers.delete(peer));
        peer.on('authentication', (request) => {
          if (
            request.method === 'password' &&
            request.username === 'fixture' &&
            request.password === secret
          ) {
            authentications++;
            request.accept();
          } else request.reject(['password']);
        });
        peer.on('ready', () =>
          peer.on('session', (accept) => {
            const session = accept();
            session.on('sftp', (approve) => {
              const channel = installSftpWire(approve(), remoteRoot);
              sftpChannels.add(channel);
              void channel.closed.then(() => sftpChannels.delete(channel));
            });
            session.on('pty', (approve, _reject, info) => {
              terminalType =
                'term' in info && typeof info.term === 'string' ? info.term : undefined;
              approve?.();
            });
            session.on('env', (approve, _reject, info) => {
              terminalEnvironment[info.key] = info.val;
              approve?.();
            });
            session.on('exec', (approve, _reject, info) => {
              executionCommands.push(info.command);
              const channel = approve();
              channel.write('/bin/sh');
              channel.exit(0);
              channel.end();
            });
            session.on('shell', (approve) => {
              const channel = approve();
              channel.write('Fixture SSH shell ready\r\n');
              channel.on('data', (data: Buffer) => channel.write(data));
              channel.on('eof', () => channel.end());
            });
            session.on('window-change', (approve) => approve?.());
          }),
        );
      },
    );
  let server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('SSH fixture did not bind');
  const home = await mkdtemp(join(tmpdir(), 'axterm-connections-profile-'));
  remoteRoot = join(home, 'sftp-fixture');
  await mkdir(remoteRoot);
  await writeFile(join(remoteRoot, 'notes.txt'), 'WIRE_PRIVATE_TEXT\r\nsecond\r\n');
  await writeFile(join(remoteRoot, 'binary.bin'), Buffer.from([0xff, 0xfe, 0, 1]));
  await writeFile(join(remoteRoot, 'large.bin'), Buffer.alloc(2 * 1024 * 1024 + 1));
  let application: Awaited<ReturnType<typeof runProfile>> | undefined;
  let client: Context | undefined;
  let terminalStream: Terminals.TerminalStream | undefined;
  const sockets = new Set<WebSocket>();
  try {
    const vault = new EncryptedVault(join(home, 'vault-v2'));
    await vault.open();
    const jumpCredential = await vault.put({ kind: 'password', label: 'Controlled jump', secret });
    await vault.close();
    const profile = join(home, 'profiles/web');
    await mkdir(profile, { recursive: true });
    await writeFile(
      join(profile, 'package.json'),
      JSON.stringify({
        name: 'isolated-connections-profile',
        private: true,
        axterm: {
          profile: {
            bundles: [
              '@axterm/bundle-base',
              '@axterm/bundle-web',
              '@axterm/bundle-catalog',
              '@axterm/bundle-configuration',
              '@axterm/bundle-terminals',
              '@axterm/bundle-connections',
              '@axterm/bundle-files',
              '@axterm/bundle-automation',
            ],
          },
        },
      }),
    );
    application = await runProfile({
      profile: 'web',
      home,
      installAnchor: resolve('apps/cli/package.json'),
      templates: {},
      patchFiles: [],
      args: [],
      requiredServices: [
        'connections',
        'connectionsController',
        'terminalController',
        'terminalFacts',
        'automationController',
        'webStartup',
      ],
      prepare(ctx) {
        ctx.provide('webAssets', {
          index: resolve('apps/web/dist/index.html'),
          authenticationPage: resolve('apps/web/dist/auth.html'),
        });
      },
    });
    const host = application.ctx;
    const origin = new URL(host.webStartup.url).origin;
    const token = (await readFile(host.webStartup.tokenFile!, 'utf8')).trim();
    const auth = await fetch(origin + '/connect', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token }),
    });
    expect(auth.status).toBe(200);
    const cookie = auth.headers.get('set-cookie')!.split(';')[0]!;
    client = new Context();
    await client.plugin(Registry);
    installConnection(client, {
      interactions: 'answer',
      recovery: { backoffBaseMs: 10 },
      transport: {
        streamBaseUrl: origin + '/',
        fetch: (input, init) =>
          fetch(new URL(input, origin + '/'), {
            ...init,
            headers: { ...Object.fromEntries(new Headers(init.headers)), cookie },
          }),
        createWebSocket: (url) => {
          const socket = new WebSocket(url, { headers: { cookie, origin } });
          sockets.add(socket);
          socket.once('close', () => sockets.delete(socket));
          return socket as unknown as ConnectionWebSocket;
        },
      },
    });
    await client.plugin(ClientGateway);
    await client.plugin({
      inject: ['typert', 'remote', 'connection'],
      async apply(scope) {
        const unmount = await scope.remote.$mount(catalogDescriptor);
        scope.effect(() => unmount);
        await scope.inject(['remote.catalog'], (owner) => {
          const catalog = new Catalog.CatalogModel(owner);
          owner.provide('catalogModel', catalog);
          owner.effect(() => () => catalog.dispose());
        });
      },
    });
    const modelOwner = client.plugin(Connections);
    await modelOwner;
    await client.plugin(Terminals);
    await client.plugin(Files);
    await client.plugin(Automation);
    const model = client.connectionsModel;
    await vi.waitFor(() => expect(model.getSnapshot().status).toBe('ready'));
    const key = randomUUID();
    const input = {
      target: {
        hostname: '127.0.0.1',
        port: address.port,
        username: 'fixture',
        authType: 'password' as const,
      },
      temporarySecret: secret,
    };
    const waitChallenge = (id: string, kind: 'unknownHostKey' | 'changedHostKey') =>
      vi.waitFor(() => {
        const state = model.getSnapshot();
        if (state.status !== 'ready') throw new Error('Connection model is not ready');
        const item = state.baseline.interactions.find((item) => item.connectionId === id);
        expect(item?.kind).toBe(kind);
        return item!;
      });
    const beforeStale = host.connections.list().length;
    await expect(
      client.remote.connections.createConnection(randomUUID(), randomUUID(), input),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: 'connections/failure', details: { reason: 'stale' } },
    });
    expect(host.connections.list()).toHaveLength(beforeStale);
    const rejected = await model.createConnection(randomUUID(), input);
    const rejectedChallenge = await waitChallenge(rejected.id, 'unknownHostKey');
    await model.respondInteraction(rejectedChallenge.id, { accepted: false, remember: true });
    await vi.waitFor(() => expect(host.connections.get(rejected.id).state).toBe('failed'));
    expect(await model.listKnownHostKeys()).toEqual([]);
    expect(authentications).toBe(0);
    await model.closeConnection(rejected.id);
    const canceled = await model.createConnection(randomUUID(), input);
    const canceledChallenge = await waitChallenge(canceled.id, 'unknownHostKey');
    await model.closeConnection(canceled.id);
    await expect(
      model.respondInteraction(canceledChallenge.id, { accepted: true, remember: true }),
    ).rejects.toMatchObject({ details: { reason: 'not-found' } });
    expect(await model.listKnownHostKeys()).toEqual([]);
    expect(authentications).toBe(0);
    const created = await model.createConnection(key, input);
    const challenge = await waitChallenge(created.id, 'unknownHostKey');
    expect(challenge.severity).toBe('warning');
    await model.respondInteraction(challenge.id, { accepted: true, remember: true });
    await vi.waitFor(() => expect(host.connections.get(created.id).state).toBe('ready'));
    expect((await model.createConnection(key, input)).id).toBe(created.id);
    expect(authentications).toBe(1);
    const acceptedState = model.getSnapshot();
    if (acceptedState.status !== 'ready') throw new Error('Missing accepted connections');
    expect(await model.getConnectionCommandOutcome(acceptedState.baseline.generation, key)).toEqual(
      { status: 'accepted', id: created.id },
    );
    expect(
      await model.getConnectionCommandOutcome(acceptedState.baseline.generation, randomUUID()),
    ).toEqual({ status: 'missing' });
    expect(
      await client.remote.connections.getConnectionCommandOutcome(randomUUID(), key),
    ).toMatchObject({ ok: false, error: { details: { reason: 'stale' } } });
    expect(await client.remote.connections.closeConnection(randomUUID(), created.id)).toMatchObject(
      { ok: false, error: { details: { reason: 'stale' } } },
    );
    expect(host.connections.get(created.id).state).toBe('ready');
    expect(authentications).toBe(1);

    await vi.waitFor(() => {
      const state = model.getSnapshot();
      expect(state.status === 'ready' && state.baseline.knownHosts.length).toBe(1);
    });
    expect(JSON.stringify(model.getSnapshot())).not.toContain(secret);
    await vi.waitFor(() => expect(client!.catalogModel.getSnapshot().status).toBe('ready'));
    const catalog = client.catalogModel;
    const recent = await vi.waitFor(() => {
      const state = catalog.getSnapshot();
      if (state.status !== 'ready') throw new Error('Catalog not ready');
      const item = state.baseline.history.items.find(
        (item) => item.hostname === '127.0.0.1' && item.port === address.port,
      );
      expect(item).toBeDefined();
      return item!;
    });
    expect(recent.hostId).toBeNull();
    const beforeHistory = host.connections.list().length;
    expect(
      await client.remote.connections.reconnectConnectionHistory(
        randomUUID(),
        randomUUID(),
        recent.id,
        { temporarySecret: secret },
        `"v${recent.version}"`,
      ),
    ).toMatchObject({ ok: false, error: { details: { reason: 'stale' } } });
    await expect(
      model.reconnectConnectionHistory(
        randomUUID(),
        recent.id,
        { temporarySecret: secret },
        '"v999"',
      ),
    ).rejects.toMatchObject({ details: { reason: 'precondition-failed' } });
    expect(host.connections.list()).toHaveLength(beforeHistory);
    const reconnectKey = randomUUID();
    const historyEtag = `"v${recent.version}"`;
    const fromHistory = await model.reconnectConnectionHistory(
      reconnectKey,
      recent.id,
      { temporarySecret: secret },
      historyEtag,
    );
    await vi.waitFor(() => expect(host.connections.get(fromHistory.id).state).toBe('ready'));
    expect(
      (
        await model.reconnectConnectionHistory(
          reconnectKey,
          recent.id,
          { temporarySecret: secret },
          historyEtag,
        )
      ).id,
    ).toBe(fromHistory.id);
    const beforeChangedHistory = host.connections.list().length;
    await expect(
      model.reconnectConnectionHistory(
        reconnectKey,
        recent.id,
        { temporarySecret: 'CHANGED_HISTORY_SECRET_MUST_NOT_AUTHENTICATE' },
        historyEtag,
      ),
    ).rejects.toMatchObject({ code: 'connections/failure', details: { reason: 'conflict' } });
    expect(host.connections.list()).toHaveLength(beforeChangedHistory);
    await model.closeConnection(fromHistory.id);
    await model.closeConnection(fromHistory.id);
    const toSave = await vi.waitFor(() => {
      const state = catalog.getSnapshot();
      if (state.status !== 'ready') throw new Error('Catalog not ready');
      const item = state.baseline.history.items.find((item) => item.id === recent.id)!;
      expect(item.version).toBeGreaterThan(recent.version);
      return { item, tree: state.baseline.bookmarks };
    });
    const promoted = await catalog.promoteConnectionHistoryToBookmark(
      randomUUID(),
      recent.id,
      { title: 'Saved from real SSH history' },
      `"v${toSave.item.version}"`,
      toSave.tree.etag,
    );
    expect(promoted.createdHost).toBe(true);
    await catalog.updateHost(
      randomUUID(),
      promoted.hostId,
      { credentialRef: jumpCredential.ref },
      '"v1"',
    );
    const stored = await model.reconnectConnectionHistory(
      randomUUID(),
      recent.id,
      {},
      `"v${promoted.historyVersion}"`,
    );
    await vi.waitFor(() => expect(host.connections.get(stored.id).state).toBe('ready'));
    expect(host.connections.get(stored.id).hostId).toBe(promoted.hostId);
    await model.closeConnection(stored.id);

    const savedHost = await client.catalogModel.createHost(randomUUID(), {
      name: 'Tunnel reference Host',
      credentialRef: jumpCredential.ref,
      hostname: '127.0.0.1',
      port: address.port,
      username: 'fixture',
      authType: 'password',
    });
    const profileInput = {
      name: 'Owned saved tunnel',
      hostId: savedHost.ids[0]!,
      type: 'local' as const,
      bindHost: '127.0.0.1',
      bindPort: 0,
      targetHost: '127.0.0.1',
      targetPort: echoAddress.port,
      allowNonLoopback: false,
    };
    const profileKey = randomUUID();
    const savedProfile = await model.createTunnelProfile(profileKey, profileInput);
    expect(await model.createTunnelProfile(profileKey, profileInput)).toEqual(savedProfile);
    await vi.waitFor(() => {
      const value = model.getSnapshot();
      expect(
        value.status === 'ready' &&
          value.baseline.tunnelProfiles.some(
            (item) => item.id === savedProfile.ids[0] && item.version === 1,
          ),
      ).toBe(true);
    });
    await expect(
      model.updateTunnelProfile(
        randomUUID(),
        savedProfile.ids[0]!,
        { name: 'Missing revision' },
        undefined,
      ),
    ).rejects.toMatchObject({ details: { reason: 'precondition-required' } });
    const updateKey = randomUUID();
    const updatedProfile = await model.updateTunnelProfile(
      updateKey,
      savedProfile.ids[0]!,
      { name: 'Updated saved tunnel' },
      '"v1"',
    );
    expect(
      await model.updateTunnelProfile(
        updateKey,
        savedProfile.ids[0]!,
        { name: 'Updated saved tunnel' },
        '"v1"',
      ),
    ).toEqual(updatedProfile);
    await model.retry();
    await vi.waitFor(() => {
      const value = model.getSnapshot();
      expect(
        value.status === 'ready' &&
          value.baseline.tunnelProfiles.some(
            (item) => item.id === savedProfile.ids[0] && item.version === 2,
          ),
      ).toBe(true);
    });
    const removeKey = randomUUID();
    const removedProfile = await model.deleteTunnelProfile(removeKey, savedProfile.ids[0]!, '"v2"');
    expect(await model.deleteTunnelProfile(removeKey, savedProfile.ids[0]!, '"v2"')).toEqual(
      removedProfile,
    );
    expect(await model.createTunnelProfile(profileKey, profileInput)).toEqual(savedProfile);
    await vi.waitFor(() => {
      const value = model.getSnapshot();
      expect(value.status === 'ready' && value.baseline.tunnelProfiles.length).toBe(0);
    });
    const tunnelBytes = Buffer.alloc(4 * 1024 * 1024, 0x6b);
    for (const type of ['local', 'remote', 'dynamic'] as const) {
      const nonce = randomUUID();
      const request = {
        connectionId: created.id,
        profile: {
          name: 'Owned ' + type,
          hostId: created.hostId!,
          type,
          bindHost: '127.0.0.1',
          bindPort: 0,
          targetHost: type === 'dynamic' ? null : '127.0.0.1',
          targetPort: type === 'dynamic' ? null : echoAddress.port,
          allowNonLoopback: false,
        },
      };
      const tunnel = await model.startTunnel(nonce, request);
      expect((await model.startTunnel(nonce, request)).id).toBe(tunnel.id);
      await vi.waitFor(() => {
        const state = model.getSnapshot();
        expect(
          state.status === 'ready' &&
            state.baseline.tunnels.some(
              (value) => value.id === tunnel.id && value.state === 'active',
            ),
        ).toBe(true);
      });
      const socket = createConnection({ host: '127.0.0.1', port: tunnel.bindPort });
      socket.on('error', () => {});
      const chunks: Buffer[] = [];
      socket.on('data', (bytes) => chunks.push(bytes));
      const closed = once(socket, 'close');
      await once(socket, 'connect');
      if (type === 'dynamic') {
        const port = Buffer.alloc(2);
        port.writeUInt16BE(echoAddress.port);
        socket.end(
          Buffer.concat([Buffer.from([5, 1, 0, 5, 1, 0, 1, 127, 0, 0, 1]), port, tunnelBytes]),
        );
      } else socket.end(tunnelBytes);
      await closed;
      const received = Buffer.concat(chunks).subarray(type === 'dynamic' ? 12 : 0);
      expect(received.length, type).toBe(tunnelBytes.length);
      expect(createHash('sha256').update(received).digest('hex')).toBe(
        createHash('sha256').update(tunnelBytes).digest('hex'),
      );
      await model.stopTunnel(tunnel.id);
      await expect(model.startTunnel(nonce, request)).rejects.toMatchObject({
        details: { reason: 'receipt-expired' },
      });
      await vi.waitFor(() => {
        const state = model.getSnapshot();
        expect(state.status === 'ready' && state.baseline.tunnels.length).toBe(0);
      });
    }
    await vi.waitFor(() =>
      expect([...forwardings].reduce((count, value) => count + value.resourceCount(), 0)).toBe(0),
    );

    const jumped = await host.connections.openStream(
      {
        target: { host: '127.0.0.1', port: echoAddress.port },
        proxy: { mode: 'direct' },
        username: '',
        jumpHostId: savedHost.ids[0]!,
        timeoutMs: 5000,
      },
      new AbortController().signal,
    );
    const jumpBytes = Buffer.alloc(4 * 1024 * 1024, 0x6a);
    const jumpReceived: Buffer[] = [];
    let jumpLength = 0;
    const jumpRoundTrip = new Promise<void>((resolve, reject) => {
      jumped.stream.on('data', (data: Buffer) => {
        jumpReceived.push(data);
        jumpLength += data.length;
        if (jumpLength === jumpBytes.length) resolve();
      });
      jumped.stream.once('error', reject);
    });
    jumped.stream.write(jumpBytes);
    await jumpRoundTrip;
    expect(createHash('sha256').update(Buffer.concat(jumpReceived)).digest('hex')).toBe(
      createHash('sha256').update(jumpBytes).digest('hex'),
    );
    await jumped.close();
    expect(jumped.stream.closed).toBe(true);

    const automation = client.automationModel;
    await vi.waitFor(() => expect(automation.getSnapshot().status).toBe('ready'));
    const catalogState = client.catalogModel.getSnapshot();
    if (catalogState.status !== 'ready') throw new Error('Catalog is unavailable');
    const batchBookmark = await client.catalogModel.createBookmark(
      randomUUID(),
      { protocol: 'ssh', hostId: savedHost.ids[0]!, title: 'Owned batch' },
      catalogState.baseline.bookmarks.etag,
    );
    const batchKey = randomUUID();
    const batchInput = {
      name: 'SSH batch',
      bookmarkIds: [batchBookmark.ids[0]!],
      steps: [{ id: randomUUID(), name: 'Inspect', command: 'printf AXTERM_OWNED_BATCH_EXEC' }],
    };
    const batch = await automation.createBatchOperation(batchKey, batchInput);
    expect(await automation.createBatchOperation(batchKey, batchInput)).toEqual(batch);
    await vi.waitFor(() => {
      const state = automation.getSnapshot();
      expect(
        state.status === 'ready' &&
          state.baseline.batches.find((item) => item.id === batch.ids[0])?.state,
      ).toBe('succeeded');
    });
    expect(
      executionCommands.filter((command) => command === batchInput.steps[0]!.command),
    ).toHaveLength(1);
    let automationState = automation.getSnapshot();
    if (automationState.status !== 'ready') throw new Error('Automation is unavailable');
    const group = await automation.createQuickCommandGroup(
      randomUUID(),
      { name: 'Owned commands', parentId: null },
      automationState.baseline.quickCommands.etag,
    );
    automationState = automation.getSnapshot();
    if (automationState.status !== 'ready') throw new Error('Automation is unavailable');
    expect(
      automationState.baseline.quickCommands.groups.some((item) => item.id === group.ids[0]),
    ).toBe(true);
    await automation.createTrigger(
      randomUUID(),
      {
        name: 'SSH prompt rule',
        enabled: true,
        match: { type: 'text', value: 'AXTERM_TRIGGER_PROBE', caseSensitive: true },
        action: { type: 'send', value: 'AXTERM_TRIGGER_RESPONSE' },
        sendEnter: true,
        mode: 'once',
        cooldownMs: 0,
      },
      automationState.baseline.triggers.etag,
    );

    const retainedTunnel = await model.startTunnel(randomUUID(), {
      connectionId: created.id,
      profile: {
        name: 'Connection-owned lifetime',
        hostId: created.hostId!,
        type: 'local',
        bindHost: '127.0.0.1',
        bindPort: 0,
        targetHost: '127.0.0.1',
        targetPort: echoAddress.port,
        allowNonLoopback: false,
      },
    });
    await vi.waitFor(() => expect(client!.terminalFactsModel.getSnapshot().status).toBe('ready'));
    const terminalProfile = await client.terminalFactsModel.createTerminalProfile(randomUUID(), {
      name: 'SSH profile',
      term: 'screen-256color',
      lang: 'en_US.UTF-8',
      fontSize: 19,
      env: { PROFILE_MARKER: 'profile' },
    });
    const opened = await client.remote.terminals.createTerminal(
      host.runtimeIdentity.generation,
      randomUUID(),
      {
        kind: 'ssh',
        connectionId: created.id,
        profileId: terminalProfile.ids[0]!,
        environment: { PROFILE_MARKER: 'command-line' },
        cols: 80,
        rows: 24,
      },
    );
    if (!opened.ok) throw opened.error;
    expect(opened.value).toMatchObject({
      profileId: terminalProfile.ids[0],
      appearance: { fontSize: 19 },
    });
    expect(terminalType).toBe('screen-256color');
    expect(terminalEnvironment).toMatchObject({
      LANG: 'en_US.UTF-8',
      PROFILE_MARKER: 'command-line',
    });
    const target = { protocol: 'sftp' as const, connectionId: created.id };
    const files = client.fileGrantsModel;
    expect(await files.getRemoteHome(target)).toEqual({ path: '/' });
    const leased = await host.connections.openFiles(target);
    try {
      expect(await leased.filesystem.list('/')).toHaveLength(3);
    } finally {
      await leased.close();
    }
    expect((await files.listRemoteDirectory(target, '/')).entries).toHaveLength(3);
    const remoteDirectory = files.openRemoteDirectory(target, '/');
    await vi.waitFor(() => {
      const state = remoteDirectory.getSnapshot();
      expect(state.status === 'ready' && state.baseline.entries.length).toBe(3);
    });
    expect(JSON.stringify(remoteDirectory.getSnapshot())).not.toContain('WIRE_PRIVATE_TEXT');
    const text = await files.readRemoteText(target, '/notes.txt');
    expect(text).toMatchObject({ content: 'WIRE_PRIVATE_TEXT\r\nsecond\r\n', lineEnding: 'crlf' });
    await expect(files.readRemoteText(target, '/binary.bin')).rejects.toMatchObject({
      details: { reason: 'unavailable' },
    });
    await expect(files.readRemoteText(target, '/large.bin')).rejects.toMatchObject({
      details: { reason: 'unavailable' },
    });
    const createdKey = randomUUID();
    const createdFile = await files.createRemoteEntry(createdKey, target, {
      path: '/created.txt',
      type: 'file',
    });
    expect(
      await files.createRemoteEntry(createdKey, target, { path: '/created.txt', type: 'file' }),
    ).toEqual(createdFile);
    await expect(
      files.createRemoteEntry(createdKey, target, { path: '/different.txt', type: 'file' }),
    ).rejects.toMatchObject({ details: { reason: 'conflict' } });
    await files.chmodRemoteEntry(randomUUID(), target, { path: '/created.txt', mode: 0o640 });
    expect((await files.statRemoteEntry(target, '/created.txt')).mode! & 0o777).toBe(0o640);
    await files.renameRemoteEntry(randomUUID(), target, {
      from: '/created.txt',
      to: '/renamed.txt',
    });
    await files.operateRemoteEntries(randomUUID(), target, {
      paths: ['/renamed.txt'],
      destination: '/',
      operation: 'copy',
    });
    expect(
      (await files.listRemoteDirectory(target, '/')).entries.map((entry) => entry.name),
    ).toContain('renamed(copy-1).txt');
    await files.deleteRemoteEntry(randomUUID(), target, '/renamed(copy-1).txt');
    const writeKey = randomUUID();
    const writeInput = {
      path: '/notes.txt',
      content: 'attempt',
      overwriteRevision: text.revision,
      lineEnding: 'lf' as const,
    };
    // This actual v3 server does not advertise POSIX replacement. It must fail closed.
    await expect(files.writeRemoteText(writeKey, target, writeInput)).rejects.toMatchObject({
      details: { reason: 'unavailable' },
    });
    expect(await readFile(join(remoteRoot, 'notes.txt'), 'utf8')).toBe(text.content);
    expect(
      (await files.listRemoteDirectory(target, '/')).entries.some((entry) =>
        entry.name.startsWith('.axterm-'),
      ),
    ).toBe(false);
    await writeFile(join(remoteRoot, 'notes.txt'), 'changed by peer');
    await expect(files.writeRemoteText(randomUUID(), target, writeInput)).rejects.toMatchObject({
      details: { reason: 'conflict' },
    });
    await expect(files.writeRemoteText(writeKey, target, writeInput)).rejects.toMatchObject({
      details: { reason: 'unavailable' },
    });
    await remoteDirectory.retry();
    await vi.waitFor(() => {
      const state = remoteDirectory.getSnapshot();
      expect(
        state.status === 'ready' &&
          state.baseline.entries.some((entry) => entry.name === 'renamed.txt'),
      ).toBe(true);
    });
    await remoteDirectory.dispose();
    await vi.waitFor(() => expect(sftpChannels.size).toBe(0));
    const connection = client.get('connection') as unknown as ConnectionHandle;
    let output = '';
    const controls: unknown[] = [];
    const decoder = new TextDecoder();
    terminalStream = new Terminals.TerminalStream(connection, {
      terminalId: opened.value.id,
      writer: {
        write(bytes, consumed) {
          output = (
            output + (typeof bytes === 'string' ? bytes : decoder.decode(bytes, { stream: true }))
          ).slice(-16_384);
          consumed();
        },
      },
      control: (control) => controls.push(control),
    });
    await vi.waitFor(() =>
      expect(controls).toContainEqual(expect.objectContaining({ type: 'ready' })),
    );
    expect(terminalStream.sendInput('AXTERM_SSH_WIRE_OK\n')).toBe(true);
    await vi.waitFor(() => expect(output).toContain('AXTERM_SSH_WIRE_OK'));
    expect(terminalStream.sendInput('AXTERM_TRIGGER_PROBE\n')).toBe(true);
    await vi.waitFor(() => expect(output).toContain('AXTERM_TRIGGER_RESPONSE'));
    await automation.retry();
    await vi.waitFor(() => expect(automation.getSnapshot().status).toBe('ready'));
    expect(await host.desktopTaskInspection.inspect(new AbortController().signal)).toEqual({
      active: true,
    });
    await model.closeConnection(created.id);
    await vi.waitFor(() => {
      const value = model.getSnapshot();
      expect(
        value.status === 'ready' &&
          value.baseline.tunnels.some(
            (item) => item.id === retainedTunnel.id && item.state === 'failed',
          ),
      ).toBe(true);
    });
    await model.stopTunnel(retainedTunnel.id);
    await vi.waitFor(() => expect(host.terminals.resourceCount()).toBe(0));
    expect(await host.desktopTaskInspection.inspect(new AbortController().signal)).toEqual({
      active: false,
    });
    const failed = await model.createConnection(randomUUID(), {
      ...input,
      temporarySecret: 'wrong-controlled-password',
    });
    await vi.waitFor(() => expect(host.connections.get(failed.id).state).toBe('failed'));
    expect(JSON.stringify(model.getSnapshot())).not.toContain('wrong-controlled-password');
    await model.closeConnection(failed.id);
    const previousKey = (await model.listKnownHostKeys())[0]!;
    for (const peer of peers) peer.end();
    await new Promise<void>((done) => server.close(() => done()));
    server = createServer();
    server.listen(address.port, '127.0.0.1');
    await once(server, 'listening');
    const changed = await model.createConnection(randomUUID(), input);
    const changedChallenge = await waitChallenge(changed.id, 'changedHostKey');
    expect(changedChallenge.severity).toBe('high');
    expect(changedChallenge.presentation).toMatchObject({
      kind: 'sshHostKey',
      previousFingerprint: previousKey.fingerprint,
    });
    await model.respondInteraction(changedChallenge.id, { accepted: false, remember: true });
    await vi.waitFor(() => expect(host.connections.get(changed.id).state).toBe('failed'));
    expect(await model.listKnownHostKeys()).toEqual([previousKey]);
    await model.closeConnection(changed.id);
    const acceptedChange = await model.createConnection(randomUUID(), input);
    await model.respondInteraction((await waitChallenge(acceptedChange.id, 'changedHostKey')).id, {
      accepted: true,
      remember: true,
    });
    await vi.waitFor(() => expect(host.connections.get(acceptedChange.id).state).toBe('ready'));
    const replacement = (await model.listKnownHostKeys())[0]!;
    expect(replacement).toMatchObject({ id: previousKey.id, version: 2 });
    expect(replacement.publicKey).not.toBe(previousKey.publicKey);
    await model.closeConnection(acceptedChange.id);
    await modelOwner.dispose();
    expect(() => model.subscribe(() => {})).toThrow('CONNECTIONS_MODEL_CLOSED');
  } finally {
    terminalStream?.dispose();
    await client?.fiber.dispose();
    for (const socket of sockets) {
      socket.on('error', () => {});
      socket.terminate();
    }
    await application?.shutdown.shutdown(0);
    for (const peer of peers) peer.end();
    await new Promise<void>((done) => server.close(() => done()));
    await Promise.all([...sftpChannels].map((channel) => channel.closed));
    await Promise.all([...forwardings].map((value) => value.close()));
    for (const socket of echoPeers) socket.destroy();
    await new Promise<void>((done) => echo.close(() => done()));
    await rm(home, { recursive: true, force: true });
  }
}, 30_000);
