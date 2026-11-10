import remoteDesktopDescriptor from '../../packages/plugins/remote-desktop/lib/typert.remote-client.js';
import { Context } from '@deepseek-ai/cordis';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import WebSocket from 'ws';
import { expect, it, vi } from 'vitest';
import Registry from '@axterm/infra-typert-registry';
import { EncryptedVault } from '@axterm/infra-credential-vault';
import {
  installConnection,
  type ConnectionWebSocket,
} from '../../packages/infra/connection/src/client/index.ts';
import * as Gateway from '../../packages/infra/gateway/src/client/index.ts';
import * as Catalog from '../../packages/plugins/catalog/src/client/index.ts';
import * as Connections from '../../packages/plugins/connections/src/client/index.ts';
import * as RemoteDesktop from '../../packages/plugins/remote-desktop/src/client/index.ts';
import { REMOTE_DESKTOP_STREAM_PATH } from '@axterm/plugin-api/remote-desktop';
import type {} from '../../packages/plugins/remote-desktop/src/index.ts';
import { remoteDesktopWire, rdpFirstFrame } from '../fixtures/remote-desktop-wire.ts';
import { createHash } from 'node:crypto';
import type {} from '../../packages/plugins/connections/src/index.ts';
import { runProfile } from '../../apps/cli/src/profile-boot.ts';

it.each(['rdp', 'vnc', 'spice'] as const)(
  'owns authenticated %s Remote metadata, one-time Vault claims and 4 MiB binary transport, then drains on unload',
  async (protocol) => {
    const home = await mkdtemp(join(tmpdir(), 'axterm-owned-remote-desktop-'));
    const password = 'CONTROLLED_DESKTOP_VAULT_SECRET';
    const peer = await remoteDesktopWire(protocol);
    const sockets = new Set<WebSocket>();
    const wire: string[] = [];
    let application: Awaited<ReturnType<typeof runProfile>> | undefined;
    let client: Context | undefined;
    try {
      const vault = new EncryptedVault(join(home, 'vault-v2'));
      await vault.open();
      const credential = await vault.put({
        kind: 'password',
        label: 'Controlled VNC fixture',
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
                '@axterm/bundle-remote-desktop',
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
        requiredServices: ['connections', 'remoteDesktopController', 'catalog', 'webStartup'],
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
            if (!new URL(url).pathname.endsWith('/remote-desktop/credentials'))
              socket.on('message', (bytes) => wire.push(bytes.toString()));
            socket.once('close', () => sockets.delete(socket));
            return socket as unknown as ConnectionWebSocket;
          },
        },
      });
      await client.plugin(Gateway);
      await client.plugin(Catalog);
      await client.plugin(Connections);
      await client.plugin(RemoteDesktop);
      const catalog = client.catalogModel;
      await vi.waitFor(() => expect(catalog.getSnapshot().status).toBe('ready'));
      let state = catalog.getSnapshot();
      if (state.status !== 'ready') throw new Error('Catalog unavailable');
      const connectionProfile = await catalog.createConnectionProfile(randomUUID(), {
        name: 'VNC credential override',
        [protocol]: {
          ...(protocol !== 'spice' ? { username: 'profile-user' } : {}),
          passwordCredentialRef: credential.ref,
        },
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
          protocol,
          hostId: null,
          title: 'Owned VNC',
          connectionProfileId: connectionProfile.ids[0]!,
          [protocol]: {
            hostname: '127.0.0.1',
            port: peer.port,
            ...(protocol !== 'spice' ? { username: 'bookmark-user' } : {}),
          },
        },
        state.baseline.bookmarks.etag,
      );

      expect(Object.hasOwn(remoteDesktopDescriptor.methods, 'remoteDesktop/claimCredentials')).toBe(
        false,
      );
      for (const method of Object.values(remoteDesktopDescriptor.methods))
        expect(JSON.stringify(method.result.jsonSchema)).not.toContain('"password"');
      if (protocol === 'vnc') {
        const assets = await client.remote.remoteDesktop.getProtocolAssets();
        if (!assets.ok) throw assets.error;
        const url = new URL(assets.value.novnc, origin + '/');
        expect((await fetch(url)).status).toBe(401);
        const module = await fetch(url, { headers: { cookie, origin } });
        expect(module.status).toBe(200);
        expect(module.headers.get('content-type')).toContain('javascript');
        const digest = createHash('sha256')
          .update(new Uint8Array(await module.arrayBuffer()))
          .digest('hex');
        expect(url.pathname.endsWith('novnc-' + digest + '.js')).toBe(true);
        url.searchParams.set('unexpected', '1');
        expect((await fetch(url, { headers: { cookie, origin } })).status).toBe(404);
      }
      const model = client.remoteDesktopModel;
      await vi.waitFor(() => expect(model.getSnapshot().status).toBe('ready'));
      const key = randomUUID();
      const created = await client.remote.remoteDesktop.createSession(
        key,
        {
          protocol,
          bookmarkId: bookmark.ids[0]!,
        },
        host.runtimeIdentity.generation,
      );
      if (!created.ok) throw created.error;
      const session = created.value;
      expect(await model.getCommandOutcome(host.runtimeIdentity.generation, key)).toEqual({
        status: 'accepted',
        id: session.id,
      });
      await expect(model.getCommandOutcome(crypto.randomUUID(), key)).rejects.toMatchObject({
        code: 'remoteDesktop/failure',
      });
      expect(
        await client.remote.remoteDesktop.createSession(
          key,
          {
            protocol,
            bookmarkId: bookmark.ids[0]!,
          },
          host.runtimeIdentity.generation,
        ),
      ).toEqual(created);
      await vi.waitFor(() => {
        const state = model.getSnapshot();
        expect(
          state.status === 'ready' && state.baseline.sessions.some((s) => s.id === session.id),
        ).toBe(true);
      });
      expect(JSON.stringify(model.getSnapshot())).not.toContain(password);
      const claim = await model.claimCredentials(session.id);
      expect(claim.password).toBe(password);
      expect(claim.username).toBe(protocol === 'spice' ? '' : 'profile-user');
      await expect(model.claimCredentials(session.id)).rejects.toThrow();
      expect(wire.join('')).not.toContain(password);
      const url = new URL(REMOTE_DESKTOP_STREAM_PATH, origin);
      url.protocol = 'ws:';
      url.searchParams.set('id', session.id);
      const unauthorized = new WebSocket(url, { headers: { origin } });
      unauthorized.on('error', () => {});
      let refusalTimer: ReturnType<typeof setTimeout> | undefined;
      const refused = await new Promise<number>((resolve, reject) => {
        unauthorized.once('unexpected-response', (_request, response) => {
          response.resume();
          unauthorized.terminate();
          resolve(response.statusCode!);
        });
        unauthorized.once('open', () => reject(new Error('Unauthenticated stream opened')));
        unauthorized.once('error', reject);
        refusalTimer = setTimeout(
          () => reject(new Error('Unauthenticated handshake timed out')),
          3000,
        );
      }).finally(() => {
        clearTimeout(refusalTimer);
        unauthorized.terminate();
      });
      expect(refused).toBe(401);
      const socket = new WebSocket(url, { headers: { cookie, origin } });
      sockets.add(socket);
      socket.on('error', () => {});
      await once(socket, 'open');
      if (protocol === 'rdp') {
        const response = once(socket, 'message');
        socket.send(rdpFirstFrame(peer.port));
        const [data, binary] = await response;
        expect(binary).toBe(true);
        expect((data as Buffer)[0]).toBe(0x30);
      }
      const payload = Buffer.alloc(4 * 1024 * 1024, 0x73);
      const received: Buffer[] = [];
      let bytes = 0;
      const roundTrip = new Promise<void>((resolve, reject) => {
        socket.on('message', (data, binary) => {
          if (!binary) {
            reject(new Error('Text protocol bytes'));
            return;
          }
          const chunk = Buffer.from(data as Buffer);
          received.push(chunk);
          bytes += chunk.length;
          if (bytes === payload.length) resolve();
          else if (bytes > payload.length) reject(new Error('Unexpected bytes'));
        });
        socket.once('close', () => {
          if (bytes !== payload.length) reject(new Error('Early close'));
        });
      });
      // Bounded protocol frames; bytes do not enter the Remote metadata model.
      for (let offset = 0; offset < payload.length; offset += 65536)
        socket.send(payload.subarray(offset, offset + 65536));
      await roundTrip;
      expect(createHash('sha256').update(Buffer.concat(received)).digest('hex')).toBe(
        createHash('sha256').update(payload).digest('hex'),
      );
      await model.retry();
      await vi.waitFor(() => {
        const state = model.getSnapshot();
        expect(
          state.status === 'ready' && state.baseline.sessions.some((s) => s.id === session.id),
        ).toBe(true);
      });
      expect(JSON.stringify(model.getSnapshot())).not.toContain(password);
      await host.remoteDesktopController.close();
      await vi.waitFor(() => expect(peer.peers.size).toBe(0));
      expect(await host.desktopTaskInspection.inspect(new AbortController().signal)).toEqual({
        active: false,
      });
    } finally {
      await client?.fiber.dispose();
      for (const socket of sockets) {
        socket.on('error', () => {});
        socket.terminate();
      }
      await application?.shutdown.shutdown(0);
      await peer.close();
      await rm(home, { recursive: true, force: true });
    }
  },
  30000,
);
