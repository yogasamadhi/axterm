import { constants } from 'node:fs';
import { mkdir, open, rename, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { terminalBackgroundAssetSchema } from '@workspace/contracts';
import type { HostCapabilityClient } from '../adapters/host-capability/client';
import { ApplicationError } from './errors';

const maximumAssetBytes = 16 * 1024 * 1024;
const formats = [
  { extension: 'png', mimeType: 'image/png' as const },
  { extension: 'jpg', mimeType: 'image/jpeg' as const },
  { extension: 'gif', mimeType: 'image/gif' as const },
  { extension: 'webp', mimeType: 'image/webp' as const },
] as const;

export class TerminalBackgroundAssetService {
  constructor(
    private readonly directory: string | undefined,
    private readonly host: HostCapabilityClient | undefined,
  ) {}

  async import(grantId: string) {
    const host = this.requireHost();
    const directory = this.requireDirectory();
    const grant = await host.resolveGrant(grantId);
    if (grant.kind !== 'file' || !grant.permissions.includes('read'))
      throw new ApplicationError('VALIDATION_ERROR', 'A readable image grant is required', 400);
    const source = await open(grant.path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)).catch(
      () => {
        throw new ApplicationError(
          'VALIDATION_ERROR',
          'The background image cannot be opened',
          400,
        );
      },
    );
    let temporary = '';
    try {
      const metadata = await source.stat();
      if (!metadata.isFile())
        throw new ApplicationError(
          'VALIDATION_ERROR',
          'The background must be a regular file',
          400,
        );
      if (metadata.size < 1 || metadata.size > maximumAssetBytes)
        throw new ApplicationError(
          'PAYLOAD_TOO_LARGE',
          'The background image must be between 1 byte and 16 MiB',
          413,
        );
      const header = Buffer.alloc(Math.min(16, metadata.size));
      await source.read(header, 0, header.length, 0);
      const format = detectFormat(header);
      if (!format)
        throw new ApplicationError(
          'VALIDATION_ERROR',
          'Only PNG, JPEG, GIF and WebP backgrounds are supported',
          400,
        );
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const id = randomUUID();
      const destination = join(directory, `${id}.${format.extension}`);
      temporary = `${destination}.tmp`;
      const target = await open(temporary, 'wx', 0o600);
      try {
        const buffer = Buffer.alloc(64 * 1024);
        let position = 0;
        while (position < metadata.size) {
          const { bytesRead } = await source.read(
            buffer,
            0,
            Math.min(buffer.length, metadata.size - position),
            position,
          );
          if (!bytesRead) break;
          await target.write(buffer, 0, bytesRead, position);
          position += bytesRead;
        }
        if (position !== metadata.size)
          throw new ApplicationError('INVALID_STATE', 'Background image changed while importing');
        await target.sync();
        await target.close();
        await rename(temporary, destination);
        temporary = '';
      } catch (error) {
        await target.close().catch(() => undefined);
        throw error;
      }
      return terminalBackgroundAssetSchema.parse({
        id,
        mimeType: format.mimeType,
        bytes: metadata.size,
      });
    } finally {
      await source.close().catch(() => undefined);
      if (temporary) await unlink(temporary).catch(() => undefined);
    }
  }

  async resolve(id: string) {
    const directory = this.requireDirectory();
    for (const format of formats) {
      const path = join(directory, `${id}.${format.extension}`);
      const metadata = await stat(path).catch(() => undefined);
      if (!metadata?.isFile()) continue;
      if (metadata.size < 1 || metadata.size > maximumAssetBytes)
        throw new ApplicationError('INVALID_STATE', 'Background asset has an invalid size');
      return {
        path,
        asset: terminalBackgroundAssetSchema.parse({
          id,
          mimeType: format.mimeType,
          bytes: metadata.size,
        }),
      };
    }
    throw new ApplicationError('NOT_FOUND', 'Background asset not found', 404);
  }

  async delete(id: string): Promise<void> {
    const directory = this.requireDirectory();
    let deleted = false;
    for (const format of formats) {
      const path = join(directory, `${id}.${format.extension}`);
      const result = await unlink(path).then(
        () => true,
        () => false,
      );
      deleted ||= result;
    }
    if (!deleted) throw new ApplicationError('NOT_FOUND', 'Background asset not found', 404);
  }

  private requireDirectory(): string {
    if (!this.directory)
      throw new ApplicationError(
        'CAPABILITY_UNAVAILABLE',
        'Persistent background assets are unavailable',
        503,
      );
    return this.directory;
  }

  private requireHost(): HostCapabilityClient {
    if (!this.host)
      throw new ApplicationError('CAPABILITY_UNAVAILABLE', 'Background import is unavailable', 503);
    return this.host;
  }
}

function detectFormat(header: Buffer) {
  if (header.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])))
    return formats[0];
  if (header[0] === 0xff && header[1] === 0xd8 && header[2] === 0xff) return formats[1];
  if (header.subarray(0, 6).toString('ascii') === 'GIF87a') return formats[2];
  if (header.subarray(0, 6).toString('ascii') === 'GIF89a') return formats[2];
  if (
    header.subarray(0, 4).toString('ascii') === 'RIFF' &&
    header.subarray(8, 12).toString('ascii') === 'WEBP'
  )
    return formats[3];
  return undefined;
}
