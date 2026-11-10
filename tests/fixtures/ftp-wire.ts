import { once } from 'node:events';
import { createServer, type Server, type Socket } from 'node:net';
import { posix } from 'node:path';
import { TLSSocket } from 'node:tls';
import { getFtpTestSecureContext } from './ftp-test-certificate.ts';

export async function startFtpFixture(
  options: {
    security?: 'plain' | 'explicit-tls' | 'implicit-tls';
    listing?: string;
    username?: string;
    password?: string;
    initialFiles?: Record<string, string>;
    allowReplace?: boolean;
  } = {},
): Promise<{
  port: number;
  files: Map<string, Buffer>;
  close(): Promise<void>;
}> {
  const files = new Map<string, Buffer>(
    Object.entries(options.initialFiles ?? { '/hello.txt': 'hello' }).map(([path, value]) => [
      path,
      Buffer.from(value),
    ]),
  );
  const directories = new Set(['/']);
  for (const path of files.keys()) {
    let directory = posix.dirname(path);
    while (!directories.has(directory)) {
      directories.add(directory);
      directory = posix.dirname(directory);
    }
  }
  const dataServers = new Set<Server>();
  const controlSockets = new Set<Socket>();
  const dataSockets = new Set<Socket>();
  const secureContext =
    options.security && options.security !== 'plain' ? await getFtpTestSecureContext() : undefined;
  const server = createServer((raw) => {
    let socket =
      options.security === 'implicit-tls'
        ? new TLSSocket(raw, { isServer: true, ...(secureContext ? { secureContext } : {}) })
        : raw;
    controlSockets.add(socket);
    socket.on('close', () => controlSockets.delete(socket));
    socket.on('error', (error: NodeJS.ErrnoException) => {
      // The real client may close immediately after QUIT, before this fixture's
      // reply is flushed. Keep that expected disconnect from escaping Vitest.
      if (error.code !== 'EPIPE' && error.code !== 'ECONNRESET') throw error;
    });
    socket.write('220 Axterm FTP fixture\r\n');
    let buffer = '';
    let chain = Promise.resolve();
    let renameFrom: string | null = null;
    let passive: Promise<Socket> | undefined;
    let cwd = '/';
    let restart = 0;
    let username = '';
    let authenticated = false;
    const receive = (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      while (buffer.includes('\r\n')) {
        const offset = buffer.indexOf('\r\n');
        const line = buffer.slice(0, offset);
        buffer = buffer.slice(offset + 2);
        chain = chain
          .then(() => respond(line))
          .catch(() => {
            socket.destroy();
          });
      }
    };
    socket.on('data', receive);
    async function respond(line: string) {
      const separator = line.indexOf(' ');
      const command = (separator < 0 ? line : line.slice(0, separator)).toUpperCase();
      const argument = separator < 0 ? '' : line.slice(separator + 1);
      if (command === 'AUTH' && argument === 'TLS' && options.security === 'explicit-tls') {
        socket.write('234 Begin TLS\r\n');
        socket.off('data', receive);
        const secured = new TLSSocket(socket, {
          isServer: true,
          ...(secureContext ? { secureContext } : {}),
        });
        secured.on('error', () => {});
        secured.on('data', receive);
        socket = secured;
      } else if (command === 'USER') {
        username = argument;
        socket.write('331 Password required\r\n');
      } else if (command === 'PASS') {
        authenticated =
          (!options.username || username === options.username) &&
          (!options.password || argument === options.password);
        socket.write(authenticated ? '230 Logged in\r\n' : '530 Authentication failed\r\n');
      } else if (!authenticated) socket.write('530 Authentication required\r\n');
      else if (command === 'FEAT')
        socket.write('211-Features\r\n EPSV\r\n MLST type*;size*;modify*;\r\n211 End\r\n');
      else if (
        command === 'OPTS' ||
        command === 'TYPE' ||
        command === 'STRU' ||
        command === 'PBSZ' ||
        command === 'PROT'
      )
        socket.write('200 Command accepted\r\n');
      else if (command === 'PWD') socket.write(`257 "${cwd}" is current directory\r\n`);
      else if (command === 'CWD') {
        const path = posix.resolve(cwd, argument);
        if (!directories.has(path)) socket.write('550 Directory not found\r\n');
        else {
          cwd = path;
          socket.write('250 Directory changed\r\n');
        }
      } else if (command === 'EPSV') {
        let accept!: (data: Socket) => void;
        passive = new Promise<Socket>((resolve) => {
          accept = resolve;
        });
        const dataServer = createServer((rawData) => {
          const data =
            options.security && options.security !== 'plain'
              ? new TLSSocket(rawData, {
                  isServer: true,
                  ...(secureContext ? { secureContext } : {}),
                })
              : rawData;
          data.on('error', () => {});
          dataSockets.add(data);
          data.once('close', () => dataSockets.delete(data));
          accept(data);
          dataServer.close();
        });
        dataServers.add(dataServer);
        dataServer.on('close', () => dataServers.delete(dataServer));
        dataServer.listen(0, '127.0.0.1');
        await once(dataServer, 'listening');
        const address = dataServer.address();
        if (!address || typeof address === 'string') throw new Error('FTP data fixture failed');
        socket.write(`229 Entering Extended Passive Mode (|||${address.port}|)\r\n`);
      } else if (command === 'MLSD' || command === 'LIST') {
        socket.write('150 Opening data connection\r\n');
        const data = await requirePassive();
        const listing =
          options.listing ??
          [
            ...files.entries(),
            ...[...directories]
              .filter((path) => path !== '/')
              .map((path) => [path, undefined] as const),
          ]
            .filter(([path]) => posix.dirname(path) === posix.resolve(cwd, argument || '.'))
            .map(([path, content]) =>
              command === 'MLSD'
                ? `type=${content ? 'file' : 'dir'};size=${content?.length ?? 0};modify=20260913000000; ${posix.basename(path)}\r\n`
                : `${content ? '-' : 'd'}rw-r--r-- 1 user group ${content?.length ?? 0} Sep 13 00:00 ${posix.basename(path)}\r\n`,
            )
            .join('');
        data.end(listing);
        await once(data, 'close');
        socket.write('226 Transfer complete\r\n');
      } else if (command === 'STOR') {
        socket.write('150 Opening data connection\r\n');
        const data = await requirePassive();
        const chunks: Buffer[] = [];
        data.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
        await once(data, 'end');
        files.set(posix.resolve(cwd, argument), Buffer.concat(chunks));
        socket.write('226 Transfer complete\r\n');
      } else if (command === 'REST') {
        restart = Number(argument);
        socket.write('350 Restart accepted\r\n');
      } else if (command === 'RETR') {
        socket.write('150 Opening data connection\r\n');
        const data = await requirePassive();
        data.end((files.get(posix.resolve(cwd, argument)) ?? Buffer.alloc(0)).subarray(restart));
        restart = 0;
        await once(data, 'close');
        socket.write('226 Transfer complete\r\n');
      } else if (command === 'RNFR') {
        if (!files.has(argument)) socket.write('550 Source not found\r\n');
        else {
          renameFrom = argument;
          socket.write('350 Ready for RNTO\r\n');
        }
      } else if (command === 'RNTO') {
        const source = renameFrom;
        renameFrom = null;
        if (!source) socket.write('503 Use RNFR first\r\n');
        else if (files.has(argument) && !options.allowReplace)
          socket.write('550 Target exists\r\n');
        else {
          files.set(argument, files.get(source)!);
          files.delete(source);
          socket.write('250 Rename complete\r\n');
        }
      } else if (command === 'DELE') {
        if (!files.delete(argument)) socket.write('550 File not found\r\n');
        else socket.write('250 Deleted\r\n');
      } else if (command === 'SITE' && argument.startsWith('CHMOD ')) {
        const path = posix.resolve(cwd, argument.split(' ').slice(2).join(' '));
        socket.write(
          files.has(path) || directories.has(path)
            ? '200 Permissions changed\r\n'
            : '550 Path not found\r\n',
        );
      } else if (command === 'QUIT') {
        socket.end('221 Goodbye\r\n');
      } else socket.write('502 Command not implemented\r\n');
    }
    async function requirePassive() {
      if (!passive) throw new Error('Passive data connection was not prepared');
      const next = passive;
      passive = undefined;
      return next;
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('FTP fixture failed');
  return {
    port: address.port,
    files,
    close: async () => {
      for (const socket of controlSockets) socket.destroy();
      for (const socket of dataSockets) socket.destroy();
      for (const dataServer of dataServers) dataServer.close();
      server.close();
      await once(server, 'close');
    },
  };
}
