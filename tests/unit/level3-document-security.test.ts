import { createHash } from 'node:crypto';
import type { BrowserWindow } from 'electron';
import { expect, it, vi } from 'vitest';
import { protectApplicationDocument } from '../../packages/infra/connection/src/document-security.ts';
import { WindowTransport } from '../../apps/desktop/src/shell/window-transport.ts';
import { APP_URL } from '../../apps/desktop/src/shell/window-policy.ts';
const hash = (text: string) =>
  "'sha256-" + createHash('sha256').update(text).digest('base64') + "'";
it('retains original CSP restrictions with only real inline script hashes and a fresh bounded document nonce', () => {
  const source =
    '<!doctype html><html><head><script>globalThis.boot=1</script></head><body><!-- <script>comment()</script> --><textarea><script>text()</script></textarea><template><script>inert()</script></template><script src="/factory.js">ignored()</script></body></html>';
  const document = protectApplicationDocument(source, {
      surface: 'web',
      url: 'https://example.test/app/',
    }),
    csp = document.headers['content-security-policy']!;
  expect(csp).toContain("script-src 'self' 'wasm-unsafe-eval'");
  expect(csp).toContain("connect-src 'self' data:;");
  expect(csp).toContain("style-src 'self' 'unsafe-inline'");
  expect(csp).not.toContain("script-src 'self' 'unsafe-inline'");
  expect(csp).not.toContain("'unsafe-eval'");
  for (const clause of [
    "object-src 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
    "base-uri 'self'",
  ])
    expect(csp).toContain(clause);
  expect(csp).toContain(hash('globalThis.boot=1'));
  for (const text of ['comment()', 'text()', 'inert()', 'ignored()'])
    expect(csp).not.toContain(hash(text));
  const nonce = /name="axterm-csp-nonce" content="([^"]+)"/.exec(document.html)![1]!;
  expect(csp).toContain(`'nonce-${nonce}'`);
  expect(Buffer.from(nonce, 'base64')).toHaveLength(24);
  expect(document.html.replace(/<meta name="axterm-csp-nonce" content="[^"]+">/, '')).toBe(source);
  expect(
    protectApplicationDocument(source, { surface: 'web', url: 'https://example.test/app/' }).html,
  ).not.toBe(document.html);
});
it('rejects oversized documents, excessive script policies, duplicate nonce ownership and invalid Web authorities without reflecting values', () => {
  expect(() =>
    protectApplicationDocument('x'.repeat(8 * 1024 * 1024 + 1), { surface: 'desktop' }),
  ).toThrow('DOCUMENT_POLICY_LIMIT');
  expect(() =>
    protectApplicationDocument('<script>1</script>'.repeat(129), { surface: 'desktop' }),
  ).toThrow('DOCUMENT_POLICY_LIMIT');
  expect(() =>
    protectApplicationDocument('<meta name="axterm-csp-nonce" content="foreign">', {
      surface: 'desktop',
    }),
  ).toThrow('DOCUMENT_POLICY_NONCE_DUPLICATE');
  for (const url of [
    'not-a-url',
    'javascript:alert(1)',
    'https://user:PRIVATE_DOCUMENT_VALUE@example.test/',
    'http://localhost/?token=PRIVATE_DOCUMENT_VALUE',
  ])
    expect(() => protectApplicationDocument('<html></html>', { surface: 'web', url })).toThrow(
      'DOCUMENT_POLICY_ORIGIN_INVALID',
    );
});
it('enforces Desktop CSP network authority through the actual owning WindowTransport for IPv6, foreign frames and direct HTTP', () => {
  type Before = (
    details: {
      url: string;
      webContentsId: number;
      resourceType: string;
      frame?: { processId: number; routingId: number; url: string };
    },
    callback: (value: { cancel?: boolean }) => void,
  ) => void;
  let listener: Before | null = null;
  const session = {
    protocol: { handle: vi.fn(), unhandle: vi.fn() },
    webRequest: {
      onBeforeRequest: (next: Before | null) => {
        listener = next;
      },
      onBeforeSendHeaders: vi.fn(),
    },
    setPermissionRequestHandler: vi.fn(),
    setPermissionCheckHandler: vi.fn(),
  };
  const frame = { processId: 10, routingId: 20, url: APP_URL },
    contents = {
      id: 7,
      session,
      isDestroyed: () => false,
      mainFrame: frame,
      getURL: () => APP_URL,
    },
    window = { webContents: contents, isDestroyed: () => false };
  const owner = new WindowTransport(window as unknown as BrowserWindow, {
    webRoot: '/unused',
    authority: () => ({
      origin: 'http://[::1]:49152',
      generation: crypto.randomUUID(),
      credential: 'PRIVATE_SHELL_VALUE',
    }),
    shellDocument: () => new Response('unused'),
  });
  const before = listener as unknown as Before;
  function cancelled(url: string, foreign = false) {
    let result: boolean | undefined;
    before(
      {
        url,
        webContentsId: 7,
        resourceType: 'webSocket',
        frame: foreign ? { ...frame, routingId: 21 } : frame,
      },
      (value) => {
        result = value.cancel;
      },
    );
    return result;
  }
  try {
    expect(
      protectApplicationDocument('<html></html>', { surface: 'desktop' }).headers[
        'content-security-policy'
      ],
    ).toContain("connect-src 'self' data: ws:;");
    expect(cancelled('ws://[::1]:49152/stream')).toBe(false);
    for (const url of [
      'ws://[::1]:49153/stream',
      'ws://evil.example/stream',
      'wss://evil.example/stream',
      'http://[::1]:49152/api/desktop/getRuntimeMetadata',
      'https://example.test/',
    ])
      expect(cancelled(url)).toBe(true);
    expect(cancelled('ws://[::1]:49152/stream', true)).toBe(true);
  } finally {
    owner.dispose();
  }
  expect(cancelled('ws://[::1]:49152/stream')).toBe(true);
  expect(listener).toBeNull();
});
