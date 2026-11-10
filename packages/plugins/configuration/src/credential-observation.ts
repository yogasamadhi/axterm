import { createHash } from 'node:crypto';
import { RemoteError } from '@axterm/plugin-api';
import {
  CREDENTIALS_CHUNK_CHARACTERS,
  CREDENTIALS_MAX_SNAPSHOT_BYTES,
  type SavedCredentialsUpdate,
} from '@axterm/plugin-api/saved-credentials';
const failure = (reason: 'capacity' | 'unavailable' | 'closed' | 'conflict') =>
  new RemoteError(
    'configuration/credentials-failure',
    'Credential metadata observation is unavailable',
    { reason },
  );
/** Only metadata enters the bounded stream. The source coalesces concurrent Vault reads. */
export class CredentialSnapshotBudget {
  bytes = 0;
  followers = 0;
}
export class CredentialSnapshotObservation {
  private readonly followers = new Set<() => void>();
  private readonly endings = new Set<Promise<unknown>>();
  private closed = false;
  private loading: Promise<unknown> | undefined;
  private cached: { value: unknown; at: number } | undefined;
  private read(): Promise<unknown> {
    if (this.cached && performance.now() - this.cached.at < 200)
      return Promise.resolve(this.cached.value);
    return (this.loading ??= this.snapshot()
      .then((value) => {
        this.cached = { value, at: performance.now() };
        return value;
      })
      .finally(() => {
        this.loading = undefined;
      }));
  }
  constructor(
    private readonly generation: string,
    private readonly snapshot: () => Promise<unknown>,
    private readonly budget: CredentialSnapshotBudget = new CredentialSnapshotBudget(),
    private readonly failed: (
      reason: 'capacity' | 'unavailable' | 'closed' | 'conflict',
    ) => Error = failure,
    private readonly maxBytes: number = CREDENTIALS_MAX_SNAPSHOT_BYTES,
  ) {}
  watch(signal: AbortSignal): AsyncIterableIterator<SavedCredentialsUpdate> {
    signal.throwIfAborted();
    if (this.closed) throw this.failed('closed');
    if (this.budget.followers >= 16) throw this.failed('capacity');
    let open = true;
    let reading = false;
    let retainedBytes = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let wake: (() => void) | undefined;
    const notify = () => {
      wake?.();
    };

    const close = () => {
      if (!open) return;
      open = false;
      clearTimeout(timer);
      notify();
      signal.removeEventListener('abort', close);
      this.budget.bytes -= retainedBytes;
      retainedBytes = 0;
      this.followers.delete(close);
      this.budget.followers--;
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
    this.budget.followers++;
    signal.addEventListener('abort', close, { once: true });
    const generator = async function* (
      this: CredentialSnapshotObservation,
    ): AsyncGenerator<SavedCredentialsUpdate> {
      let cursor = -1;
      let previous: string | undefined;
      try {
        while (open) {
          let text = JSON.stringify(await this.read());
          if (!open) return;
          const digest = createHash('sha256').update(text).digest('hex');
          if (digest === previous) {
            await wait();
            continue;
          }
          previous = digest;
          const frame = { cursor: cursor + 1, text };
          text = '';
          const bytes = Buffer.byteLength(frame.text);
          if (bytes > this.maxBytes || this.budget.bytes + bytes > 2 * this.maxBytes)
            throw this.failed('capacity');
          retainedBytes = bytes;
          this.budget.bytes += bytes;
          yield {
            type: 'begin',
            mode: cursor < 0 ? 'baseline' : 'replace',
            generation: this.generation,
            cursor: frame.cursor,
          };
          for (let offset = 0; offset < frame.text.length; offset += CREDENTIALS_CHUNK_CHARACTERS) {
            if (!open) return;
            yield {
              type: 'chunk',
              offset,
              text: frame.text.slice(offset, offset + CREDENTIALS_CHUNK_CHARACTERS),
              final: offset + CREDENTIALS_CHUNK_CHARACTERS >= frame.text.length,
            };
          }
          if (!open) return;
          cursor = frame.cursor;
          frame.text = '';
          this.budget.bytes -= retainedBytes;
          retainedBytes = 0;
          yield { type: 'commit', cursor };
        }
      } catch (error) {
        if (open) throw error instanceof RemoteError ? error : this.failed('unavailable');
      } finally {
        close();
      }
    }.call(this);
    return {
      [Symbol.asyncIterator]() {
        return this;
      },
      next: async () => {
        if (reading) throw this.failed('conflict');
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
    await this.loading?.catch(() => {});
    this.cached = undefined;
  }
}
