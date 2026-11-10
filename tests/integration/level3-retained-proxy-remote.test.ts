import { randomUUID } from 'node:crypto';
import { createServer as createHttpServer, type Server as HttpServer } from 'node:http';
import {
  createConnection,
  createServer as createTcpServer,
  type Server as TcpServer,
} from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import connectionsDescriptor from '../../packages/plugins/connections/lib/typert.remote-client.js';
import { remoteProfile, remoteValue } from '../fixtures/level3-remote-profile.ts';

const profiles: Awaited<ReturnType<typeof remoteProfile>>[] = [];
const directories: string[] = [];
const servers: Array<HttpServer | TcpServer> = [];

afterEach(async () => {
  for (const f of profiles.splice(0).reverse()) await f.close();
  await Promise.all(servers.splice(0).map(closeServer));
  for (const path of directories.splice(0)) await rm(path, { recursive: true, force: true });
});
async function fixture() {
  const home = await mkdtemp(join(tmpdir(), 'axterm-proxy-remote-'));
  directories.push(home);
  const f = await remoteProfile(home, { application: true });
  profiles.push(f);
  const unmount = await f.client.remote.$mount(connectionsDescriptor);
  f.client.effect(() => unmount);
  return f;
}

describe('SSH proxy Runtime contract', () => {
  it('tests transient authentication plus persisted global and per-Host HTTP CONNECT paths', async () => {
    const target = createTcpServer((socket) => socket.on('error', () => undefined));
    servers.push(target);
    const targetPort = await listen(target);
    const seenAuthorization: Array<string | undefined> = [];
    const proxy = createHttpServer();
    proxy.on('connect', (request, downstream, head) => {
      seenAuthorization.push(request.headers['proxy-authorization']);
      if (request.headers['proxy-authorization'] !== 'Basic cHJveHktdXNlcjp0cmFuc2llbnQtc2VjcmV0') {
        downstream.end('HTTP/1.1 407 Proxy Authentication Required\r\n\r\n');
        return;
      }
      const separator = request.url?.lastIndexOf(':') ?? -1;
      const host = request.url?.slice(0, separator) ?? '';
      const port = Number(request.url?.slice(separator + 1));
      const upstream = createConnection({ host, port }, () => {
        downstream.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (head.length) upstream.write(head);
        upstream.pipe(downstream);
        downstream.pipe(upstream);
      });
      upstream.on('error', () => downstream.destroy());
      downstream.on('error', () => upstream.destroy());
    });
    servers.push(proxy);
    const proxyPort = await listen(proxy);

    const f = await fixture();
    const endpoint = {
      url: `http://127.0.0.1:${proxyPort}`,
      username: 'proxy-user',
      credentialRef: null,
    } as const;
    try {
      const transient = await remoteValue(
        f.client.remote.connections.testProxy({
          source: { kind: 'custom', endpoint, temporaryPassword: 'transient-secret' },
          target: { host: '127.0.0.1', port: targetPort },
          timeoutMs: 2_000,
        }),
      );
      expect(transient).toMatchObject({
        reachable: true,
        protocol: 'http',
        proxyHost: '127.0.0.1',
        proxyPort,
        target: { host: '127.0.0.1', port: targetPort },
      });
      expect(JSON.stringify(transient)).not.toContain('transient-secret');
      expect(seenAuthorization).toEqual(['Basic cHJveHktdXNlcjp0cmFuc2llbnQtc2VjcmV0']);

      const settings = await remoteValue(f.client.remote.configuration.getSettings());
      await remoteValue(
        f.client.remote.configuration.updateSettings(
          randomUUID(),
          {
            network: {
              proxy: {
                mode: 'custom',
                endpoint: {
                  url: `http://127.0.0.1:${proxyPort}`,
                  username: null,
                  credentialRef: null,
                },
              },
            },
          },
          '"v' + settings.version + '"',
        ),
      );
      proxy.removeAllListeners('connect');
      proxy.on('connect', (request, downstream) => {
        const separator = request.url?.lastIndexOf(':') ?? -1;
        const upstream = createConnection(
          {
            host: request.url?.slice(0, separator) ?? '',
            port: Number(request.url?.slice(separator + 1)),
          },
          () => {
            downstream.write('HTTP/1.1 200 Connection Established\r\n\r\n');
            upstream.pipe(downstream);
            downstream.pipe(upstream);
          },
        );
        upstream.on('error', () => downstream.destroy());
      });
      expect(
        await remoteValue(
          f.client.remote.connections.testProxy({
            source: { kind: 'global' },
            target: { host: '127.0.0.1', port: targetPort },
            timeoutMs: 2_000,
          }),
        ),
      ).toMatchObject({ reachable: true, proxyPort });

      const receipt = await remoteValue(
        f.client.remote.catalog.createHost(randomUUID(), {
          name: 'proxied fixture',
          hostname: '127.0.0.1',
          port: targetPort,
          username: 'fixture',
          proxy: {
            mode: 'custom',
            endpoint: {
              url: `http://127.0.0.1:${proxyPort}`,
              username: null,
              credentialRef: null,
            },
          },
        }),
      );
      const host = await remoteValue(f.client.remote.catalog.getHost(receipt.ids[0]!));
      expect(
        await remoteValue(
          f.client.remote.connections.testProxy({
            source: { kind: 'host', hostId: host.id },
            target: { host: host.hostname, port: host.port },
            timeoutMs: 2_000,
          }),
        ),
      ).toMatchObject({ reachable: true, target: { port: targetPort } });

      const global = await remoteValue(f.client.remote.configuration.getSettings());
      await remoteValue(
        f.client.remote.configuration.updateSettings(
          randomUUID(),
          {
            network: { proxy: { mode: 'direct' } },
          },
          '"v' + global.version + '"',
        ),
      );
      const direct = await remoteValue(f.client.remote.configuration.getSettings());
      expect(direct.network.proxy).toEqual({ mode: 'direct' });
      await expect(
        remoteValue(
          f.client.remote.connections.testProxy({
            source: { kind: 'global' },
            target: { host: '127.0.0.1', port: targetPort },
          }),
        ),
      ).rejects.toMatchObject({ code: 'connections/failure', details: { reason: 'unavailable' } });
    } finally {
      await f.close();
    }
  });

  it('rejects proxy URL credentials before any network connection and omits them from errors', async () => {
    let contacted = 0;
    const proxy = createTcpServer((socket) => {
      contacted++;
      socket.destroy();
    });
    servers.push(proxy);
    const port = await listen(proxy);
    const f = await fixture();
    try {
      const rejected: unknown = await remoteValue(
        f.client.remote.connections.testProxy({
          source: {
            kind: 'custom',
            endpoint: {
              url: `http://proxy-user:url-secret@127.0.0.1:${port}`,
              username: null,
              credentialRef: null,
            },
          },
          target: { host: '127.0.0.1', port: 22 },
        }),
      ).catch((error: unknown) => error);
      expect(rejected).toMatchObject({
        code: 'connections/failure',
        details: { reason: 'invalid-input' },
      });
      expect(contacted).toBe(0);
      expect(JSON.stringify(rejected)).not.toContain('url-secret');
      expect(JSON.stringify(rejected)).not.toContain('proxy-user');
    } finally {
      await f.close();
    }
  });
});

function listen(server: HttpServer | TcpServer): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      const address = server.address();
      if (!address || typeof address === 'string') reject(new Error('Fixture did not bind TCP'));
      else resolve(address.port);
    });
  });
}

function closeServer(server: HttpServer | TcpServer): Promise<void> {
  return new Promise((resolve) => {
    if ('closeAllConnections' in server) server.closeAllConnections();
    server.close(() => resolve());
  });
}
