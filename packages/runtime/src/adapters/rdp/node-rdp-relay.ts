import { once } from 'node:events';
import { isIP } from 'node:net';
import { connect as connectTls, type PeerCertificate } from 'node:tls';
import type { Duplex } from 'node:stream';
import type { RdpRelay, RdpRelayHandle } from '../../ports/rdp-relay';

const VERSION_1 = 3_390;
const MAX_CLEAN_PATH_BYTES = 256 * 1024;
const MAX_X224_BYTES = 64 * 1024;
const MAX_PENDING_BYTES = 8 * 1024 * 1024;
const SOCKET_HIGH_WATER = 8 * 1024 * 1024;
const TAG_SEQUENCE = 0x30;
const TAG_INTEGER = 0x02;
const TAG_OCTET_STRING = 0x04;
const TAG_UTF8_STRING = 0x0c;
const contextTag = (index: number) => 0xa0 + index;

interface TlsUpgradeResult {
  stream: Duplex;
  certificates: Buffer[];
}

type TlsUpgrade = (
  socket: Duplex,
  host: string,
  timeoutMs: number,
  signal: AbortSignal,
) => Promise<TlsUpgradeResult>;

export class NodeRdpRelay implements RdpRelay {
  constructor(private readonly upgradeTls: TlsUpgrade = defaultTlsUpgrade) {}

  async attach(input: Parameters<RdpRelay['attach']>[0]): Promise<RdpRelayHandle> {
    const relayAbort = new AbortController();
    const abortFromOwner = () => relayAbort.abort(input.signal.reason);
    input.signal.addEventListener('abort', abortFromOwner, { once: true });
    let targetSocket: Duplex | undefined;
    let tlsStream: Duplex | undefined;
    let closed = false;
    let ready = false;
    let pendingBytes = 0;
    const pending: Buffer[] = [];
    let firstMessage = true;

    const finish = (errorCode?: string) => {
      if (closed) return;
      closed = true;
      relayAbort.abort();
      input.signal.removeEventListener('abort', abortFromOwner);
      input.socket.off('message', onMessage);
      input.socket.off('close', onWebSocketClose);
      input.socket.off('error', onWebSocketError);
      tlsStream?.removeAllListeners();
      if (tlsStream && !tlsStream.destroyed) tlsStream.destroy();
      if (targetSocket && targetSocket !== tlsStream && !targetSocket.destroyed)
        targetSocket.destroy();
      if (input.socket.readyState === 1) input.socket.close(errorCode ? 1011 : 1000, 'rdp closed');
      input.onClose(errorCode);
    };

    const onWebSocketClose = () => finish();
    const onWebSocketError = () => finish('RDP_WEBSOCKET_FAILED');
    const onMessage = (data: Buffer, isBinary: boolean) => {
      if (!isBinary || !data.length || data.length > MAX_CLEAN_PATH_BYTES) {
        finish('RDP_PROTOCOL_ERROR');
        return;
      }
      if (firstMessage) {
        firstMessage = false;
        void start(Buffer.from(data)).catch(() => finish('RDP_CONNECTION_FAILED'));
        return;
      }
      if (!ready || !tlsStream) {
        pendingBytes += data.length;
        if (pendingBytes > MAX_PENDING_BYTES) finish('RDP_BACKPRESSURE_LIMIT');
        else pending.push(Buffer.from(data));
        return;
      }
      if (tlsStream.writableLength + data.length > SOCKET_HIGH_WATER) {
        finish('RDP_BACKPRESSURE_LIMIT');
        return;
      }
      tlsStream.write(data);
    };

    const start = async (firstFrame: Buffer) => {
      const request = parseRdpCleanPathRequest(firstFrame);
      const destination = parseRdpDestination(request.destination);
      if (!sameTarget(destination, input.target)) throw new Error('RDP destination mismatch');
      targetSocket = await input.openTarget(relayAbort.signal);
      const x224Response = await exchangeX224(
        targetSocket,
        request.x224ConnectionRequest,
        input.timeoutMs,
        relayAbort.signal,
      );
      const upgraded = await this.upgradeTls(
        targetSocket,
        input.target.host,
        input.timeoutMs,
        relayAbort.signal,
      );
      if (closed) {
        upgraded.stream.destroy();
        return;
      }
      tlsStream = upgraded.stream;
      tlsStream.on('data', (chunk: Buffer | string) => {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        if (input.socket.bufferedAmount + bytes.length > SOCKET_HIGH_WATER) {
          finish('RDP_BACKPRESSURE_LIMIT');
          return;
        }
        if (input.socket.readyState === 1) input.socket.send(bytes, { binary: true });
      });
      tlsStream.on('end', () => finish());
      tlsStream.on('close', () => finish());
      tlsStream.on('error', () => finish('RDP_CONNECTION_FAILED'));
      input.socket.send(
        buildRdpCleanPathResponse(
          formatDestination(input.target),
          x224Response,
          upgraded.certificates,
        ),
        { binary: true },
      );
      ready = true;
      for (const chunk of pending) tlsStream.write(chunk);
      pending.length = 0;
      pendingBytes = 0;
      input.onReady();
    };

    input.socket.on('message', onMessage);
    input.socket.on('close', onWebSocketClose);
    input.socket.on('error', onWebSocketError);
    if (input.signal.aborted) finish();
    return { close: finish };
  }
}

export function parseRdpCleanPathRequest(data: Uint8Array): {
  destination: string;
  x224ConnectionRequest: Buffer;
} {
  const input = Buffer.from(data);
  if (!input.length || input.length > MAX_CLEAN_PATH_BYTES)
    throw new Error('Invalid RDCleanPath request size');
  const outer = decodeTlv(input, 0);
  if (outer.tag !== TAG_SEQUENCE || outer.totalLength !== input.length)
    throw new Error('Invalid RDCleanPath sequence');
  let version: number | undefined;
  let destination: string | undefined;
  let x224ConnectionRequest: Buffer | undefined;
  for (const child of decodeChildren(outer.value)) {
    const index = child.tag & 0x1f;
    if ((child.tag & 0xe0) !== 0xa0) continue;
    const nested = decodeTlv(child.value, 0);
    if (nested.totalLength !== child.value.length) throw new Error('Invalid RDCleanPath field');
    if (index === 0 && nested.tag === TAG_INTEGER) version = decodeInteger(nested.value);
    else if (index === 2 && nested.tag === TAG_UTF8_STRING)
      destination = nested.value.toString('utf8');
    else if (index === 6 && nested.tag === TAG_OCTET_STRING)
      x224ConnectionRequest = Buffer.from(nested.value);
  }
  if (version !== VERSION_1 || !destination || !x224ConnectionRequest?.length)
    throw new Error('Incomplete RDCleanPath request');
  if (Buffer.byteLength(destination, 'utf8') > 320 || x224ConnectionRequest.length > MAX_X224_BYTES)
    throw new Error('Oversized RDCleanPath field');
  return { destination, x224ConnectionRequest };
}

export function buildRdpCleanPathResponse(
  serverAddress: string,
  x224Response: Uint8Array,
  certificates: Uint8Array[],
): Buffer {
  if (!certificates.length || certificates.length > 16) throw new Error('Missing RDP certificate');
  const certificateSequence = wrap(
    TAG_SEQUENCE,
    Buffer.concat(certificates.map((certificate) => wrap(TAG_OCTET_STRING, certificate))),
  );
  return wrap(
    TAG_SEQUENCE,
    Buffer.concat([
      wrap(contextTag(0), encodeInteger(VERSION_1)),
      wrap(contextTag(6), wrap(TAG_OCTET_STRING, x224Response)),
      wrap(contextTag(7), certificateSequence),
      wrap(contextTag(9), wrap(TAG_UTF8_STRING, Buffer.from(serverAddress, 'utf8'))),
    ]),
  );
}

export function parseRdpDestination(value: string): { host: string; port: number } {
  if (value.startsWith('[')) {
    const end = value.indexOf(']');
    if (end < 2) throw new Error('Invalid IPv6 RDP destination');
    const host = value.slice(1, end);
    const suffix = value.slice(end + 1);
    return { host, port: suffix ? parsePort(suffix.replace(/^:/, '')) : 3_389 };
  }
  const colon = value.lastIndexOf(':');
  if (colon <= 0 || value.indexOf(':') !== colon) return { host: value, port: 3_389 };
  return { host: value.slice(0, colon), port: parsePort(value.slice(colon + 1)) };
}

function sameTarget(left: { host: string; port: number }, right: { host: string; port: number }) {
  return (
    left.port === right.port && left.host.toLocaleLowerCase() === right.host.toLocaleLowerCase()
  );
}

function formatDestination(target: { host: string; port: number }) {
  return `${isIP(target.host) === 6 ? `[${target.host}]` : target.host}:${target.port}`;
}

function parsePort(value: string): number {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error('Invalid RDP port');
  return port;
}

async function exchangeX224(
  socket: Duplex,
  request: Buffer,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<Buffer> {
  if (signal.aborted) throw signal.reason;
  socket.write(request);
  let buffered = Buffer.alloc(0);
  const deadline = setTimeout(() => socket.destroy(new Error('RDP X.224 timeout')), timeoutMs);
  const abort = () => socket.destroy(signal.reason as Error | undefined);
  signal.addEventListener('abort', abort, { once: true });
  try {
    while (buffered.length < 4) {
      const [chunk] = (await once(socket, 'data')) as [Buffer];
      buffered = Buffer.concat([buffered, chunk]);
      if (buffered.length > MAX_X224_BYTES) throw new Error('Oversized X.224 response');
    }
    if (buffered[0] !== 3) throw new Error('Invalid X.224 TPKT response');
    const length = buffered.readUInt16BE(2);
    if (length < 7 || length > MAX_X224_BYTES) throw new Error('Invalid X.224 response length');
    while (buffered.length < length) {
      const [chunk] = (await once(socket, 'data')) as [Buffer];
      buffered = Buffer.concat([buffered, chunk]);
      if (buffered.length > MAX_X224_BYTES) throw new Error('Oversized X.224 response');
    }
    const remainder = buffered.subarray(length);
    if (remainder.length) socket.unshift(remainder);
    return buffered.subarray(0, length);
  } finally {
    clearTimeout(deadline);
    signal.removeEventListener('abort', abort);
  }
}

async function defaultTlsUpgrade(
  socket: Duplex,
  host: string,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<TlsUpgradeResult> {
  if (signal.aborted) throw signal.reason;
  const tls = connectTls({
    socket,
    rejectUnauthorized: false,
    ...(isIP(host) ? {} : { servername: host }),
  });
  const abort = () => tls.destroy(signal.reason as Error | undefined);
  const deadline = setTimeout(() => tls.destroy(new Error('RDP TLS timeout')), timeoutMs);
  signal.addEventListener('abort', abort, { once: true });
  try {
    await Promise.race([
      once(tls, 'secureConnect'),
      once(tls, 'error').then(([error]) => Promise.reject(error)),
    ]);
    tls.setTimeout(0);
    tls.setNoDelay(true);
    tls.setKeepAlive(true, 10_000);
    const certificates = certificateChain(tls.getPeerCertificate(true));
    if (!certificates.length) throw new Error('RDP server did not provide a certificate');
    return { stream: tls, certificates };
  } finally {
    clearTimeout(deadline);
    signal.removeEventListener('abort', abort);
  }
}

function certificateChain(certificate: PeerCertificate): Buffer[] {
  const result: Buffer[] = [];
  const seen = new Set<string>();
  let current: (PeerCertificate & { issuerCertificate?: PeerCertificate }) | undefined =
    certificate;
  while (current?.raw?.length && result.length < 16) {
    const key = current.raw.toString('base64');
    if (seen.has(key)) break;
    seen.add(key);
    result.push(Buffer.from(current.raw));
    current = current.issuerCertificate;
  }
  return result;
}

interface Tlv {
  tag: number;
  value: Buffer;
  totalLength: number;
}

function decodeTlv(buffer: Buffer, offset: number): Tlv {
  if (offset < 0 || offset + 2 > buffer.length) throw new Error('Truncated DER value');
  const tag = buffer[offset]!;
  const first = buffer[offset + 1]!;
  let length = 0;
  let lengthBytes = 1;
  if (first < 0x80) length = first;
  else {
    const count = first & 0x7f;
    if (!count || count > 4 || offset + 2 + count > buffer.length)
      throw new Error('Invalid DER length');
    lengthBytes += count;
    for (let index = 0; index < count; index += 1)
      length = length * 256 + buffer[offset + 2 + index]!;
  }
  const header = 1 + lengthBytes;
  const end = offset + header + length;
  if (length < 0 || end > buffer.length) throw new Error('Truncated DER content');
  return { tag, value: buffer.subarray(offset + header, end), totalLength: header + length };
}

function decodeChildren(buffer: Buffer): Tlv[] {
  const result: Tlv[] = [];
  let offset = 0;
  while (offset < buffer.length) {
    const child = decodeTlv(buffer, offset);
    result.push(child);
    if (result.length > 32) throw new Error('Too many RDCleanPath fields');
    offset += child.totalLength;
  }
  return result;
}

function decodeInteger(buffer: Buffer): number {
  if (!buffer.length || buffer.length > 6 || (buffer[0]! & 0x80) !== 0)
    throw new Error('Invalid DER integer');
  let result = 0;
  for (const byte of buffer) result = result * 256 + byte;
  return result;
}

function encodeLength(length: number): Buffer {
  if (!Number.isSafeInteger(length) || length < 0) throw new Error('Invalid DER length');
  if (length < 0x80) return Buffer.from([length]);
  const bytes: number[] = [];
  for (let value = length; value > 0; value = Math.floor(value / 256)) bytes.unshift(value & 0xff);
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

function wrap(tag: number, value: Uint8Array): Buffer {
  const content = Buffer.from(value);
  return Buffer.concat([Buffer.from([tag]), encodeLength(content.length), content]);
}

function encodeInteger(value: number): Buffer {
  const bytes: number[] = [];
  for (let current = value; current > 0; current = Math.floor(current / 256))
    bytes.unshift(current & 0xff);
  if (!bytes.length) bytes.push(0);
  if ((bytes[0]! & 0x80) !== 0) bytes.unshift(0);
  return wrap(TAG_INTEGER, Buffer.from(bytes));
}
