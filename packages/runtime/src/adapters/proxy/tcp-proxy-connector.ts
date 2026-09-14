import { isIP, connect as connectTcp, type Socket } from 'node:net';
import { connect as connectTls } from 'node:tls';
import type {
  ProxyConnectRequest,
  ProxyConnector,
  ProxyEndpoint,
} from '../../ports/proxy-connector';

const MAX_HTTP_RESPONSE_BYTES = 32 * 1024;
const MAX_SOCKS_FIELD_BYTES = 255;

export class ProxyConnectionError extends Error {
  constructor(
    readonly code:
      | 'PROXY_URL_INVALID'
      | 'PROXY_AUTH_INVALID'
      | 'PROXY_AUTH_REQUIRED'
      | 'PROXY_CONNECT_REJECTED'
      | 'PROXY_PROTOCOL_ERROR'
      | 'PROXY_RESPONSE_TOO_LARGE'
      | 'PROXY_TIMEOUT'
      | 'PROXY_ABORTED',
    message: string,
  ) {
    super(message);
    this.name = 'ProxyConnectionError';
  }
}

export class TcpProxyConnector implements ProxyConnector {
  async connect(request: ProxyConnectRequest): Promise<Socket> {
    const endpoint = parseProxyEndpoint(request.proxy);
    const socket = await openProxySocket(endpoint, request.timeoutMs, request.signal);
    try {
      if (endpoint.protocol === 'http:' || endpoint.protocol === 'https:')
        await establishHttpTunnel(
          socket,
          endpoint,
          request.target,
          request.timeoutMs,
          request.signal,
        );
      else
        await establishSocks5Tunnel(
          socket,
          endpoint,
          request.target,
          request.timeoutMs,
          request.signal,
        );
      socket.setTimeout(0);
      socket.pause();
      setImmediate(() => {
        if (!socket.destroyed) socket.resume();
      });
      return socket;
    } catch (error) {
      socket.destroy();
      if (error instanceof ProxyConnectionError) throw error;
      throw new ProxyConnectionError('PROXY_CONNECT_REJECTED', 'Proxy connection failed');
    }
  }
}

interface ParsedProxyEndpoint {
  protocol: 'http:' | 'https:' | 'socks5:' | 'socks5h:';
  host: string;
  port: number;
  username?: string;
  password?: string;
}

export function parseProxyEndpoint(proxy: ProxyEndpoint): ParsedProxyEndpoint {
  let value: URL;
  try {
    value = new URL(proxy.url);
  } catch {
    throw new ProxyConnectionError('PROXY_URL_INVALID', 'Proxy URL is invalid');
  }
  if (!['http:', 'https:', 'socks5:', 'socks5h:'].includes(value.protocol))
    throw new ProxyConnectionError(
      'PROXY_URL_INVALID',
      'Proxy URL must use http, https, socks5 or socks5h',
    );
  if (
    !value.hostname ||
    (value.pathname !== '' && value.pathname !== '/') ||
    value.search ||
    value.hash
  )
    throw new ProxyConnectionError('PROXY_URL_INVALID', 'Proxy URL contains unsupported fields');
  if (value.username || value.password)
    throw new ProxyConnectionError(
      'PROXY_URL_INVALID',
      'Proxy credentials must be supplied separately from the URL',
    );
  const protocol = value.protocol as ParsedProxyEndpoint['protocol'];
  const host =
    value.hostname.startsWith('[') && value.hostname.endsWith(']')
      ? value.hostname.slice(1, -1)
      : value.hostname;
  const port = value.port
    ? Number(value.port)
    : protocol === 'https:'
      ? 443
      : protocol === 'http:'
        ? 8080
        : 1080;
  if (!Number.isInteger(port) || port < 1 || port > 65_535)
    throw new ProxyConnectionError('PROXY_URL_INVALID', 'Proxy port is invalid');
  const username = proxy.username?.trim();
  const password = proxy.password;
  if (!!username !== !!password)
    throw new ProxyConnectionError(
      'PROXY_AUTH_INVALID',
      'Proxy username and password must be supplied together',
    );
  assertUtf8Field(username, 'Proxy username');
  assertUtf8Field(password, 'Proxy password');
  return {
    protocol,
    host,
    port,
    ...(username ? { username, password } : {}),
  };
}

function assertUtf8Field(value: string | undefined, label: string): void {
  if (value === undefined) return;
  if (!value || Buffer.byteLength(value, 'utf8') > MAX_SOCKS_FIELD_BYTES)
    throw new ProxyConnectionError('PROXY_AUTH_INVALID', `${label} is invalid`);
}

async function openProxySocket(
  endpoint: ParsedProxyEndpoint,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<Socket> {
  assertTimeout(timeoutMs);
  if (signal?.aborted) throw abortedError();
  return new Promise<Socket>((resolve, reject) => {
    let settled = false;
    const socket =
      endpoint.protocol === 'https:'
        ? connectTls({
            host: endpoint.host,
            port: endpoint.port,
            ...(isIP(endpoint.host) ? {} : { servername: endpoint.host }),
          })
        : connectTcp({ host: endpoint.host, port: endpoint.port });
    const cleanup = () => {
      socket.off('connect', connected);
      socket.off('secureConnect', connected);
      socket.off('error', failed);
      socket.off('timeout', timedOut);
      signal?.removeEventListener('abort', aborted);
    };
    const finish = (action: () => void) => {
      if (settled) return;
      settled = true;
      cleanup();
      action();
    };
    const connected = () => finish(() => resolve(socket));
    const failed = () =>
      finish(() => {
        socket.destroy();
        reject(
          new ProxyConnectionError('PROXY_CONNECT_REJECTED', 'Could not connect to the proxy'),
        );
      });
    const timedOut = () =>
      finish(() => {
        socket.destroy();
        reject(new ProxyConnectionError('PROXY_TIMEOUT', 'Proxy connection timed out'));
      });
    const aborted = () =>
      finish(() => {
        socket.destroy();
        reject(abortedError());
      });
    socket.setTimeout(timeoutMs);
    socket.once(endpoint.protocol === 'https:' ? 'secureConnect' : 'connect', connected);
    socket.once('error', failed);
    socket.once('timeout', timedOut);
    signal?.addEventListener('abort', aborted, { once: true });
  });
}

async function establishHttpTunnel(
  socket: Socket,
  endpoint: ParsedProxyEndpoint,
  target: ProxyConnectRequest['target'],
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<void> {
  const authority = formatAuthority(target.host, target.port);
  const authorization = endpoint.username
    ? `Proxy-Authorization: Basic ${Buffer.from(`${endpoint.username}:${endpoint.password}`, 'utf8').toString('base64')}\r\n`
    : '';
  socket.write(
    `CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n${authorization}Proxy-Connection: keep-alive\r\n\r\n`,
  );
  const response = await readUntil(socket, Buffer.from('\r\n\r\n'), {
    maxBytes: MAX_HTTP_RESPONSE_BYTES,
    timeoutMs,
    ...(signal ? { signal } : {}),
  });
  const headerEnd = response.indexOf('\r\n\r\n');
  const header = response.subarray(0, headerEnd).toString('latin1');
  const status = /^HTTP\/1\.[01] (\d{3})(?: |\r?$)/m.exec(header)?.[1];
  if (!status)
    throw new ProxyConnectionError('PROXY_PROTOCOL_ERROR', 'Proxy returned an invalid response');
  if (status === '407')
    throw new ProxyConnectionError('PROXY_AUTH_REQUIRED', 'Proxy authentication was rejected');
  if (status !== '200')
    throw new ProxyConnectionError(
      'PROXY_CONNECT_REJECTED',
      `Proxy rejected the connection with HTTP ${status}`,
    );
  const remainder = response.subarray(headerEnd + 4);
  if (remainder.length) socket.unshift(remainder);
}

async function establishSocks5Tunnel(
  socket: Socket,
  endpoint: ParsedProxyEndpoint,
  target: ProxyConnectRequest['target'],
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<void> {
  assertProxyTarget(target);
  const reader = new BoundedSocketReader(socket, timeoutMs, signal);
  try {
    const hasCredentials = !!endpoint.username;
    socket.write(Buffer.from(hasCredentials ? [5, 2, 0, 2] : [5, 1, 0]));
    const greeting = await reader.read(2);
    if (greeting[0] !== 5)
      throw new ProxyConnectionError('PROXY_PROTOCOL_ERROR', 'SOCKS proxy version is invalid');
    if (greeting[1] === 0xff)
      throw new ProxyConnectionError('PROXY_AUTH_REQUIRED', 'SOCKS proxy rejected authentication');
    if (greeting[1] === 2) {
      if (!hasCredentials)
        throw new ProxyConnectionError('PROXY_AUTH_REQUIRED', 'SOCKS proxy requires credentials');
      const username = Buffer.from(endpoint.username!, 'utf8');
      const password = Buffer.from(endpoint.password!, 'utf8');
      socket.write(
        Buffer.concat([
          Buffer.from([1, username.length]),
          username,
          Buffer.from([password.length]),
          password,
        ]),
      );
      const authentication = await reader.read(2);
      if (authentication[0] !== 1 || authentication[1] !== 0)
        throw new ProxyConnectionError('PROXY_AUTH_REQUIRED', 'SOCKS proxy authentication failed');
    } else if (greeting[1] !== 0) {
      throw new ProxyConnectionError(
        'PROXY_PROTOCOL_ERROR',
        `SOCKS proxy selected unsupported authentication method ${greeting[1]}`,
      );
    }

    const address = encodeSocksAddress(target.host);
    socket.write(
      Buffer.concat([
        Buffer.from([5, 1, 0]),
        address,
        Buffer.from([(target.port >> 8) & 0xff, target.port & 0xff]),
      ]),
    );
    const reply = await reader.read(4);
    if (reply[0] !== 5 || reply[2] !== 0)
      throw new ProxyConnectionError(
        'PROXY_PROTOCOL_ERROR',
        'SOCKS proxy returned an invalid reply',
      );
    if (reply[1] !== 0)
      throw new ProxyConnectionError(
        'PROXY_CONNECT_REJECTED',
        `SOCKS proxy rejected the connection with code ${reply[1]}`,
      );
    let addressBytes = -1;
    if (reply[3] === 1) addressBytes = 4;
    else if (reply[3] === 4) addressBytes = 16;
    else if (reply[3] === 3) addressBytes = (await reader.read(1))[0] ?? -1;
    if (addressBytes < 0)
      throw new ProxyConnectionError('PROXY_PROTOCOL_ERROR', 'SOCKS proxy address type is invalid');
    await reader.read(addressBytes + 2);
    reader.release();
  } catch (error) {
    reader.dispose();
    throw error;
  }
}

function encodeSocksAddress(host: string): Buffer {
  if (!host || Buffer.byteLength(host, 'utf8') > MAX_SOCKS_FIELD_BYTES)
    throw new ProxyConnectionError('PROXY_URL_INVALID', 'Proxy target host is invalid');
  if (isIP(host) === 4) return Buffer.from([1, ...host.split('.').map((part) => Number(part))]);
  if (isIP(host) === 6) return Buffer.concat([Buffer.from([4]), encodeIpv6(host)]);
  const value = Buffer.from(host, 'utf8');
  return Buffer.concat([Buffer.from([3, value.length]), value]);
}

function encodeIpv6(host: string): Buffer {
  const halves = host.toLowerCase().split('::');
  if (halves.length > 2 || host.includes('%'))
    throw new ProxyConnectionError('PROXY_URL_INVALID', 'Proxy IPv6 target is invalid');
  const parseHalf = (value: string): number[] => {
    if (!value) return [];
    const groups = value.split(':');
    const last = groups.at(-1);
    if (last && isIP(last) === 4) {
      groups.pop();
      const bytes = last.split('.').map(Number);
      groups.push(((bytes[0]! << 8) | bytes[1]!).toString(16));
      groups.push(((bytes[2]! << 8) | bytes[3]!).toString(16));
    }
    return groups.map((group) => {
      if (!/^[\da-f]{1,4}$/.test(group))
        throw new ProxyConnectionError('PROXY_URL_INVALID', 'Proxy IPv6 target is invalid');
      return Number.parseInt(group, 16);
    });
  };
  const left = parseHalf(halves[0] ?? '');
  const right = parseHalf(halves[1] ?? '');
  const omitted = 8 - left.length - right.length;
  if ((halves.length === 1 && omitted !== 0) || (halves.length === 2 && omitted < 1))
    throw new ProxyConnectionError('PROXY_URL_INVALID', 'Proxy IPv6 target is invalid');
  const groups = halves.length === 1 ? left : [...left, ...Array(omitted).fill(0), ...right];
  const bytes = Buffer.allocUnsafe(16);
  for (const [index, group] of groups.entries()) bytes.writeUInt16BE(group, index * 2);
  return bytes;
}

function formatAuthority(host: string, port: number): string {
  assertProxyTarget({ host, port });
  return `${isIP(host) === 6 ? `[${host}]` : host}:${port}`;
}

function assertProxyTarget(target: ProxyConnectRequest['target']): void {
  if (
    !target.host ||
    Buffer.byteLength(target.host, 'utf8') > 253 ||
    [...target.host].some((character) => {
      const code = character.charCodeAt(0);
      return code <= 0x20 || code === 0x7f || '/@?#'.includes(character);
    }) ||
    (!isIP(target.host) && (target.host.includes('[') || target.host.includes(']'))) ||
    !Number.isInteger(target.port) ||
    target.port < 1 ||
    target.port > 65_535
  )
    throw new ProxyConnectionError('PROXY_URL_INVALID', 'Proxy target is invalid');
}

function assertTimeout(timeoutMs: number): void {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 250 || timeoutMs > 300_000)
    throw new ProxyConnectionError('PROXY_URL_INVALID', 'Proxy timeout is invalid');
}

function abortedError(): ProxyConnectionError {
  return new ProxyConnectionError('PROXY_ABORTED', 'Proxy connection was canceled');
}

async function readUntil(
  socket: Socket,
  marker: Buffer,
  options: { maxBytes: number; timeoutMs: number; signal?: AbortSignal },
): Promise<Buffer> {
  if (options.signal?.aborted) throw abortedError();
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    const timer = setTimeout(
      () => fail(new ProxyConnectionError('PROXY_TIMEOUT', 'Proxy handshake timed out')),
      options.timeoutMs,
    );
    const cleanup = () => {
      clearTimeout(timer);
      socket.off('data', data);
      socket.off('error', fail);
      socket.off('close', closed);
      options.signal?.removeEventListener('abort', aborted);
    };
    const finish = (value: Buffer) => {
      cleanup();
      resolve(value);
    };
    const fail = (error: Error) => {
      cleanup();
      reject(error);
    };
    const closed = () =>
      fail(new ProxyConnectionError('PROXY_PROTOCOL_ERROR', 'Proxy closed during handshake'));
    const aborted = () => fail(abortedError());
    const data = (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > options.maxBytes)
        return fail(
          new ProxyConnectionError('PROXY_RESPONSE_TOO_LARGE', 'Proxy response is too large'),
        );
      chunks.push(chunk);
      const value = Buffer.concat(chunks, bytes);
      if (value.indexOf(marker) >= 0) finish(value);
    };
    socket.on('data', data);
    socket.once('error', fail);
    socket.once('close', closed);
    options.signal?.addEventListener('abort', aborted, { once: true });
  });
}

class BoundedSocketReader {
  private buffer = Buffer.alloc(0);
  private readonly waiters: Array<{
    bytes: number;
    resolve(value: Buffer): void;
    reject(error: Error): void;
  }> = [];
  private readonly timer: ReturnType<typeof setTimeout>;
  private released = false;
  private readonly onData = (chunk: Buffer) => {
    if (this.released) return;
    if (this.buffer.length + chunk.length > MAX_HTTP_RESPONSE_BYTES)
      return this.fail(
        new ProxyConnectionError('PROXY_RESPONSE_TOO_LARGE', 'SOCKS response is too large'),
      );
    this.buffer = Buffer.concat([this.buffer, chunk]);
    this.flush();
  };
  private readonly onError = (error: Error) => this.fail(error);
  private readonly onClose = () =>
    this.fail(
      new ProxyConnectionError('PROXY_PROTOCOL_ERROR', 'SOCKS proxy closed during handshake'),
    );
  private readonly onAbort = () => this.fail(abortedError());

  constructor(
    private readonly socket: Socket,
    timeoutMs: number,
    private readonly signal?: AbortSignal,
  ) {
    if (signal?.aborted) throw abortedError();
    socket.on('data', this.onData);
    socket.once('error', this.onError);
    socket.once('close', this.onClose);
    signal?.addEventListener('abort', this.onAbort, { once: true });
    this.timer = setTimeout(
      () => this.fail(new ProxyConnectionError('PROXY_TIMEOUT', 'SOCKS handshake timed out')),
      timeoutMs,
    );
  }

  read(bytes: number): Promise<Buffer> {
    if (!Number.isInteger(bytes) || bytes < 0 || bytes > MAX_HTTP_RESPONSE_BYTES)
      return Promise.reject(
        new ProxyConnectionError('PROXY_PROTOCOL_ERROR', 'SOCKS response length is invalid'),
      );
    if (this.released)
      return Promise.reject(
        new ProxyConnectionError('PROXY_PROTOCOL_ERROR', 'SOCKS reader is already closed'),
      );
    return new Promise((resolve, reject) => {
      this.waiters.push({ bytes, resolve, reject });
      this.flush();
    });
  }

  release(): void {
    if (this.released) return;
    this.released = true;
    this.cleanup();
    if (this.buffer.length) this.socket.unshift(this.buffer);
    this.buffer = Buffer.alloc(0);
  }

  dispose(): void {
    if (this.released) return;
    this.released = true;
    this.cleanup();
    const error = new ProxyConnectionError('PROXY_PROTOCOL_ERROR', 'SOCKS reader was disposed');
    for (const waiter of this.waiters.splice(0)) waiter.reject(error);
    this.buffer = Buffer.alloc(0);
  }

  private flush(): void {
    while (this.waiters.length) {
      const waiter = this.waiters[0]!;
      if (this.buffer.length < waiter.bytes) return;
      this.waiters.shift();
      const value = this.buffer.subarray(0, waiter.bytes);
      this.buffer = this.buffer.subarray(waiter.bytes);
      waiter.resolve(value);
    }
  }

  private fail(error: Error): void {
    if (this.released) return;
    this.released = true;
    this.cleanup();
    for (const waiter of this.waiters.splice(0)) waiter.reject(error);
    this.buffer = Buffer.alloc(0);
  }

  private cleanup(): void {
    clearTimeout(this.timer);
    this.socket.off('data', this.onData);
    this.socket.off('error', this.onError);
    this.socket.off('close', this.onClose);
    this.signal?.removeEventListener('abort', this.onAbort);
  }
}
