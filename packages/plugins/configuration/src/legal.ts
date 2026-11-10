import { createReadStream, readFileSync, statSync, type ReadStream } from 'node:fs';
import { finished } from 'node:stream/promises';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { RemoteError } from '@axterm/plugin-api';
import type { LegalDocumentDescriptor, LegalDocumentChunk } from '@axterm/plugin-api/configuration';
const documentSchema = z
  .object({
    id: z.string().regex(/^[a-f0-9]{24}$/),
    name: z.string().min(1).max(256),
    bytes: z
      .number()
      .int()
      .min(1)
      .max(8 * 1024 * 1024),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
const manifestSchema = z
  .object({ version: z.literal(1), documents: z.array(documentSchema).max(128) })
  .strict();
const failure = () =>
  new RemoteError('configuration/failure', 'Legal document is unavailable', {
    reason: 'unavailable',
  });
/** Immutable package artifacts; no caller path or mutable user storage. */
export class LegalDocuments {
  private readonly documents: readonly LegalDocumentDescriptor[];
  private readonly streams = new Map<ReadStream, Promise<void>>();
  private readonly lifetime = new AbortController();
  private closing: Promise<void> | undefined;
  constructor(
    private readonly directory = join(
      dirname(createRequire(import.meta.url).resolve('@axterm/plugin-configuration/package.json')),
      'lib/legal',
    ),
  ) {
    const path = join(directory, 'manifest.json');
    if (statSync(path).size > 65536) throw failure();
    const manifest = manifestSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
    if (
      new Set(manifest.documents.map((value) => value.id)).size !== manifest.documents.length ||
      manifest.documents.reduce((sum, value) => sum + value.bytes, 0) > 32 * 1024 * 1024
    )
      throw failure();
    this.documents = Object.freeze(manifest.documents.map((value) => Object.freeze(value)));
  }
  list(): readonly LegalDocumentDescriptor[] {
    if (this.lifetime.signal.aborted) throw failure();
    return this.documents;
  }
  async *read(id: string, signal: AbortSignal): AsyncIterable<LegalDocumentChunk> {
    signal.throwIfAborted();
    if (this.lifetime.signal.aborted || this.streams.size >= 8) throw failure();
    const document = this.documents.find((value) => value.id === id);
    if (!document) throw failure();
    const path = join(this.directory, document.id + '.txt');
    if (statSync(path).size !== document.bytes) throw failure();
    const stream = createReadStream(path, {
      encoding: 'utf8',
      highWaterMark: 16384,
      signal: AbortSignal.any([signal, this.lifetime.signal]),
    });
    const done = finished(stream).then(
      () => {},
      () => {},
    );
    this.streams.set(stream, done);
    const hash = createHash('sha256');
    let offset = 0,
      bytes = 0;
    try {
      for await (const value of stream) {
        const text = String(value);
        bytes += Buffer.byteLength(text);
        if (bytes > document.bytes) throw failure();
        hash.update(text);
        yield { offset, text };
        offset += text.length;
      }
      if (bytes !== document.bytes || hash.digest('hex') !== document.sha256) throw failure();
    } catch {
      throw failure();
    } finally {
      stream.destroy();
      await done;
      this.streams.delete(stream);
    }
  }
  close(): Promise<void> {
    return (this.closing ??= (async () => {
      this.lifetime.abort();
      for (const stream of this.streams.keys()) stream.destroy();
      await Promise.allSettled([...this.streams.values()]);
      this.streams.clear();
    })());
  }
}
