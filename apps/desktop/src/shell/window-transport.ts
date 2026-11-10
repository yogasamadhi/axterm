import { runtimeLegalId } from './legal.ts';
import type { BrowserWindow, Session } from 'electron';
import { randomUUID } from 'node:crypto';
import { serveWebDocument, forwardWebRequest } from './web-document.ts';
import {
  APP_URL,
  isApplicationDocument,
  ownsMainFrame,
  isHostWebSocket,
  webSocketHeaders,
  type HostAuthority,
  type WindowIdentity,
} from './window-policy.ts';

export interface WindowTransportOptions {
  readonly webRoot: string;
  readonly authority: () => HostAuthority | undefined;
  readonly shellDocument: (path: string) => Response;
  readonly runtimeLegalDocument?: (request: Request, signal: AbortSignal) => Promise<Response>;
}
/** One ephemeral session belongs to exactly one application window. */
export class WindowTransport {
  private readonly lifetime = new AbortController();
  private readonly active = new Set<AbortController>();
  private closed = false;
  private readonly session: Session;
  constructor(
    private readonly window: BrowserWindow,
    private readonly options: WindowTransportOptions,
  ) {
    this.session = window.webContents.session;
    this.session.protocol.handle('axterm-app', (request) => this.resource(request));
    this.session.webRequest.onBeforeRequest((details, callback) => {
      if (this.closed) {
        callback({ cancel: true });
        return;
      }
      const url = new URL(details.url);
      if (url.protocol === 'axterm-app:') {
        const owner = this.owner();
        const mainNavigation =
          details.resourceType === 'mainFrame' && details.webContentsId === owner?.id;
        const appRequest =
          url.host === 'app' &&
          (mainNavigation ? isApplicationDocument(details.url) : ownsMainFrame(details, owner));
        const shellRequest =
          url.host === 'shell' &&
          details.webContentsId === owner?.id &&
          (mainNavigation || details.frame?.routingId === owner?.frame.routingId);
        const legalRequest =
          owner !== undefined &&
          !!runtimeLegalId(details.url) &&
          details.resourceType === 'subFrame' &&
          details.webContentsId === owner?.id &&
          isApplicationDocument(owner.frame.url);
        callback({ cancel: !appRequest && !shellRequest && !legalRequest });
        return;
      }
      if (url.protocol === 'http:' || url.protocol === 'https:') {
        callback({ cancel: true });
        return;
      }
      if (url.protocol === 'ws:' || url.protocol === 'wss:') {
        callback({
          cancel:
            !isHostWebSocket(details.url, this.options.authority()) ||
            !ownsMainFrame(details, this.owner()),
        });
        return;
      }
      callback({});
    });
    this.session.webRequest.onBeforeSendHeaders((details, callback) => {
      callback(webSocketHeaders(details, this.owner(), this.options.authority()));
    });
    const clipboard = (permission: string, url: string) =>
      ['clipboard-read', 'clipboard-sanitized-write'].includes(permission) &&
      isApplicationDocument(url);
    this.session.setPermissionRequestHandler((contents, permission, callback, details) =>
      callback(
        !this.closed &&
          contents === window.webContents &&
          details.isMainFrame &&
          isApplicationDocument(contents.getURL()) &&
          clipboard(permission, details.requestingUrl),
      ),
    );
    this.session.setPermissionCheckHandler(
      (contents, permission, origin, details) =>
        !this.closed &&
        contents === window.webContents &&
        details.isMainFrame &&
        isApplicationDocument(contents.getURL()) &&
        origin === 'axterm-app://app' &&
        clipboard(permission, details.requestingUrl ?? contents.getURL()),
    );
  }
  private owner(): WindowIdentity | undefined {
    if (this.closed || this.window.isDestroyed() || this.window.webContents.isDestroyed())
      return undefined;
    try {
      const frame = this.window.webContents.mainFrame;
      return {
        id: this.window.webContents.id,
        frame: { processId: frame.processId, routingId: frame.routingId, url: frame.url },
      };
    } catch {
      return undefined;
    }
  }
  private async resource(request: Request): Promise<Response> {
    if (this.closed || !this.owner()) return new Response(null, { status: 503 });
    const url = new URL(request.url);
    if (url.hostname === 'shell') return this.options.shellDocument(url.pathname);
    if (url.hostname !== 'app') return new Response(null, { status: 404 });
    if (
      ['/', '/index.html', '/favicon.svg', '/manifest.webmanifest'].includes(url.pathname) ||
      url.pathname.startsWith('/assets/')
    ) {
      try {
        return await serveWebDocument(request, this.options.webRoot);
      } catch {
        return new Response('Unavailable', { status: 503 });
      }
    }
    const legal = !!runtimeLegalId(request.url) && !!this.options.runtimeLegalDocument;
    const authority = this.options.authority();
    if (!legal && !authority) return new Response(null, { status: 503 });
    if (this.active.size >= 128) return new Response(null, { status: 429 });
    const abort = new AbortController();
    this.active.add(abort);
    const signal = AbortSignal.any([this.lifetime.signal, abort.signal]);
    // Binary requests may still be sending their body while awaiting response headers.
    // Keep policy transport-only; the owning plugin validates and publishes its data.
    const binaryUpload =
      request.body !== null &&
      ['POST', 'PUT', 'PATCH'].includes(request.method) &&
      request.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() ===
        'application/octet-stream';
    const timer = setTimeout(() => abort.abort(), binaryUpload ? 30 * 60_000 : 30_000);
    const release = () => {
      clearTimeout(timer);
      this.active.delete(abort);
    };
    try {
      const response = legal
        ? await this.options.runtimeLegalDocument!(request, signal)
        : await forwardWebRequest(request, authority!, signal);
      clearTimeout(timer);
      if (!response.body) {
        release();
        return response;
      }
      const reader = response.body.getReader();
      const body = new ReadableStream<Uint8Array>({
        async pull(controller) {
          try {
            const next = await reader.read();
            if (next.done) {
              release();
              reader.releaseLock();
              controller.close();
            } else controller.enqueue(next.value);
          } catch {
            try {
              await reader.cancel();
            } catch {
              /* The generation may already be disconnected. */
            } finally {
              release();
              reader.releaseLock();
            }
            controller.error(new Error('DESKTOP_RESPONSE_INTERRUPTED'));
          }
        },
        async cancel() {
          abort.abort();
          try {
            await reader.cancel();
          } finally {
            release();
            reader.releaseLock();
          }
        },
      });
      return new Response(body, { status: response.status, headers: response.headers });
    } catch {
      release();
      return new Response('Host unavailable', { status: 503 });
    }
  }
  retireGeneration(): void {
    for (const abort of this.active) abort.abort();
    this.active.clear();
  }
  dispose(): void {
    if (this.closed) return;
    this.closed = true;
    this.lifetime.abort();
    this.retireGeneration();
    this.session.protocol.unhandle('axterm-app');
    this.session.webRequest.onBeforeRequest(null);
    this.session.webRequest.onBeforeSendHeaders(null);
    this.session.setPermissionRequestHandler(null);
    this.session.setPermissionCheckHandler(null);
  }
}
/** Distinct memory sessions prevent another window from inheriting protocol or credential authority. */
export function windowPartition(): string {
  return `axterm-window-${randomUUID()}`;
}
export { APP_URL };
