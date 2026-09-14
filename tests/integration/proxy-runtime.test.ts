import { randomUUID } from 'node:crypto';
import { createServer as createHttpServer, type Server as HttpServer } from 'node:http';
import {
  createConnection,
  createServer as createTcpServer,
  type Server as TcpServer,
} from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { createRuntimeClient } from '../../packages/client/src/api-client';
import { startRuntime } from '../../packages/runtime/src/bootstrap/runtime';

const runtimes: Awaited<ReturnType<typeof startRuntime>>[] = [];
const servers: Array<HttpServer | TcpServer> = [];

afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.close()));
  await Promise.all(servers.splice(0).map(closeServer));
});

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

    const runtime = await startRuntime({
      generation: randomUUID(),
      appVersion: '0.10.0',
      mode: 'headless',
    });
    runtimes.push(runtime);
    const client = createRuntimeClient({ resolve: async () => runtime.bootstrap() });
    const endpoint = {
      url: `http://127.0.0.1:${proxyPort}`,
      username: 'proxy-user',
      credentialRef: null,
    } as const;
    try {
      const transient = await client.testProxy({
        source: { kind: 'custom', endpoint, temporaryPassword: 'transient-secret' },
        target: { host: '127.0.0.1', port: targetPort },
        timeoutMs: 2_000,
      });
      expect(transient).toMatchObject({
        reachable: true,
        protocol: 'http',
        proxyHost: '127.0.0.1',
        proxyPort,
        target: { host: '127.0.0.1', port: targetPort },
      });
      expect(JSON.stringify(transient)).not.toContain('transient-secret');
      expect(seenAuthorization).toEqual(['Basic cHJveHktdXNlcjp0cmFuc2llbnQtc2VjcmV0']);

      const settings = await client.settings();
      const global = await client.updateSettings(settings, {
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
      });
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
        await client.testProxy({
          source: { kind: 'global' },
          target: { host: '127.0.0.1', port: targetPort },
          timeoutMs: 2_000,
        }),
      ).toMatchObject({ reachable: true, proxyPort });

      const host = await client.createHost({
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
      });
      expect(
        await client.testProxy({
          source: { kind: 'host', hostId: host.id },
          target: { host: host.hostname, port: host.port },
          timeoutMs: 2_000,
        }),
      ).toMatchObject({ reachable: true, target: { port: targetPort } });

      const direct = await client.updateSettings(global, {
        network: { proxy: { mode: 'direct' } },
      });
      expect(direct.network.proxy).toEqual({ mode: 'direct' });
      await expect(
        client.testProxy({
          source: { kind: 'global' },
          target: { host: '127.0.0.1', port: targetPort },
        }),
      ).rejects.toMatchObject({ code: 'PROXY_NOT_CONFIGURED', status: 409 });
    } finally {
      client.dispose();
    }
  });

  it('rejects proxy URL credentials before any network connection and omits them from errors', async () => {
    const runtime = await startRuntime({
      generation: randomUUID(),
      appVersion: '0.10.0',
      mode: 'headless',
    });
    runtimes.push(runtime);
    const client = createRuntimeClient({ resolve: async () => runtime.bootstrap() });
    try {
      await expect(
        client.testProxy({
          source: {
            kind: 'custom',
            endpoint: {
              url: 'http://proxy-user:url-secret@127.0.0.1:8080',
              username: null,
              credentialRef: null,
            },
          },
          target: { host: '127.0.0.1', port: 22 },
        }),
      ).rejects.toMatchObject({ code: 'VALIDATION_ERROR', status: 400 });
    } finally {
      client.dispose();
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
