import { RemoteError } from '@axterm/plugin-api';
import type { TerminalUpdate, TerminalDelta, TerminalBaseline } from '@axterm/plugin-api/terminals';
import type { TerminalService, TerminalMetadataChange } from './terminal-service.ts';
const finished = (): IteratorResult<TerminalUpdate> => ({ done: true, value: undefined });
class Cursor implements AsyncIterableIterator<TerminalUpdate> {
  private readonly queue: TerminalDelta[] = [];
  private baseline: TerminalBaseline | undefined;
  private pending: PromiseWithResolvers<IteratorResult<TerminalUpdate>> | undefined;
  private closed = false;
  private failure: Error | undefined;
  constructor(
    baseline: TerminalBaseline,
    private readonly signal: AbortSignal,
    private release: () => void,
  ) {
    this.baseline = baseline;
    signal.addEventListener('abort', this.aborted, { once: true });
  }
  [Symbol.asyncIterator](): AsyncIterableIterator<TerminalUpdate> {
    return this;
  }
  next(): Promise<IteratorResult<TerminalUpdate>> {
    if (this.pending) return Promise.reject(new Error('TERMINAL_OBSERVATION_CONCURRENT_READ'));
    if (this.failure) {
      const error = this.failure;
      this.failure = undefined;
      return Promise.reject(error);
    }
    if (this.closed) return Promise.resolve(finished());
    if (this.baseline) {
      const value = this.baseline;
      this.baseline = undefined;
      return Promise.resolve({ done: false, value });
    }
    const value = this.queue.shift();
    if (value) return Promise.resolve({ done: false, value });
    return (this.pending = Promise.withResolvers<IteratorResult<TerminalUpdate>>()).promise;
  }
  push(value: TerminalDelta): void {
    if (this.closed) return;
    if (this.pending) {
      const pending = this.pending;
      this.pending = undefined;
      pending.resolve({ done: false, value });
    } else if (this.queue.length < 64) this.queue.push(value);
    else
      this.close(
        new RemoteError('terminals/failure', 'Terminal metadata requires a fresh baseline', {
          reason: 'capacity',
        }),
      );
  }
  return(): Promise<IteratorResult<TerminalUpdate>> {
    this.close();
    return Promise.resolve(finished());
  }
  close(error?: Error): void {
    if (this.closed) return;
    this.closed = true;
    this.failure = error;
    this.baseline = undefined;
    this.queue.length = 0;
    this.signal.removeEventListener('abort', this.aborted);
    this.release();
    this.release = () => {};
    const pending = this.pending;
    this.pending = undefined;
    if (pending) {
      if (error) {
        this.failure = undefined;
        pending.reject(error);
      } else pending.resolve(finished());
    }
  }
  private readonly aborted = () => this.close();
}
/** Only session metadata enters this bounded stream; PTY bytes never pass through it. */
export class TerminalObservation {
  resourceCount(): number {
    return this.followers.size;
  }
  private readonly followers = new Set<Cursor>();
  private readonly unsubscribe: () => void;
  private revision = 0;
  private closed = false;
  constructor(
    private readonly terminals: TerminalService,
    private readonly generation: string,
  ) {
    this.unsubscribe = terminals.subscribeMetadata((change) => this.changed(change));
  }
  snapshot(): TerminalBaseline {
    return {
      type: 'baseline',
      generation: this.generation,
      revision: this.revision,
      sessions: this.terminals.list(),
    };
  }
  watch(signal: AbortSignal): AsyncIterable<TerminalUpdate> {
    signal.throwIfAborted();
    if (this.closed)
      throw new RemoteError('terminals/failure', 'Terminal observation is closed', {
        reason: 'closed',
      });
    if (this.followers.size >= 64)
      throw new RemoteError('terminals/failure', 'Terminal observation capacity exceeded', {
        reason: 'capacity',
      });
    const cursor = new Cursor(this.snapshot(), signal, () => this.followers.delete(cursor));
    this.followers.add(cursor);
    return cursor;
  }
  dispose(): void {
    if (this.closed) return;
    this.closed = true;
    this.unsubscribe();
    for (const cursor of this.followers) cursor.close();
    this.followers.clear();
  }
  private changed(change: TerminalMetadataChange): void {
    const delta: TerminalDelta = { ...change, revision: ++this.revision };
    if (!Number.isSafeInteger(this.revision)) {
      this.dispose();
      return;
    }
    for (const cursor of this.followers) cursor.push(delta);
  }
}
