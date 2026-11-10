import type { PluginManagementUpdate, PluginManagementSnapshot } from '@axterm/plugin-api/plugins';
import { PluginManagementError } from './application.ts';
import { RemoteError } from '@axterm/plugin-api';
import type { PluginFailure } from '@axterm/plugin-api/plugins';
const failure = (reason: PluginFailure) =>
  new RemoteError('plugins/failure', 'Plugin observation is unavailable', { reason });
/** Complete opening baseline and atomic replacement deltas; the durable journal reconciles commands across restarts. */
export class PluginObservation {
  private readonly followers = new Set<{
    close(): void;
    iterator: AsyncGenerator<PluginManagementUpdate>;
  }>();
  private closing?: Promise<void>;
  constructor(private readonly snapshot: () => Promise<PluginManagementSnapshot>) {}
  watch(signal: AbortSignal): AsyncIterable<PluginManagementUpdate> {
    if (this.closing) throw failure('closed');
    signal.throwIfAborted();
    if (this.followers.size >= 16) throw failure('capacity');
    let reading = false;
    let open = true,
      wake: (() => void) | undefined,
      timer: ReturnType<typeof setTimeout> | undefined;
    const close = () => {
      if (!open) return;
      open = false;
      clearTimeout(timer);
      signal.removeEventListener('abort', close);
      wake?.();
    };
    const wait = () =>
      new Promise<void>((resolve) => {
        wake = resolve;
        timer = setTimeout(resolve, 250);
      });
    const read = this.snapshot,
      followers = this.followers;
    const owner = {
      close,
      get iterator(): AsyncGenerator<PluginManagementUpdate> {
        return iterator;
      },
    };
    const iterator = (async function* (): AsyncGenerator<PluginManagementUpdate> {
      let previous: string | undefined,
        cursor = 0;
      try {
        while (open) {
          const snapshot = await read();
          if (!open) return;
          const text = JSON.stringify(snapshot);
          if (new TextEncoder().encode(text).byteLength > 2 * 1024 * 1024)
            throw new PluginManagementError('capacity');
          if (text !== previous) {
            yield {
              type: previous === undefined ? 'baseline' : 'replace',
              cursor: cursor++,
              snapshot,
            };
            previous = text;
          } else {
            await wait();
            wake = undefined;
            clearTimeout(timer);
          }
        }
      } catch (error) {
        if (open)
          throw failure(error instanceof PluginManagementError ? error.reason : 'unavailable');
      } finally {
        close();
        followers.delete(owner);
      }
    })();
    followers.add(owner);
    signal.addEventListener('abort', close, { once: true });
    return {
      [Symbol.asyncIterator]() {
        return {
          next: async () => {
            if (reading) throw failure('conflict');
            reading = true;
            try {
              return await iterator.next();
            } finally {
              reading = false;
            }
          },
          return: async () => {
            close();
            try {
              return await iterator.return(undefined);
            } finally {
              followers.delete(owner);
            }
          },
          throw: async (error) => {
            close();
            try {
              return await iterator.throw(error);
            } finally {
              followers.delete(owner);
            }
          },
        };
      },
    };
  }
  close(): Promise<void> {
    return (this.closing ??= (async () => {
      for (const owner of this.followers) owner.close();
      await Promise.all([...this.followers].map((owner) => owner.iterator.return(undefined)));
      this.followers.clear();
    })());
  }
}
