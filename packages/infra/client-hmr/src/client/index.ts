import type { Context } from '@deepseek-ai/cordis';
import type {} from '@axterm/infra-client-modules/client';
import { EVENTS_ROUTE, parsePluginsEventFrame } from '../events.ts';
export const name = 'client-hmr';
export const inject = ['modules'];
type Fetch = (input: string, init: RequestInit) => Promise<Response>;
/** Bounded SSE boundary. Entry reconciliation belongs to the root module controller. */
export async function readGraphEvents(
  fetch: Fetch,
  signal: AbortSignal,
  receive: (value: unknown) => void,
): Promise<void> {
  const response = await fetch(EVENTS_ROUTE, {
    method: 'GET',
    headers: { accept: 'text/event-stream' },
    credentials: 'same-origin',
    signal,
  });
  if (!response.ok || !response.body) {
    await response.body?.cancel();
    throw new Error('CLIENT_GRAPH_UNAVAILABLE');
  }
  const reader = response.body.getReader(),
    decoder = new TextDecoder();
  let buffer = '',
    cancelling: Promise<void> | undefined;
  const abort = () => {
    cancelling = reader.cancel().catch(() => {});
  };
  signal.addEventListener('abort', abort, { once: true });
  try {
    signal.throwIfAborted();
    while (!signal.aborted) {
      const item = await reader.read();
      if (item.done) break;
      if (item.value.byteLength > 4 * 1024 * 1024) throw new Error('CLIENT_GRAPH_CAPACITY');
      buffer += decoder.decode(item.value, { stream: true });
      let match: RegExpExecArray | null;
      while ((match = /\r?\n\r?\n/u.exec(buffer))) {
        const block = buffer.slice(0, match.index);
        buffer = buffer.slice(match.index + match[0].length);
        if (new TextEncoder().encode(block).byteLength > 2 * 1024 * 1024)
          throw new Error('CLIENT_GRAPH_CAPACITY');
        const data = block
          .split(/\r?\n/u)
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).trimStart())
          .join('\n');
        if (data) {
          receive(JSON.parse(data));
        }
      }
      if (buffer.length > 2 * 1024 * 1024) throw new Error('CLIENT_GRAPH_CAPACITY');
    }
    if (!signal.aborted) throw new Error('CLIENT_GRAPH_ENDED');
  } finally {
    signal.removeEventListener('abort', abort);
    await (cancelling ?? reader.cancel().catch(() => {}));
    reader.releaseLock();
  }
}
export function apply(ctx: Context): void {
  const entries = ctx.modules.entries;
  let closed = false,
    pending: unknown,
    active = false;
  const run = () => {
    if (closed || active || pending === undefined) return;
    const graph = pending;
    pending = undefined;
    active = true;
    // entries.sync retains the actual reconciliation in the root-owned queue. Joining it here would deadlock self-unload.
    const operation = Promise.resolve().then(() => entries.sync(graph));
    void operation.then(
      () => {
        active = false;
        run();
      },
      () => {
        active = false;
        if (!closed) ctx.logger.warn('CLIENT_GRAPH_RECONCILIATION_FAILED');
        run();
      },
    );
  };
  const receive = (value: unknown) => {
    const parsed = parsePluginsEventFrame(value);
    if (parsed.kind === 'invalid') throw new Error('CLIENT_GRAPH_FRAME_INVALID');
    if (parsed.kind === 'frame' && parsed.frame.type === 'graph') {
      pending = parsed.frame.graph;
      run();
    }
  };
  ctx.effect(() => {
    const lifetime = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined, wake: (() => void) | undefined;
    const transport = (globalThis as { __AXTERM_TRANSPORT__?: { fetch?: Fetch } })
      .__AXTERM_TRANSPORT__;
    const fetch: Fetch = transport?.fetch ?? ((input, init) => globalThis.fetch(input, init));
    const done = (async () => {
      let failures = 0;
      while (!lifetime.signal.aborted) {
        try {
          await readGraphEvents(fetch, lifetime.signal, receive);
        } catch {
          if (!lifetime.signal.aborted && failures === 0)
            ctx.logger.warn('CLIENT_GRAPH_STREAM_UNAVAILABLE');
        }
        if (lifetime.signal.aborted) break;
        failures++;
        await new Promise<void>((resolve) => {
          wake = resolve;
          timer = setTimeout(resolve, Math.min(5000, 250 * 2 ** Math.min(failures, 5)));
        });
        clearTimeout(timer);
        wake = undefined;
      }
    })();
    return async () => {
      closed = true;
      pending = undefined;
      lifetime.abort();
      clearTimeout(timer);
      wake?.();
      await done;
    };
  }, 'client-hmr: graph transport');
}
