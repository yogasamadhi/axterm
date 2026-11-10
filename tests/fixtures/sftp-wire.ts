import { randomUUID } from 'node:crypto';
import type { Stats } from 'node:fs';
import {
  chmod,
  lstat,
  mkdir,
  open,
  readdir,
  rename,
  rmdir,
  stat,
  unlink,
  type FileHandle,
} from 'node:fs/promises';
import { posix, resolve, sep } from 'node:path';
import type { Attributes, SFTPWrapper } from 'ssh2';

/** Real wire fixture, confined to its caller's disposable directory. No production adapter. */
export function installSftpWire(
  sftp: SFTPWrapper,
  root: string,
  options: { atomicReplace?: boolean } = {},
) {
  // Test-only wire server: ssh2 v3 omits extensions from VERSION. Advertise only the
  // POSIX rename operation implemented below; production/vendor code is untouched.
  if (options.atomicReplace) {
    const wire = sftp as unknown as {
      _protocol: { channelData(id: number, payload: Buffer): void };
      outgoing: { id: number; window: number };
    };
    const protocol = wire._protocol;
    wire._protocol = new Proxy(protocol, {
      get(target, key) {
        const member = Reflect.get(target, key);
        if (key !== 'channelData')
          return typeof member === 'function' ? member.bind(target) : member;
        return (id: number, payload: Buffer) => {
          if (
            id === wire.outgoing.id &&
            payload.length === 9 &&
            payload.readUInt32BE(0) === 5 &&
            payload[4] === 2
          ) {
            const name = Buffer.from('posix-rename@openssh.com'),
              value = Buffer.from('1'),
              prefix = Buffer.alloc(4),
              nameLength = Buffer.alloc(4),
              valueLength = Buffer.alloc(4);
            nameLength.writeUInt32BE(name.length);
            valueLength.writeUInt32BE(value.length);
            const body = Buffer.concat([payload.subarray(4), nameLength, name, valueLength, value]);
            prefix.writeUInt32BE(body.length);
            wire.outgoing.window -= body.length - 5;
            return protocol.channelData(id, Buffer.concat([prefix, body]));
          }
          return protocol.channelData(id, payload);
        };
      },
    });
  }
  type Handle = { file: FileHandle } | { path: string; entries: string[]; offset: number };
  const handles = new Map<string, Handle>();
  const pending = new Set<Promise<unknown>>();
  let requests = 0;
  let closing = false;
  const drained = Promise.withResolvers<void>();
  const local = (path: string) => {
    const normalized = posix.resolve('/', path);
    const result = resolve(root, '.' + normalized);
    if (result !== resolve(root) && !result.startsWith(resolve(root) + sep))
      throw new Error('Fixture path escaped');
    return result;
  };
  const attrs = (value: Stats): Attributes => ({
    size: value.size,
    mode: value.mode,
    uid: value.uid,
    gid: value.gid,
    atime: Math.floor(value.atimeMs / 1000),
    mtime: Math.floor(value.mtimeMs / 1000),
  });
  const failure = (id: number, error: unknown) => {
    const code = error instanceof Error && 'code' in error ? String(error.code) : '';
    sftp.status(id, code === 'ENOENT' ? 2 : code === 'EACCES' ? 3 : code === 'EEXIST' ? 11 : 4);
  };
  const task = (id: number, perform: () => Promise<void>) => {
    requests++;
    const done = Promise.resolve()
      .then(perform)
      .catch((error) => {
        if (!closing) failure(id, error);
      });
    pending.add(done);
    void done.finally(() => pending.delete(done));
  };
  const requireHandle = (raw: Buffer) => {
    const found = handles.get(raw.toString());
    if (!found) throw new Error('Unknown fixture handle');
    return found;
  };
  const issue = (id: number, handle: Handle) => {
    const key = randomUUID();
    handles.set(key, handle);
    sftp.handle(id, Buffer.from(key));
  };
  sftp.on('error', () => {});
  sftp.on('REALPATH', (id, path) =>
    task(id, async () => {
      sftp.name(id, [
        { filename: posix.resolve('/', path), longname: '', attrs: attrs(await stat(local(path))) },
      ]);
    }),
  );
  sftp.on('STAT', (id, path) =>
    task(id, async () => {
      sftp.attrs(id, attrs(await stat(local(path))));
    }),
  );
  sftp.on('LSTAT', (id, path) =>
    task(id, async () => {
      sftp.attrs(id, attrs(await lstat(local(path))));
    }),
  );
  sftp.on('OPENDIR', (id, path) =>
    task(id, async () => {
      issue(id, { path: local(path), entries: await readdir(local(path)), offset: 0 });
    }),
  );
  sftp.on('READDIR', (id, raw) =>
    task(id, async () => {
      const handle = requireHandle(raw);
      if ('file' in handle) throw new Error('Not a directory');
      const names = handle.entries.slice(handle.offset, handle.offset + 64);
      handle.offset += names.length;
      if (!names.length) {
        sftp.status(id, 1);
        return;
      }
      sftp.name(
        id,
        await Promise.all(
          names.map(async (filename) => ({
            filename,
            longname: '',
            attrs: attrs(await lstat(resolve(handle.path, filename))),
          })),
        ),
      );
    }),
  );
  sftp.on('OPEN', (id, path, flags, metadata) =>
    task(id, async () => {
      // SFTP v3 SSH_FXF_READ=1, WRITE=2, APPEND=4, CREAT=8, TRUNC=16, EXCL=32.
      const writing = !!(flags & 2);
      const mode = !writing ? 'r' : flags & 32 ? 'wx' : flags & 4 ? 'a' : flags & 16 ? 'w' : 'r+';
      issue(id, { file: await open(local(path), mode, metadata.mode ?? 0o600) });
    }),
  );
  sftp.on('READ', (id, raw, offset, length) =>
    task(id, async () => {
      const handle = requireHandle(raw);
      if (!('file' in handle)) throw new Error('Not a file');
      const bytes = Buffer.alloc(Math.min(length, 64 * 1024));
      const result = await handle.file.read(bytes, 0, bytes.length, offset);
      if (!result.bytesRead) sftp.status(id, 1);
      else sftp.data(id, bytes.subarray(0, result.bytesRead));
    }),
  );
  sftp.on('WRITE', (id, raw, offset, bytes) =>
    task(id, async () => {
      const handle = requireHandle(raw);
      if (!('file' in handle)) throw new Error('Not a file');
      let written = 0;
      while (written < bytes.length) {
        const result = await handle.file.write(
          bytes,
          written,
          bytes.length - written,
          offset + written,
        );
        if (!result.bytesWritten) throw new Error('Short fixture write');
        written += result.bytesWritten;
      }
      sftp.status(id, 0);
    }),
  );
  sftp.on('FSTAT', (id, raw) =>
    task(id, async () => {
      const handle = requireHandle(raw);
      sftp.attrs(id, attrs('file' in handle ? await handle.file.stat() : await stat(handle.path)));
    }),
  );
  sftp.on('FSETSTAT', (id, raw, metadata) =>
    task(id, async () => {
      const handle = requireHandle(raw);
      if (!('file' in handle) || metadata.mode === undefined)
        throw new Error('Invalid fixture fchmod');
      await handle.file.chmod(metadata.mode);
      sftp.status(id, 0);
    }),
  );
  sftp.on('CLOSE', (id, raw) =>
    task(id, async () => {
      const handle = requireHandle(raw);
      if ('file' in handle) await handle.file.close();
      handles.delete(raw.toString());
      sftp.status(id, 0);
    }),
  );
  sftp.on('MKDIR', (id, path, metadata) =>
    task(id, async () => {
      await mkdir(local(path), { mode: metadata.mode ?? 0o700 });
      sftp.status(id, 0);
    }),
  );
  sftp.on('REMOVE', (id, path) =>
    task(id, async () => {
      await unlink(local(path));
      sftp.status(id, 0);
    }),
  );
  sftp.on('RMDIR', (id, path) =>
    task(id, async () => {
      await rmdir(local(path));
      sftp.status(id, 0);
    }),
  );
  sftp.on('RENAME', (id, from, to) =>
    task(id, async () => {
      await rename(local(from), local(to));
      sftp.status(id, 0);
    }),
  );
  sftp.on('SETSTAT', (id, path, metadata) =>
    task(id, async () => {
      if (metadata.mode === undefined) throw new Error('Unsupported fixture metadata');
      await chmod(local(path), metadata.mode);
      sftp.status(id, 0);
    }),
  );
  sftp.on('EXTENDED', (id: number, name: string, bytes: Buffer) => {
    if (!options.atomicReplace || name !== 'posix-rename@openssh.com') {
      sftp.status(id, 8);
      return;
    }
    task(id, async () => {
      let offset = 0;
      const path = () => {
        if (!bytes || offset + 4 > bytes.length) throw Error('Malformed fixture request');
        const length = bytes.readUInt32BE(offset);
        offset += 4;
        if (!length || length > 16384 || offset + length > bytes.length)
          throw Error('Invalid fixture path');
        const result = new TextDecoder('utf-8', { fatal: true }).decode(
          bytes.subarray(offset, offset + length),
        );
        offset += length;
        return local(result);
      };
      const from = path(),
        to = path();
      if (offset !== bytes.length) throw Error('Unexpected fixture bytes');
      await rename(from, to);
      sftp.status(id, 0);
    });
  });
  sftp.once('close', () => {
    sftp.end(); // Explicit SFTP channel-close acknowledgement; ssh2's server does not send it automatically.
    closing = true;
    void (async () => {
      await Promise.allSettled([...pending]);
      await Promise.allSettled(
        [...handles.values()].map((handle) =>
          'file' in handle ? handle.file.close() : Promise.resolve(),
        ),
      );
      handles.clear();
      drained.resolve();
    })();
  });
  return {
    closed: drained.promise,
    resourceCount: () => handles.size + pending.size,
    requestCount: () => requests,
  };
}
