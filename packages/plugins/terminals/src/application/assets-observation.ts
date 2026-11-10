import { RemoteError } from '@axterm/plugin-api';
import {
  TERMINAL_ASSETS_CHUNK_CHARACTERS,
  TERMINAL_ASSETS_MAX_SNAPSHOT_BYTES,
  type TerminalAssetsContent,
  type TerminalAssetsUpdate,
} from '@axterm/plugin-api/terminals';
import type { RelationalDomain } from '@axterm/plugin-api/storage';
const failure = (reason: 'capacity' | 'unavailable' | 'closed' | 'conflict') =>
  new RemoteError('terminals/failure', 'Terminal facts observation is unavailable', { reason });
/** Terminal-owned collections are replaced atomically; durable cursors also detect another Profile's writes. */
export class TerminalAssetsObservation {
  private readonly followers = new Set<() => void>();
  private readonly endings = new Set<Promise<unknown>>();
  private bufferedBytes = 0;
  private closed = false;
  constructor(
    private readonly domain: RelationalDomain,
    private readonly generation: string,
    private readonly snapshot: () => TerminalAssetsContent,
  ) {}
  watch(signal: AbortSignal): AsyncIterableIterator<TerminalAssetsUpdate> {
    signal.throwIfAborted();
    if (this.closed) throw failure('closed');
    if (this.followers.size >= 64) throw failure('capacity');
    let open = true;
    let reading = false;
    let retainedBytes = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let wake: (() => void) | undefined;
    const notify = () => {
      wake?.();
    };
    const unsubscribe = this.domain.subscribe(notify);
    const close = () => {
      if (!open) return;
      open = false;
      unsubscribe();
      clearTimeout(timer);
      notify();
      signal.removeEventListener('abort', close);
      this.bufferedBytes -= retainedBytes;
      retainedBytes = 0;
      this.followers.delete(close);
      const ending = generator.return(undefined).catch(() => {});
      this.endings.add(ending);
      void ending.finally(() => this.endings.delete(ending));
    };
    const wait = async () => {
      const pending = Promise.withResolvers<void>();
      wake = () => pending.resolve();
      timer = setTimeout(notify, 250);
      try {
        await pending.promise;
      } finally {
        clearTimeout(timer);
        wake = undefined;
      }
    };
    this.followers.add(close);
    signal.addEventListener('abort', close, { once: true });
    const generator = async function* (
      this: TerminalAssetsObservation,
    ): AsyncGenerator<TerminalAssetsUpdate> {
      let cursor = -1;
      try {
        while (open) {
          if (cursor === this.domain.cursor()) {
            await wait();
            continue;
          }
          const frame = this.domain.transaction(() => ({
            cursor: this.domain.cursor(),
            text: JSON.stringify(this.snapshot()),
          }));
          const bytes = Buffer.byteLength(frame.text);
          if (
            bytes > TERMINAL_ASSETS_MAX_SNAPSHOT_BYTES ||
            this.bufferedBytes + bytes > 2 * TERMINAL_ASSETS_MAX_SNAPSHOT_BYTES
          )
            throw failure('capacity');
          retainedBytes = bytes;
          this.bufferedBytes += bytes;
          yield {
            type: 'begin',
            mode: cursor < 0 ? 'baseline' : 'replace',
            generation: this.generation,
            cursor: frame.cursor,
          };
          for (
            let offset = 0;
            offset < frame.text.length;
            offset += TERMINAL_ASSETS_CHUNK_CHARACTERS
          ) {
            if (!open) return;
            yield {
              type: 'chunk',
              offset,
              text: frame.text.slice(offset, offset + TERMINAL_ASSETS_CHUNK_CHARACTERS),
              final: offset + TERMINAL_ASSETS_CHUNK_CHARACTERS >= frame.text.length,
            };
          }
          if (!open) return;
          cursor = frame.cursor;
          this.bufferedBytes -= retainedBytes;
          retainedBytes = 0;
          yield { type: 'commit', cursor };
        }
      } catch (error) {
        if (open) throw error instanceof RemoteError ? error : failure('unavailable');
      } finally {
        close();
      }
    }.call(this);
    return {
      [Symbol.asyncIterator]() {
        return this;
      },
      next: async () => {
        if (reading) throw failure('conflict');
        reading = true;
        try {
          return await generator.next();
        } finally {
          reading = false;
        }
      },
      return: async () => {
        close();
        return generator.return(undefined);
      },
      throw: async (error) => {
        close();
        return generator.throw(error);
      },
    };
  }
  async dispose(): Promise<void> {
    this.closed = true;
    for (const close of [...this.followers]) close();
    await Promise.all([...this.endings]);
  }
}
