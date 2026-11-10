import { constants } from 'node:fs';
import { open, chmod, utimes } from 'node:fs/promises';
import { isAbsolute, join, posix, relative, sep } from 'node:path';
import { resolveOpenedFileRealPathForHandle, type Root } from '@openclaw/fs-safe/root';
import { RemoteError } from '@axterm/plugin-api';
const failure = () =>
  new RemoteError('files/failure', 'The authorized permission change failed', { reason: 'stale' });
/** Shared pinned-mode adapter, preserving the existing macOS/Windows fallback boundary. */
export async function applyPinnedMode(
  filesystem: Root,
  path: string,
  mode: number,
  metadata: { dev: number; ino: number; isFile: boolean; isSymbolicLink: boolean; nlink: number },
  assert: () => void,
  verify: () => Promise<void>,
): Promise<void> {
  if (metadata.isSymbolicLink || (metadata.isFile && metadata.nlink > 1)) throw failure();
  const parent = posix.dirname(path);
  const directory = parent === '.' ? filesystem.rootReal : await filesystem.resolve(parent);
  const candidate = join(directory, posix.basename(path));
  if (process.platform === 'win32') {
    await verify();
    assert();
    await chmod(candidate, mode);
    await verify();
    return;
  }
  const handle = await open(
    candidate,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
  );
  try {
    const actual = await handle.stat();
    const real = await resolveOpenedFileRealPathForHandle(handle, candidate);
    const inside = relative(filesystem.rootReal, real);
    if (
      inside === '..' ||
      inside.startsWith('..' + sep) ||
      isAbsolute(inside) ||
      metadata.dev !== actual.dev ||
      metadata.ino !== actual.ino
    )
      throw failure();
    await verify();
    assert();
    await handle.chmod(mode);
  } finally {
    await handle.close();
  }
}

export async function applyPinnedTimes(
  filesystem: Root,
  path: string,
  modifiedAt: number,
  accessedAt: number,
  metadata: { dev: number; ino: number; isFile: boolean; isSymbolicLink: boolean; nlink: number },
  assert: () => void,
  verify: () => Promise<void>,
): Promise<void> {
  if (metadata.isSymbolicLink || (metadata.isFile && metadata.nlink > 1)) throw failure();
  const parent = posix.dirname(path);
  const directory = parent === '.' ? filesystem.rootReal : await filesystem.resolve(parent);
  const candidate = join(directory, posix.basename(path));
  if (process.platform === 'win32') {
    await verify();
    assert();
    await utimes(candidate, new Date(accessedAt), new Date(modifiedAt));
    await verify();
    return;
  }
  const handle = await open(
    candidate,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
  );
  try {
    const actual = await handle.stat();
    const real = await resolveOpenedFileRealPathForHandle(handle, candidate);
    const inside = relative(filesystem.rootReal, real);
    if (
      inside === '..' ||
      inside.startsWith('..' + sep) ||
      isAbsolute(inside) ||
      metadata.dev !== actual.dev ||
      metadata.ino !== actual.ino
    )
      throw failure();
    await verify();
    assert();
    await handle.utimes(new Date(accessedAt), new Date(modifiedAt));
  } finally {
    await handle.close();
  }
}
