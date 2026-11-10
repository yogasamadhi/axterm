import { createHash } from 'node:crypto';
import { RemoteError } from '@axterm/plugin-api';
import {
  FILE_GRANTS_CHUNK_CHARACTERS,
  FILE_GRANTS_MAX_SNAPSHOT_BYTES,
  type FileGrantsUpdate,
  type FileGrant,
} from '@axterm/plugin-api/files';
const failure = (reason: 'capacity' | 'unavailable' | 'closed' | 'conflict') =>
  new RemoteError('files/failure', 'File grant observation is unavailable', { reason });
/** Ephemeral grants use complete atomic replacements; no file bodies enter this stream. */
export class FileSnapshotBudget {
  bytes = 0;
  followers = 0;
}
export class FileSnapshotObservation {
  private readonly followers = new Set<() => void>();
  private readonly endings = new Set<Promise<unknown>>();
  private closed = false;
  constructor(
    private readonly generation: string,
    private readonly snapshot: (signal: AbortSignal) => Promise<unknown>,
    private readonly budget: FileSnapshotBudget = new FileSnapshotBudget(),
  ) {}
  watch(signal: AbortSignal): AsyncIterableIterator<FileGrantsUpdate> {
    signal.throwIfAborted();
    if (this.closed) throw failure('closed');
    if (this.budget.followers >= 16) throw failure('capacity');
    let open = true;
    const abort = new AbortController();
    const lifetime = AbortSignal.any([signal, abort.signal]);
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
      abort.abort();
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
      this: FileSnapshotObservation,
    ): AsyncGenerator<FileGrantsUpdate> {
      let cursor = -1;
      let previous: string | undefined;
      try {
        while (open) {
          let text = JSON.stringify(await this.snapshot(lifetime));
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
          if (
            bytes > FILE_GRANTS_MAX_SNAPSHOT_BYTES ||
            this.budget.bytes + bytes > 2 * FILE_GRANTS_MAX_SNAPSHOT_BYTES
          )
            throw failure('capacity');
          retainedBytes = bytes;
          this.budget.bytes += bytes;
          yield {
            type: 'begin',
            mode: cursor < 0 ? 'baseline' : 'replace',
            generation: this.generation,
            cursor: frame.cursor,
          };
          for (let offset = 0; offset < frame.text.length; offset += FILE_GRANTS_CHUNK_CHARACTERS) {
            if (!open) return;
            yield {
              type: 'chunk',
              offset,
              text: frame.text.slice(offset, offset + FILE_GRANTS_CHUNK_CHARACTERS),
              final: offset + FILE_GRANTS_CHUNK_CHARACTERS >= frame.text.length,
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

export class FileGrantsObservation extends FileSnapshotObservation {
  constructor(
    generation: string,
    snapshot: (signal: AbortSignal) => Promise<readonly FileGrant[]>,
    budget?: FileSnapshotBudget,
  ) {
    super(generation, async (signal) => ({ grants: await snapshot(signal) }), budget);
  }
}
