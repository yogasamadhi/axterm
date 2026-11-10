import { RemoteError } from '@axterm/plugin-api';
import type { RelationalDomain } from '@axterm/plugin-api/storage';
import type { AiLogEntry } from '@axterm/plugin-api/ai';
import type { AiQueries } from './adapters/queries.ts';
/** Durable visible entries, separate from ephemeral application events and metadata baselines. */
export class AiLogObservation {
  private readonly followers = new Set<() => void>();
  private readonly endings = new Set<Promise<unknown>>();
  private bytes = 0;
  private closed = false;
  constructor(
    private readonly domain: RelationalDomain,
    private readonly queries: AiQueries,
  ) {}
  watch(runId: string, after: number, signal: AbortSignal): AsyncIterableIterator<AiLogEntry> {
    signal.throwIfAborted();
    if (this.closed || this.followers.size >= 64)
      throw new RemoteError('ai/failure', 'AI log observation unavailable', {
        reason: this.closed ? 'closed' : 'capacity',
      });
    let live = true;
    let wake: (() => void) | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let retained = 0;
    let reading = false;
    const notify = () => wake?.();
    const off = this.domain.subscribe(notify);
    const close = () => {
      if (!live) return;
      live = false;
      off();
      signal.removeEventListener('abort', close);
      clearTimeout(timer);
      notify();
      this.bytes -= retained;
      retained = 0;
      this.followers.delete(close);
      const ending = generator.return(undefined).catch(() => {});
      this.endings.add(ending);
      void ending.then(() => this.endings.delete(ending));
    };
    this.followers.add(close);
    signal.addEventListener('abort', close, { once: true });
    const generator = async function* (this: AiLogObservation): AsyncGenerator<AiLogEntry> {
      let cursor = after;
      try {
        while (live) {
          const page = this.queries.logs(runId, { after: cursor, limit: 50 });
          if (page.entries.length) {
            const size = Buffer.byteLength(JSON.stringify(page));
            if (this.bytes + size > 16 * 1024 * 1024)
              throw new RemoteError('ai/failure', 'AI log observation capacity reached', {
                reason: 'capacity',
              });
            retained = size;
            this.bytes += retained;
            for (const entry of page.entries) {
              if (!live) return;
              yield entry;
              cursor = entry.cursor;
            }
            this.bytes -= retained;
            retained = 0;
            continue;
          }
          await new Promise<void>((resolve) => {
            wake = resolve;
            timer = setTimeout(resolve, 250);
          });
          clearTimeout(timer);
          wake = undefined;
        }
      } catch (error) {
        if (live) {
          if (error instanceof RemoteError) throw error;
          throw new RemoteError('ai/failure', 'AI log observation unavailable', {
            reason: 'unavailable',
          });
        }
      } finally {
        close();
      }
    }.call(this);
    return {
      [Symbol.asyncIterator]() {
        return this;
      },
      next: async () => {
        if (reading)
          throw new RemoteError('ai/failure', 'Concurrent AI log reads refused', {
            reason: 'conflict',
          });
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
  resourceCount(): number {
    return this.followers.size + this.endings.size;
  }
  async dispose(): Promise<void> {
    this.closed = true;
    for (const close of [...this.followers]) close();
    await Promise.all([...this.endings]);
  }
}
