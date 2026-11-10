import { RemoteError } from '@axterm/plugin-api';
import { AI_CHUNK_CHARACTERS, AI_MAX_SNAPSHOT_BYTES } from '@axterm/plugin-api/ai';
import type { AiBaseline, AiCollection, AiUpdate } from '@axterm/plugin-api/ai';
import type { RelationalDomain } from '@axterm/plugin-api/storage';

const collections: readonly AiCollection[] = [
  'providers',
  'models',
  'conversations',
  'runs',
  'approvals',
  'engines',
];
const failure = () =>
  new RemoteError('ai/failure', 'Ai observation is unavailable', {
    reason: 'capacity',
  });

/** Pull-based replacement deltas use the durable outbox cursor, including changes from other Profiles. */
export class AiObservation {
  private readonly followers = new Set<() => void>();
  private readonly endings = new Set<Promise<unknown>>();
  private bufferedBytes = 0;
  private closed = false;
  private engineRevision = 0;
  invalidateEngines(): void {
    if (this.closed) return;
    this.engineRevision++;
    for (const notify of this.notifications) notify();
  }
  private readonly notifications = new Set<() => void>();
  constructor(
    private readonly domain: RelationalDomain,
    private readonly snapshot: (
      selected: ReadonlySet<AiCollection>,
    ) => Pick<AiBaseline, 'generation' | 'cursor'> & Partial<Pick<AiBaseline, AiCollection>>,
  ) {}
  resourceCount(): number {
    return this.followers.size + this.endings.size;
  }
  watch(signal: AbortSignal): AsyncIterableIterator<AiUpdate> {
    signal.throwIfAborted();
    if (this.closed)
      throw new RemoteError('ai/failure', 'Ai observation is closed', {
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
    this.notifications.add(notify);
    const close = () => {
      if (!open) return;
      open = false;
      unsubscribe();
      this.notifications.delete(notify);
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
    const generator = async function* (this: AiObservation): AsyncGenerator<AiUpdate> {
      let cursor = -1;
      let engineRevision = -1;
      try {
        while (open) {
          const current = this.domain.cursor();
          if (cursor === current && engineRevision === this.engineRevision) {
            await wait();
            continue;
          }
          const { selected, baseline, capturedEngineRevision } = this.domain.transaction(() => {
            const snapshotCursor = this.domain.cursor();
            const selected = new Set<AiCollection>();
            if (cursor < 0) for (const name of collections) selected.add(name);
            else {
              const changes = this.domain.events(cursor, 10_000);
              for (const change of changes) {
                if (change.type.startsWith('ai-provider.')) selected.add('providers');
                else if (change.type.startsWith('ai-model.')) selected.add('models');
                else if (change.type.startsWith('ai-conversation.')) selected.add('conversations');
                else if (change.type.startsWith('ai-run.')) {
                  selected.add('runs');
                  selected.add('conversations');
                } else if (change.type === 'ai/log-appended') {
                  if (
                    change.payload &&
                    typeof change.payload === 'object' &&
                    'kind' in change.payload &&
                    change.payload.kind === 'approval'
                  )
                    selected.add('approvals');
                } else for (const name of collections) selected.add(name);
              }
              // Unknown/pruned cursors always recover by replacing every collection.
              if (
                cursor !== snapshotCursor &&
                (!changes.length || changes.at(-1)!.cursor !== snapshotCursor)
              )
                for (const name of collections) selected.add(name);
            }
            if (engineRevision !== this.engineRevision) selected.add('engines');
            const revision = snapshotCursor + this.engineRevision;
            if (!Number.isSafeInteger(revision)) throw failure();
            return {
              selected,
              baseline: { ...this.snapshot(selected), revision },
              capturedEngineRevision: this.engineRevision,
            };
          });
          const serialized = [...selected].map((name) => {
            const text = JSON.stringify(baseline[name]);
            if (typeof text !== 'string') throw failure();
            return [name, text] as const;
          });
          const bytes = serialized.reduce((size, [, text]) => size + Buffer.byteLength(text), 0);
          if (
            bytes > AI_MAX_SNAPSHOT_BYTES ||
            this.bufferedBytes + bytes > 2 * AI_MAX_SNAPSHOT_BYTES
          )
            throw failure();
          retainedBytes = bytes;
          this.bufferedBytes += bytes;
          yield {
            type: 'begin',
            generation: baseline.generation,
            cursor: baseline.cursor,
            revision: baseline.revision,
            mode: cursor < 0 ? 'baseline' : 'delta',
            collections: [...selected],
          };
          for (const [collection, text] of serialized) {
            for (let offset = 0; offset < text.length; offset += AI_CHUNK_CHARACTERS) {
              if (!open) return;
              yield {
                type: 'chunk',
                collection,
                offset,
                text: text.slice(offset, offset + AI_CHUNK_CHARACTERS),
                final: offset + AI_CHUNK_CHARACTERS >= text.length,
              };
            }
          }
          if (!open) return;
          cursor = baseline.cursor;
          engineRevision = capturedEngineRevision;
          this.bufferedBytes -= retainedBytes;
          retainedBytes = 0;
          yield { type: 'commit', cursor, revision: baseline.revision };
        }
      } catch (error) {
        if (open) {
          if (error instanceof RemoteError) throw error;
          throw new RemoteError('ai/failure', 'Ai information is unavailable', {
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
          throw new RemoteError('ai/failure', 'Concurrent AI reads are unavailable', {
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
