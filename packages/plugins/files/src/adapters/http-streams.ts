import { createHash } from 'node:crypto';
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { Context } from '@deepseek-ai/cordis';
import type {} from '@axterm/infra-connection';
import { RemoteError, remoteErrorOf } from '@axterm/plugin-api';
import {
  LOCAL_FILE_READ_PATH,
  LOCAL_FILE_WRITE_PATH,
  localFileReadQuerySchema,
  localFileWriteQuerySchema,
  localFileWriteHeadersSchema,
  type FilesFailureReason,
} from '@axterm/plugin-api/files';
import type { LocalFileLease } from '@axterm/plugin-api/host';
import type { FileCommands } from '../ports/commands.ts';
import type { HostFiles } from '@axterm/plugin-api/host';
const failure = (reason: FilesFailureReason): Response => {
  const statuses: Partial<Record<FilesFailureReason, number>> = {
    'invalid-input': 400,
    'not-found': 404,
    forbidden: 403,
    stale: 410,
    capacity: 413,
    conflict: 409,
    cancelled: 409,
    uncertain: 409,
    'receipt-expired': 409,
  };
  return Response.json(
    { code: 'files/failure', message: 'The file stream could not complete', details: { reason } },
    { status: statuses[reason] ?? 503, headers: { 'cache-control': 'no-store' } },
  );
};
function reasonOf(error: unknown): FilesFailureReason {
  const marked = remoteErrorOf(error);
  return marked?.code === 'files/failure' ? marked.details.reason : 'unavailable';
}
function query(request: Request): Record<string, string> | undefined {
  const params = new URL(request.url).searchParams;
  const fields = Object.fromEntries(params);
  return [...params].length === Object.keys(fields).length ? fields : undefined;
}
interface Active {
  abort: AbortController;
  done: Promise<void>;
  finish(): void;
}
/** Only bulk bytes use HTTP; all registrations and transferred bodies have one owner. */
export class FileHttpStreams {
  private readonly active = new Set<Active>();
  private readonly withdraw: (() => Promise<void>)[];
  private accepting = true;
  private closing: Promise<void> | undefined;
  constructor(
    ctx: Context,
    private readonly files: HostFiles,
    private readonly journal: FileCommands,
  ) {
    this.withdraw = [
      ctx.connection.fetch.register({
        path: LOCAL_FILE_READ_PATH,
        methods: ['GET'],
        requestBody: 'buffered',
        fetch: (request) => this.read(request),
      }),
      ctx.connection.fetch.register({
        path: LOCAL_FILE_WRITE_PATH,
        methods: ['POST'],
        requestBody: 'streaming',
        fetch: (request) => this.write(request),
      }),
    ];
  }
  resourceCount(): number {
    return this.active.size;
  }
  private begin(request: Request): { signal: AbortSignal; finish(): void } | undefined {
    if (!this.accepting || this.active.size >= 64) return undefined;
    const done = Promise.withResolvers<void>();
    const record: Active = {
      abort: new AbortController(),
      done: done.promise,
      finish: () => done.resolve(),
    };
    this.active.add(record);
    return {
      signal: AbortSignal.any([request.signal, record.abort.signal]),
      finish: () => {
        this.active.delete(record);
        record.finish();
      },
    };
  }
  private async read(request: Request): Promise<Response> {
    const parsed = localFileReadQuerySchema.safeParse(query(request));
    if (!parsed.success) return failure('invalid-input');
    const task = this.begin(request);
    if (!task) return failure(this.accepting ? 'capacity' : 'closed');
    let lease: LocalFileLease | undefined;
    let source: Readable | undefined;
    let cleanup: Promise<void> | undefined;
    const end = () =>
      (cleanup ??= (async () => {
        source?.destroy();
        try {
          await lease?.close();
        } finally {
          task.finish();
        }
      })());
    const aborted = () => {
      source?.destroy();
      if (lease) void end().catch(() => {});
    };
    task.signal.addEventListener('abort', aborted, { once: true });
    try {
      const input = parsed.data;
      lease = await this.files.open(input.grantId, 'read', task.signal);
      const metadata = await lease.stat(input.path);
      if (metadata.type !== 'file') return failure('invalid-input');
      const start = input.start ?? 0;
      const endByte = Math.min(
        input.end ?? Math.max(0, metadata.size - 1),
        Math.max(0, metadata.size - 1),
      );
      if ((input.start !== undefined || input.end !== undefined) && start >= metadata.size) {
        await end();
        return new Response(null, {
          status: 416,
          headers: { 'content-range': `bytes */${metadata.size}`, 'cache-control': 'no-store' },
        });
      }
      source = await lease.read(input.path, { start, ...(metadata.size ? { end: endByte } : {}) });
      const iterator = source[Symbol.asyncIterator]();
      const finish = async () => {
        task.signal.removeEventListener('abort', aborted);
        await end();
      };
      const body = new ReadableStream<Uint8Array>(
        {
          pull: async (controller) => {
            try {
              const next = await iterator.next();
              if (next.done) {
                await finish();
                controller.close();
              } else controller.enqueue(new Uint8Array(next.value));
            } catch {
              await finish().catch(() => {});
              controller.error(new Error('FILE_STREAM_INTERRUPTED'));
            }
          },
          cancel: async () => {
            source?.destroy();
            try {
              await iterator.return?.();
            } finally {
              await finish();
            }
          },
        },
        { highWaterMark: 1 },
      );
      return new Response(body, {
        status: input.start !== undefined || input.end !== undefined ? 206 : 200,
        headers: {
          'content-type': 'application/octet-stream',
          'content-length': String(metadata.size ? endByte - start + 1 : 0),
          'cache-control': 'no-store',
          'x-content-type-options': 'nosniff',
          ...(input.start !== undefined || input.end !== undefined
            ? { 'content-range': `bytes ${start}-${endByte}/${metadata.size}` }
            : {}),
        },
      });
    } catch (error) {
      await end().catch(() => {});
      return failure(task.signal.aborted ? 'cancelled' : reasonOf(error));
    } finally {
      if (!source) {
        task.signal.removeEventListener('abort', aborted);
        await end().catch(() => {});
      }
    }
  }
  private async write(request: Request): Promise<Response> {
    const parsed = localFileWriteQuerySchema.safeParse(query(request));
    const headers = localFileWriteHeadersSchema.safeParse({
      key: request.headers.get('idempotency-key'),
      bytes: request.headers.get('x-axterm-file-bytes'),
      sha256: request.headers.get('x-axterm-file-sha256'),
    });
    if (
      !parsed.success ||
      !headers.success ||
      !request.headers.has('x-axterm-file-bytes') ||
      !request.body
    )
      return failure('invalid-input');
    const declared = request.headers.get('content-length');
    if (declared !== null && Number(declared) !== headers.data.bytes)
      return failure('invalid-input');
    const task = this.begin(request);
    if (!task) return failure(this.accepting ? 'capacity' : 'closed');
    try {
      const { key, ...input } = { ...parsed.data, ...headers.data };
      const receipt = await this.journal.execute(
        key,
        'writeLocalStream',
        input,
        async (signal) => {
          const lease = await this.files.open(input.grantId, 'write', signal);
          if (lease.path && lease.path !== input.path) {
            await lease.close();
            throw new RemoteError('files/failure', 'The file target is outside its authority', {
              reason: 'forbidden',
            });
          }
          const source = Readable.fromWeb(request.body as NodeReadableStream<Uint8Array>, {
            signal,
          });
          let count = 0;
          const digest = createHash('sha256');
          const guarded = new Transform({
            highWaterMark: 64 * 1024,
            transform(chunk: Buffer, _encoding, callback) {
              count += chunk.length;
              if (count > input.bytes) {
                callback(
                  new RemoteError(
                    'files/failure',
                    'The file body does not match its declared size',
                    { reason: 'invalid-input' },
                  ),
                );
                return;
              }
              digest.update(chunk);
              callback(null, chunk);
            },
            flush(callback) {
              callback(
                count === input.bytes && digest.digest('hex') === input.sha256
                  ? undefined
                  : new RemoteError(
                      'files/failure',
                      'The file body does not match its declared digest',
                      { reason: 'invalid-input' },
                    ),
              );
            },
          });
          const transfer = pipeline(source, guarded, { signal });
          void transfer.catch(() => {});
          try {
            await lease.write(input.path, guarded, {
              overwrite: input.overwrite,
              mode: input.mode,
            });
            await transfer;
            return 1;
          } finally {
            source.destroy();
            guarded.destroy();
            await transfer.catch(() => {});
            await lease.close();
          }
        },
        task.signal,
      );
      return Response.json(receipt, { headers: { 'cache-control': 'no-store' } });
    } catch (error) {
      return failure(task.signal.aborted ? 'cancelled' : reasonOf(error));
    } finally {
      task.finish();
    }
  }
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.accepting = false;
    return (this.closing = (async () => {
      await Promise.all(this.withdraw.map((dispose) => dispose()));
      const active = [...this.active];
      for (const task of active) task.abort.abort();
      await Promise.allSettled(active.map((task) => task.done));
    })());
  }
}
