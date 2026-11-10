import { RemoteError } from '@axterm/plugin-api';
import type { Context } from '@deepseek-ai/cordis';
import {
  CONNECTIONS_CHUNK_CHARACTERS,
  CONNECTIONS_MAX_SNAPSHOT_BYTES,
  type Connection,
  type FtpConnection,
  type TunnelProfile,
  type Tunnel,
  type Interaction,
  type ConnectionsBaseline,
  type ConnectionsUpdate,
  type ConnectionCollection,
} from '@axterm/plugin-api/connections';
import type { RelationalDomain } from '@axterm/plugin-api/storage';
import type { KnownHosts } from './adapters/known-hosts.ts';
import type { ConnectionEvents } from './ports/events.ts';
const names: readonly ConnectionCollection[] = [
  'connections',
  'ftpConnections',
  'interactions',
  'knownHosts',
  'tunnelProfiles',
  'tunnels',
];
const failure = (reason: 'capacity' | 'closed' | 'conflict' | 'unavailable') =>
  new RemoteError('connections/failure', 'Connection information is unavailable', { reason });
/** Ephemeral connection/challenge revisions and durable fact cursors are intentionally distinct. */
export class ConnectionObservation implements ConnectionEvents {
  private readonly followers = new Set<() => void>();
  private readonly endings = new Set<Promise<unknown>>();
  private readonly listeners = new Set<() => void>();
  private readonly versions = {
    connections: 0,
    ftpConnections: 0,
    interactions: 0,
    knownHosts: 0,
    tunnelProfiles: 0,
    tunnels: 0,
  };
  private readonly unsubscribe: () => void;
  private revision = 0;
  private cursor: number;
  private closed = false;
  private bufferedBytes = 0;
  resourceCount(): number {
    return this.followers.size;
  }
  constructor(
    private readonly ctx: Context,
    private readonly domain: RelationalDomain,
    private readonly known: KnownHosts,
    private readonly readConnections: () => Connection[],
    private readonly readInteractions: () => Interaction[],
    private readonly readFtp: () => FtpConnection[] = () => [],
    private readonly readProfiles: () => TunnelProfile[] = () => [],
    private readonly readTunnels: () => Tunnel[] = () => [],
  ) {
    this.cursor = domain.cursor();
    this.unsubscribe = domain.subscribe(() => this.syncDurable());
  }
  publish(type: 'connection.status', payload: Connection): void;
  publish(
    type: 'connection.history-failed',
    payload: { connectionId: string; errorCode: string },
  ): void;
  publish(type: 'interaction.required', payload: Interaction): void;
  publish(type: 'interaction.expired', payload: { id: string }): void;
  publish(type: 'interaction.resolved', payload: { id: string; accepted: boolean }): void;
  publish(
    type: string,
    payload:
      | Connection
      | Interaction
      | { connectionId: string; errorCode: string }
      | { id: string; accepted?: boolean },
  ): void {
    if (this.closed) return;
    if (type === 'connection.history-failed') {
      if ('connectionId' in payload && payload.connectionId)
        this.ctx.emit('connections/history-recording-failed', {
          connectionId: payload.connectionId,
          errorCode: 'CONNECTION_HISTORY_WRITE_FAILED',
        });
      return;
    }
    this.changed(type === 'connection.status' ? 'connections' : 'interactions');
  }
  ftpChanged(): void {
    if (!this.closed) this.changed('ftpConnections');
  }
  tunnelsChanged(): void {
    if (!this.closed) this.changed('tunnels');
  }
  private changed(name: ConnectionCollection): void {
    this.versions[name] = ++this.revision;
    for (const listener of [...this.listeners]) listener();
  }
  private syncDurable(): void {
    const cursor = this.domain.cursor();
    if (cursor !== this.cursor) {
      this.cursor = cursor;
      this.changed('knownHosts');
      this.changed('tunnelProfiles');
    }
  }
  private snapshot(): ConnectionsBaseline {
    return this.domain.transaction(() => {
      this.syncDurable();
      return {
        generation: this.ctx.runtimeIdentity.generation,
        cursor: this.cursor,
        revision: this.revision,
        connections: this.readConnections(),
        ftpConnections: this.readFtp(),
        interactions: this.readInteractions(),
        knownHosts: this.known.list(),
        tunnelProfiles: this.readProfiles(),
        tunnels: this.readTunnels(),
      };
    });
  }
  watch(signal: AbortSignal): AsyncIterableIterator<ConnectionsUpdate> {
    signal.throwIfAborted();
    if (this.closed) throw failure('closed');
    if (this.followers.size >= 64) throw failure('capacity');
    let open = true;
    let reading = false;
    let retainedBytes = 0;
    let wake: (() => void) | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const notify = () => {
      wake?.();
    };
    this.listeners.add(notify);
    const close = () => {
      if (!open) return;
      open = false;
      this.listeners.delete(notify);
      clearTimeout(timer);
      notify();
      signal.removeEventListener('abort', close);
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
      this: ConnectionObservation,
    ): AsyncGenerator<ConnectionsUpdate> {
      let revision = -1;
      try {
        while (open) {
          this.syncDurable();
          if (revision === this.revision) {
            await wait();
            continue;
          }
          const { selected, baseline } = this.domain.transaction(() => {
            this.syncDurable();
            const selected = names.filter((name) => revision < 0 || this.versions[name] > revision);
            return { selected, baseline: this.snapshot() };
          });
          const encoded = selected.map((name) => [name, JSON.stringify(baseline[name])] as const);
          const bytes = encoded.reduce((size, [, text]) => size + Buffer.byteLength(text), 0);
          if (
            bytes > CONNECTIONS_MAX_SNAPSHOT_BYTES ||
            this.bufferedBytes + bytes > 2 * CONNECTIONS_MAX_SNAPSHOT_BYTES
          )
            throw failure('capacity');
          retainedBytes = bytes;
          this.bufferedBytes += bytes;
          yield {
            type: 'begin',
            generation: baseline.generation,
            cursor: baseline.cursor,
            revision: baseline.revision,
            mode: revision < 0 ? 'baseline' : 'delta',
            collections: selected,
          };
          for (const [collection, text] of encoded)
            for (let offset = 0; offset < text.length; offset += CONNECTIONS_CHUNK_CHARACTERS) {
              if (!open) return;
              yield {
                type: 'chunk',
                collection,
                offset,
                text: text.slice(offset, offset + CONNECTIONS_CHUNK_CHARACTERS),
                final: offset + CONNECTIONS_CHUNK_CHARACTERS >= text.length,
              };
            }
          if (!open) return;
          revision = baseline.revision;
          this.bufferedBytes -= retainedBytes;
          retainedBytes = 0;
          yield { type: 'commit', revision };
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
    this.unsubscribe();
    for (const close of [...this.followers]) close();
    await Promise.all([...this.endings]);
    this.listeners.clear();
  }
}
