// Copyright (c) 2026 DeepSeek. SPDX-License-Identifier: MIT
// Adapted from packages/client/connection/src/browser-auth.ts at 8bd073392eef6f54e921a093b95076248eb08cbb.
/** Browser-session authentication for the Host Connection carrier. */

import { z } from 'zod';
import { createLaunchTokenFile } from './launch-token.ts';
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { PeerId } from '@axterm/plugin-api';
import { CONNECT_PATH, type ConnectionInteractions } from './connect-protocol.ts';
import { credentialKey } from '@axterm/plugin-api/credentials';
import type { CredentialRecord } from '@axterm/plugin-api/credentials';
import type { CredentialsService } from '@axterm/plugin-api/host';
import type {
  ConnectionIndexRequest,
  ConnectionIndexResponse,
  ConnectionTrustRequest,
} from './rpc.ts';

const AUTH_RECORD_KEY = credentialKey('client-connection', 'browser-session');
const DAY_MILLISECONDS = 24 * 60 * 60 * 1000;
const SECRET_BYTES = 32;
const TOKEN_QUERY = 'token';
const COOKIE_PREFIX = 'axterm-auth-';
const COOKIE_PAYLOAD_VERSION = 1;
const STORED_SECRET_VERSION = 1;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]*$/;
const PROCESS_LAUNCH_TOKENS = new WeakMap<object, string>();
const PROCESS_AUTH_EPOCHS = new WeakMap<object, { generation: string }>();
const EXCHANGE_WINDOW_MS = 60_000;
const EXCHANGE_ATTEMPTS = 20;
const PROCESS_EXCHANGE_WINDOWS = new WeakMap<object, { since: number; attempts: number }>();

interface StoredSecretPayload {
  readonly version: typeof STORED_SECRET_VERSION;
  readonly secret: string;
}

interface BrowserCookiePayload {
  readonly version: typeof COOKIE_PAYLOAD_VERSION;
  readonly authority: string;
  readonly generation: string;
  readonly issuedAt: number;
  readonly expiresAt: number;
}

interface ApiCookiePayload extends Omit<BrowserCookiePayload, 'version'> {
  readonly version: 2;
  readonly id: PeerId;
}

type CookiePayload = BrowserCookiePayload | ApiCookiePayload;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function encodeBase64Url(value: Uint8Array): string {
  return Buffer.from(value)
    .toString('base64')
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/u, '');
}

function decodeBase64Url(value: string): Buffer | undefined {
  if (!BASE64URL_PATTERN.test(value) || value.length % 4 === 1) return undefined;
  const padding = '='.repeat((4 - (value.length % 4)) % 4);
  const decoded = Buffer.from(value.replaceAll('-', '+').replaceAll('_', '/') + padding, 'base64');
  return encodeBase64Url(decoded) === value ? decoded : undefined;
}

function processLaunchToken(owner: object): string {
  const existing = PROCESS_LAUNCH_TOKENS.get(owner);
  if (existing !== undefined) return existing;
  const created = encodeBase64Url(randomBytes(SECRET_BYTES));
  PROCESS_LAUNCH_TOKENS.set(owner, created);
  return created;
}

function header(headers: ConnectionTrustRequest['headers'], name: string): string | undefined {
  if (headers instanceof Headers) return headers.get(name) ?? undefined;
  const value = headers[name];
  return typeof value === 'string' ? value : undefined;
}

/** Protocol-scoped cookie audience; HTTP retains its existing authority-only spelling. */
function requestAudience(
  headers: ConnectionTrustRequest['headers'],
  secure: boolean,
): string | undefined {
  const host = header(headers, 'host');
  if (host === undefined) return undefined;
  try {
    const url = new URL(`${secure ? 'https:' : 'http:'}//${host}`);
    return secure ? url.origin : url.host;
  } catch {
    return undefined;
  }
}

function canonicalSecret(value: unknown): Buffer | undefined {
  if (typeof value !== 'string') return undefined;
  const decoded = decodeBase64Url(value);
  if (decoded === undefined || decoded.byteLength !== SECRET_BYTES) return undefined;
  return decoded;
}

function storedSecret(record: CredentialRecord | undefined): Buffer | undefined {
  if (record === undefined) return undefined;
  if (
    record.kind !== 'grant' ||
    !isRecord(record.payload) ||
    record.payload.version !== STORED_SECRET_VERSION
  ) {
    throw new Error(
      'client-connection: browser-session credential record has an unsupported format',
    );
  }
  const secret = canonicalSecret(record.payload.secret);
  if (secret === undefined) {
    throw new Error('client-connection: browser-session credential record has an invalid secret');
  }
  return secret;
}

function tokenMatches(actual: string, expected: string): boolean {
  const actualBytes = Buffer.from(actual, 'utf8');
  const expectedBytes = Buffer.from(expected, 'utf8');
  return (
    actualBytes.byteLength === expectedBytes.byteLength &&
    timingSafeEqual(actualBytes, expectedBytes)
  );
}

function cookieName(authority: string): string {
  return COOKIE_PREFIX + encodeBase64Url(createHash('sha256').update(authority).digest());
}

/** Read the exact generated cookie without implementing general Cookie decoding. */
function cookieValue(headerValue: string, name: string): string | undefined {
  for (const segment of headerValue.split(';')) {
    const at = segment.indexOf('=');
    if (at === -1 || segment.slice(0, at).trim() !== name) continue;
    return segment.slice(at + 1).trim();
  }
  return undefined;
}

/** Serialize the fixed browser-session attributes; generated names and values are cookie-safe base64url. */
function sessionCookie(name: string, value: string, secure: boolean): string {
  const attributes = `${name}=${value}; Path=/; HttpOnly; SameSite=Strict`;
  return secure ? `${attributes}; Secure` : attributes;
}

function signature(secret: Buffer, body: string): Buffer {
  return createHmac('sha256', secret).update(body).digest();
}

function encodeCookie(payload: CookiePayload, secret: Buffer): string {
  const body = encodeBase64Url(Buffer.from(JSON.stringify(payload), 'utf8'));
  return `v${payload.version}.${body}.${encodeBase64Url(signature(secret, body))}`;
}

function decodeCookie(value: string, secret: Buffer): CookiePayload | undefined {
  const parts = value.split('.');
  const [version, body, encodedSignature] = parts;
  if (
    parts.length !== 3 ||
    (version !== 'v1' && version !== 'v2') ||
    body === undefined ||
    encodedSignature === undefined
  ) {
    return undefined;
  }
  const actualSignature = decodeBase64Url(encodedSignature);
  if (actualSignature === undefined) return undefined;
  const expectedSignature = signature(secret, body);
  if (
    actualSignature.byteLength !== expectedSignature.byteLength ||
    !timingSafeEqual(actualSignature, expectedSignature)
  )
    return undefined;
  let decoded: unknown;
  try {
    const bodyBytes = decodeBase64Url(body);
    if (bodyBytes === undefined) return undefined;
    decoded = JSON.parse(bodyBytes.toString('utf8'));
  } catch {
    return undefined;
  }
  if (
    !isRecord(decoded) ||
    (decoded.version !== COOKIE_PAYLOAD_VERSION && decoded.version !== 2) ||
    version !== `v${decoded.version}` ||
    typeof decoded.authority !== 'string' ||
    typeof decoded.generation !== 'string' ||
    typeof decoded.issuedAt !== 'number' ||
    !Number.isSafeInteger(decoded.issuedAt) ||
    typeof decoded.expiresAt !== 'number' ||
    !Number.isSafeInteger(decoded.expiresAt)
  )
    return undefined;
  const payload = {
    generation: decoded.generation as string,
    authority: decoded.authority,
    issuedAt: decoded.issuedAt,
    expiresAt: decoded.expiresAt,
  };
  if (decoded.version === COOKIE_PAYLOAD_VERSION)
    return { version: COOKIE_PAYLOAD_VERSION, ...payload };
  if (typeof decoded.id !== 'string' || decoded.id.length === 0) return undefined;
  return { version: 2, ...payload, id: decoded.id as PeerId };
}

async function initializeSecret(credentials: CredentialsService): Promise<Buffer> {
  const generated: StoredSecretPayload = {
    version: STORED_SECRET_VERSION,
    secret: encodeBase64Url(randomBytes(SECRET_BYTES)),
  };
  const record = await credentials.modifyRecord(AUTH_RECORD_KEY, (current) => {
    if (current !== undefined) {
      storedSecret(current);
      return Promise.resolve(undefined);
    }
    return Promise.resolve({ kind: 'grant', payload: generated });
  });
  const secret = storedSecret(record);
  if (secret === undefined) {
    throw new Error('client-connection: browser-session credential record was not created');
  }
  return secret;
}

/**
 * Process launch-token exchange and persistent signed-cookie verification.
 * Connection loads the credential provider's signing secret during activation
 * and retains it for synchronous request authentication.
 */
export class BrowserAuth {
  private disposed = false;
  private readonly epoch: { generation: string };
  private get generation(): string {
    return this.epoch.generation;
  }
  private readonly launchToken: string;
  private readonly maxAgeMilliseconds: number;

  private constructor(
    private readonly processOwner: object,
    private readonly secret: Buffer,
    maxAgeDays: number,
  ) {
    this.launchToken = processLaunchToken(processOwner);
    this.epoch = PROCESS_AUTH_EPOCHS.get(processOwner) ?? {
      generation: createHash('sha256').update(this.launchToken).digest('hex'),
    };
    PROCESS_AUTH_EPOCHS.set(processOwner, this.epoch);
    this.maxAgeMilliseconds = maxAgeDays * DAY_MILLISECONDS;
    if (
      !Number.isSafeInteger(this.maxAgeMilliseconds) ||
      !Number.isSafeInteger(Date.now() + this.maxAgeMilliseconds)
    ) {
      throw new Error('client-connection: cookieMaxAgeDays exceeds the safe timestamp range');
    }
  }

  /**
   * Initialize browser authentication and create its durable signing secret
   * when this Harness home has none.
   * @param processOwner - root application context retaining one token across Connection reloads.
   * @param credentials - persistent credential provider for the Web profile.
   * @param maxAgeDays - positive absolute browser-cookie lifetime in days.
   * @returns initialized authentication owner with the process owner's launch token.
   */
  static async create(
    processOwner: object,
    credentials: CredentialsService,
    maxAgeDays: number,
  ): Promise<BrowserAuth> {
    return new BrowserAuth(processOwner, await initializeSecret(credentials), maxAgeDays);
  }

  /** Forget the activation's retained signing material. */
  dispose(): void {
    this.disposed = true;
    this.secret.fill(0);
  }

  /** Return a clean application URL; authentication material is never put in a URL. */
  authenticatedUrl(baseUrl: string): string {
    const url = new URL(baseUrl);
    if (url.searchParams.has(TOKEN_QUERY) || url.username || url.password)
      throw new Error('Authentication material in application URLs is forbidden');
    return url.href;
  }

  /** Web-only delivery; callers own the returned cleanup through their lifecycle. */
  writeLaunchTokenFile(directory: string): Promise<{ path: string; dispose(): Promise<void> }> {
    return createLaunchTokenFile(directory, this.launchToken);
  }

  /** Authenticate an index using a generation-bound session cookie, never a query token. */
  authorizeIndex(
    req: ConnectionIndexRequest,
    res: ConnectionIndexResponse,
    secure = false,
  ): boolean {
    const url = new URL(req.url ?? '/', 'http://axterm.invalid');
    if (url.searchParams.has(TOKEN_QUERY)) {
      res.writeHead(400, { 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' });
      res.end('Authentication material in URLs is forbidden');
      return false;
    }
    if (this.isAuthenticated(req, secure)) return true;
    this.writeUnauthorized(req, res);
    return false;
  }

  /** Exchange a bounded POST body for a session cookie after the Host/Origin fence. */
  authorizeConnect(
    req: ConnectionIndexRequest,
    res: ConnectionIndexResponse,
    secure: boolean,
    publish: (interactions: ConnectionInteractions) => PeerId | undefined,
    input: unknown,
  ): void {
    if (this.disposed) {
      this.writeUnauthorized(req, res);
      return;
    }
    const url = new URL(req.url ?? '/', 'http://axterm.invalid');
    if (req.method !== 'POST') {
      res.writeHead(405, { allow: 'POST', 'cache-control': 'no-store' });
      res.end();
      return;
    }
    const now = Date.now();
    let attempts = PROCESS_EXCHANGE_WINDOWS.get(this.processOwner);
    if (!attempts || now < attempts.since || now - attempts.since >= EXCHANGE_WINDOW_MS) {
      attempts = { since: now, attempts: 0 };
      PROCESS_EXCHANGE_WINDOWS.set(this.processOwner, attempts);
    }
    if (attempts.attempts >= EXCHANGE_ATTEMPTS) {
      res.writeHead(429, {
        'cache-control': 'no-store',
        'retry-after': String(
          Math.max(1, Math.ceil((attempts.since + EXCHANGE_WINDOW_MS - now) / 1000)),
        ),
      });
      res.end('Too many authentication attempts');
      return;
    }
    attempts.attempts++;
    const parsed = z
      .object({
        token: z.string().min(1).max(256),
        kind: z.enum(['browser', 'api']).default('browser'),
        interactions: z.enum(['answer', 'none']).default('none'),
      })
      .strict()
      .safeParse(input);
    if (url.pathname !== CONNECT_PATH || url.search || !parsed.success) {
      res.writeHead(400, { 'cache-control': 'no-store' });
      res.end('Invalid authentication request');
      return;
    }
    const authority = requestAudience(req.headers, secure);
    if (authority === undefined || !tokenMatches(parsed.data.token, this.launchToken)) {
      this.writeUnauthorized(req, res);
      return;
    }
    const issuedAt = Date.now();
    const common = {
      authority,
      generation: this.generation,
      issuedAt,
      expiresAt: issuedAt + this.maxAgeMilliseconds,
    };
    let payload: CookiePayload;
    if (parsed.data.kind === 'api') {
      const id = publish(parsed.data.interactions);
      if (id === undefined) {
        res.writeHead(429, { 'cache-control': 'no-store' });
        res.end('Connection capacity reached');
        return;
      }
      payload = { version: 2, ...common, id };
    } else payload = { version: COOKIE_PAYLOAD_VERSION, ...common };
    res.writeHead(200, {
      'cache-control': 'no-store',
      'content-type': 'application/json',
      'referrer-policy': 'no-referrer',
      'set-cookie': sessionCookie(
        cookieName(authority),
        encodeCookie(payload, this.secret),
        secure,
      ),
    });
    res.end('{"ok":true}');
  }

  /**
   * Verify the authority-bound browser cookie on a Host request.
   * @param request - request headers carrying Host and Cookie.
   * @param secure - whether the receiving listener uses TLS, including its default port.
   * @returns true only for an unexpired cookie signed by this activation's loaded secret.
   */
  isAuthenticated(request: ConnectionTrustRequest, secure = false): boolean {
    return this.authenticate(request, secure)?.version === COOKIE_PAYLOAD_VERSION;
  }

  /** Global Web logout revokes future cookie admission, including through a reloaded Connection owner. */
  authorizeDisconnect(
    req: ConnectionIndexRequest,
    res: ConnectionIndexResponse,
    secure = false,
  ): void {
    const url = new URL(req.url ?? '/', 'http://axterm.invalid');
    if (req.method !== 'DELETE' || url.pathname !== CONNECT_PATH || url.search) {
      res.writeHead(400, { 'cache-control': 'no-store' });
      res.end('Invalid authentication request');
      return;
    }
    if (!this.authenticate(req, secure)) {
      this.writeUnauthorized(req, res);
      return;
    }
    const authority = requestAudience(req.headers, secure)!;
    this.epoch.generation = randomBytes(SECRET_BYTES).toString('hex');
    res.writeHead(204, {
      'cache-control': 'no-store',
      'set-cookie': sessionCookie(cookieName(authority), '', secure) + '; Max-Age=0',
    });
    res.end();
  }

  /**
   * Verify an API credential without creating or reviving its operator.
   * @param request - request headers carrying Host and Cookie.
   * @param secure - whether the receiving listener uses TLS.
   * @returns the signed operator id, or undefined for invalid, expired, or browser cookies.
   */
  authenticateApi(request: ConnectionTrustRequest, secure = false): PeerId | undefined {
    const payload = this.authenticate(request, secure);
    return payload?.version === 2 ? payload.id : undefined;
  }

  private authenticate(
    request: ConnectionTrustRequest,
    secure: boolean,
  ): CookiePayload | undefined {
    if (this.disposed) return undefined;
    const authority = requestAudience(request.headers, secure);
    const rawCookie = header(request.headers, 'cookie');
    if (authority === undefined || rawCookie === undefined) return undefined;
    const value = cookieValue(rawCookie, cookieName(authority));
    if (value === undefined) return undefined;
    const payload = decodeCookie(value, this.secret);
    if (
      payload === undefined ||
      payload.authority !== authority ||
      payload.generation !== this.generation
    )
      return undefined;
    const now = Date.now();
    if (
      payload.issuedAt > now ||
      payload.expiresAt <= now ||
      payload.expiresAt <= payload.issuedAt ||
      payload.expiresAt - payload.issuedAt > this.maxAgeMilliseconds
    )
      return undefined;
    return payload;
  }

  private writeUnauthorized(req: ConnectionIndexRequest, res: ConnectionIndexResponse): void {
    res.writeHead(401, {
      'cache-control': 'no-store',
      'content-type': 'text/plain; charset=utf-8',
    });
    res.end(
      req.method === 'HEAD'
        ? undefined
        : 'Axterm authentication required; use the authentication page and protected launch credential file.\n',
    );
  }
}
