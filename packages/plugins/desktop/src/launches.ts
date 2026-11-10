import { ownDesktopIterator } from './owned-iterator.ts';
import { z } from 'zod';
import { desktopLaunchSchema, type DesktopLaunch } from '@axterm/plugin-api/session-intents';
import type { NativeDesktopLaunches } from '@axterm/plugin-api/host';
/** Ephemeral OS input is delivered once; no baseline cache or reconnect replay exists. */
export class DesktopLaunchStreams {
  private readonly lifetime = new AbortController();
  private readonly streams = new Set<AsyncGenerator<DesktopLaunch>>();
  private closing: Promise<void> | undefined;
  private readonly polled = new Set<string>();
  private readonly windows = new Map<string, number>();
  private startup:
    { phase: 'native' } | { phase: 'configured'; windowId: string; key: string } | undefined;
  decision(
    windowId: string,
    key: string,
    claim = false,
  ): 'waiting' | 'ready' | 'native' | 'configured' | 'claimed' {
    z.uuid().parse(windowId);
    z.uuid().parse(key);
    if (this.closing) throw Error('DESKTOP_STARTUP_CLOSED');
    if (this.startup?.phase === 'native') return 'native';
    if (this.startup?.phase === 'configured')
      return this.startup.windowId === windowId && this.startup.key === key
        ? 'configured'
        : 'claimed';
    if (!this.polled.has(windowId)) return 'waiting';
    if (claim) {
      this.startup = { phase: 'configured', windowId, key };
      return 'configured';
    }
    return 'ready';
  }
  constructor(private readonly native: () => NativeDesktopLaunches | undefined) {}
  watch(windowId: string, signal: AbortSignal): AsyncIterable<DesktopLaunch> {
    z.uuid().parse(windowId);
    if (this.closing || this.streams.size >= 8) throw Error('DESKTOP_LAUNCH_STREAM_CAPACITY');
    const native = this.native();
    if (!native) throw Error('DESKTOP_LAUNCH_UNAVAILABLE');
    signal.throwIfAborted();
    this.lifetime.signal.throwIfAborted();
    const streams = this.streams,
      windows = this.windows,
      polled = this.polled;
    const markNative = () => {
      if (!this.startup) this.startup = { phase: 'native' };
    };
    windows.set(windowId, (windows.get(windowId) ?? 0) + 1);
    const iterator = ownDesktopIterator<DesktopLaunch>(
      (owned) =>
        (async function* () {
          while (!owned.aborted) {
            const next = await native.next(windowId, owned);
            if (next) markNative();
            if (!next) polled.add(windowId);
            owned.throwIfAborted();
            if (next) yield desktopLaunchSchema.parse(next);
          }
        })(),
      [this.lifetime.signal, signal],
      release,
    );
    function release(): void {
      if (!streams.delete(iterator)) return;
      const remaining = (windows.get(windowId) ?? 1) - 1;
      if (remaining > 0) windows.set(windowId, remaining);
      else {
        windows.delete(windowId);
        polled.delete(windowId);
      }
    }
    streams.add(iterator);
    return { [Symbol.asyncIterator]: () => iterator };
  }
  resourceCount(): number {
    return this.streams.size;
  }
  close(): Promise<void> {
    return (this.closing ??= (async () => {
      this.lifetime.abort();
      await Promise.allSettled([...this.streams].map((stream) => stream.return(undefined)));
      this.streams.clear();
      this.polled.clear();
      this.windows.clear();
    })());
  }
}
