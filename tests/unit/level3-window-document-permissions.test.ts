import type { BrowserWindow } from 'electron';
import { expect, it, vi } from 'vitest';
import { APP_URL, isApplicationDocument } from '../../apps/desktop/src/shell/window-policy.ts';
import { WindowTransport } from '../../apps/desktop/src/shell/window-transport.ts';
it('retains original top-level document trust inputs on the owned application scheme', () => {
  expect(isApplicationDocument(APP_URL)).toBe(true);
  expect(isApplicationDocument(APP_URL + 'index.html')).toBe(true);
  for (const url of [
    'file:///etc/passwd',
    'axterm-app://app.evil.example/',
    APP_URL + 'assets/x.js',
    APP_URL + '?token=x',
    'http://127.0.0.1:1235/',
    'https://example.com/',
    'not-a-url',
  ])
    expect(isApplicationDocument(url)).toBe(false);
});
it('allows original clipboard permissions only to its actual owned top-level document and revokes captured checks on disposal', () => {
  type Request = (
    contents: unknown,
    permission: string,
    callback: (allowed: boolean) => void,
    details: { isMainFrame: boolean; requestingUrl: string },
  ) => void;
  type Check = (
    contents: unknown,
    permission: string,
    origin: string,
    details: { isMainFrame: boolean; requestingUrl?: string },
  ) => boolean;
  let request: Request | null = null,
    check: Check | null = null;
  const session = {
    protocol: { handle: vi.fn(), unhandle: vi.fn() },
    webRequest: { onBeforeRequest: vi.fn(), onBeforeSendHeaders: vi.fn() },
    setPermissionRequestHandler: (next: Request | null) => {
      request = next;
    },
    setPermissionCheckHandler: (next: Check | null) => {
      check = next;
    },
  };
  const contents = { session, getURL: () => APP_URL },
    window = { webContents: contents };
  const transport = new WindowTransport(window as unknown as BrowserWindow, {
    webRoot: '/unused',
    authority: () => undefined,
    shellDocument: () => new Response('unused'),
  });
  const requested = request as unknown as Request,
    checked = check as unknown as Check;
  const answer = (
    permission: string,
    requestingUrl = APP_URL,
    isMainFrame = true,
    target: unknown = contents,
  ) => {
    let allowed: boolean | undefined;
    requested(
      target,
      permission,
      (value) => {
        allowed = value;
      },
      { isMainFrame, requestingUrl },
    );
    return allowed;
  };
  try {
    for (const permission of ['clipboard-read', 'clipboard-sanitized-write']) {
      expect(answer(permission)).toBe(true);
      expect(
        checked(contents, permission, 'axterm-app://app', {
          isMainFrame: true,
          requestingUrl: APP_URL,
        }),
      ).toBe(true);
    }
    for (const permission of ['notifications', 'media', 'deprecated-sync-clipboard-read'])
      expect(answer(permission)).toBe(false);
    for (const requestingUrl of [
      APP_URL + 'assets/frame.html',
      'https://example.com',
      'not-a-url',
    ]) {
      expect(answer('clipboard-read', requestingUrl)).toBe(false);
      expect(
        checked(contents, 'clipboard-read', 'axterm-app://app', {
          isMainFrame: true,
          requestingUrl,
        }),
      ).toBe(false);
    }
    expect(answer('clipboard-read', APP_URL, false)).toBe(false);
    expect(answer('clipboard-read', APP_URL, true, { ...contents })).toBe(false);
    expect(
      checked(contents, 'clipboard-read', 'https://example.com', {
        isMainFrame: true,
        requestingUrl: APP_URL,
      }),
    ).toBe(false);
  } finally {
    transport.dispose();
  }
  expect(request).toBeNull();
  expect(check).toBeNull();
  expect(answer('clipboard-read')).toBe(false);
  expect(
    checked(contents, 'clipboard-read', 'axterm-app://app', {
      isMainFrame: true,
      requestingUrl: APP_URL,
    }),
  ).toBe(false);
});
