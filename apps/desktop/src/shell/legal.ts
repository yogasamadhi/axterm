import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { finished } from 'node:stream/promises';
import { dirname, join, win32 } from 'node:path';
import type { ReadStream } from 'node:fs';
export interface RuntimeLegalPaths {
  readonly directory: string;
  readonly packaged: boolean;
}
/** Two fixed static Shell documents, never a caller-provided filesystem path. */
export function runtimeLegalId(value: string): 'electron' | 'chromium' | undefined {
  try {
    const url = new URL(value);
    if (
      url.protocol !== 'axterm-app:' ||
      url.hostname !== 'app' ||
      url.port ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      return;
    if (url.pathname === '/desktop/licenses/electron') return 'electron';
    if (url.pathname === '/desktop/licenses/chromium') return 'chromium';
  } catch {
    /* Invalid URLs have no native capability. */
  }
}
/** Prepared runtime notices are extraFiles beside resources (Contents on macOS). */
export function resolvePackagedRuntimeLegalDirectory(
  resourcesDirectory: string,
  platform: NodeJS.Platform,
): string {
  return platform === 'win32' ? win32.dirname(resourcesDirectory) : dirname(resourcesDirectory);
}
export function resolveRuntimeLegalDocument(value: string, paths: RuntimeLegalPaths) {
  const id = runtimeLegalId(value);
  if (!id) return undefined;
  return {
    id,
    contentType: id === 'chromium' ? 'text/html; charset=utf-8' : 'text/plain; charset=utf-8',
    path: join(
      paths.directory,
      id === 'chromium'
        ? 'LICENSES.chromium.html'
        : paths.packaged
          ? 'LICENSE.electron.txt'
          : 'LICENSE',
    ),
  };
}
export class RuntimeLegalDocuments {
  private readonly streams = new Map<ReadStream, Promise<void>>();
  private readonly lifetime = new AbortController();
  private closing: Promise<void> | undefined;
  private readonly pending = new Set<Promise<Response>>();
  constructor(private readonly paths: RuntimeLegalPaths) {}
  serve(request: Request, signal: AbortSignal): Promise<Response> {
    if (this.lifetime.signal.aborted || this.pending.size + this.streams.size >= 8)
      return Promise.resolve(new Response(null, { status: 503 }));
    const task = this.open(request, signal);
    this.pending.add(task);
    void task.then(
      () => this.pending.delete(task),
      () => this.pending.delete(task),
    );
    return task;
  }
  private async open(request: Request, signal: AbortSignal): Promise<Response> {
    const document = resolveRuntimeLegalDocument(request.url, this.paths);
    if (!document || !['GET', 'HEAD'].includes(request.method))
      return new Response(null, { status: 404 });
    if (this.lifetime.signal.aborted || this.streams.size >= 8)
      return new Response(null, { status: 503 });
    const file = document.path;
    try {
      const info = await stat(file);
      signal.throwIfAborted();
      this.lifetime.signal.throwIfAborted();
      if (!info.isFile() || info.size > 32 * 1024 * 1024)
        return new Response(null, { status: 404 });
      const headers = {
        'content-type': document.contentType,
        'content-length': String(info.size),
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
        'content-security-policy':
          "default-src 'none'; style-src 'unsafe-inline'; sandbox; frame-ancestors axterm-app://app",
      };
      if (request.method === 'HEAD') return new Response(null, { headers });
      const stream = createReadStream(file, {
          signal: AbortSignal.any([signal, this.lifetime.signal]),
          ...(info.size ? { end: info.size - 1 } : {}),
        }),
        done = finished(stream).then(
          () => {},
          () => {},
        );
      this.streams.set(stream, done);
      void done.then(() => this.streams.delete(stream));
      return new Response(Readable.toWeb(stream) as ReadableStream<Uint8Array>, { headers });
    } catch {
      return new Response(null, { status: 404 });
    }
  }
  close(): Promise<void> {
    return (this.closing ??= (async () => {
      this.lifetime.abort();
      await Promise.allSettled([...this.pending]);
      for (const stream of this.streams.keys()) stream.destroy();
      await Promise.allSettled([...this.streams.values()]);
      this.streams.clear();
    })());
  }
}
