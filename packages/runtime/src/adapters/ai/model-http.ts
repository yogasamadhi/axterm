import { request as requestHttp, type IncomingMessage } from 'node:http';
import { request as requestHttps } from 'node:https';
import { isIP, type Socket } from 'node:net';
import { Readable } from 'node:stream';
import { connect as connectTls, type TLSSocket } from 'node:tls';
import type { AiProvider, ProxyEndpointConfig } from '@workspace/contracts';
import { TcpProxyConnector } from '../proxy/tcp-proxy-connector';

export type AiModelProxy =
  (Omit<ProxyEndpointConfig, 'credentialRef'> & { password?: string }) | null | undefined;

/** Legacy saved gateways may expose /models; Pi's offline catalog handles Pi configurations. */
export async function discoverLegacyModels(
  provider: AiProvider,
  apiKey: string,
  proxy: AiModelProxy,
  signal?: AbortSignal,
): Promise<string[]> {
  const response = await requestModel(
    new URL('models', provider.baseUrl.replace(/\/?$/, '/')),
    {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        ...(provider.auth === 'x-api-key'
          ? { 'x-api-key': apiKey }
          : { Authorization: `Bearer ${apiKey}` }),
        ...(provider.protocol === 'anthropic' ? { 'anthropic-version': '2023-06-01' } : {}),
      },
      signal: signal ?? new AbortController().signal,
    },
    proxy,
    provider.timeoutMs,
  );
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error(`Model provider rejected request (${response.status})`);
  }
  const parsed = JSON.parse(await readText(response, 2 * 1024 * 1024)) as unknown;
  const source = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === 'object' && Array.isArray((parsed as { data?: unknown }).data)
      ? (parsed as { data: unknown[] }).data
      : parsed &&
          typeof parsed === 'object' &&
          Array.isArray((parsed as { models?: unknown }).models)
        ? (parsed as { models: unknown[] }).models
        : [];
  return [
    ...new Set(
      source
        .map((item) =>
          typeof item === 'string'
            ? item
            : item && typeof item === 'object'
              ? String(
                  (item as { id?: unknown; name?: unknown; model?: unknown }).id ??
                    (item as { name?: unknown }).name ??
                    (item as { model?: unknown }).model ??
                    '',
                )
              : '',
        )
        .map((value) => value.trim())
        .filter((value) => value.length > 0 && value.length <= 512),
    ),
  ].slice(0, 500);
}

async function readText(response: Response, maximumBytes: number): Promise<string> {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let result = '';
  let received = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      received += chunk.value.length;
      if (received > maximumBytes) throw new Error('Model provider response exceeded limit');
      result += decoder.decode(chunk.value, { stream: true });
    }
    return result + decoder.decode();
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

export async function requestModel(
  endpoint: URL,
  init: {
    method: 'GET' | 'POST';
    headers: Record<string, string>;
    body?: string;
    signal: AbortSignal;
  },
  proxy: AiModelProxy,
  timeoutMs: number,
): Promise<Response> {
  const signal = AbortSignal.any([init.signal, AbortSignal.timeout(timeoutMs)]);
  if (!proxy)
    return fetch(endpoint, {
      method: init.method,
      headers: init.headers,
      ...(init.body === undefined ? {} : { body: init.body }),
      redirect: 'error',
      signal,
    });

  const rawSocket = await new TcpProxyConnector().connect({
    proxy: {
      url: proxy.url,
      ...(proxy.username ? { username: proxy.username, password: proxy.password } : {}),
    },
    target: {
      host: endpoint.hostname,
      port: endpoint.port ? Number(endpoint.port) : endpoint.protocol === 'https:' ? 443 : 80,
    },
    timeoutMs,
    signal,
  });
  const socket =
    endpoint.protocol === 'https:'
      ? await secureSocket(rawSocket, endpoint.hostname, signal)
      : rawSocket;
  try {
    return await requestOnSocket(endpoint, init, socket, signal);
  } catch (error) {
    socket.destroy();
    throw error;
  }
}

async function secureSocket(
  socket: Socket,
  hostname: string,
  signal: AbortSignal,
): Promise<TLSSocket> {
  if (signal.aborted) {
    socket.destroy();
    throw signal.reason;
  }
  return new Promise<TLSSocket>((resolve, reject) => {
    const tls = connectTls({
      socket,
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
    const failed = (error: Error) => {
      cleanup();
      tls.destroy();
      reject(error);
    };
    const aborted = () => failed(new Error('Model provider request was canceled'));
    tls.once('secureConnect', connected);
    tls.once('error', failed);
    signal.addEventListener('abort', aborted, { once: true });
  });
}

async function requestOnSocket(
  endpoint: URL,
  init: { method: 'GET' | 'POST'; headers: Record<string, string>; body?: string },
  socket: Socket,
  signal: AbortSignal,
): Promise<Response> {
  const request = endpoint.protocol === 'https:' ? requestHttps : requestHttp;
  const response = await new Promise<IncomingMessage>((resolve, reject) => {
    const outgoing = request(
      {
        protocol: endpoint.protocol,
        hostname: endpoint.hostname,
        port: endpoint.port || undefined,
        method: init.method,
        path: `${endpoint.pathname}${endpoint.search}`,
        headers: {
          ...init.headers,
          ...(init.body === undefined ? {} : { 'Content-Length': Buffer.byteLength(init.body) }),
        },
        agent: false,
        signal,
        createConnection: () => socket,
      },
      resolve,
    );
    outgoing.once('error', reject);
    outgoing.end(init.body);
  });
  const headers = new Headers();
  for (const [name, value] of Object.entries(response.headers)) {
    if (Array.isArray(value)) for (const item of value) headers.append(name, item);
    else if (value !== undefined) headers.set(name, String(value));
  }
  return new Response(Readable.toWeb(response) as ReadableStream<Uint8Array>, {
    status: response.statusCode ?? 500,
    ...(response.statusMessage ? { statusText: response.statusMessage } : {}),
    headers,
  });
}
