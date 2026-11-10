import { RemoteError } from '@axterm/plugin-api';
import {
  MANAGED_FILE_IMPORT_PATH,
  managedFileImportSchema,
  fileGrantSchema,
  type FileGrant,
} from '@axterm/plugin-api/files';
/** One accepted File body per user action. No byte buffering, command retry or browser persistence. */
export class ManagedFileImportModel {
  private readonly lifetime = new AbortController();
  private readonly pending = new Set<Promise<unknown>>();
  private closing: Promise<void> | undefined;
  constructor(
    private readonly generation: () => string | undefined,
    private readonly request: (input: string, init: RequestInit) => Promise<Response> = (
      input,
      init,
    ) => globalThis.fetch(input, init),
  ) {}
  import(file: File, editable: boolean, signal?: AbortSignal): Promise<FileGrant> {
    this.assert();
    if (this.pending.size >= 8) throw new Error('FILE_IMPORT_CAPACITY');
    const generation = this.generation();
    if (!generation) throw new Error('FILE_IMPORT_GENERATION_UNAVAILABLE');
    const input = managedFileImportSchema.parse({ name: file.name, size: file.size, editable });
    const owned = AbortSignal.any([
      this.lifetime.signal,
      AbortSignal.timeout(30 * 60 * 1000),
      ...(signal ? [signal] : []),
    ]);
    const task = Promise.resolve().then(async () => {
      owned.throwIfAborted();
      const response = await this.request(MANAGED_FILE_IMPORT_PATH, {
        method: 'POST',
        credentials: 'same-origin',
        headers: {
          'content-type': 'application/octet-stream',
          'x-axterm-generation': generation,
          'x-axterm-file-name': encodeURIComponent(input.name),
          'x-axterm-file-size': String(input.size),
          'x-axterm-editable': editable ? '1' : '0',
        },
        // Electron's custom-scheme File stream cannot read an empty Blob.
        // A zero-byte declaration has no body; non-empty Files stay streaming.
        ...(input.size === 0 ? {} : { body: file }),
        signal: owned,
      });
      try {
        owned.throwIfAborted();
        if (!response.ok) {
          await response.body?.cancel().catch(() => {});
          throw new RemoteError('files/failure', 'The file import could not complete', {
            reason:
              response.status === 413
                ? 'capacity'
                : response.status === 400
                  ? 'invalid-input'
                  : response.status === 409
                    ? 'stale'
                    : 'unavailable',
          });
        }
        if (response.headers.get('x-axterm-generation') !== generation) {
          await response.body?.cancel().catch(() => {});
          throw new RemoteError('files/failure', 'File import generation changed', {
            reason: 'stale',
          });
        }
        const reader = response.body?.getReader();
        if (!reader) throw new Error('FILE_IMPORT_RESPONSE_INVALID');
        const aborted = () => {
          void reader.cancel().catch(() => {});
        };
        owned.addEventListener('abort', aborted, { once: true });
        if (owned.aborted) aborted();
        const chunks: Uint8Array[] = [];
        let size = 0;
        try {
          for (;;) {
            const next = await reader.read();
            if (next.done) break;
            size += next.value.byteLength;
            if (size > 64 * 1024) throw new Error('FILE_IMPORT_RESPONSE_CAPACITY');
            chunks.push(next.value);
          }
        } finally {
          owned.removeEventListener('abort', aborted);
          await reader.cancel().catch(() => {});
          reader.releaseLock();
        }
        owned.throwIfAborted();
        const current = this.generation();
        if (current !== undefined && current !== generation)
          throw new RemoteError('files/failure', 'File import generation changed', {
            reason: 'stale',
          });
        const bytes = new Uint8Array(size);
        let offset = 0;
        for (const chunk of chunks) {
          bytes.set(chunk, offset);
          offset += chunk.byteLength;
        }
        const grant = fileGrantSchema.parse(
          JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)),
        );
        if (
          grant.kind !== 'file' ||
          grant.name !== input.name ||
          grant.permissions.join(',') !== (editable ? 'read,write' : 'read')
        )
          throw new Error('FILE_IMPORT_RESPONSE_INVALID');
        Object.freeze(grant.permissions);
        return Object.freeze(grant);
      } finally {
        if (response.body && !response.body.locked) await response.body.cancel().catch(() => {});
      }
    });
    this.pending.add(task);
    void task.then(
      () => this.pending.delete(task),
      () => this.pending.delete(task),
    );
    return task;
  }
  resourceCount(): number {
    return this.pending.size;
  }
  dispose(): Promise<void> {
    if (this.closing) return this.closing;
    const closed = Promise.withResolvers<void>();
    this.closing = closed.promise;
    this.lifetime.abort();
    void Promise.allSettled([...this.pending]).then(() => closed.resolve());
    return closed.promise;
  }
  private assert(): void {
    if (this.lifetime.signal.aborted) throw new Error('FILE_IMPORT_MODEL_CLOSED');
  }
}
