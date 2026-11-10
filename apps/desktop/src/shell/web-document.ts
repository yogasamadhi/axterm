import { protectApplicationDocument } from '@axterm/infra-connection/document-security';
// Copyright (c) 2026 DeepSeek. SPDX-License-Identifier: MIT
// Adapted from apps/desktop/src/web-document.ts at 8bd073392eef6f54e921a093b95076248eb08cbb.
/** Local Web document and authenticated HTTP forwarding for the application window. */
import { readFile } from 'node:fs/promises';
import { DESKTOP_AUTH_HEADER } from '@axterm/infra-connection';
import type { HostAuthority } from './window-policy.ts';
import { isApplicationUrl } from './window-policy.ts';
import { extname, resolve, sep } from 'node:path';

const MIME: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
  '.woff2': 'font/woff2',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};
const BOOT = '<script>globalThis.__AXTERM_BOOT_READY__ = Promise.withResolvers()</script>';

/**
 * Read an application-owned static asset; the index waits for asynchronous Host injections.
 * @param request - Local application request.
 * @param root - Packaged Web dist directory.
 * @returns Static response, or a missing/invalid path response.
 */
export async function serveWebDocument(request: Request, root: string): Promise<Response> {
  if (!['GET', 'HEAD'].includes(request.method)) return new Response(null, { status: 405 });
  const url = new URL(request.url);
  let pathname: string;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    return new Response(null, { status: 400 });
  }
  const target = resolve(root, '.' + (pathname === '/' ? '/index.html' : pathname));
  const directory = resolve(root);
  if (!target.startsWith(directory + sep)) return new Response(null, { status: 403 });
  let body: Buffer;
  try {
    body = await readFile(target);
  } catch (error) {
    if (['ENOENT', 'EISDIR', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? ''))
      return new Response(null, { status: 404 });
    throw error;
  }
  let content: string | Uint8Array<ArrayBuffer> =
    pathname === '/' || pathname === '/index.html'
      ? body.toString().replace('<head>', '<head>' + BOOT)
      : new Uint8Array(body);
  const secured =
    extname(target) === '.html'
      ? protectApplicationDocument(
          typeof content === 'string' ? content : new TextDecoder().decode(content),
          { surface: 'desktop' },
        )
      : undefined;
  if (secured) content = secured.html;
  return new Response(request.method === 'HEAD' ? null : content, {
    headers: {
      ...secured?.headers,
      'content-type': MIME[extname(target)] ?? 'application/octet-stream',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    },
  });
}

/**
 * Response headers not relayed to the renderer. `set-cookie` would hand the
 * Host's authentication cookie to the page's cookie jar, which the shell owns
 * instead; the rest describe the Node `fetch` connection (its encoding, length,
 * and hop-by-hop transport), which Chromium never sees.
 */
const WITHHELD_RESPONSE_HEADERS = [
  'set-cookie',
  'x-axterm-desktop-authorization',
  'content-encoding',
  'content-length',
  'transfer-encoding',
  'connection',
  'keep-alive',
  'te',
  'trailer',
  'upgrade',
  'proxy-authenticate',
  'proxy-authorization',
];

/** Host routes whose responses carry immutable cache headers keyed by a per-process revision. */
const PLUGIN_BUNDLE_PATH = /^\/plugins\//u;

/**
 * Forward local application requests to its authenticated Host, preserving streaming and cancellation.
 * Plugin bundle responses lose their `cache-control` for `no-store`: the Host marks them immutable
 * under a revision that changes every launch, so Chromium's disk cache would only accumulate bundles
 * no later launch can reuse.
 * @param request - Request from the application origin.
 * @param authority - Current generation and shell-memory credential.
 * @param signal - Window/generation lifetime.
 * @param fetcher - Node HTTP transport, replaceable for transport tests.
 * @returns Host response without connection-level headers.
 */
export async function forwardWebRequest(
  request: Request,
  authority: HostAuthority,
  signal: AbortSignal,
  fetcher: typeof fetch = fetch,
): Promise<Response> {
  const source = new URL(request.url);
  if (!isApplicationUrl(request.url) || source.searchParams.has('token'))
    return new Response(null, { status: 403 });
  const origin = request.headers.get('origin');
  if (origin !== null && origin !== 'axterm-app://app') return new Response(null, { status: 403 });
  const target = new URL(authority.origin);
  target.pathname = source.pathname;
  target.search = source.search;
  const headers = new Headers(request.headers);
  for (const name of [
    'host',
    'origin',
    'cookie',
    'authorization',
    DESKTOP_AUTH_HEADER,
    'sec-fetch-site',
  ])
    headers.delete(name);
  headers.set(DESKTOP_AUTH_HEADER, authority.credential);
  headers.set('origin', authority.origin);
  const init = {
    method: request.method,
    headers,
    body: request.body,
    signal: AbortSignal.any([request.signal, signal]),
    duplex: 'half',
    redirect: 'manual' as const,
  };
  const response = await fetcher(target, init);
  const location = response.headers.get('location');
  if (location !== null) {
    let redirected: URL;
    try {
      redirected = new URL(location, target);
    } catch {
      await response.body?.cancel();
      return new Response(null, { status: 502 });
    }
    if (
      redirected.origin !== target.origin ||
      redirected.username ||
      redirected.password ||
      redirected.searchParams.has('token')
    ) {
      await response.body?.cancel();
      return new Response(null, { status: 502 });
    }
  }
  const outgoing = new Headers(response.headers);
  if (location !== null) {
    const redirected = new URL(location, target);
    outgoing.set(
      'location',
      'axterm-app://app' + redirected.pathname + redirected.search + redirected.hash,
    );
  }
  for (const name of WITHHELD_RESPONSE_HEADERS) outgoing.delete(name);
  if (PLUGIN_BUNDLE_PATH.test(source.pathname)) outgoing.set('cache-control', 'no-store');
  return new Response(response.body, { status: response.status, headers: outgoing });
}
