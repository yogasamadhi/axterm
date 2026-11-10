import { mkdir, mkdtemp, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { DESKTOP_AUTH_HEADER } from '@axterm/infra-connection';
import {
  APP_URL,
  ownsMainFrame,
  webSocketHeaders,
  type WindowRequest,
} from '../../apps/desktop/src/shell/window-policy.ts';
import { forwardWebRequest, serveWebDocument } from '../../apps/desktop/src/shell/web-document.ts';
import { parseLoginEnvironment } from '../../apps/desktop/src/shell/login-environment.ts';
import { parseHostControl } from '../../apps/desktop-host/src/protocol.ts';
import { resolveShellHome } from '../../apps/desktop/src/shell/home-policy.ts';
const generation = '12345678-1234-4234-8234-123456789012';
const authority = {
  generation,
  origin: 'http://127.0.0.1:4321',
  credential: 'SHELL_ONLY_CREDENTIAL',
};
const frame = { processId: 1, routingId: 2, url: APP_URL };
const owner = { id: 3, frame };
const request = (): WindowRequest => ({
  url: 'ws://127.0.0.1:4321/api',
  webContentsId: 3,
  frame,
  requestHeaders: {
    Origin: 'axterm-app://app',
    Cookie: 'untrusted',
    Authorization: 'untrusted',
    [DESKTOP_AUTH_HEADER]: 'untrusted',
  },
});
it('attaches current Host authority only to the owning main document and strips incoming credentials everywhere', () => {
  expect(webSocketHeaders(request(), owner, authority)).toEqual({
    requestHeaders: {
      origin: authority.origin,
      [DESKTOP_AUTH_HEADER]: authority.credential,
      'sec-fetch-site': 'same-origin',
    },
  });
  for (const changes of [
    { frame: undefined },
    { frame: null },
    { frame: { ...frame, routingId: 8 } },
    { frame: { ...frame, url: 'about:blank' } },
    { webContentsId: 8 },
    { requestHeaders: { Origin: 'https://foreign.test' } },
  ]) {
    const result = webSocketHeaders(
      { ...request(), ...changes } as WindowRequest,
      owner,
      authority,
    );
    expect(result.cancel).toBe(true);
    expect(result.requestHeaders[DESKTOP_AUTH_HEADER]).toBeUndefined();
  }
  expect(ownsMainFrame(request(), undefined)).toBe(false);
  for (const target of [
    'ws://external.test/api',
    'http://127.0.0.1:4321/api',
    'ws://127.0.0.1:4322/api',
  ]) {
    expect(
      webSocketHeaders({ ...request(), url: target }, owner, authority).requestHeaders[
        DESKTOP_AUTH_HEADER
      ],
    ).toBeUndefined();
  }
  expect(
    webSocketHeaders(request(), owner, undefined).requestHeaders[DESKTOP_AUTH_HEADER],
  ).toBeUndefined();
});
it('serves the static entry with an asynchronous same-document gate and rejects escaped assets and unsafe methods', async () => {
  const root = await mkdtemp(join(tmpdir(), 'axterm-web-document-'));
  try {
    await writeFile(join(root, 'index.html'), '<html><head></head><body>BOOT</body></html>');
    const response = await serveWebDocument(new Request(APP_URL), root);
    expect(await response.text()).toContain('<head><script>globalThis.__AXTERM_BOOT_READY__');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect((await serveWebDocument(new Request(APP_URL, { method: 'POST' }), root)).status).toBe(
      405,
    );
    expect((await serveWebDocument(new Request(APP_URL + '%2e%2e%2fsecret'), root)).status).toBe(
      403,
    );
    expect((await serveWebDocument(new Request(APP_URL + 'missing'), root)).status).toBe(404);
    expect(
      await (await serveWebDocument(new Request(APP_URL, { method: 'HEAD' }), root)).text(),
    ).toBe('');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
it('streams only to the current Host, rewrites owned redirects and removes cookies and transport headers', async () => {
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async (url, init) => {
    expect(String(url)).toBe(authority.origin + '/plugins/probe?q=1');
    const headers = new Headers(init?.headers);
    expect(headers.get('origin')).toBe(authority.origin);
    expect(headers.get(DESKTOP_AUTH_HEADER)).toBe(authority.credential);
    expect(headers.get('cookie')).toBeNull();
    expect(headers.get('authorization')).toBeNull();
    return new Response('streamed', {
      status: 200,
      headers: {
        'set-cookie': 'private',
        'content-encoding': 'gzip',
        'content-length': '8',
        'cache-control': 'immutable',
        location: '/next',
        [DESKTOP_AUTH_HEADER]: 'never-to-page',
      },
    });
  });
  const response = await forwardWebRequest(
    new Request(APP_URL + 'plugins/probe?q=1', { headers: request().requestHeaders }),
    authority,
    new AbortController().signal,
    fetcher,
  );
  expect(await response.text()).toBe('streamed');
  expect(response.headers.get('location')).toBe('axterm-app://app/next');
  expect(response.headers.get('cache-control')).toBe('no-store');
  for (const header of ['set-cookie', 'content-encoding', 'content-length', DESKTOP_AUTH_HEADER])
    expect(response.headers.has(header)).toBe(false);
  for (const url of ['https://other.test/file', APP_URL + 'file?token=invalid'])
    expect(
      (await forwardWebRequest(new Request(url), authority, new AbortController().signal, fetcher))
        .status,
    ).toBe(403);
  expect(fetcher).toHaveBeenCalledOnce();
  const cancel = vi.fn();
  const foreign = vi.fn<typeof fetch>().mockResolvedValue(
    new Response(new ReadableStream({ cancel }), {
      status: 302,
      headers: { location: 'https://other.test/' },
    }),
  );
  expect(
    (
      await forwardWebRequest(
        new Request(APP_URL + 'file'),
        authority,
        new AbortController().signal,
        foreign,
      )
    ).status,
  ).toBe(502);
  expect(cancel).toHaveBeenCalledOnce();
});
it('rejects wrong origins, private fields, oversized injection payloads and prototype pollution at the Host boundary', () => {
  const ready = {
    kind: 'axterm-desktop-control',
    version: 1,
    generation,
    type: 'ready',
    origin: authority.origin,
    injections: [{ kind: 'global', name: '__AXTERM_BOOT__', value: { plugins: [] } }],
  };
  expect(parseHostControl(ready)).toEqual(ready);
  for (const patch of [
    { origin: 'http://localhost:4321' },
    { origin: 'http://127.0.0.1:4321/?token=x' },
    { credential: 'PRIVATE' },
    { injections: [{ kind: 'global', name: '__proto__', value: {} }] },
    { injections: [{ kind: 'script', placement: 'head', text: '</script>' }] },
    { injections: [{ kind: 'html', placement: 'body', html: 'x'.repeat(262145) }] },
  ])
    expect(() => parseHostControl({ ...ready, ...patch })).toThrow('HOST_CONTROL_INVALID');
});
it('extracts only a complete framed login environment without copying native or auth launch overrides', () => {
  expect(
    parseLoginEnvironment(
      Buffer.from(
        'noise\0_AXTERM_LOGIN_ENV_\0PATH=/bin\0A=x=y\0PWD=/bad\0AXTERM_HOME=/bad\0ELECTRON_RUN_AS_NODE=1\0_AXTERM_LOGIN_ENV_\0trailer',
      ),
    ),
  ).toEqual({ PATH: '/bin', A: 'x=y' });
  expect(parseLoginEnvironment(Buffer.from('_AXTERM_LOGIN_ENV_\0PATH=/bin'))).toBeUndefined();
});

it('requires an isolated development home including descendants and symlink aliases', async () => {
  const root = await mkdtemp(join(tmpdir(), 'axterm-shell-home-'));
  try {
    const user = join(root, 'user');
    const production = join(user, '.axterm');
    await mkdir(production, { recursive: true });
    await symlink(
      production,
      join(root, 'alias'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    await expect(resolveShellHome(undefined, false, user)).rejects.toThrow(
      'DEVELOPMENT_HOME_REQUIRED',
    );
    await expect(resolveShellHome('relative', true, user)).rejects.toThrow('ABSOLUTE');
    for (const path of [production, join(production, 'nested'), join(root, 'alias', 'nested')])
      await expect(resolveShellHome(path, false, user)).rejects.toThrow('ISOLATED');
    await expect(resolveShellHome(join(root, 'development'), false, user)).resolves.toBe(
      join(root, 'development'),
    );
    await expect(resolveShellHome(undefined, true, user)).resolves.toBe(production);
    if (process.platform === 'darwin' || process.platform === 'win32')
      await expect(
        resolveShellHome(join(user, '.AXTERM', 'nested'), true, user, true),
      ).rejects.toThrow('ISOLATED');
    // A packaged migration fixture still obeys the development isolation policy.
    await expect(resolveShellHome(undefined, true, user, true)).rejects.toThrow('HOME_REQUIRED');
    await expect(resolveShellHome(production, true, user, true)).rejects.toThrow('ISOLATED');
    await expect(resolveShellHome(join(root, 'alias', 'nested'), true, user, true)).rejects.toThrow(
      'ISOLATED',
    );
    await expect(resolveShellHome(join(root, 'validation'), true, user, true)).resolves.toBe(
      join(root, 'validation'),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
