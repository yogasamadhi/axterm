import { RemoteError } from '@axterm/plugin-api';
import {
  AUTOMATION_CHUNK_CHARACTERS,
  AUTOMATION_MAX_SNAPSHOT_BYTES,
} from '@axterm/plugin-api/automation';
import type {
  AutomationBaseline,
  AutomationCollection,
  AutomationUpdate,
} from '@axterm/plugin-api/automation';
import type { RelationalDomain } from '@axterm/plugin-api/storage';

const collections: readonly AutomationCollection[] = ['quickCommands', 'triggers', 'batches'];
const failure = () =>
  new RemoteError('automation/failure', 'Automation observation is unavailable', {
    reason: 'capacity',
  });

/** Pull-based replacement deltas use the durable outbox cursor, including changes from other Profiles. */
export class AutomationObservation {
  private readonly followers = new Set<() => void>();
  private readonly endings = new Set<Promise<unknown>>();
  private bufferedBytes = 0;
  private closed = false;
  resourceCount(): number {
    return this.followers.size;
  }
  constructor(
    private readonly domain: RelationalDomain,
    private readonly snapshot: () => AutomationBaseline,
  ) {}
  watch(signal: AbortSignal): AsyncIterableIterator<AutomationUpdate> {
    signal.throwIfAborted();
    if (this.closed)
      throw new RemoteError('automation/failure', 'Automation observation is closed', {
        reason: 'closed',
      });
    if (this.followers.size >= 64) throw failure();
    let open = true;
    let wake: (() => void) | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let retainedBytes = 0;
    let reading = false;
    const notify = () => {
      wake?.();
    };
    const unsubscribe = this.domain.subscribe(notify);
    const close = () => {
      if (!open) return;
      open = false;
      unsubscribe();
      signal.removeEventListener('abort', close);
      clearTimeout(timer);
      notify();
      this.bufferedBytes -= retainedBytes;
      retainedBytes = 0;
      this.followers.delete(close);
      const ending = generator.return(undefined).catch(() => {});
      this.endings.add(ending);
      void ending.finally(() => this.endings.delete(ending));
    };
    this.followers.add(close);
    signal.addEventListener('abort', close, { once: true });
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
    const generator = async function* (
      this: AutomationObservation,
    ): AsyncGenerator<AutomationUpdate> {
      let cursor = -1;
      try {
        while (open) {
          const current = this.domain.cursor();
          if (cursor === current) {
            await wait();
            continue;
          }
          const { selected, baseline } = this.domain.transaction(() => {
            const snapshotCursor = this.domain.cursor();
            const selected = new Set<AutomationCollection>();
            if (cursor < 0) for (const name of collections) selected.add(name);
            else {
              const changes = this.domain.events(cursor, 10_000);
              for (const change of changes) {
                if (change.type.startsWith('quick-command')) selected.add('quickCommands');
                else if (change.type.startsWith('trigger')) selected.add('triggers');
                else if (change.type.startsWith('batch-operation.')) selected.add('batches');
                else for (const name of collections) selected.add(name);
              }
              // Unknown/pruned cursors always recover by replacing every collection.
              if (!changes.length || changes.at(-1)!.cursor !== snapshotCursor)
                for (const name of collections) selected.add(name);
            }
            return { selected, baseline: this.snapshot() };
          });
          const serialized = [...selected].map(
            (name) => [name, JSON.stringify(baseline[name])] as const,
          );
          const bytes = serialized.reduce((size, [, text]) => size + Buffer.byteLength(text), 0);
          if (
            bytes > AUTOMATION_MAX_SNAPSHOT_BYTES ||
            this.bufferedBytes + bytes > 2 * AUTOMATION_MAX_SNAPSHOT_BYTES
          )
            throw failure();
          retainedBytes = bytes;
          this.bufferedBytes += bytes;
          yield {
            type: 'begin',
            generation: baseline.generation,
            cursor: baseline.cursor,
            mode: cursor < 0 ? 'baseline' : 'delta',
            collections: [...selected],
          };
          for (const [collection, text] of serialized) {
            for (let offset = 0; offset < text.length; offset += AUTOMATION_CHUNK_CHARACTERS) {
              if (!open) return;
              yield {
                type: 'chunk',
                collection,
                offset,
                text: text.slice(offset, offset + AUTOMATION_CHUNK_CHARACTERS),
                final: offset + AUTOMATION_CHUNK_CHARACTERS >= text.length,
              };
            }
          }
          if (!open) return;
          cursor = baseline.cursor;
          this.bufferedBytes -= retainedBytes;
          retainedBytes = 0;
          yield { type: 'commit', cursor };
        }
      } catch (error) {
        if (open) {
          if (error instanceof RemoteError) throw error;
          throw new RemoteError('automation/failure', 'Automation information is unavailable', {
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
          throw new RemoteError('automation/failure', 'Concurrent catalog reads are unavailable', {
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
  async dispose(): Promise<void> {
    this.closed = true;
    for (const close of [...this.followers]) close();
    await Promise.all([...this.endings]);
  }
}
