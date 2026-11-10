import { afterEach, expect, it, vi } from 'vitest';
import type { BrowserWindow } from 'electron';
import { WindowTransport } from '../../apps/desktop/src/shell/window-transport.ts';
import { APP_URL } from '../../apps/desktop/src/shell/window-policy.ts';
const live = new Set<WindowTransport>();
afterEach(() => {
  for (const transport of live) transport.dispose();
  live.clear();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
function fixture() {
  let handle!: (request: Request) => Promise<Response>;
  const session = {
    protocol: {
      handle: vi.fn((_scheme: string, handler: typeof handle) => {
        handle = handler;
      }),
      unhandle: vi.fn(),
    },
    webRequest: { onBeforeRequest: vi.fn(), onBeforeSendHeaders: vi.fn() },
    setPermissionRequestHandler: vi.fn(),
    setPermissionCheckHandler: vi.fn(),
  };
  const window = {
    isDestroyed: () => false,
    webContents: {
      id: 1,
      isDestroyed: () => false,
      getURL: () => APP_URL,
      mainFrame: { processId: 2, routingId: 3, url: APP_URL },
      session,
    },
  };
  const authority = {
    generation: crypto.randomUUID(),
    origin: 'http://127.0.0.1:4321',
    credential: 'WINDOW_ONLY_CREDENTIAL',
  };
  const transport = new WindowTransport(window as unknown as BrowserWindow, {
    webRoot: '/unused',
    authority: () => authority,
    shellDocument: () => new Response(),
  });
  live.add(transport);
  return { transport, session, handle: (request: Request) => handle(request) };
}
function stalledFetch() {
  const signals: AbortSignal[] = [];
  const fetcher = vi.fn<typeof fetch>(
    (_url, init) =>
      new Promise((_resolve, reject) => {
        const signal = init!.signal!;
        signals.push(signal);
        const abort = () => reject(new DOMException('Aborted', 'AbortError'));
        if (signal.aborted) abort();
        else signal.addEventListener('abort', abort, { once: true });
      }),
  );
  vi.stubGlobal('fetch', fetcher);
  return { fetcher, signals };
}
function binary(type = 'application/octet-stream', method = 'POST') {
  return new Request(APP_URL + 'owned-stream', {
    method,
    headers: { 'content-type': type },
    body: new Uint8Array([1, 2, 3]),
  });
}
it('preserves the ordinary header deadline, actually aborts its request and releases the timer', async () => {
  const f = fixture(),
    fetch = stalledFetch();
  const timers = vi.spyOn(globalThis, 'setTimeout');
  const clear = vi.spyOn(globalThis, 'clearTimeout');
  const pending = f.handle(binary('application/json'));
  await Promise.resolve();
  expect(fetch.signals[0]?.aborted).toBe(false);
  const callback = timers.mock.calls.find(([, delay]) => delay === 30_000)?.[0];
  expect(callback).toBeTypeOf('function');
  (callback as () => void)();
  expect((await pending).status).toBe(503);
  expect(fetch.signals[0]?.aborted).toBe(true);
  expect(clear).toHaveBeenCalled();
});
it('admits binary method/media types under the bounded upload wait and still cancels each actual request on generation retirement', async () => {
  const f = fixture(),
    fetch = stalledFetch();
  const timers = vi.spyOn(globalThis, 'setTimeout');
  const pending = ['POST', 'PUT', 'PATCH'].map((method) =>
    f.handle(binary('Application/Octet-Stream; charset=binary', method)),
  );
  await Promise.resolve();
  expect(timers.mock.calls.filter(([, delay]) => delay === 30 * 60_000)).toHaveLength(3);
  expect(timers.mock.calls.filter(([, delay]) => delay === 30_000)).toHaveLength(0);
  f.transport.retireGeneration();
  expect(fetch.signals.every((signal) => signal.aborted)).toBe(true);
  expect((await Promise.all(pending)).map((response) => response.status)).toEqual([503, 503, 503]);
});
it('keeps bodyless/other HTTP requests on the short wait and propagates the original renderer cancellation', async () => {
  const f = fixture(),
    fetch = stalledFetch();
  const timers = vi.spyOn(globalThis, 'setTimeout');
  const cancel = new AbortController();
  const pending = [
    f.handle(
      new Request(APP_URL + 'read', {
        headers: { 'content-type': 'application/octet-stream' },
        signal: cancel.signal,
      }),
    ),
    f.handle(binary('text/plain')),
  ];
  await Promise.resolve();
  expect(timers.mock.calls.filter(([, delay]) => delay === 30_000)).toHaveLength(2);
  cancel.abort();
  expect((await pending[0]!).status).toBe(503);
  expect(fetch.signals[0]?.aborted).toBe(true);
  f.transport.dispose();
  expect((await pending[1]!).status).toBe(503);
});
it('retains the per-window admission cap for slow binary requests and drains their actual cancellations on disposal', async () => {
  const f = fixture(),
    fetch = stalledFetch();
  const requests = Array.from({ length: 128 }, () => f.handle(binary()));
  expect((await f.handle(binary())).status).toBe(429);
  expect(fetch.fetcher).toHaveBeenCalledTimes(128);
  f.transport.dispose();
  expect((await Promise.all(requests)).every((response) => response.status === 503)).toBe(true);
  expect(fetch.signals.every((signal) => signal.aborted)).toBe(true);
  expect(f.session.protocol.unhandle).toHaveBeenCalledExactlyOnceWith('axterm-app');
  expect((await f.handle(binary())).status).toBe(503);
});
