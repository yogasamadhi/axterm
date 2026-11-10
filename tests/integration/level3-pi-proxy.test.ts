import { createServer, type Server } from 'node:http';
import {
  createConnection,
  createServer as createTcpServer,
  type Server as TcpServer,
  type Socket,
} from 'node:net';
import { once } from 'node:events';
import { createServer as createHttpsServer } from 'node:https';
import { getCACertificates, setDefaultCACertificates } from 'node:tls';
import { getFtpTestCertificate } from '../fixtures/ftp-test-certificate.ts';
import { Context } from '@deepseek-ai/cordis';
import { afterEach, expect, it, vi } from 'vitest';
import Engines from '../../packages/infra/engines/src/index.ts';
import { PiEngineProvider, piEngineConfigSchema } from '../../packages/engines/pi/src/index.ts';
import { EngineModelProvider } from '../../packages/plugins/ai/src/adapters/engine-model.ts';
import { ProxyService } from '../../packages/plugins/connections/src/application/proxy-service.ts';
import { TargetStreams } from '../../packages/plugins/connections/src/adapters/target-streams.ts';
import { TcpProxyConnector } from '../../packages/plugins/connections/src/adapters/proxy/tcp-proxy-connector.ts';
import type { ConnectionsApplication } from '@axterm/plugin-api/host';
import { credentialRef } from '@axterm/plugin-api/credentials';
import { MemoryCredentials } from '../support/level3-memory-credentials.ts';
import { piSseStart, piSseText, piSseEnd, piSseHidden } from '../fixtures/pi-sse.ts';

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
});
async function listen(server: Server | TcpServer) {
  const sockets = new Set<Socket>();
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('error', () => {});
    socket.once('close', () => sockets.delete(socket));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  cleanups.push(async () => {
    const done = once(server, 'close');
    server.close();
    for (const socket of sockets) socket.destroy();
    await done;
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Fixture missing port');
  return address.port;
}
function relay(downstream: Socket, port: number, connected: () => void) {
  const upstream = createConnection({ host: '127.0.0.1', port }, connected);
  upstream.on('error', () => downstream.destroy());
  downstream.on('error', () => upstream.destroy());
  downstream.once('close', () => upstream.destroy());
  upstream.once('close', () => downstream.destroy());
  return upstream;
}
for (const protocol of ['http', 'socks5h'] as const)
  for (const secure of [false, true])
    it(`preserves legacy endpoint/auth through actual ${protocol} routing to ${secure ? 'HTTPS' : 'HTTP'} and owned stream drain`, async () => {
      const seen: {
        path?: string;
        key?: string;
        authorization?: string;
        proxyAuthorization?: string;
        host?: string;
      } = {};
      const certificate = secure ? await getFtpTestCertificate() : undefined;
      const previousCa = getCACertificates('default');
      if (certificate) {
        setDefaultCACertificates([...previousCa, certificate.cert]);
        cleanups.push(async () => setDefaultCACertificates(previousCa));
      }
      const modelHost = secure ? 'localhost' : 'virtual-model.invalid';
      let holdOpen = false;
      let requests = 0;
      const handler: Parameters<typeof createServer>[1] = (request, response) => {
        requests++;
        seen.path = request.url ?? '';
        seen.key = String(request.headers['x-api-key']);
        seen.authorization = String(request.headers.authorization ?? '');
        seen.proxyAuthorization = String(request.headers['proxy-authorization'] ?? '');
        seen.host = String(request.headers.host);
        request.resume();
        request.on('end', () => {
          response.writeHead(200, { 'content-type': 'text/event-stream' });
          const text =
            piSseStart('openai-chat') +
            piSseHidden('openai-chat') +
            piSseText('openai-chat', 'visible result');
          if (holdOpen) response.write(text);
          else response.end(text + piSseEnd('openai-chat'));
        });
      };
      const model = certificate ? createHttpsServer(certificate, handler) : createServer(handler);
      const modelPort = await listen(model);
      const targets: string[] = [];
      const proxyAuth: string[] = [];
      let proxy: Server | TcpServer;
      if (protocol === 'http') {
        const http = createServer();
        http.on('connect', (request, downstream, head) => {
          targets.push(request.url ?? '');
          proxyAuth.push(String(request.headers['proxy-authorization']));
          const peer = relay(downstream as Socket, modelPort, () => {
            downstream.write('HTTP/1.1 200 Connection Established\r\n\r\n');
            if (head.length) peer.write(head);
            peer.pipe(downstream);
            downstream.pipe(peer);
          });
        });
        proxy = http;
      } else {
        proxy = createTcpServer((downstream) => {
          let buffer = Buffer.alloc(0);
          let greeting = true;
          const receive = (chunk: Buffer) => {
            buffer = Buffer.concat([buffer, chunk]);
            if (greeting) {
              if (buffer.length < 2 + buffer[1]!) return;
              buffer = buffer.subarray(2 + buffer[1]!);
              greeting = false;
              downstream.write(Buffer.from([5, 0]));
            }
            if (buffer.length < 5) return;
            if (buffer[3] !== 3) throw new Error('SOCKS fixture requires remote DNS');
            const length = buffer[4]!;
            if (buffer.length < 7 + length) return;
            targets.push(
              buffer.subarray(5, 5 + length).toString() + ':' + buffer.readUInt16BE(5 + length),
            );
            const rest = buffer.subarray(7 + length);
            downstream.off('data', receive);
            const peer = relay(downstream, modelPort, () => {
              downstream.write(Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0, 0]));
              if (rest.length) peer.write(rest);
              peer.pipe(downstream);
              downstream.pipe(peer);
            });
          };
          downstream.on('data', receive);
        });
      }
      const proxyPort = await listen(proxy);
      const root = new Context();
      await root.plugin(MemoryCredentials, {
        PI_KEY: 'PRIVATE_MODEL_KEY',
        PROXY_REF: 'PRIVATE_PROXY_KEY',
      });
      await root.plugin(Engines);
      const proxyService = new ProxyService({} as never, new TcpProxyConnector(), {
        resolveCredential: async (ref) =>
          (await root.credentials.resolve(credentialRef(ref)))!.value,
        readGrantedText: async () => {
          throw new Error('unused');
        },
        revokeGrant: async () => {},
      });
      const streams = new TargetStreams({} as never, proxyService);
      root.provide('connections', {
        openStream: (input, signal) => streams.open(input, signal),
      } as ConnectionsApplication);
      cleanups.push(async () => {
        await root.fiber.dispose();
        await streams.close();
      });
      const settings = piEngineConfigSchema.parse({
        providers: {
          configured: {
            provider: 'axterm-custom',
            api: 'openai-completions',
            baseUrl: `${secure ? 'https' : 'http'}://${modelHost}:${modelPort}/v1`,
            credentialRef: 'PI_KEY',
            models: [{ id: 'fixture-model' }],
            timeoutMs: 2000,
            legacy: { apiPath: '/gateway/stream', auth: 'x-api-key' },
            proxy: {
              url: `${protocol}://127.0.0.1:${proxyPort}`,
              ...(protocol === 'http'
                ? { username: 'proxy-user', credentialRef: 'PROXY_REF' }
                : {}),
            },
          },
        },
      });
      root.engines.register('pi', new PiEngineProvider(root, settings));
      const adapter = new EngineModelProvider(root.engines, 'pi', 'configured');
      const events = [];
      for await (const event of adapter.stream({
        model: 'fixture-model',
        system: 'system',
        prompt: 'hello',
        context: 'reviewed',
        signal: new AbortController().signal,
      }))
        events.push(event);
      expect(events).toContainEqual({ type: 'delta', text: 'visible result' });
      expect(events.at(-1)).toEqual({ type: 'completed' });
      expect(JSON.stringify(events)).not.toMatch(/PRIVATE_|HIDDEN_REASONING/);
      expect(seen).toEqual({
        path: '/v1/gateway/stream',
        key: 'PRIVATE_MODEL_KEY',
        authorization: '',
        proxyAuthorization: '',
        host: `${modelHost}:${modelPort}`,
      });
      expect(targets).toEqual([`${modelHost}:${modelPort}`]);
      if (protocol === 'http')
        expect(proxyAuth).toEqual([
          'Basic ' + Buffer.from('proxy-user:PRIVATE_PROXY_KEY').toString('base64'),
        ]);
      await vi.waitFor(() => expect(streams.resourceCount()).toBe(0));
      expect(requests).toBe(1);
      if (certificate) {
        const wrong = piEngineConfigSchema.parse({
          providers: {
            configured: {
              ...settings.providers.configured!,
              baseUrl: `https://wrong-host.invalid:${modelPort}/v1`,
            },
          },
        });
        root.engines.register('wrong-host', new PiEngineProvider(root, wrong));
        await expect(
          new EngineModelProvider(root.engines, 'wrong-host', 'configured')
            .stream({
              model: 'fixture-model',
              system: '',
              prompt: 'hello',
              context: '',
              signal: new AbortController().signal,
            })
            .next(),
        ).rejects.toThrow('PROVIDER_FAILED');
        expect(requests).toBe(1);
        await vi.waitFor(() => expect(streams.resourceCount()).toBe(0));
        setDefaultCACertificates(previousCa);
        await expect(
          adapter
            .stream({
              model: 'fixture-model',
              system: '',
              prompt: 'hello',
              context: '',
              signal: new AbortController().signal,
            })
            .next(),
        ).rejects.toThrow('PROVIDER_FAILED');
        expect(requests).toBe(1);
        await vi.waitFor(() => expect(streams.resourceCount()).toBe(0));
        setDefaultCACertificates([...previousCa, certificate.cert]);
      }
      holdOpen = true;
      const controller = new AbortController();
      const pending = adapter.stream({
        model: 'fixture-model',
        system: '',
        prompt: 'hello',
        context: '',
        signal: controller.signal,
      });
      expect((await pending.next()).value).toEqual({ type: 'delta', text: 'visible result' });
      controller.abort();
      await vi.waitFor(() => expect(streams.resourceCount()).toBe(0));
      await pending.return(undefined);
      expect(requests).toBe(2);
    });
