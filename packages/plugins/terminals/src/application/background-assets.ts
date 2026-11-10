import type { TerminalAssetStore } from '../ports/background-assets.ts';
import { createHash, randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { finished } from 'node:stream/promises';
import { RemoteError } from '@axterm/plugin-api';
import type { HostFiles, LocalFileLease, ConfigurationQueries } from '@axterm/plugin-api/host';
import {
  TERMINAL_ASSET_MAX_BYTES,
  terminalBackgroundMetadataSchema,
  type TerminalBackgroundMetadata,
  type TerminalAssetReceipt,
  type TerminalAssetDeleteReceipt,
} from '@axterm/plugin-api/terminals';
const chunkBytes = 64 * 1024;
const failure = (
  reason:
    | 'closed'
    | 'stale'
    | 'capacity'
    | 'not-found'
    | 'conflict'
    | 'invalid-input'
    | 'precondition-failed'
    | 'unavailable',
) => new RemoteError('terminals/failure', 'The background asset operation failed', { reason });
export function backgroundFormat(
  header: Uint8Array,
): TerminalBackgroundMetadata['mimeType'] | undefined {
  const bytes = Buffer.from(header.buffer, header.byteOffset, header.byteLength);
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])))
    return 'image/png';
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg';
  if (['GIF87a', 'GIF89a'].includes(bytes.subarray(0, 6).toString('ascii'))) return 'image/gif';
  if (
    bytes.subarray(0, 4).toString('ascii') === 'RIFF' &&
    bytes.subarray(8, 12).toString('ascii') === 'WEBP'
  )
    return 'image/webp';
  return undefined;
}
/** One relational owner for bounded image facts and binary chunks. No private filesystem storage. */
export class TerminalBackgroundAssets {
  private readonly lifetime = new AbortController();
  private readonly leases = new Set<LocalFileLease>();
  private readonly imports = new Map<
    string,
    { hash: string; task: Promise<TerminalAssetReceipt> }
  >();
  private readonly streams = new Map<Readable, { id: string; done: Promise<void> }>();
  private closing: Promise<void> | undefined;
  constructor(
    private readonly store: TerminalAssetStore,
    private readonly files: HostFiles,
    private readonly configuration: ConfigurationQueries,
    private readonly generation: string,
  ) {}
  private assert(generation = this.generation): void {
    if (this.lifetime.signal.aborted) throw failure('closed');
    if (generation !== this.generation) throw failure('stale');
  }
  list(): TerminalBackgroundMetadata[] {
    this.assert();
    return this.store.list();
  }
  get(id: string): TerminalBackgroundMetadata {
    this.assert();
    return this.store.get(id);
  }
  import(
    key: string,
    grantId: string,
    generation: string,
    signal: AbortSignal,
  ): Promise<TerminalAssetReceipt> {
    this.assert(generation);
    signal.throwIfAborted();
    const input = { grantId, generation },
      command = key.toLowerCase(),
      hash = JSON.stringify(input);
    const saved = this.store.lookupImport(command, input);
    if (saved) return Promise.resolve(saved);
    const existing = this.imports.get(command);
    if (existing) {
      if (existing.hash !== hash) throw failure('conflict');
      return existing.task;
    }
    if (this.imports.size >= 4 || this.leases.size >= 4) throw failure('capacity');
    const task = this.readAndCommit(
      command,
      input,
      AbortSignal.any([signal, this.lifetime.signal]),
    );
    this.imports.set(command, { hash, task });
    const release = () => {
      if (this.imports.get(command)?.task === task) this.imports.delete(command);
    };
    void task.then(release, release);
    return task;
  }
  private async readAndCommit(
    key: string,
    input: { grantId: string; generation: string },
    signal: AbortSignal,
  ): Promise<TerminalAssetReceipt> {
    const lease = await this.files.open(input.grantId, 'read', signal);
    this.leases.add(lease);
    let stream: Readable | undefined;
    try {
      signal.throwIfAborted();
      const metadata = await lease.stat(lease.path);
      if (metadata.type !== 'file') throw failure('invalid-input');
      if (metadata.size < 1 || metadata.size > TERMINAL_ASSET_MAX_BYTES) throw failure('capacity');
      stream = await lease.read(lease.path);
      const chunks: Buffer[] = [];
      let bytes = 0,
        filled = 0,
        current = Buffer.alloc(chunkBytes);
      const hash = createHash('sha256');
      for await (const raw of stream) {
        signal.throwIfAborted();
        if (lease.signal.aborted) throw failure('stale');
        const data = raw instanceof Uint8Array ? raw : undefined;
        if (!data) throw failure('invalid-input');
        bytes += data.byteLength;
        if (bytes > TERMINAL_ASSET_MAX_BYTES || bytes > metadata.size) throw failure('capacity');
        hash.update(data);
        let offset = 0;
        while (offset < data.byteLength) {
          const count = Math.min(chunkBytes - filled, data.byteLength - offset);
          current.set(data.subarray(offset, offset + count), filled);
          filled += count;
          offset += count;
          if (filled === chunkBytes) {
            chunks.push(current);
            current = Buffer.alloc(chunkBytes);
            filled = 0;
          }
        }
      }
      if (filled) chunks.push(current.subarray(0, filled));
      signal.throwIfAborted();
      this.assert(input.generation);
      if (lease.signal.aborted || bytes !== metadata.size) throw failure('stale');
      const mimeType = backgroundFormat(chunks[0] ?? new Uint8Array());
      if (!mimeType) throw failure('invalid-input');
      const asset = terminalBackgroundMetadataSchema.parse({
        id: randomUUID(),
        mimeType,
        bytes,
        sha256: hash.digest('hex'),
        version: 1,
        createdAt: new Date().toISOString(),
      });
      return this.store.commitImport(key, input, asset, chunks);
    } finally {
      stream?.destroy();
      if (stream) await finished(stream).catch(() => {});
      await lease.close();
      this.leases.delete(lease);
    }
  }
  remove(key: string, id: string, version: number, generation: string): TerminalAssetDeleteReceipt {
    this.assert(generation);
    return this.store.remove(key, id, version, generation, () => {
      if ([...this.streams.values()].some((value) => value.id === id)) throw failure('conflict');
      if (JSON.stringify(this.configuration.getSettings()).includes('"assetId":"' + id + '"'))
        throw failure('conflict');
    });
  }
  openStream(id: string): {
    asset: TerminalBackgroundMetadata;
    stream: Readable;
    close(): Promise<void>;
  } {
    this.assert();
    if (this.streams.size >= 16) throw failure('capacity');
    const asset = this.get(id),
      store = this.store,
      lifetime = this.lifetime.signal;
    const stream = Readable.from(
      (async function* () {
        let bytes = 0;
        const hash = createHash('sha256');
        for (let index = 0; bytes < asset.bytes; index++) {
          lifetime.throwIfAborted();
          if (index >= 256) throw failure('unavailable');
          const content = store.readChunk(id, index);
          if (
            !(content instanceof Uint8Array) ||
            content.byteLength < 1 ||
            content.byteLength > chunkBytes ||
            bytes + content.byteLength > asset.bytes
          )
            throw failure('unavailable');
          bytes += content.byteLength;
          hash.update(content);
          yield Buffer.from(content);
        }
        if (bytes !== asset.bytes || hash.digest('hex') !== asset.sha256)
          throw failure('unavailable');
      })(),
    );
    const done = finished(stream).then(
      () => {},
      () => {},
    );
    this.streams.set(stream, { id, done });
    return {
      asset,
      stream,
      close: async () => {
        stream.destroy();
        await done;
        this.streams.delete(stream);
      },
    };
  }
  close(): Promise<void> {
    if (this.closing) return this.closing;
    const task = (async () => {
      this.lifetime.abort();
      for (const stream of this.streams.keys()) stream.destroy();
      await Promise.allSettled([...this.imports.values()].map((value) => value.task));
      await Promise.allSettled([...this.streams.values()].map((value) => value.done));
      await Promise.allSettled(
        [...this.leases].map(async (lease) => {
          await lease.close();
          this.leases.delete(lease);
        }),
      );
      this.streams.clear();
      if (this.leases.size) throw Error('TERMINAL_ASSET_LEASE_DRAIN_FAILED');
    })();
    this.closing = task;
    void task.catch(() => {
      if (this.closing === task) this.closing = undefined;
    });
    return task;
  }
}
