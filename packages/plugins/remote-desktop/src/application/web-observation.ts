import { RemoteError } from '@axterm/plugin-api';
import type {
  WebSessionUpdate,
  WebSessionDelta,
  WebSessionBaseline,
} from '@axterm/plugin-api/remote-desktop';
import type { WebSessions, WebSessionChange } from './web-sessions.ts';
const finished = (): IteratorResult<WebSessionUpdate> => ({ done: true, value: undefined });
class Cursor implements AsyncIterableIterator<WebSessionUpdate> {
  private readonly queue: WebSessionDelta[] = [];
  private baseline: WebSessionBaseline | undefined;
  private pending: PromiseWithResolvers<IteratorResult<WebSessionUpdate>> | undefined;
  private closed = false;
  private failure: Error | undefined;
  constructor(
    baseline: WebSessionBaseline,
    private readonly signal: AbortSignal,
    private release: () => void,
  ) {
    this.baseline = baseline;
    signal.addEventListener('abort', this.aborted, { once: true });
  }
  [Symbol.asyncIterator](): AsyncIterableIterator<WebSessionUpdate> {
    return this;
  }
  next(): Promise<IteratorResult<WebSessionUpdate>> {
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
    return (this.pending = Promise.withResolvers<IteratorResult<WebSessionUpdate>>()).promise;
  }
  push(value: WebSessionDelta): void {
    if (this.closed) return;
    if (this.pending) {
      const pending = this.pending;
      this.pending = undefined;
      pending.resolve({ done: false, value });
    } else if (this.queue.length < 64) this.queue.push(value);
    else
      this.close(
        new RemoteError('remoteDesktop/failure', 'Web session metadata requires a fresh baseline', {
          reason: 'capacity',
        }),
      );
  }
  return(): Promise<IteratorResult<WebSessionUpdate>> {
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
/** Only session metadata enters this bounded stream; native view contents never pass through it. */
export class WebSessionObservation {
  private readonly followers = new Set<Cursor>();
  private readonly unsubscribe: () => void;
  private revision = 0;
  private closed = false;
  constructor(
    private readonly terminals: Pick<WebSessions, 'list' | 'subscribe'>,
    private readonly windowId: string,
    private readonly generation: string,
  ) {
    this.unsubscribe = terminals.subscribe((windowId, change) => {
      if (windowId === this.windowId) this.changed(change);
    });
  }
  snapshot(): WebSessionBaseline {
    return {
      type: 'baseline',
      generation: this.generation,
      revision: this.revision,
      sessions: this.terminals.list(this.windowId),
    };
  }
  watch(signal: AbortSignal): AsyncIterable<WebSessionUpdate> {
    signal.throwIfAborted();
    if (this.closed)
      throw new RemoteError('remoteDesktop/failure', 'Web session observation is closed', {
        reason: 'closed',
      });
    if (this.followers.size >= 64)
      throw new RemoteError('remoteDesktop/failure', 'Web session observation capacity exceeded', {
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
  private changed(change: WebSessionChange): void {
    const delta: WebSessionDelta = {
      ...change,
      generation: this.generation,
      revision: ++this.revision,
    };
    if (!Number.isSafeInteger(this.revision)) {
      this.dispose();
      return;
    }
    for (const cursor of this.followers) cursor.push(delta);
  }
}
