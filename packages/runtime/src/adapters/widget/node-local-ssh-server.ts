import { spawn, type ChildProcess } from 'node:child_process';
import { generateKeyPairSync, timingSafeEqual } from 'node:crypto';
import {
  chmod,
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rename,
  rmdir,
  unlink,
  type FileHandle,
} from 'node:fs/promises';
import type { Dirent, Stats } from 'node:fs';
import { basename, dirname, isAbsolute, join, posix, relative, resolve, sep } from 'node:path';
import ssh2, { type Connection, type SFTPWrapper } from 'ssh2';
import { spawn as spawnPty, type IPty } from 'node-pty';
import type {
  LocalSshServerAdapter,
  LocalSshServerOptions,
  RunningWidgetServer,
} from '../../ports/widget-server';

export class NodeLocalSshServer implements LocalSshServerAdapter {
  async start(options: LocalSshServerOptions): Promise<RunningWidgetServer> {
    const rootPath = await realpath(options.rootPath);
    const clients = new Set<Connection>();
    const ptys = new Set<IPty>();
    const processes = new Set<ChildProcess>();
    // ssh2 1.17's OpenSSH Ed25519 writer intermittently emits a key that its own
    // parser rejects. Node's SEC1 P-256 export is deterministic for ssh2 and
    // remains an ephemeral, instance-owned host identity.
    const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const hostKey = privateKey.export({ type: 'sec1', format: 'pem' });
    const server = new Server({ hostKeys: [hostKey] }, (client) => {
      if (clients.size >= 16) {
        client.end();
        return;
      }
      clients.add(client);
      client.once('close', () => clients.delete(client));
      client.on('error', () => undefined);
      let attempts = 0;
      client.on('authentication', (context) => {
        attempts += 1;
        if (
          attempts <= 5 &&
          context.method === 'password' &&
          secureEqual(context.username, options.username) &&
          secureEqual(context.password, options.password)
        ) {
          context.accept();
          return;
        }
        context.reject(['password']);
      });
      client.on('ready', () => attachSessions(client, rootPath, ptys, processes));
    });
    server.maxConnections = 16;
    try {
      await new Promise<void>((resolveListen, rejectListen) => {
        const fail = (error: Error) => rejectListen(error);
        server.once('error', fail);
        server.listen(options.port, options.host, () => {
          server.off('error', fail);
          resolveListen();
        });
      });
    } catch (error) {
      server.close();
      throw error;
    }
    const address = server.address();
    if (!address || typeof address === 'string') {
      server.close();
      throw new Error('SSH Widget server did not bind TCP');
    }
    let closed: Promise<void> | undefined;
    return {
      host: options.host,
      port: address.port,
      url: `ssh://${printableHost(options.host)}:${address.port}`,
      stop: () => {
        closed ??= new Promise<void>((resolveClose) => {
          for (const terminal of ptys) terminal.kill();
          ptys.clear();
          for (const process of processes) process.kill('SIGTERM');
          processes.clear();
          for (const client of clients) client.end();
          const timer = setTimeout(() => {
            for (const client of clients) (client as Connection & { destroy(): void }).destroy();
          }, 1_000);
          timer.unref();
          server.close(() => {
            clearTimeout(timer);
            resolveClose();
          });
          if (!server.listening) {
            clearTimeout(timer);
            resolveClose();
          }
        });
        return closed;
      },
    };
  }
}

const { Server, utils } = ssh2;

function attachSessions(
  client: Connection,
  rootPath: string,
  ptys: Set<IPty>,
  processes: Set<ChildProcess>,
) {
  client.on('session', (accept) => {
    const session = accept();
    let columns = 80;
    let rows = 24;
    let terminal: IPty | undefined;
    session.on('pty', (acceptPty, _rejectPty, info) => {
      columns = info.cols || columns;
      rows = info.rows || rows;
      acceptPty?.();
    });
    session.on('window-change', (acceptChange, _rejectChange, info) => {
      terminal?.resize(Math.max(info.cols, 1), Math.max(info.rows, 1));
      acceptChange?.();
    });
    session.on('shell', (acceptShell) => {
      const stream = acceptShell();
      terminal = spawnPty(defaultShell(), [], {
        name: 'xterm-256color',
        cols: columns,
        rows,
        cwd: rootPath,
        env: process.env as Record<string, string>,
      });
      const owned = terminal;
      ptys.add(owned);
      const dataDisposable = owned.onData((data) => stream.write(data));
      const exitDisposable = owned.onExit(({ exitCode }) => {
        ptys.delete(owned);
        dataDisposable.dispose();
        stream.exit(exitCode || 0);
        stream.end();
      });
      stream.on('data', (data: Buffer) => owned.write(data.toString('utf8')));
      stream.once('close', () => {
        exitDisposable.dispose();
        if (ptys.delete(owned)) owned.kill();
      });
    });
    session.on('exec', (acceptExec, _rejectExec, info) => {
      const stream = acceptExec();
      const shell = defaultShell();
      const args =
        process.platform === 'win32' ? ['/d', '/s', '/c', info.command] : ['-lc', info.command];
      const child = spawn(shell, args, {
        cwd: rootPath,
        env: process.env,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      processes.add(child);
      child.stdout.pipe(stream);
      child.stderr.pipe(stream.stderr);
      stream.pipe(child.stdin);
      stream.once('close', () => child.kill('SIGTERM'));
      child.once('close', (code) => {
        processes.delete(child);
        stream.exit(code ?? 1);
        stream.end();
      });
      child.once('error', () => {
        processes.delete(child);
        stream.exit(1);
        stream.end();
      });
    });
    session.on('sftp', (acceptSftp) => attachSftp(acceptSftp(), rootPath));
  });
}

function attachSftp(sftp: SFTPWrapper, rootPath: string) {
  const { STATUS_CODE } = utils.sftp;
  const files = new Map<string, FileHandle>();
  const directories = new Map<string, { entries: Dirent<string>[]; path: string; sent: boolean }>();
  let handleSequence = 0;
  const handle = (prefix: string) => Buffer.from(`${prefix}-${++handleSequence}`);
  const fail = (requestId: number, error?: unknown) => {
    const code =
      error instanceof Error && 'code' in error && error.code === 'ENOENT'
        ? STATUS_CODE.NO_SUCH_FILE
        : error instanceof Error && 'code' in error && error.code === 'EACCES'
          ? STATUS_CODE.PERMISSION_DENIED
          : STATUS_CODE.FAILURE;
    sftp.status(requestId, code);
  };
  sftp.on('REALPATH', (requestId, path) => {
    void resolveExisting(rootPath, path)
      .then((resolved) =>
        sftp.name(requestId, [
          {
            filename: clientPath(rootPath, resolved),
            longname: '',
            attrs: { mode: 0, uid: 0, gid: 0, size: 0, atime: 0, mtime: 0 },
          },
        ]),
      )
      .catch((error) => fail(requestId, error));
  });
  sftp.on('STAT', (requestId, path) => {
    void resolveExisting(rootPath, path)
      .then((resolved) => lstat(resolved))
      .then((stats) => sftp.attrs(requestId, attributes(stats)))
      .catch((error) => fail(requestId, error));
  });
  sftp.on('LSTAT', (requestId, path) => {
    void resolveExisting(rootPath, path)
      .then((resolved) => lstat(resolved))
      .then((stats) => sftp.attrs(requestId, attributes(stats)))
      .catch((error) => fail(requestId, error));
  });
  sftp.on('OPENDIR', (requestId, path) => {
    if (directories.size >= 128) {
      fail(requestId);
      return;
    }
    void resolveExisting(rootPath, path)
      .then(async (resolved) => {
        const entries = await readdir(resolved, { withFileTypes: true });
        const value = handle('dir');
        directories.set(value.toString('hex'), { entries, path: resolved, sent: false });
        sftp.handle(requestId, value);
      })
      .catch((error) => fail(requestId, error));
  });
  sftp.on('READDIR', (requestId, value) => {
    const directory = directories.get(value.toString('hex'));
    if (!directory) return fail(requestId);
    if (directory.sent) {
      sftp.status(requestId, STATUS_CODE.EOF);
      return;
    }
    directory.sent = true;
    void Promise.all(
      directory.entries.slice(0, 10_000).map(async (entry) => {
        const stats = await lstat(join(directory.path, entry.name));
        return {
          filename: entry.name,
          longname: longName(entry.name, stats),
          attrs: attributes(stats),
        };
      }),
    )
      .then((entries) => sftp.name(requestId, entries))
      .catch((error) => fail(requestId, error));
  });
  sftp.on('OPEN', (requestId, path, flags) => {
    if (files.size >= 128) return fail(requestId);
    const openFlags = utils.sftp.flagsToString(flags);
    if (!openFlags) return fail(requestId);
    void resolveTarget(rootPath, path)
      .then((resolved) => open(resolved, openFlags))
      .then((file) => {
        const value = handle('file');
        files.set(value.toString('hex'), file);
        sftp.handle(requestId, value);
      })
      .catch((error) => fail(requestId, error));
  });
  sftp.on('READ', (requestId, value, offset, length) => {
    const file = files.get(value.toString('hex'));
    if (!file || length > 1024 * 1024) return fail(requestId);
    const buffer = Buffer.alloc(length);
    void file
      .read(buffer, 0, length, Number(offset))
      .then(({ bytesRead }) => {
        if (!bytesRead) sftp.status(requestId, STATUS_CODE.EOF);
        else sftp.data(requestId, buffer.subarray(0, bytesRead));
      })
      .catch((error) => fail(requestId, error));
  });
  sftp.on('WRITE', (requestId, value, offset, data) => {
    const file = files.get(value.toString('hex'));
    if (!file || data.length > 1024 * 1024) return fail(requestId);
    void file
      .write(data, 0, data.length, Number(offset))
      .then(() => sftp.status(requestId, STATUS_CODE.OK))
      .catch((error) => fail(requestId, error));
  });
  sftp.on('FSTAT', (requestId, value) => {
    const file = files.get(value.toString('hex'));
    if (!file) return fail(requestId);
    void file
      .stat()
      .then((stats) => sftp.attrs(requestId, attributes(stats)))
      .catch((error) => fail(requestId, error));
  });
  sftp.on('CLOSE', (requestId, value) => {
    const key = value.toString('hex');
    const file = files.get(key);
    files.delete(key);
    directories.delete(key);
    void (file ? file.close() : Promise.resolve())
      .then(() => sftp.status(requestId, STATUS_CODE.OK))
      .catch((error) => fail(requestId, error));
  });
  sftp.on('REMOVE', (requestId, path) => {
    void resolveExisting(rootPath, path)
      .then((resolved) => unlink(resolved))
      .then(() => sftp.status(requestId, STATUS_CODE.OK))
      .catch((error) => fail(requestId, error));
  });
  sftp.on('RENAME', (requestId, source, target) => {
    void Promise.all([resolveExisting(rootPath, source), resolveTarget(rootPath, target)])
      .then(([from, to]) => rename(from, to))
      .then(() => sftp.status(requestId, STATUS_CODE.OK))
      .catch((error) => fail(requestId, error));
  });
  sftp.on('MKDIR', (requestId, path) => {
    void resolveTarget(rootPath, path)
      .then((resolved) => mkdir(resolved))
      .then(() => sftp.status(requestId, STATUS_CODE.OK))
      .catch((error) => fail(requestId, error));
  });
  sftp.on('RMDIR', (requestId, path) => {
    void resolveExisting(rootPath, path)
      .then((resolved) => rmdir(resolved))
      .then(() => sftp.status(requestId, STATUS_CODE.OK))
      .catch((error) => fail(requestId, error));
  });
  sftp.on('SETSTAT', (requestId, path, attrs) => {
    if (attrs.mode === undefined) return sftp.status(requestId, STATUS_CODE.OP_UNSUPPORTED);
    void resolveExisting(rootPath, path)
      .then((resolved) => chmod(resolved, attrs.mode!))
      .then(() => sftp.status(requestId, STATUS_CODE.OK))
      .catch((error) => fail(requestId, error));
  });
  sftp.once('close', () => {
    void Promise.allSettled([...files.values()].map((file) => file.close()));
    files.clear();
    directories.clear();
  });
}

function lexicalPath(rootPath: string, path: string): string {
  if (path.includes('\0') || path.includes('\\')) throw accessError();
  const normalized = posix.normalize(`/${path || ''}`);
  const candidate = resolve(rootPath, `.${normalized}`);
  if (!isInside(rootPath, candidate)) throw accessError();
  return candidate;
}

async function resolveExisting(rootPath: string, path: string): Promise<string> {
  const candidate = await realpath(lexicalPath(rootPath, path));
  if (!isInside(rootPath, candidate)) throw accessError();
  return candidate;
}

async function resolveTarget(rootPath: string, path: string): Promise<string> {
  const candidate = lexicalPath(rootPath, path);
  try {
    return await resolveExisting(rootPath, path);
  } catch (error) {
    if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error;
    const parent = await realpath(dirname(candidate));
    if (!isInside(rootPath, parent)) throw accessError();
    return join(parent, basename(candidate));
  }
}

function isInside(rootPath: string, candidate: string): boolean {
  const value = relative(rootPath, candidate);
  return value === '' || (!value.startsWith(`..${sep}`) && value !== '..' && !isAbsolute(value));
}

function clientPath(rootPath: string, path: string): string {
  const value = relative(rootPath, path).split(sep).join('/');
  return value ? `/${value}` : '/';
}

function attributes(stats: Stats) {
  return {
    mode: Number(stats.mode),
    uid: Number(stats.uid),
    gid: Number(stats.gid),
    size: Number(stats.size),
    atime: Math.floor(stats.atimeMs / 1_000),
    mtime: Math.floor(stats.mtimeMs / 1_000),
  };
}

function longName(name: string, stats: Stats): string {
  const type = stats.isDirectory() ? 'd' : stats.isSymbolicLink() ? 'l' : '-';
  const bits = [0o400, 0o200, 0o100, 0o040, 0o020, 0o010, 0o004, 0o002, 0o001]
    .map((bit, index) => (stats.mode & bit ? 'rwx'[index % 3] : '-'))
    .join('');
  return `${type}${bits} 1 ${stats.uid} ${stats.gid} ${stats.size} ${name}`;
}

function accessError(): Error & { code: string } {
  return Object.assign(new Error('Path escapes the granted root'), { code: 'EACCES' });
}

function secureEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

function printableHost(host: string): string {
  return host.includes(':') ? `[${host}]` : host;
}

function defaultShell(): string {
  return process.platform === 'win32'
    ? process.env.COMSPEC || 'powershell.exe'
    : process.env.SHELL || '/bin/sh';
}
