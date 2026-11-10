// Retained first-party Axterm protocol adapter; ownership adaptation is recorded in ADR-141.
import { generateKeyPairSync, timingSafeEqual } from 'node:crypto';
import { createServer, type Socket } from 'node:net';
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
import type {
  SubprocessService,
  SubprocessHandle,
  SubprocessTerminalHandle,
} from '@axterm/plugin-api/host';
import type {
  LocalSshServerAdapter,
  LocalSshServerOptions,
  RunningWidgetServer,
} from '../../ports/widgets.ts';

export class NodeLocalSshServer implements LocalSshServerAdapter {
  constructor(private readonly subprocess: SubprocessService) {}
  async start(options: LocalSshServerOptions): Promise<RunningWidgetServer> {
    await options.assertAuthority?.();
    const rootPath = await realpath(options.rootPath),
      clients = new Set<Connection>(),
      tasks = new Set<Promise<unknown>>(),
      ptys = new Set<SubprocessTerminalHandle>(),
      processes = new Set<SubprocessHandle>();
    const lifetime = new AbortController();
    const environment = await this.subprocess.terminalEnvironment(lifetime.signal);
    const shell =
      environment.defaultShell ?? (environment.platform === 'windows' ? 'cmd.exe' : '/bin/sh');
    let active = 0;
    const track = (operation: () => Promise<void>) => {
      if (lifetime.signal.aborted || active >= 32) throw new Error('WIDGET_CAPACITY');
      active++;
      const task = Promise.resolve()
        .then(operation)
        .finally(() => {
          active--;
        });
      tasks.add(task);
      void task.then(
        () => tasks.delete(task),
        () => tasks.delete(task),
      );
      return task;
    };
    const assertAuthority = async () => {
      lifetime.signal.throwIfAborted();
      await options.assertAuthority?.();
    };
    const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const server = new Server(
      { hostKeys: [privateKey.export({ type: 'sec1', format: 'pem' })] },
      (client) => {
        if (lifetime.signal.aborted || clients.size >= 16) {
          client.end();
          return;
        }
        clients.add(client);
        client.once('close', () => clients.delete(client));
        client.on('error', () => undefined);
        let attempts = 0;
        client.on('authentication', (context) => {
          if (
            ++attempts <= 5 &&
            context.method === 'password' &&
            secureEqual(context.username, options.username) &&
            secureEqual(context.password, options.password)
          )
            context.accept();
          else context.reject(['password']);
        });
        client.on('ready', () =>
          client.on('session', (accept) => {
            const session = accept();
            let cols = 80,
              rows = 24,
              terminal: SubprocessTerminalHandle | undefined;
            let resizing: Promise<void> | undefined;
            const resize = () => {
              if (!terminal || resizing) return;
              const owned = terminal;
              resizing = (async () => {
                let appliedCols = 0,
                  appliedRows = 0;
                while (terminal === owned && (appliedCols !== cols || appliedRows !== rows)) {
                  appliedCols = cols;
                  appliedRows = rows;
                  await owned.resize(appliedCols, appliedRows);
                }
              })()
                .catch(() => {
                  client.end();
                })
                .finally(() => {
                  if (resizing) tasks.delete(resizing);
                  resizing = undefined;
                });
              tasks.add(resizing);
            };
            session.on('pty', (acceptPty, _reject, info) => {
              cols = Math.max(1, info.cols || 80);
              rows = Math.max(1, info.rows || 24);
              acceptPty?.();
            });
            session.on('window-change', (acceptChange, _reject, info) => {
              cols = Math.max(1, info.cols);
              rows = Math.max(1, info.rows);
              resize();
              acceptChange?.();
            });
            session.on('shell', (acceptShell, rejectShell) => {
              if (active >= 32 || lifetime.signal.aborted) {
                rejectShell();
                return;
              }
              const stream = acceptShell();
              void track(async () => {
                await assertAuthority();
                const owned = await this.subprocess.spawnTerminal({
                  argv: [shell],
                  cwd: rootPath,
                  cols,
                  rows,
                  terminalType: 'xterm-256color',
                  graceMs: 1000,
                  signal: lifetime.signal,
                });
                terminal = owned;
                ptys.add(owned);
                try {
                  if (stream.destroyed || lifetime.signal.aborted) return;
                  owned.output.pipe(stream, { end: false });
                  const input = (data: Buffer) => {
                    stream.pause();
                    void owned.write(data).then(
                      () => stream.resume(),
                      () => stream.destroy(),
                    );
                  };
                  stream.on('data', input);
                  stream.once('close', () => {
                    void owned.terminate().catch(() => undefined);
                  });
                  const outcome = await owned.done;
                  stream.off('data', input);
                  stream.exit(outcome.exitCode ?? 1);
                  stream.end();
                } finally {
                  await owned.terminate();
                  ptys.delete(owned);
                  terminal = undefined;
                }
              }).catch(() => {
                stream.exit(1);
                stream.end();
              });
            });
            session.on('exec', (acceptExec, rejectExec, info) => {
              if (active >= 32 || lifetime.signal.aborted) {
                rejectExec();
                return;
              }
              const stream = acceptExec();
              void track(async () => {
                await assertAuthority();
                const args =
                  environment.platform === 'windows'
                    ? ['/d', '/s', '/c', info.command]
                    : ['-lc', info.command];
                const child = this.subprocess.spawn({
                  argv: [shell, ...args],
                  cwd: rootPath,
                  stdio: { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' },
                  graceMs: 1000,
                  signal: lifetime.signal,
                });
                processes.add(child);
                try {
                  child.stdout?.pipe(stream, { end: false });
                  child.stderr?.pipe(stream.stderr, { end: false });
                  if (child.stdin) stream.pipe(child.stdin);
                  stream.once('close', () => child.terminate());
                  const outcome = await child.done;
                  stream.exit(outcome.exitCode ?? 1);
                  stream.end();
                } finally {
                  await child.dispose();
                  processes.delete(child);
                }
              }).catch(() => {
                stream.exit(1);
                stream.end();
              });
            });
            session.on('sftp', (acceptSftp) =>
              attachSftp(acceptSftp(), rootPath, tasks, assertAuthority),
            );
          }),
        );
      },
    );
    const sockets = new Set<Socket>();
    const transport = createServer((socket) => {
      sockets.add(socket);
      socket.once('close', () => sockets.delete(socket));
      socket.on('error', () => undefined);
      server.injectSocket(socket);
    });
    transport.maxConnections = 16;
    try {
      await new Promise<void>((resolveListen, reject) => {
        transport.once('error', reject);
        transport.listen(options.port, options.host, () => {
          transport.off('error', reject);
          resolveListen();
        });
      });
    } catch (error) {
      transport.close();
      throw error;
    }
    const address = transport.address();
    if (!address || typeof address === 'string') {
      transport.close();
      throw new Error('WIDGET_BIND_FAILED');
    }
    let closed: Promise<void> | undefined;
    return {
      host: options.host,
      port: address.port,
      url: `ssh://${printableHost(options.host)}:${address.port}`,
      stop: () =>
        (closed ??= (async () => {
          lifetime.abort();
          for (const child of processes) child.terminate();
          const terminals = [...ptys].map((terminal) => terminal.terminate());
          for (const socket of sockets) socket.destroy();
          await new Promise<void>((resolveClose) => transport.close(() => resolveClose()));
          await Promise.allSettled(terminals);
          while (tasks.size) await Promise.allSettled([...tasks]);
        })()),
    };
  }
}
const { Server, utils } = ssh2;

function attachSftp(
  sftp: SFTPWrapper,
  rootPath: string,
  tasks: Set<Promise<unknown>>,
  assertAuthority: () => Promise<void>,
) {
  let closed = false;
  const pending = new Set<Promise<unknown>>();
  const track = (operation: () => Promise<unknown>) => {
    if (closed || pending.size >= 64) {
      sftp.end();
      return;
    }
    const task = Promise.resolve().then(async () => {
      if (closed) throw accessError();
      await assertAuthority();
      return operation();
    });
    pending.add(task);
    tasks.add(task);
    void task.then(
      () => {
        pending.delete(task);
        tasks.delete(task);
      },
      () => {
        pending.delete(task);
        tasks.delete(task);
      },
    );
  };
  // Runtime file operations wait for the peer's EOF before returning REST
  // results. A client ending a subsystem must not leave its response pending.
  sftp.once('end', () => sftp.end());
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
    track(() =>
      resolveExisting(rootPath, path)
        .then((resolved) =>
          sftp.name(requestId, [
            {
              filename: clientPath(rootPath, resolved),
              longname: '',
              attrs: { mode: 0, uid: 0, gid: 0, size: 0, atime: 0, mtime: 0 },
            },
          ]),
        )
        .catch((error) => fail(requestId, error)),
    );
  });
  sftp.on('STAT', (requestId, path) => {
    track(() =>
      resolveExisting(rootPath, path)
        .then((resolved) => lstat(resolved))
        .then((stats) => sftp.attrs(requestId, attributes(stats)))
        .catch((error) => fail(requestId, error)),
    );
  });
  sftp.on('LSTAT', (requestId, path) => {
    track(() =>
      resolveExisting(rootPath, path)
        .then((resolved) => lstat(resolved))
        .then((stats) => sftp.attrs(requestId, attributes(stats)))
        .catch((error) => fail(requestId, error)),
    );
  });
  sftp.on('OPENDIR', (requestId, path) => {
    if (directories.size + pending.size >= 128) {
      fail(requestId);
      return;
    }
    track(() =>
      resolveExisting(rootPath, path)
        .then(async (resolved) => {
          const entries = await readdir(resolved, { withFileTypes: true });
          const value = handle('dir');
          directories.set(value.toString('hex'), { entries, path: resolved, sent: false });
          sftp.handle(requestId, value);
        })
        .catch((error) => fail(requestId, error)),
    );
  });
  sftp.on('READDIR', (requestId, value) => {
    const directory = directories.get(value.toString('hex'));
    if (!directory) return fail(requestId);
    if (directory.sent) {
      sftp.status(requestId, STATUS_CODE.EOF);
      return;
    }
    directory.sent = true;
    track(() =>
      Promise.all(
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
        .catch((error) => fail(requestId, error)),
    );
  });
  sftp.on('OPEN', (requestId, path, flags) => {
    if (files.size + pending.size >= 128) return fail(requestId);
    const openFlags = utils.sftp.flagsToString(flags);
    if (!openFlags) return fail(requestId);
    track(() =>
      resolveTarget(rootPath, path)
        .then((resolved) => open(resolved, openFlags))
        .then((file) => {
          const value = handle('file');
          files.set(value.toString('hex'), file);
          sftp.handle(requestId, value);
        })
        .catch((error) => fail(requestId, error)),
    );
  });
  sftp.on('READ', (requestId, value, offset, length) => {
    const file = files.get(value.toString('hex'));
    if (!file || length > 1024 * 1024) return fail(requestId);
    const buffer = Buffer.alloc(length);
    track(() =>
      file
        .read(buffer, 0, length, Number(offset))
        .then(({ bytesRead }) => {
          if (!bytesRead) sftp.status(requestId, STATUS_CODE.EOF);
          else sftp.data(requestId, buffer.subarray(0, bytesRead));
        })
        .catch((error) => fail(requestId, error)),
    );
  });
  sftp.on('WRITE', (requestId, value, offset, data) => {
    const file = files.get(value.toString('hex'));
    if (!file || data.length > 1024 * 1024) return fail(requestId);
    track(() =>
      file
        .write(data, 0, data.length, Number(offset))
        .then(() => sftp.status(requestId, STATUS_CODE.OK))
        .catch((error) => fail(requestId, error)),
    );
  });
  sftp.on('FSTAT', (requestId, value) => {
    const file = files.get(value.toString('hex'));
    if (!file) return fail(requestId);
    track(() =>
      file
        .stat()
        .then((stats) => sftp.attrs(requestId, attributes(stats)))
        .catch((error) => fail(requestId, error)),
    );
  });
  sftp.on('CLOSE', (requestId, value) => {
    const key = value.toString('hex');
    const file = files.get(key);
    files.delete(key);
    directories.delete(key);
    track(() =>
      (file ? file.close() : Promise.resolve())
        .then(() => sftp.status(requestId, STATUS_CODE.OK))
        .catch((error) => fail(requestId, error)),
    );
  });
  sftp.on('REMOVE', (requestId, path) => {
    track(() =>
      resolveExisting(rootPath, path)
        .then((resolved) => unlink(resolved))
        .then(() => sftp.status(requestId, STATUS_CODE.OK))
        .catch((error) => fail(requestId, error)),
    );
  });
  sftp.on('RENAME', (requestId, source, target) => {
    track(() =>
      Promise.all([resolveExisting(rootPath, source), resolveTarget(rootPath, target)])
        .then(([from, to]) => rename(from, to))
        .then(() => sftp.status(requestId, STATUS_CODE.OK))
        .catch((error) => fail(requestId, error)),
    );
  });
  sftp.on('MKDIR', (requestId, path) => {
    track(() =>
      resolveTarget(rootPath, path)
        .then((resolved) => mkdir(resolved))
        .then(() => sftp.status(requestId, STATUS_CODE.OK))
        .catch((error) => fail(requestId, error)),
    );
  });
  sftp.on('RMDIR', (requestId, path) => {
    track(() =>
      resolveExisting(rootPath, path)
        .then((resolved) => rmdir(resolved))
        .then(() => sftp.status(requestId, STATUS_CODE.OK))
        .catch((error) => fail(requestId, error)),
    );
  });
  sftp.on('SETSTAT', (requestId, path, attrs) => {
    if (attrs.mode === undefined) return sftp.status(requestId, STATUS_CODE.OP_UNSUPPORTED);
    track(() =>
      resolveExisting(rootPath, path)
        .then((resolved) => chmod(resolved, attrs.mode!))
        .then(() => sftp.status(requestId, STATUS_CODE.OK))
        .catch((error) => fail(requestId, error)),
    );
  });
  sftp.once('close', () => {
    closed = true;
    const cleanup = Promise.allSettled([...pending]).then(async () => {
      await Promise.allSettled([...files.values()].map((file) => file.close()));
      files.clear();
      directories.clear();
    });
    tasks.add(cleanup);
    void cleanup.then(() => tasks.delete(cleanup));
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
