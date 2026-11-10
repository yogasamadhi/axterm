import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';
import type { Context } from '@deepseek-ai/cordis';
import type {} from '@axterm/plugin-api/host';
import type {} from '@axterm/infra-connection';
import { RemoteError, remoteErrorOf } from '@axterm/plugin-api';
import {
  MANAGED_FILE_IMPORT_PATH,
  managedFileImportSchema,
  type FilesFailureReason,
} from '@axterm/plugin-api/files';
import type { HostFiles, LocalFileLease, ManagedFileImports } from '@axterm/plugin-api/host';
interface Cleanup {
  readonly owner: ManagedFileImports;
  id: string;
  lease?: LocalFileLease | undefined;
}
const failure = (reason: FilesFailureReason): Response =>
  Response.json(
    { code: 'files/failure', message: 'The file import could not complete', details: { reason } },
    {
      status:
        reason === 'invalid-input'
          ? 400
          : reason === 'capacity'
            ? 413
            : reason === 'cancelled'
              ? 409
              : 503,
      headers: { 'cache-control': 'no-store' },
    },
  );
/** One-shot authenticated body streaming. The shell owns temporary authority and publication. */
export class FileHttpImports {
  private readonly lifetime = new AbortController();
  private readonly active = new Set<Promise<unknown>>();
  private readonly failed = new Set<Cleanup>();
  private readonly withdraw: () => void | Promise<void>;
  private closing: Promise<void> | undefined;
  private accepting = true;
  constructor(
    private readonly ctx: Context,
    private readonly files: HostFiles,
  ) {
    this.withdraw = ctx.connection.fetch.register({
      path: MANAGED_FILE_IMPORT_PATH,
      methods: ['POST'],
      requestBody: 'streaming',
      fetch: (request) => this.accept(request),
    });
  }
  resourceCount(): number {
    return this.active.size + this.failed.size;
  }
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.accepting = false;
    const completion = Promise.withResolvers<void>();
    this.closing = completion.promise;
    this.lifetime.abort();
    void (async () => {
      const withdrawal = await Promise.allSettled([Promise.resolve().then(() => this.withdraw())]);
      await Promise.allSettled([...this.active]);
      await Promise.allSettled([...this.failed].map((record) => this.cleanup(record)));
      if (this.failed.size || withdrawal[0]?.status === 'rejected')
        throw new RemoteError('files/failure', 'Imported file resources could not drain', {
          reason: 'unavailable',
        });
    })().then(completion.resolve, completion.reject);
    return this.closing;
  }
  private accept(request: Request): Promise<Response> {
    if (!this.accepting || this.active.size >= 32)
      return Promise.resolve(failure(this.accepting ? 'capacity' : 'closed'));
    const task = Promise.resolve().then(() => this.import(request));
    this.active.add(task);
    void task.then(
      () => this.active.delete(task),
      () => this.active.delete(task),
    );
    return task;
  }
  private async import(request: Request): Promise<Response> {
    const signal = AbortSignal.any([
      request.signal,
      this.lifetime.signal,
      AbortSignal.timeout(30 * 60 * 1000),
    ]);
    let cleanup: Cleanup | undefined;
    let source: Readable | undefined;
    let guarded: Transform | undefined;
    let transfer: Promise<void> | undefined;
    try {
      signal.throwIfAborted();
      const owner = this.ctx.get('fileImports');
      if (!owner) return failure('unavailable');
      if (
        new URL(request.url).search ||
        request.headers.get('content-type')?.split(';')[0]?.trim() !== 'application/octet-stream'
      )
        return failure('invalid-input');
      const sizeHeader = request.headers.get('x-axterm-file-size');
      const editable = request.headers.get('x-axterm-editable');
      const encoded = request.headers.get('x-axterm-file-name');
      if (
        sizeHeader === null ||
        !/^(0|[1-9][0-9]*)$/u.test(sizeHeader) ||
        encoded === null ||
        (editable !== null && editable !== '0' && editable !== '1')
      )
        return failure('invalid-input');
      let name: string;
      try {
        name = decodeURIComponent(encoded);
      } catch {
        return failure('invalid-input');
      }
      const parsed = managedFileImportSchema.safeParse({
        name,
        size: Number(sizeHeader),
        editable: editable === '1',
      });
      if (!parsed.success) return failure('invalid-input');
      const input = parsed.data;
      const length = request.headers.get('content-length');
      if (
        (length !== null &&
          (!/^(0|[1-9][0-9]*)$/u.test(length) || Number(length) !== input.size)) ||
        (!request.body && input.size !== 0)
      )
        return failure('invalid-input');
      const grant = await owner.prepare(input, signal);
      cleanup = { owner, id: grant.grantId };
      cleanup.lease = await this.files.open(grant.grantId, 'write', signal);
      source = request.body
        ? Readable.fromWeb(request.body as NodeReadableStream<Uint8Array>, { signal })
        : Readable.from([]);
      let received = 0;
      guarded = new Transform({
        transform(chunk, _encoding, done) {
          received += Buffer.byteLength(chunk);
          done(
            received > input.size
              ? new RemoteError('files/failure', 'File body exceeds its declared size', {
                  reason: 'capacity',
                })
              : undefined,
            chunk,
          );
        },
      });
      transfer = pipeline(source, guarded, { signal });
      void transfer.catch(() => {});
      await cleanup.lease.write(cleanup.lease.path, guarded, { overwrite: true, mode: 0o600 });
      await transfer;
      if (received !== input.size)
        throw new RemoteError('files/failure', 'File body differs from its declared size', {
          reason: 'invalid-input',
        });
      await cleanup.lease.close();
      cleanup.lease = undefined;
      const published = await owner.commit(grant.grantId, signal);
      cleanup.id = published.grantId;
      signal.throwIfAborted();
      cleanup = undefined;
      return Response.json(published, {
        headers: {
          'cache-control': 'no-store',
          'x-axterm-generation': this.ctx.runtimeIdentity.generation,
        },
      });
    } catch (error) {
      const marked = remoteErrorOf(error);
      return failure(
        signal.aborted
          ? 'cancelled'
          : marked?.code === 'files/failure'
            ? marked.details.reason
            : 'unavailable',
      );
    } finally {
      source?.destroy();
      guarded?.destroy();
      await transfer?.catch(() => {});
      if (cleanup) await this.cleanup(cleanup).catch(() => {});
    }
  }
  private async cleanup(record: Cleanup): Promise<void> {
    this.failed.add(record);
    await record.lease?.close();
    record.lease = undefined;
    await record.owner.discard(record.id);
    this.failed.delete(record);
  }
}
