import {
  connectionSchema,
  ftpConnectionSchema,
  connectionInteractionSchema,
  knownHostKeySchema,
  tunnelProfileSchema,
  tunnelSchema,
  CONNECTIONS_CHUNK_CHARACTERS,
  CONNECTIONS_MAX_SNAPSHOT_BYTES,
  type ConnectionsBaseline,
  type ConnectionCollection,
  type ConnectionsUpdate,
} from '@axterm/plugin-api/connections';
const names: readonly ConnectionCollection[] = [
  'connections',
  'ftpConnections',
  'interactions',
  'knownHosts',
  'tunnelProfiles',
  'tunnels',
];
const invalid = (): never => {
  throw new Error('CONNECTIONS_PROJECTION_INVALID');
};
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
/** Persistent cursors and live metadata revisions have separate validation rules. */
export class ConnectionsProjection {
  private baseline: ConnectionsBaseline | undefined;
  private opening = true;
  private pending: Extract<ConnectionsUpdate, { type: 'begin' }> | undefined;
  private readonly fragments = new Map<ConnectionCollection, { text: string; final: boolean }>();
  private bytes = 0;
  reset(): void {
    this.opening = true;
    this.pending = undefined;
    this.fragments.clear();
    this.bytes = 0;
  }
  accept(frame: ConnectionsUpdate): ConnectionsBaseline | undefined {
    if (frame.type === 'begin') {
      if (
        this.pending ||
        !frame.generation ||
        !Number.isSafeInteger(frame.cursor) ||
        frame.cursor < 0 ||
        !Number.isSafeInteger(frame.revision) ||
        frame.revision < 0 ||
        !frame.collections.length ||
        frame.collections.length > names.length ||
        new Set(frame.collections).size !== frame.collections.length ||
        frame.collections.some((name) => !names.includes(name))
      )
        invalid();
      if (
        this.opening
          ? frame.mode !== 'baseline' || frame.collections.length !== names.length
          : frame.mode !== 'delta' ||
            frame.generation !== this.baseline?.generation ||
            frame.revision <= this.baseline.revision ||
            frame.cursor < this.baseline.cursor
      )
        invalid();
      this.pending = frame;
      this.fragments.clear();
      this.bytes = 0;
      return;
    }
    const pending = this.pending;
    if (!pending) return invalid();
    if (frame.type === 'chunk') {
      const previous = this.fragments.get(frame.collection);
      if (
        !pending.collections.includes(frame.collection) ||
        previous?.final ||
        frame.offset !== (previous?.text.length ?? 0) ||
        !frame.text.length ||
        frame.text.length > CONNECTIONS_CHUNK_CHARACTERS
      )
        invalid();
      this.bytes += new TextEncoder().encode(frame.text).byteLength;
      if (this.bytes > CONNECTIONS_MAX_SNAPSHOT_BYTES) invalid();
      this.fragments.set(frame.collection, {
        text: (previous?.text ?? '') + frame.text,
        final: frame.final,
      });
      return;
    }
    if (
      frame.revision !== pending.revision ||
      pending.collections.some((name) => !this.fragments.get(name)?.final)
    )
      invalid();
    const selected = <T>(name: ConnectionCollection, parse: (value: unknown) => T): T => {
      const entry = this.fragments.get(name);
      return entry ? parse(JSON.parse(entry.text)) : (this.baseline![name] as T);
    };
    const baseline: ConnectionsBaseline = freeze({
      generation: pending.generation,
      cursor: pending.cursor,
      revision: pending.revision,
      connections: selected('connections', (value) => connectionSchema.array().parse(value)),
      ftpConnections: selected('ftpConnections', (value) =>
        ftpConnectionSchema.array().parse(value),
      ),
      interactions: selected('interactions', (value) =>
        connectionInteractionSchema.array().parse(value),
      ),
      knownHosts: selected('knownHosts', (value) => knownHostKeySchema.array().parse(value)),
      tunnelProfiles: selected('tunnelProfiles', (value) =>
        tunnelProfileSchema.array().max(10000).parse(value),
      ),
      tunnels: selected('tunnels', (value) => tunnelSchema.array().max(64).parse(value)),
    });
    this.baseline = baseline;
    this.opening = false;
    this.pending = undefined;
    this.fragments.clear();
    this.bytes = 0;
    return baseline;
  }
}
