import { posix } from 'node:path';
import { Readable, Writable } from 'node:stream';
import type {
  RemoteFilesystem,
  RemoteFileAttributes,
  RemoteFileLease,
  ConnectionsApplication,
} from '@axterm/plugin-api/host';
const attributes = (directory: boolean, size = 0): RemoteFileAttributes => ({
  size,
  mode: directory ? 0o40700 : 0o100600,
  atime: 0,
  mtime: 0,
  uid: 0,
  gid: 0,
  isFile: !directory,
  isDirectory: directory,
  isSymbolicLink: false,
});
const missing = () => Object.assign(new Error('missing'), { code: 2 });
export function memoryTransferFiles(initial: Record<string, string> = {}) {
  const files = new Map(Object.entries(initial).map(([path, text]) => [path, Buffer.from(text)]));
  const directories = new Set(['/']);
  for (const path of files.keys()) {
    let parent = posix.dirname(path);
    while (!directories.has(parent)) {
      directories.add(parent);
      parent = posix.dirname(parent);
    }
  }
  let channelCount = 0;
  let opened = 0;
  let closed = 0;
  let ready = true;
  const leases = new Set<AbortController>();
  let transform: ((bytes: Buffer, done: (error?: Error | null) => void) => void) | undefined;
  const native: RemoteFilesystem = {
    realpath: async () => '/test',
    stat: async (path) => {
      if (directories.has(path)) return attributes(true);
      const bytes = files.get(path);
      if (!bytes) throw missing();
      return attributes(false, bytes.length);
    },
    lstat: async (path) => native.stat(path),
    list: async (path) => {
      if (!directories.has(path)) throw missing();
      return [...files.entries()]
        .filter(([name]) => posix.dirname(name) === path)
        .map(([name, bytes]) => ({
          filename: posix.basename(name),
          attrs: attributes(false, bytes.length),
        }))
        .concat(
          [...directories]
            .filter((name) => name !== path && posix.dirname(name) === path)
            .map((name) => ({ filename: posix.basename(name), attrs: attributes(true) })),
        );
    },
    mkdir: async (path) => {
      directories.add(path);
    },
    rename: async (from, to) => {
      if (files.has(to) || directories.has(to))
        throw Object.assign(new Error('exists'), { code: 11 });
      if (directories.has(from)) {
        for (const path of [...directories])
          if (path === from || path.startsWith(from + '/')) {
            directories.delete(path);
            directories.add(to + path.slice(from.length));
          }
        for (const [path, value] of [...files])
          if (path.startsWith(from + '/')) {
            files.delete(path);
            files.set(to + path.slice(from.length), value);
          }
        return;
      }
      const value = files.get(from);
      if (value === undefined) throw missing();
      files.set(to, value);
      files.delete(from);
    },
    replace: async (from, to) => {
      const value = files.get(from);
      if (value === undefined) throw missing();
      files.set(to, value);
      files.delete(from);
    },
    unlink: async (path) => {
      if (!files.delete(path)) throw missing();
    },
    rmdir: async (path) => {
      directories.delete(path);
    },
    chmod: async () => {},
    readStream: (path) => {
      const bytes = files.get(path);
      if (bytes === undefined) throw missing();
      return Readable.from(
        (function* () {
          for (let offset = 0; offset < bytes.length; offset += 64 * 1024)
            yield bytes.subarray(offset, offset + 64 * 1024);
        })(),
      );
    },
    writeStream: (path, options) => {
      const chunks: Buffer[] = [];
      if (options?.flags === 'wx' && files.has(path))
        throw Object.assign(new Error('exists'), { code: 11 });
      return new Writable({
        highWaterMark: 64 * 1024,
        write(chunk: Buffer, _encoding, done) {
          chunks.push(Buffer.from(chunk));
          if (transform) transform(chunk, done);
          else done();
        },
        final(done) {
          files.set(path, Buffer.concat(chunks));
          done();
        },
      });
    },
    close: async () => {},
  };
  const connection = {
    get: () => ({ state: ready ? 'ready' : 'closed' }),
    getFtp: () => ({ state: ready ? 'ready' : 'closed' }),
    openFiles: async (_target: unknown, signal?: AbortSignal): Promise<RemoteFileLease> => {
      if (!ready) throw new Error('connection unavailable');
      signal?.throwIfAborted();
      channelCount++;
      opened++;
      const abort = new AbortController();
      leases.add(abort);
      let live = true;
      return {
        filesystem: native,
        signal: AbortSignal.any([abort.signal, ...(signal ? [signal] : [])]),
        close: async () => {
          if (live) {
            live = false;
            channelCount--;
            closed++;
            leases.delete(abort);
            abort.abort();
          }
        },
      };
    },
  } as unknown as ConnectionsApplication;
  return {
    files,
    directories,
    native,
    connection,
    counts: () => ({ active: channelCount, opened, closed }),
    delay: (next: typeof transform) => {
      transform = next;
    },
    disconnect: () => {
      ready = false;
      for (const lease of leases) lease.abort();
    },
    reconnect: () => {
      ready = true;
    },
  };
}
