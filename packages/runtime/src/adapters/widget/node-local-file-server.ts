import { createReadStream } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { extname, isAbsolute, relative, resolve, sep } from 'node:path';
import type { Socket } from 'node:net';
import type {
  LocalFileServerAdapter,
  LocalFileServerOptions,
  RunningWidgetServer,
} from '../../ports/widget-server';

const contentTypes: Readonly<Record<string, string>> = {
  '.css': 'text/css; charset=utf-8',
  '.gif': 'image/gif',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8',
  '.wasm': 'application/wasm',
  '.webp': 'image/webp',
  '.xml': 'application/xml; charset=utf-8',
};

export class NodeLocalFileServer implements LocalFileServerAdapter {
  async start(options: LocalFileServerOptions): Promise<RunningWidgetServer> {
    const rootPath = await realpath(options.rootPath);
    const sockets = new Set<Socket>();
    const server = createServer((request, response) => {
      void serveRequest(rootPath, options, request, response).catch(() => {
        if (!response.headersSent) response.writeHead(500, secureHeaders());
        response.end('Internal Server Error');
      });
    });
    server.maxConnections = 32;
    server.headersTimeout = 5_000;
    server.requestTimeout = 10_000;
    server.keepAliveTimeout = 2_000;
    server.on('connection', (socket) => {
      sockets.add(socket);
      socket.once('close', () => sockets.delete(socket));
    });
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
      for (const socket of sockets) socket.destroy();
      server.close();
      throw error;
    }
    const address = server.address();
    if (!address || typeof address === 'string') {
      server.close();
      throw new Error('Static file server did not bind TCP');
    }
    const host = options.host === 'localhost' ? '127.0.0.1' : options.host;
    const printableHost = host.includes(':') ? `[${host}]` : host;
    let closed: Promise<void> | undefined;
    return {
      host,
      port: address.port,
      url: `http://${printableHost}:${address.port}`,
      stop: () => {
        closed ??= new Promise<void>((resolveClose) => {
          for (const socket of sockets) socket.destroy();
          server.close(() => resolveClose());
          if (!server.listening) resolveClose();
        });
        return closed;
      },
    };
  }
}

async function serveRequest(
  rootPath: string,
  options: LocalFileServerOptions,
  request: IncomingMessage,
  response: ServerResponse,
) {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    response.writeHead(405, { ...secureHeaders(), Allow: 'GET, HEAD' });
    response.end('Method Not Allowed');
    return;
  }
  const requestUrl = new URL(request.url ?? '/', 'http://local.invalid');
  let decoded: string;
  try {
    decoded = decodeURIComponent(requestUrl.pathname);
  } catch {
    respond(response, 400, 'Bad Request');
    return;
  }
  if (decoded.includes('\0') || decoded.includes('\\')) {
    respond(response, 400, 'Bad Request');
    return;
  }
  const segments = decoded.split('/').filter(Boolean);
  if (segments.some((segment) => segment === '.' || segment === '..')) {
    respond(response, 403, 'Forbidden');
    return;
  }
  if (segments.some((segment) => segment.startsWith('.'))) {
    if (options.dotfiles === 'deny') {
      respond(response, 403, 'Forbidden');
      return;
    }
    if (options.dotfiles === 'ignore') {
      respond(response, 404, 'Not Found');
      return;
    }
  }
  const requestedPath = resolve(rootPath, ...segments);
  let candidate: string;
  try {
    candidate = await realpath(requestedPath);
  } catch {
    respond(response, 404, 'Not Found');
    return;
  }
  if (!isInside(rootPath, candidate)) {
    respond(response, 403, 'Forbidden');
    return;
  }
  let metadata = await stat(candidate);
  if (metadata.isDirectory()) {
    if (options.redirect && !requestUrl.pathname.endsWith('/')) {
      response.writeHead(301, {
        ...secureHeaders(),
        Location: `${requestUrl.pathname}/${requestUrl.search}`,
      });
      response.end();
      return;
    }
    try {
      candidate = await realpath(resolve(candidate, options.index));
      if (!isInside(rootPath, candidate)) throw new Error('Index escaped root');
      metadata = await stat(candidate);
    } catch {
      respond(response, 404, 'Not Found');
      return;
    }
  }
  if (!metadata.isFile()) {
    respond(response, 404, 'Not Found');
    return;
  }
  const tag = `W/"${metadata.size.toString(16)}-${Math.trunc(metadata.mtimeMs).toString(16)}"`;
  if (options.etag && request.headers['if-none-match'] === tag) {
    response.writeHead(304, { ...secureHeaders(), ETag: tag });
    response.end();
    return;
  }
  let start = 0;
  let end = Math.max(metadata.size - 1, 0);
  let status = 200;
  const range = options.acceptRanges ? request.headers.range : undefined;
  if (range) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (!match || (!match[1] && !match[2])) {
      response.writeHead(416, {
        ...secureHeaders(),
        'Content-Range': `bytes */${metadata.size}`,
      });
      response.end();
      return;
    }
    if (match[1]) {
      start = Number(match[1]);
      end = match[2] ? Number(match[2]) : end;
    } else {
      const suffix = Number(match[2]);
      start = Math.max(metadata.size - suffix, 0);
    }
    if (
      !Number.isSafeInteger(start) ||
      !Number.isSafeInteger(end) ||
      start > end ||
      start >= metadata.size
    ) {
      response.writeHead(416, {
        ...secureHeaders(),
        'Content-Range': `bytes */${metadata.size}`,
      });
      response.end();
      return;
    }
    end = Math.min(end, metadata.size - 1);
    status = 206;
  }
  const headers: Record<string, string | number> = {
    ...secureHeaders(),
    'Content-Type': contentTypes[extname(candidate).toLowerCase()] ?? 'application/octet-stream',
    'Content-Length': Math.max(end - start + 1, 0),
  };
  if (options.cacheControl)
    headers['Cache-Control'] = `public, max-age=${Math.floor(options.maxAgeMs / 1_000)}`;
  if (options.lastModified) headers['Last-Modified'] = metadata.mtime.toUTCString();
  if (options.etag) headers.ETag = tag;
  if (options.acceptRanges) headers['Accept-Ranges'] = 'bytes';
  if (status === 206) headers['Content-Range'] = `bytes ${start}-${end}/${metadata.size}`;
  response.writeHead(status, headers);
  if (request.method === 'HEAD' || metadata.size === 0) {
    response.end();
    return;
  }
  const stream = createReadStream(candidate, { start, end });
  const cleanup = () => stream.destroy();
  response.once('close', cleanup);
  stream.once('error', () => response.destroy());
  stream.pipe(response);
}

function isInside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
}

function secureHeaders(): Record<string, string> {
  return {
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Cross-Origin-Resource-Policy': 'same-site',
  };
}

function respond(response: ServerResponse, status: number, body: string) {
  response.writeHead(status, { ...secureHeaders(), 'Content-Type': 'text/plain; charset=utf-8' });
  response.end(body);
}
