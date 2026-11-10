import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import type { PeerId } from '@axterm/plugin-api';
import type { BrowserAuth } from './browser-auth.ts';
import type {
  ConnectionIndexRequest,
  ConnectionIndexResponse,
  ConnectionTrustRequest,
} from './rpc.ts';
import type { ConnectionInteractions } from './connect-protocol.ts';

export const DESKTOP_AUTH_HEADER = 'x-axterm-desktop-authorization';
export interface DesktopAuthenticationVerifier {
  readonly generation: string;
  readonly digest: string;
}
export type ConnectionAuthentication = Pick<
  BrowserAuth,
  | 'dispose'
  | 'authenticatedUrl'
  | 'writeLaunchTokenFile'
  | 'authorizeIndex'
  | 'authorizeConnect'
  | 'authorizeDisconnect'
  | 'isAuthenticated'
  | 'authenticateApi'
>;
declare module '@deepseek-ai/cordis' {
  interface Context {
    desktopAuthenticationVerifier: DesktopAuthenticationVerifier;
  }
}
const verifierSchema = z
  .object({ generation: z.uuid(), digest: z.string().regex(/^[0-9a-f]{64}$/) })
  .strict();
function digest(generation: string, credential: string): Buffer {
  return createHash('sha256').update(generation).update('\0').update(credential).digest();
}
/** Shell-only creation. Only `verifier` goes to Host startup; `credential` never goes to a page or file. */
export function createDesktopAuthentication(generation: string = randomUUID()): {
  readonly credential: string;
  readonly verifier: DesktopAuthenticationVerifier;
} {
  if (!z.uuid().safeParse(generation).success) throw new Error('DESKTOP_AUTH_INVALID_GENERATION');
  const credential = randomBytes(32).toString('base64url');
  return Object.freeze({
    credential,
    verifier: Object.freeze({ generation, digest: digest(generation, credential).toString('hex') }),
  });
}
/** Host retains a generation-bound digest, never a shell credential or cookie-signing key. */
export class DesktopAuthentication implements ConnectionAuthentication {
  private readonly verifier: Buffer;
  private readonly generation: string;
  private disposed = false;
  constructor(input: DesktopAuthenticationVerifier, expectedGeneration: string) {
    const parsed = verifierSchema.safeParse(input);
    if (!parsed.success || parsed.data.generation !== expectedGeneration)
      throw new Error('DESKTOP_AUTH_INVALID_VERIFIER');
    this.verifier = Buffer.from(parsed.data.digest, 'hex');
    this.generation = parsed.data.generation;
  }
  dispose(): void {
    this.disposed = true;
    this.verifier.fill(0);
  }
  authenticatedUrl(baseUrl: string): string {
    let url: URL;
    try {
      url = new URL(baseUrl);
    } catch {
      throw new Error('DESKTOP_AUTH_INVALID_URL');
    }
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      !['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname) ||
      url.searchParams.has('token') ||
      url.username ||
      url.password
    )
      throw new Error('DESKTOP_AUTH_INVALID_URL');
    return url.href;
  }
  writeLaunchTokenFile(_directory: string): Promise<{ path: string; dispose(): Promise<void> }> {
    return Promise.reject(new Error('DESKTOP_AUTH_FILE_FORBIDDEN'));
  }
  authorizeIndex(request: ConnectionIndexRequest, response: ConnectionIndexResponse): boolean {
    if (this.hasUrlCredential(request)) {
      response.writeHead(400, { 'cache-control': 'no-store' });
      response.end();
      return false;
    }
    if (this.isAuthenticated(request)) return true;
    response.writeHead(401, { 'cache-control': 'no-store' });
    response.end();
    return false;
  }
  /** Browser logout never revokes the Shell's private Desktop header credential. */
  authorizeDisconnect(_req: ConnectionIndexRequest, res: ConnectionIndexResponse): void {
    res.writeHead(403, { 'cache-control': 'no-store' });
    res.end('Desktop authentication is Shell-owned');
  }
  authorizeConnect(
    _request: ConnectionIndexRequest,
    response: ConnectionIndexResponse,
    _secure: boolean,
    _publish: (interactions: ConnectionInteractions) => PeerId | undefined,
    _input: unknown,
  ): void {
    response.writeHead(404, { 'cache-control': 'no-store' });
    response.end();
  }
  isAuthenticated(request: ConnectionTrustRequest): boolean {
    if (this.disposed || this.hasUrlCredential(request)) return false;
    const value =
      request.headers instanceof Headers
        ? request.headers.get(DESKTOP_AUTH_HEADER)
        : request.headers[DESKTOP_AUTH_HEADER];
    if (
      typeof value !== 'string' ||
      !/^[A-Za-z0-9_-]{43}$/.test(value) ||
      Buffer.from(value, 'base64url').toString('base64url') !== value
    )
      return false;
    const candidate = digest(this.generation, value);
    return timingSafeEqual(candidate, this.verifier);
  }
  authenticateApi(_request: ConnectionTrustRequest): PeerId | undefined {
    return undefined;
  }
  private hasUrlCredential(request: ConnectionTrustRequest): boolean {
    try {
      const url = new URL(request.url ?? '/', 'http://axterm.invalid');
      return url.searchParams.has('token') || !!url.username || !!url.password;
    } catch {
      return true;
    }
  }
}
