import { Agent as HttpAgent, request as requestHttp, type IncomingMessage } from 'node:http';
import { Agent as HttpsAgent, request as requestHttps } from 'node:https';
import { isIP, type Socket } from 'node:net';
import { connect as connectTls, type TLSSocket } from 'node:tls';
import { Readable, type Duplex } from 'node:stream';
import type { ConnectionStreamLease, ConnectionsApplication } from '@axterm/plugin-api/host';
import type { HostProxyConfig } from '@axterm/plugin-api/catalog';
import { EngineError } from '@axterm/engine-api';

/** HTTP framing over an owned Connection lease. The Connection owner supplies HTTP/SOCKS routing. */
export async function requestThroughProxy(
  connections: Pick<ConnectionsApplication, 'openStream'>,
  endpoint: URL,
  init: { method: string; headers: Headers; body?: string; signal: AbortSignal },
  proxy: HostProxyConfig,
  timeoutMs: number,
): Promise<Response> {
  if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password)
    throw new EngineError('invalid');
  if (init.signal.aborted) throw new EngineError('cancelled');
  let lease: ConnectionStreamLease | undefined;
  let socket: Duplex | undefined;
  let incoming: IncomingMessage | undefined;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let agent: HttpAgent | undefined;
  let closure: Promise<void> | undefined;
  const close = () =>
    (closure ??= (async () => {
      init.signal.removeEventListener('abort', abort);
      incoming?.destroy();
      agent?.destroy();
      socket?.destroy();
      try {
        await lease?.close();
      } catch {
        throw new EngineError('drain-failed');
      }
    })());
  const abort = () => {
    void close().catch(() => {});
  };
  try {
    lease = await connections.openStream(
      {
        target: {
          host: endpoint.hostname.replace(/^\[|\]$/g, ''),
          port: endpoint.port ? Number(endpoint.port) : endpoint.protocol === 'https:' ? 443 : 80,
        },
        proxy,
        username: '',
        jumpHostId: null,
        timeoutMs: Math.max(1000, Math.min(timeoutMs, 120000)),
      },
      init.signal,
    );
    if (init.signal.aborted) throw new EngineError('cancelled');
    init.signal.addEventListener('abort', abort, { once: true });
    socket =
      endpoint.protocol === 'https:'
        ? await secureSocket(lease.stream, endpoint.hostname.replace(/^\[|\]$/g, ''), init.signal)
        : lease.stream;
    if (init.signal.aborted) throw new EngineError('cancelled');
    const request = endpoint.protocol === 'https:' ? requestHttps : requestHttp;
    const stream = socket;
    agent =
      endpoint.protocol === 'https:'
        ? new HttpsAgent({ keepAlive: false })
        : new HttpAgent({ keepAlive: false });
    // Node's Agent declaration requires Socket; its HTTP framing works over the selected Duplex.
    // An explicit per-request Agent is essential: agent:false ignores request.createConnection.
    agent.createConnection = () => stream as Socket;
    incoming = await new Promise<IncomingMessage>((resolve, reject) => {
      const outgoing = request(
        {
          protocol: endpoint.protocol,
          hostname: endpoint.hostname,
          port: endpoint.port || undefined,
          method: init.method,
          path: endpoint.pathname + endpoint.search,
          headers: {
            ...Object.fromEntries(init.headers),
            ...(init.body === undefined ? {} : { 'content-length': Buffer.byteLength(init.body) }),
          },
          agent,
          signal: init.signal,
        },
        resolve,
      );
      outgoing.once('error', reject);
      outgoing.end(init.body);
    });
    const headers = new Headers();
    for (const [name, value] of Object.entries(incoming.headers)) {
      if (Array.isArray(value)) for (const item of value) headers.append(name, item);
      else if (value !== undefined) headers.set(name, value);
    }
    const status = incoming.statusCode ?? 500;
    if ([204, 205, 304].includes(status)) {
      await close();
      return new Response(null, { status, headers });
    }
    reader = (Readable.toWeb(incoming) as ReadableStream<Uint8Array>).getReader();
    const source = reader;
    const body = new ReadableStream<Uint8Array>(
      {
        async pull(sink) {
          try {
            const item = await source.read();
            if (item.done) {
              source.releaseLock();
              await close();
              sink.close();
            } else sink.enqueue(item.value);
          } catch (error) {
            await source.cancel().catch(() => {});
            source.releaseLock();
            let failure = error;
            try {
              await close();
            } catch (error) {
              failure = error;
            }
            sink.error(
              failure instanceof EngineError
                ? failure
                : new EngineError(init.signal.aborted ? 'cancelled' : 'provider-failed'),
            );
          }
        },
        async cancel() {
          try {
            await source.cancel();
          } finally {
            source.releaseLock();
            await close();
          }
        },
      },
      { highWaterMark: 0 },
    );
    return new Response(body, { status, headers });
  } catch (error) {
    await reader?.cancel().catch(() => {});
    await close();
    throw error instanceof EngineError
      ? error
      : new EngineError(init.signal.aborted ? 'cancelled' : 'provider-failed');
  }
}

async function secureSocket(
  socket: Duplex,
  hostname: string,
  signal: AbortSignal,
): Promise<TLSSocket> {
  if (signal.aborted) throw new EngineError('cancelled');
  return new Promise<TLSSocket>((resolve, reject) => {
    const tls = connectTls({
      socket,
      host: hostname,
      ...(isIP(hostname) ? {} : { servername: hostname }),
      ALPNProtocols: ['http/1.1'],
    });
    const cleanup = () => {
      tls.off('secureConnect', connected);
      tls.off('error', failed);
      signal.removeEventListener('abort', aborted);
    };
    const connected = () => {
      cleanup();
      resolve(tls);
    };
    const failed = () => {
      cleanup();
      tls.destroy();
      reject(new EngineError('provider-failed'));
    };
    const aborted = () => failed();
    tls.once('secureConnect', connected);
    tls.once('error', failed);
    signal.addEventListener('abort', aborted, { once: true });
    if (signal.aborted) aborted();
  });
}
