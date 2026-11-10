import { AiReadResource } from './read-resource.ts';
interface Entry {
  resource: AiReadResource<unknown>;
  references: number;
  bytes: number;
  revision: string;
  readonly version: () => string;
}
export interface AiReadLease<T> {
  readonly resource: AiReadResource<T>;
  dispose(): Promise<void>;
}
/** Shared selected read ownership; UI mounts retain leases, never business copies in React state. */
export class AiReadRegistry {
  private readonly entries = new Map<string, Entry>();
  private readonly retiring = new Set<Entry>();
  private bytes = 0;
  private closing: Promise<void> | undefined;
  private closed = false;
  open<T>(
    key: string,
    read: (signal: AbortSignal) => Promise<T>,
    version: () => string,
    interval?: number,
  ): AiReadLease<T> {
    if (this.closed) throw new Error('AI_READ_REGISTRY_CLOSED');
    let entry = this.entries.get(key);
    if (entry) entry.references++;
    else {
      if (this.entries.size + this.retiring.size >= 32) throw new Error('AI_READ_CAPACITY');
      const revision = version();
      const resource = new AiReadResource<unknown>(
        read,
        (value) => {
          const size =
            value === undefined ? 0 : new TextEncoder().encode(JSON.stringify(value)).byteLength;
          if (size > 4 * 1024 * 1024 || this.bytes - owned.bytes + size > 32 * 1024 * 1024)
            throw new Error('AI_READ_CAPACITY');
          this.bytes += size - owned.bytes;
          owned.bytes = size;
        },
        () => {
          if (this.entries.get(key) === owned) this.entries.delete(key);
          this.retiring.delete(owned);
        },
        interval,
      );
      const owned: Entry = { resource, references: 1, bytes: 0, version, revision };
      entry = owned;
      this.entries.set(key, entry);
      void resource.refetch().catch(() => {});
    }
    const owned = entry;
    let closing: Promise<void> | undefined;
    return {
      resource: owned.resource as AiReadResource<T>,
      dispose: () =>
        (closing ??= (async () => {
          owned.references--;
          if (owned.references === 0) {
            if (this.closed) {
              await owned.resource.dispose();
              return;
            }
            if (this.entries.get(key) === owned) this.entries.delete(key);
            this.retiring.add(owned);
            await owned.resource.dispose();
            this.retiring.delete(owned);
          }
        })()),
    };
  }
  invalidate(): void {
    if (this.closed) return;
    for (const entry of this.entries.values()) {
      if (entry.references === 0) continue;
      const revision = entry.version();
      if (revision !== entry.revision) {
        entry.revision = revision;
        entry.resource.invalidate();
      }
    }
  }
  resourceCount(): number {
    return this.entries.size + this.retiring.size;
  }
  retainedBytes(): number {
    return this.bytes;
  }
  dispose(): Promise<void> {
    this.closed = true;
    return (this.closing ??= (async () => {
      const outcomes = await Promise.allSettled(
        [...this.entries.values(), ...this.retiring].map((entry) => entry.resource.dispose()),
      );
      if (outcomes.some((result) => result.status === 'rejected') || this.resourceCount())
        throw Error('AI_READ_REGISTRY_UNDRAINED');
    })());
  }
}
