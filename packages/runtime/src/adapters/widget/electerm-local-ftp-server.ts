import { timingSafeEqual } from 'node:crypto';
import { existsSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, posix, relative, resolve, sep } from 'node:path';
import FtpServer, { FileSystem } from '@electerm/ftp-srv';
import type {
  LocalFtpServerAdapter,
  LocalFtpServerOptions,
  RunningWidgetServer,
} from '../../ports/widget-server';

const quietLogger = {
  child: () => quietLogger,
  trace() {},
  debug() {},
  info() {},
  warn() {},
  error() {},
  fatal() {},
};

export class ElectermLocalFtpServer implements LocalFtpServerAdapter {
  async start(options: LocalFtpServerOptions): Promise<RunningWidgetServer> {
    const bindUrl = `ftp://${printableHost(options.host)}:${options.port}`;
    const server = new FtpServer({
      url: bindUrl,
      root: options.rootPath,
      anonymous: options.anonymous,
      pasv_min: options.passivePortStart,
      pasv_max: options.passivePortEnd,
      timeout: 30_000,
      endOnProcessSignal: false,
      log: quietLogger,
    });
    server.on('login', (data, resolveLogin, rejectLogin) => {
      if (options.anonymous) {
        resolveLogin({ fs: new ScopedFtpFileSystem(data.connection, options.rootPath) });
        return;
      }
      if (
        secureEqual(data.username, options.username) &&
        options.password !== undefined &&
        secureEqual(data.password, options.password)
      ) {
        resolveLogin({ fs: new ScopedFtpFileSystem(data.connection, options.rootPath) });
        return;
      }
      rejectLogin(new Error('Invalid username or password'));
    });
    try {
      await server.listen();
    } catch (error) {
      await server.close().catch(() => undefined);
      throw error;
    }
    server.server.maxConnections = 16;
    const address = server.server.address();
    if (!address || typeof address === 'string') {
      await server.close();
      throw new Error('FTP Widget server did not bind TCP');
    }
    const port = address.port;
    let closed: Promise<void> | undefined;
    return {
      host: options.host,
      port,
      url: `ftp://${printableHost(options.host)}:${port}`,
      stop: () => {
        closed ??= server.close();
        return closed;
      },
    };
  }
}

class ScopedFtpFileSystem extends FileSystem {
  constructor(connection: ConstructorParameters<typeof FileSystem>[0], rootPath: string) {
    super(connection, { root: realpathSync(rootPath) });
  }

  protected override _resolvePath(file = '.') {
    if (file.length > 4_096 || file.includes('\0') || file.includes('\\'))
      throw new Error('Path is outside the granted root');
    const portable = file.replaceAll('\\', '/');
    const clientPath = posix.isAbsolute(portable)
      ? posix.normalize(portable)
      : posix.join('/', this.cwd.replaceAll('\\', '/'), portable);
    const candidate = resolve(this.root, `.${clientPath}`);
    if (!isInside(this.root, candidate)) throw new Error('Path is outside the granted root');
    let existing = candidate;
    while (!existsSync(existing) && existing !== this.root) existing = dirname(existing);
    const resolvedAncestor = realpathSync(existing);
    if (!isInside(this.root, resolvedAncestor)) throw new Error('Path is outside the granted root');
    const fsPath = existsSync(candidate)
      ? realpathSync(candidate)
      : join(resolvedAncestor, relative(existing, candidate));
    if (!isInside(this.root, fsPath)) throw new Error('Path is outside the granted root');
    return { clientPath, fsPath };
  }
}

function isInside(rootPath: string, candidate: string): boolean {
  const value = relative(rootPath, candidate);
  return value === '' || (!value.startsWith(`..${sep}`) && value !== '..' && !isAbsolute(value));
}

function printableHost(host: string): string {
  return host.includes(':') ? `[${host}]` : host;
}

function secureEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}
