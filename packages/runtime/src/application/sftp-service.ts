import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { posix } from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { RemoteFileEntry } from '@workspace/contracts';
import {
  SftpCapabilityUnavailableError,
  type SftpAttributes,
  type SftpHandle,
} from '../ports/ssh-transport';
import { ApplicationError } from './errors';

const MAX_TEXT_BYTES = 2 * 1024 * 1024;

export class SftpService {
  constructor(
    private readonly connections: {
      handle(connectionId: string): { openSftp(): Promise<SftpHandle> };
    },
  ) {}

  async list(connectionId: string, path: string): Promise<RemoteFileEntry[]> {
    return this.withSftp(connectionId, async (sftp) => {
      const entries = await sftp.list(path);
      return entries
        .filter((entry) => entry.filename !== '.' && entry.filename !== '..')
        .map((entry) => this.entry(posix.join(path, entry.filename), entry.filename, entry.attrs))
        .sort((left, right) => {
          if (left.type === 'directory' && right.type !== 'directory') return -1;
          if (left.type !== 'directory' && right.type === 'directory') return 1;
          return left.name.localeCompare(right.name);
        });
    });
  }

  async stat(connectionId: string, path: string): Promise<RemoteFileEntry> {
    return this.withSftp(connectionId, async (sftp) =>
      this.entry(path, posix.basename(path) || '/', await sftp.lstat(path)),
    );
  }

  async mkdir(connectionId: string, path: string): Promise<void> {
    await this.withSftp(connectionId, (sftp) => sftp.mkdir(path));
  }
  async touch(connectionId: string, path: string): Promise<void> {
    await this.withSftp(connectionId, (sftp) => writeAll(sftp, path, Buffer.alloc(0)));
  }
  async rename(connectionId: string, from: string, to: string): Promise<void> {
    await this.withSftp(connectionId, (sftp) => sftp.rename(from, to));
  }
  async delete(connectionId: string, path: string): Promise<void> {
    await this.withSftp(connectionId, async (sftp) => {
      const attributes = await sftp.lstat(path);
      if (attributes.isDirectory) await sftp.rmdir(path);
      else await sftp.unlink(path);
    });
  }
  async chmod(connectionId: string, path: string, mode: number): Promise<void> {
    await this.withSftp(connectionId, async (sftp) => {
      const attributes = await sftp.lstat(path);
      if (attributes.isSymbolicLink)
        throw new ApplicationError(
          'VALIDATION_ERROR',
          'Symbolic link permissions cannot be changed safely',
          400,
        );
      await sftp.chmod(path, mode);
    });
  }

  async operate(
    connectionId: string,
    input: {
      paths: string[];
      destination: string;
      operation: 'copy' | 'move';
      conflict: 'skip' | 'overwrite' | 'rename';
    },
  ): Promise<void> {
    await this.withSftp(connectionId, async (sftp) => {
      const destination = normalizeRemoteOperationPath(input.destination);
      const destinationMetadata = await sftp.stat(destination);
      if (!destinationMetadata.isDirectory)
        throw new ApplicationError('VALIDATION_ERROR', 'Destination is not a directory', 400);
      const seen = new Set<string>();
      const budget = { remaining: 20_000 };
      for (const path of input.paths) {
        const source = normalizeRemoteOperationPath(path);
        if (seen.has(source)) continue;
        seen.add(source);
        const metadata = await sftp.lstat(source);
        if (metadata.isSymbolicLink) continue;
        if (metadata.isDirectory && remotePathWithin(source, destination))
          throw new ApplicationError(
            'VALIDATION_ERROR',
            'A directory cannot be placed inside itself',
            400,
          );
        const requestedTarget = posix.join(destination, posix.basename(source));
        if (requestedTarget === source && input.operation === 'move') continue;
        const target = await resolveRemoteOperationTarget(
          sftp,
          source,
          requestedTarget,
          input.operation,
          input.conflict,
          metadata.isDirectory,
        );
        if (!target) continue;
        if (input.operation === 'move') await sftp.rename(source, target);
        else await copyRemoteTree(sftp, source, target, metadata, budget);
      }
    });
  }

  async readText(connectionId: string, path: string) {
    return this.withSftp(connectionId, async (sftp) => {
      const attributes = await sftp.stat(path);
      if (!attributes.isFile || attributes.size > MAX_TEXT_BYTES)
        throw new ApplicationError(
          'CAPABILITY_UNAVAILABLE',
          'Remote file is not an editable text file',
          503,
        );
      const bytes = await readEditableBytes(sftp, path, attributes);
      const content = bytes.toString('utf8');
      if (content.includes('\uFFFD'))
        throw new ApplicationError('CAPABILITY_UNAVAILABLE', 'Remote file is not valid UTF-8', 503);
      return {
        path,
        content,
        revision: revision(attributes, bytes),
        lineEnding: content.includes('\r\n') ? ('crlf' as const) : ('lf' as const),
      };
    });
  }

  async readForComparison(connectionId: string, path: string, maxBytes: number) {
    return this.withSftp(connectionId, async (sftp) => {
      const attributes = await sftp.stat(path);
      const entry = this.entry(path, posix.basename(path) || '/', attributes);
      if (!attributes.isFile || attributes.size > maxBytes) return { entry };
      return { entry, bytes: await readBoundedBytes(sftp, path, attributes, maxBytes) };
    });
  }

  async writeText(
    connectionId: string,
    input: { path: string; content: string; overwriteRevision: string; lineEnding: 'lf' | 'crlf' },
  ) {
    return this.withSftp(connectionId, async (sftp) => {
      const current = await sftp.stat(input.path);
      if (!current.isFile || current.size > MAX_TEXT_BYTES)
        throw new ApplicationError(
          'CAPABILITY_UNAVAILABLE',
          'Remote file is not an editable text file',
          503,
        );
      const currentBytes = await readEditableBytes(sftp, input.path, current);
      if (revision(current, currentBytes) !== input.overwriteRevision)
        throw new ApplicationError(
          'REMOTE_EDIT_CONFLICT',
          'Remote file changed after it was opened',
          409,
        );
      const normalized =
        input.lineEnding === 'crlf'
          ? input.content.replace(/\r?\n/g, '\r\n')
          : input.content.replace(/\r\n/g, '\n');
      const bytes = Buffer.from(normalized, 'utf8');
      if (bytes.length > MAX_TEXT_BYTES)
        throw new ApplicationError(
          'CAPABILITY_UNAVAILABLE',
          'Remote file exceeds the editor limit',
          503,
        );
      const temporary = posix.join(posix.dirname(input.path), `.axterm-${randomUUID()}.tmp`);
      try {
        await writeAll(sftp, temporary, bytes);
        await sftp.chmod(temporary, current.mode & 0o7777);
        await sftp.replace(temporary, input.path);
      } catch (error) {
        await sftp.unlink(temporary).catch(() => {});
        if (error instanceof SftpCapabilityUnavailableError)
          throw new ApplicationError(
            'CAPABILITY_UNAVAILABLE',
            'Remote server does not support safe atomic text replacement',
            503,
          );
        throw error;
      }
      const updated = await sftp.stat(input.path);
      return {
        path: input.path,
        content: normalized,
        revision: revision(updated, bytes),
        lineEnding: input.lineEnding,
      };
    });
  }

  private async withSftp<T>(
    connectionId: string,
    operation: (sftp: SftpHandle) => Promise<T>,
  ): Promise<T> {
    const sftp = await this.connections.handle(connectionId).openSftp();
    try {
      return await operation(sftp);
    } finally {
      await sftp.close().catch(() => {});
    }
  }

  private entry(path: string, name: string, attributes: SftpAttributes): RemoteFileEntry {
    return {
      name,
      path,
      type: attributes.isDirectory
        ? 'directory'
        : attributes.isFile
          ? 'file'
          : attributes.isSymbolicLink
            ? 'symlink'
            : 'other',
      size: attributes.size,
      mode: attributes.mode,
      modifiedAt: new Date(attributes.mtime * 1000).toISOString(),
      accessedAt: new Date(attributes.atime * 1000).toISOString(),
      owner: String(attributes.uid),
      group: String(attributes.gid),
      revision: revision(attributes),
    };
  }
}

function revision(attributes: SftpAttributes, content?: Buffer) {
  const hash = createHash('sha256').update(
    `${attributes.size}:${attributes.mtime}:${attributes.mode}`,
  );
  if (content) hash.update(content);
  return hash.digest('base64url');
}

async function readEditableBytes(
  sftp: SftpHandle,
  path: string,
  attributes: SftpAttributes,
): Promise<Buffer> {
  return readBoundedBytes(sftp, path, attributes, MAX_TEXT_BYTES);
}

async function readBoundedBytes(
  sftp: SftpHandle,
  path: string,
  attributes: SftpAttributes,
  maxBytes: number,
): Promise<Buffer> {
  if (attributes.size === 0) return Buffer.alloc(0);
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of sftp.readStream(path)) {
    const bytes = Buffer.from(chunk);
    size += bytes.length;
    if (size > maxBytes)
      throw new ApplicationError(
        'PAYLOAD_TOO_LARGE',
        'Remote file exceeds the requested read limit',
        413,
      );
    chunks.push(bytes);
  }
  return Buffer.concat(chunks);
}
function writeAll(sftp: SftpHandle, path: string, bytes: Buffer): Promise<void> {
  return new Promise((resolve, reject) => {
    const stream = sftp.writeStream(path, { flags: 'wx', mode: 0o600 });
    stream.once('error', reject);
    // ssh2 can emit `finish` before the remote file handle has been opened and
    // closed, especially when `bytes` is empty. Closing the containing SFTP
    // channel at that point races the outstanding OPEN/CLOSE requests and can
    // leave the request pending forever. `close` is the durable boundary for
    // an auto-closing ssh2 write stream.
    stream.once('close', resolve);
    stream.end(bytes);
  });
}

function normalizeRemoteOperationPath(path: string): string {
  if (!path.startsWith('/') || path.includes('\0'))
    throw new ApplicationError('VALIDATION_ERROR', 'Remote path must be absolute', 400);
  return posix.normalize(path);
}

function remotePathWithin(root: string, candidate: string): boolean {
  const fromRoot = posix.relative(root, candidate);
  return fromRoot !== '..' && !fromRoot.startsWith('../') && !posix.isAbsolute(fromRoot);
}

async function remoteExists(sftp: SftpHandle, path: string): Promise<boolean> {
  return sftp.lstat(path).then(
    () => true,
    () => false,
  );
}

async function resolveRemoteOperationTarget(
  sftp: SftpHandle,
  source: string,
  requestedTarget: string,
  operation: 'copy' | 'move',
  conflict: 'skip' | 'overwrite' | 'rename',
  directory: boolean,
): Promise<string | undefined> {
  if (!(await remoteExists(sftp, requestedTarget))) return requestedTarget;
  if (requestedTarget === source && operation === 'move') return undefined;
  if (conflict === 'skip') return undefined;
  if (conflict === 'overwrite') {
    if (requestedTarget === source)
      throw new ApplicationError('VALIDATION_ERROR', 'Cannot overwrite an entry with itself', 400);
    await removeRemoteTree(sftp, requestedTarget, { remaining: 20_000 });
    return requestedTarget;
  }
  const name = posix.basename(requestedTarget);
  const extension = directory ? '' : posix.extname(name);
  const stem = extension ? name.slice(0, -extension.length) : name;
  for (let index = 1; index <= 999; index += 1) {
    const candidate = posix.join(
      posix.dirname(requestedTarget),
      `${stem}(copy-${index})${extension}`,
    );
    if (!(await remoteExists(sftp, candidate))) return candidate;
  }
  throw new ApplicationError('CONFLICT', 'No available conflict name', 409);
}

async function copyRemoteTree(
  sftp: SftpHandle,
  source: string,
  target: string,
  metadata: SftpAttributes,
  budget: { remaining: number },
): Promise<void> {
  budget.remaining -= 1;
  if (budget.remaining < 0)
    throw new ApplicationError('PAYLOAD_TOO_LARGE', 'Copy exceeds the entry limit', 413);
  if (metadata.isFile) {
    const writable = sftp.writeStream(target, { flags: 'wx', mode: metadata.mode & 0o7777 });
    try {
      await Promise.all([pipeline(sftp.readStream(source), writable), once(writable, 'close')]);
      await sftp.chmod(target, metadata.mode & 0o7777);
    } catch (error) {
      await sftp.unlink(target).catch(() => {});
      throw error;
    }
    return;
  }
  if (!metadata.isDirectory) return;
  await sftp.mkdir(target);
  await sftp.chmod(target, metadata.mode & 0o7777).catch(() => {});
  try {
    for (const entry of await sftp.list(source)) {
      if (entry.filename === '.' || entry.filename === '..' || entry.attrs.isSymbolicLink) continue;
      await copyRemoteTree(
        sftp,
        posix.join(source, entry.filename),
        posix.join(target, entry.filename),
        entry.attrs,
        budget,
      );
    }
  } catch (error) {
    await removeRemoteTree(sftp, target, { remaining: 20_000 }).catch(() => {});
    throw error;
  }
}

async function removeRemoteTree(
  sftp: SftpHandle,
  path: string,
  budget: { remaining: number },
): Promise<void> {
  budget.remaining -= 1;
  if (budget.remaining < 0)
    throw new ApplicationError('PAYLOAD_TOO_LARGE', 'Delete exceeds the entry limit', 413);
  const metadata = await sftp.lstat(path);
  if (!metadata.isDirectory) {
    await sftp.unlink(path);
    return;
  }
  for (const entry of await sftp.list(path)) {
    if (entry.filename === '.' || entry.filename === '..') continue;
    await removeRemoteTree(sftp, posix.join(path, entry.filename), budget);
  }
  await sftp.rmdir(path);
}
