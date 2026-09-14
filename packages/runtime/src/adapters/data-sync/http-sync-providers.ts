import { createHmac } from 'node:crypto';
import { stableHash } from '../sqlite/product-repository';
import { ApplicationError } from '../../application/errors';
import type { SyncProvider, SyncProviderContext, SyncRemoteObject } from '../../ports/data-sync';

const maxResponseBytes = 24 * 1024 * 1024;
const syncFileName = 'axterm-sync.json';

type FetchLike = typeof fetch;

export class GistSyncProvider implements SyncProvider {
  readonly type: 'github' | 'gitee';

  constructor(
    type: 'github' | 'gitee',
    private readonly fetcher: FetchLike = fetch,
  ) {
    this.type = type;
  }

  async load(context: SyncProviderContext, signal: AbortSignal): Promise<SyncRemoteObject | null> {
    const response = await this.fetcher(gistUrl(context), {
      method: 'GET',
      headers: gistHeaders(this.type, context.accessSecret),
      signal,
    });
    if (response.status === 404) return null;
    await requireOk(response);
    const body = await readJson(response);
    const contents = gistContents(body);
    return remoteObject(response, contents, record(body)?.updated_at);
  }

  async save(
    context: SyncProviderContext,
    contents: string,
    expectedRevision: string | null,
    signal: AbortSignal,
  ): Promise<SyncRemoteObject> {
    await assertCurrentRevision(this, context, expectedRevision, signal);
    const headers = gistHeaders(this.type, context.accessSecret);
    const etag = revisionEtag(expectedRevision);
    if (etag) headers['If-Match'] = etag;
    const response = await this.fetcher(gistUrl(context), {
      method: 'PATCH',
      headers,
      body: JSON.stringify({
        description: 'Axterm settings synchronization',
        files: { [syncFileName]: { content: contents } },
      }),
      signal,
    });
    await requireOk(response);
    const body = await readJson(response);
    const savedContents = gistContents(body, contents);
    return remoteObject(response, savedContents, record(body)?.updated_at);
  }
}

export class WebDavSyncProvider implements SyncProvider {
  readonly type = 'webdav' as const;

  constructor(private readonly fetcher: FetchLike = fetch) {}

  async load(context: SyncProviderContext, signal: AbortSignal): Promise<SyncRemoteObject | null> {
    const response = await this.fetcher(webDavFileUrl(context), {
      method: 'GET',
      headers: webDavHeaders(context),
      signal,
    });
    if (response.status === 404) return null;
    await requireOk(response);
    const contents = await readBoundedText(response);
    return remoteObject(response, contents, response.headers.get('Last-Modified'));
  }

  async save(
    context: SyncProviderContext,
    contents: string,
    expectedRevision: string | null,
    signal: AbortSignal,
  ): Promise<SyncRemoteObject> {
    await assertCurrentRevision(this, context, expectedRevision, signal);
    const directory = webDavDirectoryUrl(context);
    const directoryResponse = await this.fetcher(directory, {
      method: 'MKCOL',
      headers: webDavHeaders(context),
      signal,
    });
    if (![200, 201, 204, 301, 405].includes(directoryResponse.status))
      await requireOk(directoryResponse);

    const headers = webDavHeaders(context);
    const etag = revisionEtag(expectedRevision);
    if (etag) headers['If-Match'] = etag;
    else headers['If-None-Match'] = '*';
    const response = await this.fetcher(webDavFileUrl(context), {
      method: 'PUT',
      headers,
      body: contents,
      signal,
    });
    await requireOk(response);
    return remoteObject(response, contents, response.headers.get('Last-Modified'));
  }
}

export class CustomSyncProvider implements SyncProvider {
  readonly type = 'custom' as const;

  constructor(private readonly fetcher: FetchLike = fetch) {}

  async load(context: SyncProviderContext, signal: AbortSignal): Promise<SyncRemoteObject | null> {
    const response = await this.fetcher(context.profile.endpointUrl, {
      method: 'GET',
      headers: customHeaders(context),
      signal,
    });
    if (response.status === 404) return null;
    await requireOk(response);
    const bodyText = await readBoundedText(response);
    const parsed = parseJson(bodyText);
    const contents = customContents(parsed, bodyText);
    return remoteObject(response, contents, record(parsed)?.updated_at);
  }

  async save(
    context: SyncProviderContext,
    contents: string,
    expectedRevision: string | null,
    signal: AbortSignal,
  ): Promise<SyncRemoteObject> {
    await assertCurrentRevision(this, context, expectedRevision, signal);
    const headers = customHeaders(context);
    const etag = revisionEtag(expectedRevision);
    if (etag) headers['If-Match'] = etag;
    else headers['If-None-Match'] = '*';
    const response = await this.fetcher(context.profile.endpointUrl, {
      method: 'PUT',
      headers,
      body: JSON.stringify({
        description: 'Axterm settings synchronization',
        files: { [syncFileName]: { content: contents } },
        public: false,
      }),
      signal,
    });
    await requireOk(response);
    const bodyText = await readBoundedText(response);
    const parsed = bodyText ? parseJson(bodyText) : undefined;
    const savedContents = parsed ? customContents(parsed, contents) : contents;
    return remoteObject(response, savedContents, record(parsed)?.updated_at);
  }
}

function gistUrl(context: SyncProviderContext): string {
  const base = new URL(context.profile.endpointUrl);
  base.pathname = `${base.pathname.replace(/\/+$/u, '')}/${encodeURIComponent(context.profile.remoteId)}`;
  return base.toString();
}

function gistHeaders(type: 'github' | 'gitee', secret: string): Record<string, string> {
  return {
    Accept: 'application/json',
    Authorization: type === 'github' ? `Bearer ${secret}` : `token ${secret}`,
    'Content-Type': 'application/json; charset=utf-8',
    'User-Agent': 'Axterm-Sync/1',
  };
}

function webDavHeaders(context: SyncProviderContext): Record<string, string> {
  const username = context.profile.username ?? '';
  return {
    Accept: 'application/json',
    Authorization: `Basic ${Buffer.from(`${username}:${context.accessSecret}`).toString('base64')}`,
    'Content-Type': 'application/json; charset=utf-8',
  };
}

function webDavDirectoryUrl(context: SyncProviderContext): string {
  const base = context.profile.endpointUrl.endsWith('/')
    ? context.profile.endpointUrl
    : `${context.profile.endpointUrl}/`;
  return new URL('electerm/', base).toString();
}

function webDavFileUrl(context: SyncProviderContext): string {
  return new URL(
    encodeURIComponent(context.profile.remoteId),
    webDavDirectoryUrl(context),
  ).toString();
}

function customHeaders(context: SyncProviderContext): Record<string, string> {
  return {
    Accept: 'application/json',
    Authorization: `Bearer ${signJwt(context.profile.remoteId, context.accessSecret)}`,
    'Content-Type': 'application/json; charset=utf-8',
    'X-User-Agent': 'axterm-sync/v1',
  };
}

function signJwt(userId: string, secret: string): string {
  const encodedHeader = base64Url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const encodedPayload = base64Url(
    JSON.stringify({
      id: userId,
      iat: Math.floor(Date.now() / 1_000),
      exp: Math.floor(Date.now() / 1_000) + 300,
    }),
  );
  const signature = createHmac('sha256', secret)
    .update(`${encodedHeader}.${encodedPayload}`)
    .digest('base64url');
  return `${encodedHeader}.${encodedPayload}.${signature}`;
}

function base64Url(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64url');
}

async function assertCurrentRevision(
  provider: SyncProvider,
  context: SyncProviderContext,
  expectedRevision: string | null,
  signal: AbortSignal,
): Promise<void> {
  const current = await provider.load(context, signal);
  if ((current?.revision ?? null) !== expectedRevision)
    throw new ApplicationError(
      'SYNC_REMOTE_CONFLICT',
      'Remote sync data changed; compare again before uploading',
      409,
    );
}

function revisionEtag(revision: string | null): string | undefined {
  return revision?.startsWith('etag:') ? revision.slice('etag:'.length) : undefined;
}

function remoteObject(response: Response, contents: string, updatedAt: unknown): SyncRemoteObject {
  const etag = response.headers.get('ETag');
  return {
    contents,
    revision: etag ? `etag:${etag}` : `sha256:${stableHash(contents)}`,
    updatedAt:
      typeof updatedAt === 'string' && Number.isFinite(Date.parse(updatedAt))
        ? new Date(updatedAt).toISOString()
        : new Date().toISOString(),
  };
}

async function requireOk(response: Response): Promise<void> {
  if (response.ok) return;
  if (response.status === 409 || response.status === 412)
    throw new ApplicationError(
      'SYNC_REMOTE_CONFLICT',
      'Remote sync data changed; compare again before uploading',
      409,
    );
  if (response.status === 401 || response.status === 403)
    throw new ApplicationError('SYNC_PROVIDER_FAILED', 'Sync provider rejected credentials', 409);
  if (response.status === 413)
    throw new ApplicationError(
      'PAYLOAD_TOO_LARGE',
      'Sync provider rejected the document size',
      413,
    );
  throw new ApplicationError(
    'SYNC_PROVIDER_FAILED',
    `Sync provider request failed with HTTP ${response.status}`,
    409,
  );
}

async function readJson(response: Response): Promise<unknown> {
  return parseJson(await readBoundedText(response));
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw new ApplicationError('SYNC_REMOTE_INVALID', 'Sync provider returned invalid JSON', 409);
  }
}

async function readBoundedText(response: Response): Promise<string> {
  const length = Number(response.headers.get('Content-Length'));
  if (Number.isFinite(length) && length > maxResponseBytes)
    throw new ApplicationError('PAYLOAD_TOO_LARGE', 'Sync provider response exceeds 24 MiB', 413);
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const item = await reader.read();
      if (item.done) break;
      bytes += item.value.byteLength;
      if (bytes > maxResponseBytes) {
        await reader.cancel();
        throw new ApplicationError(
          'PAYLOAD_TOO_LARGE',
          'Sync provider response exceeds 24 MiB',
          413,
        );
      }
      chunks.push(item.value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString('utf8');
}

function gistContents(value: unknown, fallback?: string): string {
  const files = record(record(value)?.files);
  const file = record(files?.[syncFileName]);
  if (file?.truncated === true)
    throw new ApplicationError('PAYLOAD_TOO_LARGE', 'Sync gist content is truncated', 413);
  if (typeof file?.content === 'string') return file.content;
  if (fallback !== undefined) return fallback;
  throw new ApplicationError('SYNC_REMOTE_INVALID', `Sync gist has no ${syncFileName}`, 409);
}

function customContents(value: unknown, fallback: string): string {
  if (typeof value === 'string') return value;
  const source = record(value);
  if (typeof source?.contents === 'string') return source.contents;
  const files = record(source?.files);
  const file = record(files?.[syncFileName]);
  if (typeof file?.content === 'string') return file.content;
  if (fallback.trimStart().startsWith('{') && source) {
    const isGistShape = Object.hasOwn(source, 'files') || Object.hasOwn(source, 'description');
    if (!isGistShape) return fallback;
  }
  throw new ApplicationError(
    'SYNC_REMOTE_INVALID',
    `Custom sync response has no ${syncFileName}`,
    409,
  );
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
