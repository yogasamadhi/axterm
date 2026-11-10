import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import type { ServerResponse } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { connect, createServer, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Context } from '@deepseek-ai/cordis';
import { afterEach, describe, expect, it, vi } from 'vitest';
import WebServer, {
  isLoopbackHost,
  isWildcardHost,
  normalizeBindAddress,
  renderIndexInjections,
  type Config,
} from '../../packages/infra/web-server/src/index.ts';

const contexts: Context[] = [];
const temporary: string[] = [];
afterEach(async () => {
  await Promise.all(contexts.splice(0).map((ctx) => ctx.fiber.dispose()));
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});
async function server(config: Partial<Config> = {}) {
  const ctx = new Context();
  contexts.push(ctx);
  const fiber = await ctx.plugin(WebServer, { host: '127.0.0.1', port: 0, ...config });
  return { ctx, fiber, web: ctx.get('webServer') };
}
function active(web: WebServer | undefined): WebServer {
  if (!web) throw new Error('HTTP service did not activate');
  return web;
}

describe('Level 3 HTTP carrier with real sockets', () => {
  it('rejects Desktop fixed ports, non-loopback and TLS overrides before creating a listener', async () => {
    for (const config of [
      { host: '192.0.2.1', port: 0 },
      { host: '127.0.0.1', port: 4312 },
      {
        host: '127.0.0.1',
        port: 0,
        tls: { certFile: '/must-not-read', keyFile: '/must-not-read' },
      },
    ]) {
      const ctx = new Context();
      contexts.push(ctx);
      ctx.provide('runtimeIdentity', {
        runtimeId: randomUUID(),
        generation: randomUUID(),
        startedAt: new Date().toISOString(),
        pid: process.pid,
        mode: 'desktop',
        appVersion: '0.10.0',
      });
      await expect(ctx.plugin(WebServer, config)).rejects.toThrow(
        'DESKTOP_LISTENER_CONFIGURATION_INVALID',
      );
      expect(ctx.get('webServer')).toBeUndefined();
    }
  });

  it('matches exact, longest prefix and one fallback owner, with idempotent contribution disposal', async () => {
    const { web: provided } = await server();
    const web = active(provided);
    const origin = web.getOrigin();
    const handler = (text: string) => (_req: unknown, res: ServerResponse) => {
      res.end(text);
    };
    const prefix = web.register({ kind: 'prefix', path: '/files', handler: handler('prefix') });
    web.register({ kind: 'prefix', path: '/files/download', handler: handler('longest') });
    const exact = web.register({
      kind: 'exact',
      path: '/files/download',
      handler: handler('exact'),
    });
    const fallback = web.registerFallback(handler('fallback'));
    expect(() =>
      web.register({ kind: 'exact', path: '/files/download', handler: handler('duplicate') }),
    ).toThrow('duplicate');
    expect(() => web.registerFallback(handler('duplicate'))).toThrow('already registered');
    expect(await (await fetch(origin + '/files/download')).text()).toBe('exact');
    exact();
    expect(await (await fetch(origin + '/files/download')).text()).toBe('longest');
    expect(await (await fetch(origin + '/files/download/large')).text()).toBe('longest');
    expect(await (await fetch(origin + '/files-other')).text()).toBe('fallback');
    prefix();
    web.register({ kind: 'prefix', path: '/files', handler: handler('replacement') });
    prefix();
    expect(await (await fetch(origin + '/files/list')).text()).toBe('replacement');
    fallback();
    web.registerFallback(handler('replacement fallback'));
    fallback();
    expect(await (await fetch(origin + '/missing')).text()).toBe('replacement fallback');
  });

  it('contains handler rejection and remains available for the next request', async () => {
    const { web: provided } = await server();
    const web = active(provided);
    const origin = web.getOrigin();
    web.register({
      kind: 'exact',
      path: '/failure',
      handler: () => {
        throw new Error('fixture route failure');
      },
    });
    web.register({
      kind: 'exact',
      path: '/healthy',
      handler: (_req, res) => {
        res.end('healthy');
      },
    });
    expect((await fetch(origin + '/failure')).status).toBe(400);
    expect(await (await fetch(origin + '/healthy')).text()).toBe('healthy');
  });

  it('streams resources, cancels HEAD bodies and leaves SSE/range/already encoded content uncompressed', async () => {
    const { web: provided } = await server({ compression: 'gzip', compressionThresholdBytes: 0 });
    const web = active(provided);
    const origin = web.getOrigin();
    const cancelled = vi.fn();
    web.register({
      kind: 'exact',
      path: '/head',
      resource: async () =>
        new Response(new ReadableStream({ cancel: cancelled }), {
          headers: { 'content-type': 'application/octet-stream' },
        }),
    });
    const head = await fetch(origin + '/head', { method: 'HEAD' });
    expect(head.status).toBe(200);
    expect(await head.text()).toBe('');
    expect(cancelled).toHaveBeenCalledOnce();
    for (const [path, headers, status] of [
      ['/sse', { 'content-type': 'text/event-stream' }, 200],
      [
        '/range',
        { 'content-type': 'application/octet-stream', 'content-range': 'bytes 0-3/4' },
        206,
      ],
      [
        '/encoded',
        { 'content-type': 'application/octet-stream', 'content-encoding': 'identity' },
        200,
      ],
    ] as const) {
      web.register({
        kind: 'exact',
        path,
        resource: async () => new Response('data', { status, headers }),
      });
      const response = await fetch(origin + path, { headers: { 'accept-encoding': 'gzip' } });
      expect(response.headers.get('content-encoding')).not.toBe('gzip');
      expect(await response.text()).toBe('data');
    }
  });

  it('rejects wildcard bind literals and normalizes concrete loopback aliases', () => {
    for (const host of ['0.0.0.0', '::', '::ffff:0.0.0.0']) {
      expect(isWildcardHost(host)).toBe(true);
      expect(() => WebServer.Config({ host, port: 0 })).toThrow();
    }
    for (const host of ['127.1.2.3', '::1', '::ffff:127.0.0.1', '::0.0.0.1'])
      expect(isLoopbackHost(host)).toBe(true);
    expect(normalizeBindAddress('::0.0.0.1')).toBe('::1');
    expect(() => WebServer.Config({ host: 'localhost', port: 0 })).toThrow();
  });

  it('fails activation on an occupied port instead of choosing another listener', async () => {
    const occupied = createServer();
    occupied.listen(0, '127.0.0.1');
    await once(occupied, 'listening');
    try {
      const port = (occupied.address() as AddressInfo).port;
      await expect(server({ port })).rejects.toMatchObject({ code: 'EADDRINUSE' });
      expect(contexts.at(-1)?.get('webServer')).toBeUndefined();
    } finally {
      await new Promise<void>((resolve, reject) =>
        occupied.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });

  it('rejects unavailable or invalid TLS material without starting a plaintext listener', async () => {
    const root = await mkdtemp(join(tmpdir(), 'axterm-http-tls-'));
    temporary.push(root);
    const cert = join(root, 'certificate.pem');
    const key = join(root, 'key.pem');
    await expect(server({ tls: { certFile: cert, keyFile: key } })).rejects.toThrow(
      'cannot read tls',
    );
    expect(contexts.at(-1)?.get('webServer')).toBeUndefined();
    await writeFile(cert, 'not a certificate');
    await writeFile(key, 'not a private key');
    await expect(server({ tls: { certFile: cert, keyFile: key } })).rejects.toThrow(
      'not a usable certificate',
    );
    expect(contexts.at(-1)?.get('webServer')).toBeUndefined();
  });

  it('closes upgraded sockets and refuses contributions after service disposal', async () => {
    const { ctx, web: provided } = await server();
    const web = active(provided);
    const accepted = Promise.withResolvers<void>();
    const release = web.registerUpgrade({
      path: '/binary',
      handler: (_req, socket) => {
        socket.write(
          'HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: fixture\r\n\r\n',
        );
        accepted.resolve();
      },
    });
    expect(() => web.registerUpgrade({ path: '/binary', handler: () => {} })).toThrow('duplicate');
    release();
    web.registerUpgrade({
      path: '/binary',
      handler: (_req, socket) => {
        socket.write(
          'HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: fixture\r\n\r\n',
        );
        accepted.resolve();
      },
    });
    release();
    const socket = connect(web.port!, '127.0.0.1');
    socket.resume();
    try {
      await once(socket, 'connect');
      const closed = once(socket, 'close');
      socket.write(
        'GET /binary HTTP/1.1\r\nHost: localhost\r\nConnection: Upgrade\r\nUpgrade: fixture\r\n\r\n',
      );
      await accepted.promise;
      await ctx.fiber.dispose();
      await closed;
      expect(socket.destroyed).toBe(true);
      expect(() => web.register({ kind: 'exact', path: '/late', handler: () => {} })).toThrow(
        'disposed',
      );
    } finally {
      socket.destroy();
    }
  });

  it('escapes injected globals and retains typed injection order', () => {
    const html = renderIndexInjections('<html><head></head><body></body></html>', [
      {
        kind: 'global',
        name: '__AXTERM_BOOT__',
        value: { title: '</script><script>bad()</script>' },
      },
      { kind: 'script-src', placement: 'body', src: '/plugins/a?x="&z=<script>' },
    ]);
    expect(html).not.toContain('<script>bad()');
    expect(html).toContain('\\u003c/script>');
    expect(html).toContain('&quot;&amp;z=&lt;script&gt;');
    expect(html.indexOf('__AXTERM_BOOT__')).toBeLessThan(html.indexOf('/plugins/a'));
    expect(html).toContain('__AXTERM_BOOT_READY__');
  });
});
