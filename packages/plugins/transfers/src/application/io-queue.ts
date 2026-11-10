import { ApplicationError } from './errors.ts';
interface Waiter {
  signal: AbortSignal;
  resolve(release: () => void): void;
  reject(error: unknown): void;
  abort(): void;
}
/** Shared IO slots bound channels across independently admitted transfer tasks. */
export class TransferIOQueue {
  private active = 0;
  private readonly waiting: Waiter[] = [];
  constructor(
    private readonly limit = 16,
    private readonly queued = 128,
  ) {}
  async run<T>(signal: AbortSignal, perform: () => Promise<T>): Promise<T> {
    const release = await this.acquire(signal);
    try {
      signal.throwIfAborted();
      return await perform();
    } finally {
      release();
    }
  }
  private acquire(signal: AbortSignal): Promise<() => void> {
    signal.throwIfAborted();
    if (this.active < this.limit) {
      this.active++;
      return Promise.resolve(this.releaser());
    }
    if (this.waiting.length >= this.queued)
      return Promise.reject(
        new ApplicationError('CAPACITY_EXCEEDED', 'Transfer IO queue capacity exceeded', 503),
      );
    return new Promise((resolve, reject) => {
      const waiter: Waiter = {
        signal,
        resolve,
        reject,
        abort: () => {
          const index = this.waiting.indexOf(waiter);
          if (index >= 0) this.waiting.splice(index, 1);
          signal.removeEventListener('abort', waiter.abort);
          reject(new ApplicationError('REQUEST_CANCELED', 'Queued transfer IO canceled'));
        },
      };
      this.waiting.push(waiter);
      signal.addEventListener('abort', waiter.abort, { once: true });
      if (signal.aborted) waiter.abort();
    });
  }
  private releaser(): () => void {
    let live = true;
    return () => {
      if (!live) return;
      live = false;
      this.active--;
      const next = this.waiting.shift();
      if (next) {
        next.signal.removeEventListener('abort', next.abort);
        this.active++;
        next.resolve(this.releaser());
      }
    };
  }
}
export async function transferPool<T>(
  items: readonly T[],
  signal: AbortSignal,
  perform: (item: T) => Promise<void>,
): Promise<void> {
  let index = 0;
  let failed = false;
  let failure: unknown;
  const worker = async () => {
    try {
      while (!failed && index < items.length) {
        signal.throwIfAborted();
        const item = items[index++]!;
        await perform(item);
      }
    } catch (error) {
      failed = true;
      failure ??= error;
    }
  };
  await Promise.all(Array.from({ length: Math.min(4, items.length) }, worker));
  if (failed) throw failure;
}
