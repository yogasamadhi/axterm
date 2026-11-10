import type { Context } from '@deepseek-ai/cordis';
import type {} from '@axterm/infra-connection';
import { remoteErrorOf } from '@axterm/plugin-api';
import {
  CONFIGURATION_EXPORT_PATH,
  CONFIGURATION_INSPECT_PATH,
  CONFIGURATION_PREVIEW_PATH,
  CONFIGURATION_MAX_FILE_BYTES,
  type AxtermConfigurationInspectResult,
  type AxtermConfigurationPreview,
  type ConfigurationPortableFailure,
} from '@axterm/plugin-api/configuration-portable';
interface PortableHttpOwner {
  exportContents(signal: AbortSignal): Promise<Uint8Array>;
  inspectContents(
    contents: Uint8Array,
    signal: AbortSignal,
  ): Promise<AxtermConfigurationInspectResult>;
  previewContents(
    contents: Uint8Array,
    applySettings: boolean,
    signal: AbortSignal,
  ): Promise<AxtermConfigurationPreview>;
}
interface Active {
  readonly abort: AbortController;
  readonly done: Promise<void>;
  finish(): void;
}
const statuses: Partial<Record<ConfigurationPortableFailure, number>> = {
  'invalid-input': 400,
  capacity: 413,
  stale: 410,
  conflict: 409,
  'not-found': 404,
  cancelled: 409,
  'receipt-expired': 409,
};
const fail = (reason: ConfigurationPortableFailure): Response =>
  Response.json(
    {
      code: 'configuration/portable-failure',
      message: 'The configuration file operation failed',
      details: { reason },
    },
    { status: statuses[reason] ?? 503, headers: { 'cache-control': 'no-store' } },
  );
/** Authenticated exact file routes only. Connection owns admission; Configuration owns all readers/bodies. */
export class ConfigurationPortableHttp {
  private readonly active = new Set<Active>();
  private readonly withdraw: Array<() => Promise<void>>;
  private accepting = true;
  private closing: Promise<void> | undefined;
  constructor(
    ctx: Context,
    private readonly generation: string,
    private readonly owner: PortableHttpOwner,
  ) {
    this.withdraw = [
      ctx.connection.fetch.register({
        path: CONFIGURATION_EXPORT_PATH,
        methods: ['GET'],
        requestBody: 'buffered',
        fetch: (request) => this.handle(request, 'export'),
      }),
      ctx.connection.fetch.register({
        path: CONFIGURATION_INSPECT_PATH,
        methods: ['POST'],
        requestBody: 'streaming',
        fetch: (request) => this.handle(request, 'inspect'),
      }),
      ctx.connection.fetch.register({
        path: CONFIGURATION_PREVIEW_PATH,
        methods: ['POST'],
        requestBody: 'streaming',
        fetch: (request) => this.handle(request, 'preview'),
      }),
    ];
  }
  resourceCount(): number {
    return this.active.size;
  }
  private async body(request: Request, signal: AbortSignal): Promise<Uint8Array> {
    const length = request.headers.get('content-length');
    if (
      length !== null &&
      (!/^\d+$/.test(length) || Number(length) > CONFIGURATION_MAX_FILE_BYTES)
    ) {
      await request.body?.cancel();
      throw new Error('CAPACITY');
    }
    if (!request.body) throw new Error('INVALID');
    const reader = request.body.getReader();
    const abort = () => {
      void reader.cancel().catch(() => {});
    };
    signal.addEventListener('abort', abort, { once: true });
    try {
      const chunks: Uint8Array[] = [];
      let bytes = 0;
      while (true) {
        signal.throwIfAborted();
        const item = await reader.read();
        if (item.done) break;
        bytes += item.value.byteLength;
        if (bytes > CONFIGURATION_MAX_FILE_BYTES) {
          await reader.cancel();
          throw new Error('CAPACITY');
        }
        chunks.push(item.value);
      }
      signal.throwIfAborted();
      if (!bytes) throw new Error('INVALID');
      const contents = new Uint8Array(bytes);
      let offset = 0;
      for (const chunk of chunks) {
        contents.set(chunk, offset);
        offset += chunk.byteLength;
      }
      return contents;
    } finally {
      signal.removeEventListener('abort', abort);
      reader.releaseLock();
    }
  }
  private async reject(request: Request, reason: ConfigurationPortableFailure): Promise<Response> {
    await request.body?.cancel().catch(() => {});
    return fail(reason);
  }
  private async handle(
    request: Request,
    kind: 'export' | 'inspect' | 'preview',
  ): Promise<Response> {
    if (!this.accepting) return this.reject(request, 'closed');
    if (request.headers.get('x-axterm-generation') !== this.generation)
      return this.reject(request, 'stale');
    if (new URL(request.url).search) return this.reject(request, 'invalid-input');
    if (
      kind !== 'export' &&
      !['application/json', 'application/octet-stream'].includes(
        request.headers.get('content-type')?.split(';')[0]?.trim() ?? '',
      )
    )
      return this.reject(request, 'invalid-input');
    const setting = request.headers.get('x-axterm-apply-settings');
    if (kind === 'preview' && setting !== '0' && setting !== '1')
      return this.reject(request, 'invalid-input');
    if (this.active.size >= 4) return this.reject(request, 'capacity');
    const ending = Promise.withResolvers<void>();
    const record: Active = {
      abort: new AbortController(),
      done: ending.promise,
      finish: () => ending.resolve(),
    };
    this.active.add(record);
    const signal = AbortSignal.any([request.signal, record.abort.signal]);
    let streaming = false;
    const finish = () => {
      this.active.delete(record);
      record.finish();
    };
    try {
      if (kind === 'export') {
        let contents = await this.owner.exportContents(signal);
        signal.throwIfAborted();
        const length = contents.byteLength;
        if (!length || length > CONFIGURATION_MAX_FILE_BYTES) throw new Error('CAPACITY');
        let offset = 0;
        let bodyController: ReadableStreamDefaultController<Uint8Array> | undefined;
        const abort = () => {
          contents = new Uint8Array();
          bodyController?.error(new Error('CONFIGURATION_STREAM_CANCELLED'));
          finish();
        };
        signal.addEventListener('abort', abort, { once: true });
        streaming = true;
        const body = new ReadableStream<Uint8Array>(
          {
            start(controller) {
              bodyController = controller;
            },
            pull(controller) {
              if (signal.aborted) {
                controller.error(new Error('CONFIGURATION_STREAM_CANCELLED'));
                signal.removeEventListener('abort', abort);
                finish();
                return;
              }
              if (offset >= length) {
                contents = new Uint8Array();
                controller.close();
                signal.removeEventListener('abort', abort);
                finish();
                return;
              }
              const end = Math.min(offset + 64 * 1024, length);
              controller.enqueue(contents.subarray(offset, end));
              offset = end;
            },
            cancel() {
              signal.removeEventListener('abort', abort);
              contents = new Uint8Array();
              finish();
            },
          },
          { highWaterMark: 1 },
        );
        return new Response(body, {
          headers: {
            'content-type': 'application/json',
            'content-length': String(length),
            'content-disposition': 'attachment; filename="axterm-configuration.json"',
            'cache-control': 'no-store',
          },
        });
      }
      const contents = await this.body(request, signal);
      const result =
        kind === 'inspect'
          ? await this.owner.inspectContents(contents, signal)
          : await this.owner.previewContents(contents, setting === '1', signal);
      signal.throwIfAborted();
      return Response.json(result, { headers: { 'cache-control': 'no-store' } });
    } catch (error) {
      const marked = remoteErrorOf(error);
      return fail(
        signal.aborted
          ? 'cancelled'
          : marked?.code === 'configuration/portable-failure'
            ? marked.details.reason
            : error instanceof Error && error.message === 'CAPACITY'
              ? 'capacity'
              : error instanceof Error && error.message === 'INVALID'
                ? 'invalid-input'
                : 'unavailable',
      );
    } finally {
      if (!streaming) finish();
    }
  }
  close(): Promise<void> {
    this.accepting = false;
    return (this.closing ??= (async () => {
      const withdrawing = Promise.all(this.withdraw.map((dispose) => dispose()));
      const active = [...this.active];
      for (const record of active) record.abort.abort();
      await withdrawing;
      await Promise.allSettled(active.map((record) => record.done));
    })());
  }
}
