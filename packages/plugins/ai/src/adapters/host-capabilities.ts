import type { Context } from '@deepseek-ai/cordis';
import type { LocalFileLease } from '@axterm/plugin-api/host';
import type {} from '@axterm/plugin-api/host';
import { encodeOpaqueCredentialRef } from '@axterm/plugin-api/credentials';
import type { AiHostPort } from '../ports/host.ts';
import { ApplicationError } from '../application/errors.ts';
/** Selected owner operations only. No native path, FileHandle or plaintext credential reaches Client state. */
export class AiHostCapabilities implements AiHostPort {
  private readonly lifetime = new AbortController();
  private readonly pending = new Set<Promise<unknown>>();
  private readonly failedRevocations = new Set<string>();
  private readonly failed = new Set<LocalFileLease>();
  private closing: Promise<void> | undefined;
  constructor(private readonly ctx: Context) {}
  private grants() {
    const grants = this.ctx.get('fileGrants');
    if (!grants)
      throw new ApplicationError('CAPABILITY_UNAVAILABLE', 'AI file authority is unavailable', 503);
    return grants;
  }
  resourceCount(): number {
    return this.pending.size + this.failed.size + this.failedRevocations.size;
  }
  resolveCredential(ref: string, signal?: AbortSignal): Promise<string> {
    return this.run(signal, async (owned) => {
      const value = await this.ctx.credentials.resolve(encodeOpaqueCredentialRef(ref));
      owned.throwIfAborted();
      if (!value) throw new ApplicationError('NOT_FOUND', 'AI credential was not found', 404);
      return value.value;
    });
  }
  readGrantedTextPrefix(
    grantId: string,
    maxBytes: number,
    maxSourceBytes: number,
    signal: AbortSignal,
  ) {
    return this.run(signal, async (owned) => {
      if (
        !Number.isInteger(maxBytes) ||
        maxBytes < 1 ||
        maxBytes > 2 * 1024 * 1024 ||
        !Number.isInteger(maxSourceBytes) ||
        maxSourceBytes < maxBytes ||
        maxSourceBytes > 2 * 1024 * 1024
      )
        throw new ApplicationError('VALIDATION_ERROR', 'Invalid AI text bounds', 400);
      const lease = await this.ctx.files.open(grantId, 'read', owned);
      try {
        owned.throwIfAborted();
        lease.signal.throwIfAborted();
        const metadata = await lease.stat(lease.path);
        if (metadata.type !== 'file')
          throw new ApplicationError('VALIDATION_ERROR', 'Select a text file', 400);
        if (metadata.size > maxSourceBytes)
          throw new ApplicationError(
            'PAYLOAD_TOO_LARGE',
            'AI attachment source exceeded its bound',
            413,
          );
        const count = Math.min(metadata.size, maxBytes);
        const buffer = Buffer.alloc(count);
        let received = 0;
        if (count) {
          const stream = await lease.read(lease.path, { start: 0, end: count - 1 });
          for await (const chunk of stream) {
            owned.throwIfAborted();
            lease.signal.throwIfAborted();
            const bytes = Buffer.from(chunk);
            const offset = received;
            received += bytes.byteLength;
            if (received > count)
              throw new ApplicationError(
                'PAYLOAD_TOO_LARGE',
                'AI attachment read exceeded its bound',
                413,
              );
            bytes.copy(buffer, offset);
          }
        }
        owned.throwIfAborted();
        lease.signal.throwIfAborted();
        const bytes = buffer.subarray(0, received);
        if (!looksLikeText(bytes))
          throw new ApplicationError('VALIDATION_ERROR', 'Select a text file', 400);
        const decoded = decodeUtf8Prefix(bytes, metadata.size > received);
        return {
          name: metadata.name,
          size: metadata.size,
          ...decoded,
          truncated: metadata.size > decoded.includedBytes,
        };
      } finally {
        await this.drainLease(lease);
      }
    });
  }
  private async drainLease(lease: LocalFileLease): Promise<void> {
    try {
      await lease.close();
      this.failed.delete(lease);
    } catch {
      this.failed.add(lease);
      throw new ApplicationError('CAPABILITY_UNAVAILABLE', 'AI attachment could not drain', 503);
    }
  }
  revokeGrant(grantId: string): Promise<void> {
    return this.run(undefined, async (signal) => {
      try {
        await this.grants().revoke(grantId, signal);
        this.failedRevocations.delete(grantId);
      } catch {
        this.failedRevocations.add(grantId);
        throw new ApplicationError(
          'CAPABILITY_UNAVAILABLE',
          'AI attachment grant could not be revoked',
          503,
        );
      }
    });
  }
  close(): Promise<void> {
    this.lifetime.abort();
    return (this.closing ??= (async () => {
      await Promise.allSettled([...this.pending]);
      const results = await Promise.allSettled(
        [...this.failed].map(async (lease) => {
          await lease.close();
          this.failed.delete(lease);
        }),
      );
      await Promise.allSettled(
        [...this.failedRevocations].map(async (id) => {
          await this.grants().revoke(id);
          this.failedRevocations.delete(id);
        }),
      );
      if (
        results.some((result) => result.status === 'rejected') ||
        this.failed.size ||
        this.failedRevocations.size
      )
        throw new ApplicationError(
          'CAPABILITY_UNAVAILABLE',
          'AI Host operations could not drain',
          503,
        );
    })());
  }
  private run<T>(
    signal: AbortSignal | undefined,
    operation: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    if (this.lifetime.signal.aborted)
      return Promise.reject(
        new ApplicationError('CAPABILITY_UNAVAILABLE', 'AI Host operations are closed', 503),
      );
    if (this.pending.size >= 128)
      return Promise.reject(
        new ApplicationError('CAPACITY_EXCEEDED', 'AI Host operation capacity reached'),
      );
    const owned = AbortSignal.any([this.lifetime.signal, ...(signal ? [signal] : [])]);
    const task = Promise.resolve().then(() => {
      owned.throwIfAborted();
      return operation(owned);
    });
    this.pending.add(task);
    void task.then(
      () => this.pending.delete(task),
      () => this.pending.delete(task),
    );
    return task;
  }
}

// Pure text validation retained from the frozen generation-2 Host capability adapter.
function looksLikeText(buffer: Uint8Array): boolean {
  const length = Math.min(buffer.byteLength, 8 * 1024);
  if (!length) return false;
  let control = 0;
  for (let index = 0; index < length; index += 1) {
    const byte = buffer[index]!;
    if (byte === 0) return false;
    if (byte < 9 || (byte > 13 && byte < 32)) control += 1;
  }
  return control / length <= 0.1;
}

function decodeUtf8Prefix(
  buffer: Uint8Array,
  allowTrailingPartialCodePoint: boolean,
): { content: string; includedBytes: number } {
  const minimum = allowTrailingPartialCodePoint
    ? Math.max(0, buffer.byteLength - 3)
    : buffer.byteLength;
  for (let length = buffer.byteLength; length >= minimum; length -= 1) {
    try {
      return {
        content: new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, length)),
        includedBytes: length,
      };
    } catch {
      // A valid UTF-8 code point may cross the bounded prefix by at most three bytes.
    }
  }
  throw new ApplicationError('VALIDATION_ERROR', 'The selected file must contain UTF-8 text', 400);
}
