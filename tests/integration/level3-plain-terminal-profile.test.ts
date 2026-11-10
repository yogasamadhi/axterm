import { Context } from '@deepseek-ai/cordis';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import WebSocket from 'ws';
import { expect, it, vi } from 'vitest';
import Registry from '@axterm/infra-typert-registry';
import { EncryptedVault } from '@axterm/infra-credential-vault';
import {
  installConnection,
  type ConnectionWebSocket,
  type ConnectionHandle,
} from '../../packages/infra/connection/src/client/index.ts';
import * as Gateway from '../../packages/infra/gateway/src/client/index.ts';
import * as Catalog from '../../packages/plugins/catalog/src/client/index.ts';
import * as Connections from '../../packages/plugins/connections/src/client/index.ts';
import * as Terminals from '../../packages/plugins/terminals/src/client/index.ts';
import type {} from '../../packages/plugins/connections/src/index.ts';
import { runProfile } from '../../apps/cli/src/profile-boot.ts';

it('opens a Vault-backed Telnet bookmark through authenticated Remote and bounded binary terminals, then drains it on Connections unload', async () => {
  const home = await mkdtemp(join(tmpdir(), 'axterm-owned-telnet-profile-'));
  const password = 'CONTROLLED_TELNET_VAULT_SECRET';
  const peers = new Set<Socket>();
  const sockets = new Set<WebSocket>();
  const wire: string[] = [];
  let authenticated = false;
  const server = createServer((socket) => {
    peers.add(socket);
    socket.once('close', () => peers.delete(socket));
    socket.on('error', () => {});
    let phase = 0;
    let pending = '';
    socket.write('login: ');
    socket.on('data', (bytes) => {
      if (phase === 2) {
        socket.write(bytes);
        return;
      }
      pending += bytes.toString();
      const end = pending.indexOf('\r\n');
      if (end < 0) return;
      const line = pending.slice(0, end);
      pending = pending.slice(end + 2);
      if (phase === 0 && line === 'profile-user') {
        phase = 1;
        socket.write('Password: ');
      } else if (phase === 1 && line === password) {
        phase = 2;
        authenticated = true;
        socket.write('TELNET_AUTHENTICATED\r\n');
      } else socket.destroy();
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Fixture did not bind');
  let application: Awaited<ReturnType<typeof runProfile>> | undefined;
  let client: Context | undefined;
  let stream: Terminals.TerminalStream | undefined;
  try {
    const vault = new EncryptedVault(join(home, 'vault-v2'));
    await vault.open();
    const credential = await vault.put({
      kind: 'password',
      label: 'Controlled Telnet fixture',
      secret: password,
    });
    await vault.close();
    const profile = join(home, 'profiles/web');
    await mkdir(profile, { recursive: true });
    await writeFile(
      join(profile, 'package.json'),
      JSON.stringify({
        name: 'owned-plain-terminals-profile',
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
      requiredServices: ['connections', 'terminalController', 'catalog', 'webStartup'],
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
          socket.on('message', (bytes) => wire.push(bytes.toString()));
          socket.once('close', () => sockets.delete(socket));
          return socket as unknown as ConnectionWebSocket;
        },
      },
    });
    await client.plugin(Gateway);
    await client.plugin(Catalog);
    await client.plugin(Connections);
    await client.plugin(Terminals);
    const catalog = client.catalogModel;
    await vi.waitFor(() => expect(catalog.getSnapshot().status).toBe('ready'));
    let state = catalog.getSnapshot();
    if (state.status !== 'ready') throw new Error('Catalog unavailable');
    const connectionProfile = await catalog.createConnectionProfile(randomUUID(), {
      name: 'Telnet credential override',
      telnet: { username: 'profile-user', passwordCredentialRef: credential.ref },
    });
    state = catalog.getSnapshot();
    await vi.waitFor(() => {
      const value = catalog.getSnapshot();
      expect(
        value.status === 'ready' &&
          value.baseline.connectionProfiles.some((item) => item.id === connectionProfile.ids[0]),
      ).toBe(true);
    });
    state = catalog.getSnapshot();
    if (state.status !== 'ready') throw new Error('Catalog unavailable');
    const bookmark = await catalog.createBookmark(
      randomUUID(),
      {
        protocol: 'telnet',
        hostId: null,
        title: 'Owned Telnet',
        connectionProfileId: connectionProfile.ids[0]!,
        telnet: { hostname: '127.0.0.1', port: address.port, username: 'bookmark-user' },
      },
      state.baseline.bookmarks.etag,
    );
    const serial = await client.connectionsModel.listSerialPorts();
    expect(serial.length).toBeLessThanOrEqual(256);
    await expect(
      client.remote.terminals.createTerminal(randomUUID(), randomUUID(), {
        kind: 'local',
        cols: 80,
        rows: 24,
      }),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: 'terminals/failure', details: { reason: 'stale' } },
    });
    const terminal = await client.remote.terminals.createTerminal(
      host.runtimeIdentity.generation,
      randomUUID(),
      {
        kind: 'telnet',
        bookmarkId: bookmark.ids[0]!,
        cols: 80,
        rows: 24,
      },
    );
    if (!terminal.ok) throw terminal.error;
    expect(terminal.value).toMatchObject({ kind: 'telnet', bookmarkId: bookmark.ids[0] });
    let output = '';
    const controls: unknown[] = [];
    stream = new Terminals.TerminalStream(client.get('connection') as unknown as ConnectionHandle, {
      terminalId: terminal.value.id,
      writer: {
        write(bytes, consumed) {
          output = (
            output + (typeof bytes === 'string' ? bytes : new TextDecoder().decode(bytes))
          ).slice(-8192);
          consumed();
        },
      },
      control: (value) => controls.push(value),
    });
    await vi.waitFor(() => expect(authenticated).toBe(true));
    await vi.waitFor(() =>
      expect(controls).toContainEqual(expect.objectContaining({ type: 'ready' })),
    );
    expect(stream.sendInput('OWNED_TELNET_BINARY\n')).toBe(true);
    await vi.waitFor(() => expect(output).toContain('OWNED_TELNET_BINARY'));
    expect(output).not.toContain(password);
    expect(wire.join('')).not.toContain(password);
    expect(JSON.stringify(client.connectionsModel.getSnapshot())).not.toContain(password);
    expect(await host.desktopTaskInspection.inspect(new AbortController().signal)).toEqual({
      active: true,
    });
    await host.connectionsController.dispose();
    await vi.waitFor(() => expect(peers.size).toBe(0));
    expect(host.terminals.resourceCount()).toBe(0);
    expect(await host.desktopTaskInspection.inspect(new AbortController().signal)).toEqual({
      active: false,
    });
  } finally {
    stream?.dispose();
    await client?.fiber.dispose();
    for (const socket of sockets) {
      socket.on('error', () => {});
      socket.terminate();
    }
    await application?.shutdown.shutdown(0);
    for (const peer of peers) peer.destroy();
    await new Promise<void>((done) => server.close(() => done()));
    await rm(home, { recursive: true, force: true });
  }
}, 30_000);
