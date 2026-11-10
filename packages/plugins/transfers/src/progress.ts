import { RemoteError } from '@axterm/plugin-api';
import type { Transfer, TransferProgressSnapshot } from '@axterm/plugin-api/transfers';
import type { TransferEvents } from './application/transfer-service.ts';
/** Realtime progress is separate from durable fact cursors and never carries bytes. */
export class TransferProgress implements TransferEvents {
  private revision = 0;
  private closed = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private readonly listeners = new Set<() => void>();
  private readonly followers = new Set<() => void>();
  private readonly endings = new Set<Promise<unknown>>();
  resourceCount(): number {
    return this.followers.size;
  }
  constructor(
    private readonly generation: string,
    private readonly read: () => { items: Transfer[]; factCursor: number },
  ) {}
  publish(_type: 'transfer.progress', _transfer: Transfer): void {
    if (this.closed) return;
    this.timer ??= setTimeout(() => {
      this.timer = undefined;
      this.revision++;
      for (const listener of this.listeners) listener();
    }, 250);
  }
  watch(signal: AbortSignal): AsyncIterableIterator<TransferProgressSnapshot> {
    signal.throwIfAborted();
    if (this.closed || this.followers.size >= 32)
      throw new RemoteError('transfers/failure', 'Transfer progress is unavailable', {
        reason: this.closed ? 'closed' : 'capacity',
      });
    let open = true;
    let reading = false;
    let wake: (() => void) | undefined;
    const notify = () => wake?.();
    const close = () => {
      if (!open) return;
      open = false;
      signal.removeEventListener('abort', close);
      this.listeners.delete(notify);
      this.followers.delete(close);
      notify();
      const ending = generator.return(undefined).catch(() => {});
      this.endings.add(ending);
      void ending.then(() => this.endings.delete(ending));
    };
    const generator = async function* (
      this: TransferProgress,
    ): AsyncGenerator<TransferProgressSnapshot> {
      let previous = -1;
      try {
        while (open) {
          if (previous !== this.revision) {
            previous = this.revision;
            const snapshot = this.read();
            yield {
              generation: this.generation,
              revision: previous,
              factCursor: snapshot.factCursor,
              items: snapshot.items.map(
                ({
                  id,
                  state,
                  bytesTransferred,
                  totalBytes,
                  bytesPerSecond,
                  conflict,
                  updatedAt,
                }) => ({
                  id,
                  state,
                  bytesTransferred,
                  ...(totalBytes === undefined ? {} : { totalBytes }),
                  ...(bytesPerSecond === undefined ? {} : { bytesPerSecond }),
                  ...(conflict ? { conflict } : {}),
                  updatedAt,
                }),
              ),
            };
          }
          if (!open) return;
          if (previous !== this.revision) continue;
          await new Promise<void>((resolve) => {
            wake = resolve;
          });
          wake = undefined;
        }
      } finally {
        close();
      }
    }.call(this);
    this.listeners.add(notify);
    this.followers.add(close);
    signal.addEventListener('abort', close, { once: true });
    return {
      [Symbol.asyncIterator]() {
        return this;
      },
      next: async () => {
        if (reading)
          throw new RemoteError('transfers/failure', 'Concurrent progress reads are unavailable', {
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
  async close(): Promise<void> {
    this.closed = true;
    clearTimeout(this.timer);
    for (const close of [...this.followers]) close();
    await Promise.all([...this.endings]);
  }
}
