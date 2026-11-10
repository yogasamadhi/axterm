import { Readable } from 'node:stream';
import type { HostFiles } from '@axterm/plugin-api/host';
import type { PortableFiles } from '../ports/portable.ts';
import { PortableApplicationError } from '../application/portable-errors.ts';
const MAX_BYTES = 16 * 1024 * 1024;
/** Files retains authority, paths, staging and handles; Configuration bounds and parses its own document. */
export class ConfigurationPortableFiles implements PortableFiles {
  constructor(private readonly files: () => HostFiles | undefined) {}
  private owner(): HostFiles {
    const owner = this.files();
    if (!owner)
      throw new PortableApplicationError(
        'CAPABILITY_UNAVAILABLE',
        'File capability is unavailable',
        503,
      );
    return owner;
  }
  async read(grantId: string, signal?: AbortSignal): Promise<Uint8Array> {
    const lease = await this.owner().open(grantId, 'read', signal);
    let stream: Readable | undefined;
    try {
      const before = await lease.stat(lease.path);
      if (before.type !== 'file')
        throw new PortableApplicationError('INVALID_STATE', 'Configuration must be a regular file');
      if (!before.size || before.size > MAX_BYTES)
        throw new PortableApplicationError(
          'PAYLOAD_TOO_LARGE',
          'Configuration exceeds 16 MiB',
          413,
        );
      stream = await lease.read(lease.path);
      const chunks: Buffer[] = [];
      let bytes = 0;
      for await (const chunk of stream) {
        lease.signal.throwIfAborted();
        const part = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        bytes += part.length;
        if (bytes > MAX_BYTES)
          throw new PortableApplicationError(
            'PAYLOAD_TOO_LARGE',
            'Configuration exceeds 16 MiB',
            413,
          );
        chunks.push(part);
      }
      const after = await lease.stat(lease.path);
      if (
        bytes !== before.size ||
        after.size !== before.size ||
        after.modifiedAt !== before.modifiedAt
      )
        throw new PortableApplicationError('CONFLICT', 'Configuration changed during reading');
      lease.signal.throwIfAborted();
      return Buffer.concat(chunks, bytes);
    } finally {
      stream?.destroy();
      await lease.close();
    }
  }
  async write(grantId: string, contents: Uint8Array, signal?: AbortSignal): Promise<void> {
    if (!contents.length || contents.length > MAX_BYTES)
      throw new PortableApplicationError('PAYLOAD_TOO_LARGE', 'Configuration exceeds 16 MiB', 413);
    const lease = await this.owner().open(grantId, 'write', signal);
    try {
      await lease.write(lease.path, Readable.from([contents]), { overwrite: true, mode: 0o600 });
    } finally {
      await lease.close();
    }
  }
}
