import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { posix } from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { RemoteFileEntry, RemoteFileTarget } from '@axterm/plugin-api/files';
import {
  RemoteFileCapabilityUnavailableError,
  type RemoteFileAttributes,
  type RemoteFilesystem,
  type RemoteFileLease,
} from '@axterm/plugin-api/host';
import { ApplicationError } from './errors.ts';

const MAX_TEXT_BYTES = 2 * 1024 * 1024;

export class RemoteFileService {
  constructor(
    private readonly connections: {
      openFiles(target: RemoteFileTarget, signal?: AbortSignal): Promise<RemoteFileLease>;
    },
    private readonly signal?: AbortSignal,
  ) {}

  async home(target: RemoteFileTarget): Promise<{ path: string }> {
    return this.withFiles(target, async (sftp) => {
      const path = posix.normalize(await sftp.realpath('.'));
      if (!path.startsWith('/'))
        throw new ApplicationError(
          'CAPABILITY_UNAVAILABLE',
          'Remote home directory could not be resolved',
          503,
        );
      const metadata = await sftp.stat(path);
      if (!metadata.isDirectory)
        throw new ApplicationError(
          'CAPABILITY_UNAVAILABLE',
          'Remote home path is not a directory',
          503,
        );
      return { path };
    });
  }

  async list(target: RemoteFileTarget, path: string): Promise<RemoteFileEntry[]> {
    return this.withFiles(target, async (sftp) => {
      const entries = await sftp.list(path);
      for (const entry of entries) validateRemoteName(entry.filename);
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

  async stat(target: RemoteFileTarget, path: string): Promise<RemoteFileEntry> {
    return this.withFiles(target, async (sftp) =>
      this.entry(path, posix.basename(path) || '/', await sftp.lstat(path)),
    );
  }

  async mkdir(target: RemoteFileTarget, path: string): Promise<void> {
    await this.withFiles(target, (sftp) => sftp.mkdir(path));
  }
  async touch(target: RemoteFileTarget, path: string): Promise<void> {
    await this.withFiles(target, (sftp) => writeAll(sftp, path, Buffer.alloc(0)));
  }
  async rename(target: RemoteFileTarget, from: string, to: string): Promise<void> {
    await this.withFiles(target, (sftp) => sftp.rename(from, to));
  }
  async delete(target: RemoteFileTarget, path: string): Promise<void> {
    await this.withFiles(target, async (sftp) => {
      const attributes = await sftp.lstat(path);
      if (attributes.isDirectory) await sftp.rmdir(path);
      else await sftp.unlink(path);
    });
  }
  async chmod(target: RemoteFileTarget, path: string, mode: number): Promise<void> {
    await this.withFiles(target, async (sftp) => {
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
    target: RemoteFileTarget,
    input: {
      paths: string[];
      destination: string;
      operation: 'copy' | 'move';
      conflict: 'skip' | 'overwrite' | 'rename';
    },
  ): Promise<number> {
    const perform = async (
      sftp: RemoteFilesystem,
      sourceFiles: RemoteFilesystem,
    ): Promise<number> => {
      const destination = normalizeRemoteOperationPath(input.destination);
      const destinationMetadata = await sftp.stat(destination);
      if (!destinationMetadata.isDirectory)
        throw new ApplicationError('VALIDATION_ERROR', 'Destination is not a directory', 400);
      const seen = new Set<string>();
      let changed = 0;
      const budget = { remaining: 20_000 };
      for (const path of input.paths) {
        const source = normalizeRemoteOperationPath(path);
        if (seen.has(source)) continue;
        seen.add(source);
        const metadata = await sftp.lstat(source);
        if (metadata.isSymbolicLink) continue;
        if (!metadata.isFile && !metadata.isDirectory)
          throw new ApplicationError(
            'CAPABILITY_UNAVAILABLE',
            'Remote special files cannot be copied or moved through this workflow',
            503,
          );
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
        else await copyRemoteTree(sftp, sourceFiles, source, target, metadata, budget);
        changed++;
      }
      return changed;
    };
    // A single FTP control connection serializes transfers. Source and destination
    // need independently owned channels so a bounded copy cannot deadlock waiting
    // for its own queued download. Both leases drain on every exit path.
    return this.withFiles(target, (destination) =>
      input.operation === 'copy'
        ? this.withFiles(target, (source) => perform(destination, source))
        : perform(destination, destination),
    );
  }

  async readText(target: RemoteFileTarget, path: string) {
    return this.withFiles(target, async (sftp) => {
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

  async readForComparison(target: RemoteFileTarget, path: string, maxBytes: number) {
    return this.withFiles(target, async (sftp) => {
      const attributes = await sftp.stat(path);
      const entry = this.entry(path, posix.basename(path) || '/', attributes);
      if (!attributes.isFile || attributes.size > maxBytes) return { entry };
      try {
        return { entry, bytes: await readBoundedBytes(sftp, path, attributes, maxBytes, true) };
      } catch (error) {
        if (error instanceof ApplicationError && error.code === 'PAYLOAD_TOO_LARGE')
          return { entry: { ...entry, size: Math.max(attributes.size, maxBytes + 1) } };
        throw error;
      }
    });
  }

  async writeText(
    target: RemoteFileTarget,
    input: { path: string; content: string; overwriteRevision: string; lineEnding: 'lf' | 'crlf' },
  ) {
    return this.withFiles(target, async (sftp) => {
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
        if (error instanceof RemoteFileCapabilityUnavailableError)
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

  private async withFiles<T>(
    target: RemoteFileTarget,
    operation: (sftp: RemoteFilesystem) => Promise<T>,
  ): Promise<T> {
    this.signal?.throwIfAborted();
    const lease = await this.connections.openFiles(target, this.signal);
    const sftp = lease.filesystem;
    try {
      return await operation(sftp);
    } finally {
      await lease.close();
    }
  }

  private entry(path: string, name: string, attributes: RemoteFileAttributes): RemoteFileEntry {
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

function revision(attributes: RemoteFileAttributes, content?: Buffer) {
  const hash = createHash('sha256').update(
    `${attributes.size}:${attributes.mtime}:${attributes.mode}`,
  );
  if (content) hash.update(content);
  return hash.digest('base64url');
}

async function readEditableBytes(
  sftp: RemoteFilesystem,
  path: string,
  attributes: RemoteFileAttributes,
): Promise<Buffer> {
  return readBoundedBytes(sftp, path, attributes, MAX_TEXT_BYTES);
}

async function readBoundedBytes(
  sftp: RemoteFilesystem,
  path: string,
  attributes: RemoteFileAttributes,
  maxBytes: number,
  readEmpty = false,
): Promise<Buffer> {
  if (!readEmpty && attributes.size === 0) return Buffer.alloc(0);
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
function writeAll(sftp: RemoteFilesystem, path: string, bytes: Buffer): Promise<void> {
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

async function remoteExists(sftp: RemoteFilesystem, path: string): Promise<boolean> {
  return sftp.lstat(path).then(
    () => true,
    (error: unknown) => {
      if (
        error instanceof Error &&
        'code' in error &&
        ['2', 'ENOENT', 'NOT_FOUND'].includes(String(error.code))
      )
        return false;
      throw error;
    },
  );
}

async function resolveRemoteOperationTarget(
  sftp: RemoteFilesystem,
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
  sftp: RemoteFilesystem,
  sourceFiles: RemoteFilesystem,
  source: string,
  target: string,
  metadata: RemoteFileAttributes,
  budget: { remaining: number },
): Promise<void> {
  budget.remaining -= 1;
  if (budget.remaining < 0)
    throw new ApplicationError('PAYLOAD_TOO_LARGE', 'Copy exceeds the entry limit', 413);
  if (metadata.isFile) {
    const writable = sftp.writeStream(target, { flags: 'wx', mode: metadata.mode & 0o7777 });
    try {
      await Promise.all([
        pipeline(sourceFiles.readStream(source), writable),
        once(writable, 'close'),
      ]);
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
    for (const entry of await sourceFiles.list(source)) {
      validateRemoteName(entry.filename);
      if (entry.filename === '.' || entry.filename === '..' || entry.attrs.isSymbolicLink) continue;
      await copyRemoteTree(
        sftp,
        sourceFiles,
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
  sftp: RemoteFilesystem,
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
    validateRemoteName(entry.filename);
    if (entry.filename === '.' || entry.filename === '..') continue;
    await removeRemoteTree(sftp, posix.join(path, entry.filename), budget);
  }
  await sftp.rmdir(path);
}

function validateRemoteName(name: string): void {
  if (!name || name.includes('/') || name.includes('\0'))
    throw new ApplicationError('VALIDATION_ERROR', 'Invalid remote directory entry', 400);
}
