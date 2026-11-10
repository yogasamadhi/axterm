import { createConnection, createServer, type Server } from 'node:net';
import type { Duplex } from 'node:stream';
import type { Connection } from 'ssh2';

/** Actual ssh2 forwarding peer backed by real loopback listeners and sockets. */
export function installSshForwardingWire(peer: Connection) {
  const streams = new Set<Duplex>();
  const servers = new Map<string, Server>();
  const closingServers = new Set<Promise<void>>();
  let closed = false;
  let closing: Promise<void> | undefined;
  const own = <T extends Duplex>(stream: T): T => {
    streams.add(stream);
    stream.on('error', () => {});
    stream.once('close', () => streams.delete(stream));
    return stream;
  };
  const wire = (left: Duplex, right: Duplex) => {
    left.allowHalfOpen = true;
    right.allowHalfOpen = true;
    left.once('close', () => {
      if (!left.readableEnded || left.errored) right.destroy();
    });
    right.once('close', () => {
      if (!right.readableEnded || right.errored) left.destroy();
    });
    let leftEnded = false;
    let rightEnded = false;
    const finish = (target: Duplex, ended: () => void) => {
      target.write(Buffer.alloc(0), () => {
        if ('eof' in target && typeof target.eof === 'function') target.eof();
        else target.end();
        ended();
        if (leftEnded && rightEnded)
          for (const stream of [left, right])
            if ('eof' in stream && 'close' in stream && typeof stream.close === 'function')
              stream.close();
      });
    };
    // ssh2 ServerChannel.end() also sends CHANNEL_CLOSE. Keep TCP half-closes
    // explicit via its supported EOF API until both directions have drained.
    left.once('end', () =>
      finish(right, () => {
        leftEnded = true;
      }),
    );
    right.once('end', () =>
      finish(left, () => {
        rightEnded = true;
      }),
    );
    left.pipe(right, { end: false }).pipe(left, { end: false });
  };
  const stopServer = (key: string, server: Server) => {
    servers.delete(key);
    const stopped = new Promise<void>((resolve) => server.close(() => resolve()));
    closingServers.add(stopped);
    void stopped.then(() => closingServers.delete(stopped));
    return stopped;
  };
  peer.on('tcpip', (accept, reject, info) => {
    if (closed || streams.size >= 128 || info.destIP !== '127.0.0.1') {
      reject();
      return;
    }
    const socket = own(createConnection({ host: info.destIP, port: info.destPort }));
    let accepted = false;
    socket.once('connect', () => {
      if (closed) {
        socket.destroy();
        reject();
        return;
      }
      const channel = accept();
      accepted = true;
      if (!channel) {
        socket.destroy();
        return;
      }
      wire(socket, own(channel));
    });
    socket.once('error', () => {
      if (!accepted) reject();
    });
  });
  peer.on('request', (accept, reject, name, info) => {
    if (
      (name !== 'tcpip-forward' && name !== 'cancel-tcpip-forward') ||
      !info ||
      !('bindAddr' in info) ||
      !('bindPort' in info) ||
      typeof info.bindAddr !== 'string' ||
      typeof info.bindPort !== 'number'
    ) {
      reject?.();
      return;
    }
    if (closed || info.bindAddr !== '127.0.0.1') {
      reject?.();
      return;
    }
    if (name === 'cancel-tcpip-forward') {
      const key = `${info.bindAddr}:${info.bindPort}`;
      const server = servers.get(key);
      if (!server) {
        reject?.();
        return;
      }
      void stopServer(key, server);
      accept?.();
      return;
    }
    const host = info.bindAddr;
    const server = createServer({ allowHalfOpen: true }, (socket) => {
      own(socket);
      socket.pause();
      if (closed || streams.size >= 128) {
        socket.destroy();
        return;
      }
      const address = server.address();
      if (!address || typeof address === 'string') {
        socket.destroy();
        return;
      }
      peer.forwardOut(
        host,
        address.port,
        socket.remoteAddress ?? '127.0.0.1',
        socket.remotePort ?? 0,
        (error, channel) => {
          if (error || closed || socket.destroyed) {
            channel?.destroy();
            socket.destroy();
            return;
          }
          wire(socket, own(channel));
          socket.resume();
        },
      );
    });
    const provisional = `${host}:opening-${servers.size}`;
    servers.set(provisional, server);
    server.once('error', () => {
      servers.delete(provisional);
      reject?.();
    });
    server.listen(info.bindPort, host, () => {
      servers.delete(provisional);
      if (closed) {
        void stopServer(provisional, server);
        return;
      }
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject?.();
        return;
      }
      servers.set(`${host}:${address.port}`, server);
      accept?.(address.port);
    });
  });
  const close = () =>
    (closing ??= (async () => {
      closed = true;
      const ended = [...streams].map((stream) =>
        stream.closed
          ? Promise.resolve()
          : new Promise<void>((resolve) => stream.once('close', () => resolve())),
      );
      for (const stream of streams) stream.destroy();
      for (const [key, server] of [...servers]) void stopServer(key, server);
      await Promise.all(ended);
      await Promise.all([...closingServers]);
    })());
  peer.once('close', () => {
    void close();
  });
  return { close, resourceCount: () => streams.size + servers.size + closingServers.size };
}
