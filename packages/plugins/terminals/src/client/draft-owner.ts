import { assertTerminalDraft } from './draft-policy.ts';
interface Sink {
  readonly bracketedPaste: boolean;
  paste(text: string): boolean;
  focus(): void;
}
interface Waiter {
  readonly id: string;
  readonly wake: () => void;
}
/** UI insertion has one live sink per tab. No request survives cancellation or reload. */
export class TerminalDraftOwner {
  private readonly sinks = new Map<string, () => Sink | undefined>();
  private readonly waiters = new Set<Waiter>();
  private readonly lifetime = new AbortController();
  private readonly pending = new Set<Promise<unknown>>();
  private closing: Promise<void> | undefined;
  constructor(private readonly activate: (id: string) => void) {}
  register(id: string, read: () => Sink | undefined): () => void {
    if (this.lifetime.signal.aborted) throw new Error('TERMINAL_DRAFT_CLOSED');
    if (this.sinks.has(id)) throw new Error('TERMINAL_DRAFT_DUPLICATE');
    this.sinks.set(id, read);
    this.notify(id);
    return () => {
      if (this.sinks.get(id) === read) {
        this.sinks.delete(id);
        this.notify(id);
      }
    };
  }
  notify(id: string): void {
    for (const waiter of this.waiters) if (waiter.id === id) waiter.wake();
  }
  insertDraft(id: string, text: string, signal?: AbortSignal): Promise<void> {
    if (this.lifetime.signal.aborted) throw new Error('TERMINAL_DRAFT_CLOSED');
    if (this.pending.size >= 8) throw new Error('TERMINAL_DRAFT_CAPACITY');
    // Validate bytes before activating another tab. The sink enforces its current mode later.
    assertTerminalDraft(text, true);
    const owned = AbortSignal.any([
      this.lifetime.signal,
      AbortSignal.timeout(3000),
      ...(signal ? [signal] : []),
    ]);
    const task = Promise.resolve().then(async () => {
      owned.throwIfAborted();
      this.activate(id);
      await new Promise<void>((resolve, reject) => {
        let done = false;
        const finish = (error?: unknown) => {
          if (done) return;
          done = true;
          this.waiters.delete(waiter);
          owned.removeEventListener('abort', aborted);
          if (error) reject(error);
          else resolve();
        };
        const wake = () => {
          if (owned.aborted) {
            aborted();
            return;
          }
          const sink = this.sinks.get(id)?.();
          if (!sink) return;
          try {
            assertTerminalDraft(text, sink.bracketedPaste);
            if (!sink.paste(text)) throw new Error('TERMINAL_DRAFT_UNAVAILABLE');
            sink.focus();
            finish();
          } catch (error) {
            finish(error);
          }
        };
        const aborted = () => finish(new Error('TERMINAL_DRAFT_UNAVAILABLE'));
        const waiter = { id, wake };
        this.waiters.add(waiter);
        owned.addEventListener('abort', aborted, { once: true });
        wake();
      });
    });
    this.pending.add(task);
    void task.then(
      () => this.pending.delete(task),
      () => this.pending.delete(task),
    );
    return task;
  }
  resourceCount(): number {
    return this.pending.size + this.waiters.size + this.sinks.size;
  }
  dispose(): Promise<void> {
    if (this.closing) return this.closing;
    const done = Promise.withResolvers<void>();
    this.closing = done.promise;
    this.lifetime.abort();
    this.sinks.clear();
    void Promise.allSettled([...this.pending]).then(() => done.resolve());
    return this.closing;
  }
}
