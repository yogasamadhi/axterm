import { createHmac } from 'node:crypto';
import { stableHash } from '../sqlite/product-repository';
import { ApplicationError } from '../../application/errors';
import type { SyncProvider, SyncProviderContext, SyncRemoteObject } from '../../ports/data-sync';

const maxResponseBytes = 24 * 1024 * 1024;
const githubGistCloneThresholdBytes = 10_000_000;

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
    const bytes = await readGistFileBytes(
      this.type,
      this.fetcher,
      body,
      syncFileName(context),
      context.profile.remoteId,
      signal,
    );
    if (bytes === null) return null;
    const contents = decodeUtf8(bytes);
    return remoteObject(response, contents, record(body)?.updated_at);
  }

  async readBackup(context: SyncProviderContext, signal: AbortSignal): Promise<Uint8Array | null> {
    const response = await this.fetcher(gistUrl(context), {
      method: 'GET',
      headers: gistHeaders(this.type, context.accessSecret),
      signal,
    });
    if (response.status === 404) return null;
    await requireOk(response);
    const body = await readJson(response);
    return readGistFileBytes(
      this.type,
      this.fetcher,
      body,
      syncFileName(context),
      context.profile.remoteId,
      signal,
    );
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
        description: syncDescription(context),
        files: { [syncFileName(context)]: { content: contents } },
      }),
      signal,
    });
    await requireOk(response);
    const body = await readJson(response);
    const savedContents = gistContents(body, syncFileName(context), contents) ?? contents;
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

  async readBackup(context: SyncProviderContext, signal: AbortSignal): Promise<Uint8Array | null> {
    const response = await this.fetcher(webDavFileUrl(context), {
      method: 'GET',
      headers: webDavHeaders(context),
      signal,
    });
    if (response.status === 404) return null;
    await requireOk(response);
    return readBoundedBytes(response);
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
    const state = await this.loadState(context, signal);
    if (!state || state.targetContents === null) return null;
    return remoteObject(state.response, state.targetContents, record(state.parsed)?.updated_at);
  }

  async readBackup(context: SyncProviderContext, signal: AbortSignal): Promise<Uint8Array | null> {
    const response = await this.fetcher(context.profile.endpointUrl, {
      method: 'GET',
      headers: customHeaders(context),
      signal,
    });
    if (response.status === 404) return null;
    await requireOk(response);
    const bytes = await readBoundedBytes(response);
    let bodyText: string;
    try {
      bodyText = decodeUtf8(bytes);
    } catch {
      // A backup must preserve malformed or non-text legacy objects instead of
      // replacing their bytes with UTF-8 replacement characters.
      return bytes;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(bodyText) as unknown;
    } catch {
      return bytes;
    }

    let files: Record<string, { content: string }> | null;
    try {
      files = customNamedFiles(parsed);
    } catch {
      return bytes;
    }
    if (files) {
      const content = files[syncFileName(context)];
      return content ? Buffer.from(content.content, 'utf8') : null;
    }

    try {
      const contents = customContents(parsed, syncFileName(context));
      return contents === null ? null : Buffer.from(contents, 'utf8');
    } catch {
      // Keep an unrecognized but bounded remote object recoverable.
      return bytes;
    }
  }

  async save(
    context: SyncProviderContext,
    contents: string,
    expectedRevision: string | null,
    signal: AbortSignal,
  ): Promise<SyncRemoteObject> {
    const current = await this.loadState(context, signal);
    const currentRevision =
      current?.targetContents === null || current === null
        ? null
        : remoteObject(current.response, current.targetContents, record(current.parsed)?.updated_at)
            .revision;
    if (currentRevision !== expectedRevision)
      throw new ApplicationError(
        'SYNC_REMOTE_CONFLICT',
        'Remote sync data changed; compare again before uploading',
        409,
      );
    if (current && current.rawContents !== null)
      throw new ApplicationError(
        'SYNC_REMOTE_INVALID',
        'Custom sync endpoint must support named files before Axterm format can be uploaded',
        409,
      );

    const headers = customHeaders(context);
    const containerEtag = current?.response.headers.get('ETag');
    if (containerEtag) headers['If-Match'] = containerEtag;
    else if (!current) headers['If-None-Match'] = '*';
    const files = {
      ...(current?.files ?? {}),
      [syncFileName(context)]: { content: contents },
    };
    const response = await this.fetcher(context.profile.endpointUrl, {
      method: 'PUT',
      headers,
      body: JSON.stringify({
        description: syncDescription(context),
        files,
        public: false,
      }),
      signal,
    });
    await requireOk(response);
    const bodyText = await readBoundedText(response);
    const parsed = bodyText ? parseJson(bodyText) : undefined;
    const savedContents = parsed
      ? (customContents(parsed, syncFileName(context)) ?? contents)
      : contents;
    return remoteObject(response, savedContents, record(parsed)?.updated_at);
  }

  private async loadState(
    context: SyncProviderContext,
    signal: AbortSignal,
  ): Promise<CustomRemoteState | null> {
    const response = await this.fetcher(context.profile.endpointUrl, {
      method: 'GET',
      headers: customHeaders(context),
      signal,
    });
    if (response.status === 404) return null;
    await requireOk(response);
    const bodyText = await readBoundedText(response);
    const parsed = parseJson(bodyText);
    const files = customNamedFiles(parsed);
    return {
      response,
      parsed,
      files: files ?? {},
      rawContents: files ? null : bodyText,
      targetContents: customContents(parsed, syncFileName(context)),
    };
  }
}

interface CustomRemoteState {
  response: Response;
  parsed: unknown;
  files: Record<string, { content: string }>;
  rawContents: string | null;
  targetContents: string | null;
}

function gistUrl(context: SyncProviderContext): string {
  requireAxtermFormat(context);
  const base = new URL(context.profile.endpointUrl);
  base.pathname = `${base.pathname.replace(/\/+$/u, '')}/${encodeURIComponent(context.profile.remoteId)}`;
  return base.toString();
}

function syncFileName(context: SyncProviderContext): string {
  requireAxtermFormat(context);
  return 'axterm-sync-v1.json';
}

function syncDescription(context: SyncProviderContext): string {
  requireAxtermFormat(context);
  return 'Axterm configuration synchronization v1';
}

function requireAxtermFormat(context: SyncProviderContext): void {
  if (context.profile.format !== 'axterm-sync-v1')
    throw new ApplicationError('SYNC_FORMAT_UNSUPPORTED', 'Legacy sync is disabled', 409);
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
  requireAxtermFormat(context);
  const base = context.profile.endpointUrl.endsWith('/')
    ? context.profile.endpointUrl
    : `${context.profile.endpointUrl}/`;
  return new URL('axterm/', base).toString();
}

function webDavFileUrl(context: SyncProviderContext): string {
  return new URL(
    encodeURIComponent(context.profile.remoteId),
    webDavDirectoryUrl(context),
  ).toString();
}

function customHeaders(context: SyncProviderContext): Record<string, string> {
  requireAxtermFormat(context);
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
  return decodeUtf8(await readBoundedBytes(response));
}

async function readBoundedBytes(response: Response): Promise<Uint8Array> {
  const length = Number(response.headers.get('Content-Length'));
  if (Number.isFinite(length) && length > maxResponseBytes)
    throw new ApplicationError('PAYLOAD_TOO_LARGE', 'Sync provider response exceeds 24 MiB', 413);
  if (!response.body) return new Uint8Array();
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
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));
}

function decodeUtf8(bytes: Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new ApplicationError('SYNC_REMOTE_INVALID', 'Sync provider returned invalid UTF-8', 409);
  }
}

function gistContents(
  value: unknown,
  fileName: string,
  fallback?: string,
  allowMissing = false,
): string | null {
  const source = record(value);
  const files = record(source?.files);
  if (!files) {
    if (fallback !== undefined) return fallback;
    throw new ApplicationError('SYNC_REMOTE_INVALID', 'Sync gist has no files object', 409);
  }
  if (!Object.hasOwn(files, fileName)) {
    if (fallback !== undefined) return fallback;
    if (allowMissing) return null;
    throw new ApplicationError('SYNC_REMOTE_INVALID', `Sync gist has no ${fileName}`, 409);
  }
  const file = record(files[fileName]);
  if (file?.truncated === true && fallback === undefined)
    throw new ApplicationError('PAYLOAD_TOO_LARGE', 'Sync gist content is truncated', 413);
  if (file?.truncated === true) return fallback ?? null;
  if (typeof file?.content === 'string') return file.content;
  if (fallback !== undefined) return fallback;
  throw new ApplicationError('SYNC_REMOTE_INVALID', `Sync gist has no ${fileName}`, 409);
}

async function readGistFileBytes(
  provider: 'github' | 'gitee',
  fetcher: FetchLike,
  value: unknown,
  fileName: string,
  remoteId: string,
  signal: AbortSignal,
): Promise<Uint8Array | null> {
  const source = record(value);
  const files = record(source?.files);
  const file = record(files?.[fileName]);
  if (file?.truncated === true) {
    if (provider !== 'github') throw giteeGistTruncated();

    const expectedSize = file.size;
    if (typeof expectedSize !== 'number' || !Number.isSafeInteger(expectedSize) || expectedSize < 0)
      throw new ApplicationError('SYNC_REMOTE_INVALID', 'Truncated Gist file size is invalid', 409);

    const rawUrl = githubGistRawUrl(file.raw_url, remoteId, fileName);
    try {
      const response = await fetcher(rawUrl, {
        method: 'GET',
        headers: {
          Accept: 'application/octet-stream',
          'User-Agent': 'Axterm-Sync/1',
        },
        redirect: 'error',
        signal,
      });
      await requireOk(response);
      const bytes = await readBoundedBytes(response);
      if (bytes.byteLength !== expectedSize) {
        if (expectedSize > githubGistCloneThresholdBytes) throw githubGistCloneRequired();
        throw new ApplicationError(
          'SYNC_REMOTE_INVALID',
          'GitHub Gist raw file size does not match its metadata',
          409,
        );
      }
      return bytes;
    } catch (error) {
      if (signal.aborted) throw error;
      if (expectedSize > githubGistCloneThresholdBytes) throw githubGistCloneRequired();
      throw error;
    }
  }

  if (!file && source?.truncated === true) {
    if (provider === 'github') throw githubGistCloneRequired();
    throw giteeGistTruncated();
  }

  const contents = gistContents(value, fileName, undefined, true);
  return contents === null ? null : Buffer.from(contents, 'utf8');
}

function githubGistCloneRequired(): ApplicationError {
  return new ApplicationError(
    'SYNC_GIST_CLONE_REQUIRED',
    'GitHub truncated this Gist response. Clone the Gist with a Git client to save and verify the complete sync file; Axterm has not changed the remote Gist.',
    413,
  );
}

function giteeGistTruncated(): ApplicationError {
  return new ApplicationError(
    'SYNC_GITEE_TRUNCATED',
    'Gitee returned an incomplete Gist response; keep the remote file unchanged and obtain a complete backup before migration',
    413,
  );
}

function githubGistRawUrl(value: unknown, remoteId: string, fileName: string): URL {
  if (typeof value !== 'string')
    throw new ApplicationError('SYNC_REMOTE_INVALID', 'Sync gist raw URL is missing', 409);

  let url: URL;
  let segments: string[];
  try {
    url = new URL(value);
    segments = url.pathname
      .split('/')
      .filter(Boolean)
      .map((segment) => decodeURIComponent(segment));
  } catch {
    throw new ApplicationError('SYNC_REMOTE_INVALID', 'Sync gist raw URL is invalid', 409);
  }

  if (
    url.protocol !== 'https:' ||
    url.hostname !== 'gist.githubusercontent.com' ||
    url.port !== '' ||
    url.username !== '' ||
    url.password !== '' ||
    url.search !== '' ||
    url.hash !== '' ||
    segments.length !== 5 ||
    !segments[0] ||
    segments.some((segment) => /[\\/\0]/u.test(segment)) ||
    segments[1] !== remoteId ||
    segments[2] !== 'raw' ||
    !/^[a-f\d]{20,64}$/iu.test(segments[3] ?? '') ||
    segments[4] !== fileName
  )
    throw new ApplicationError('SYNC_REMOTE_INVALID', 'Sync gist raw URL is not trusted', 409);

  return url;
}

function customContents(value: unknown, fileName: string): string | null {
  const files = customNamedFiles(value);
  if (files && !Object.hasOwn(files, fileName)) return null;
  const file = files?.[fileName];
  if (typeof file?.content === 'string') return file.content;
  if (!files) return null;
  throw new ApplicationError('SYNC_REMOTE_INVALID', `Custom sync response has no ${fileName}`, 409);
}

function customNamedFiles(value: unknown): Record<string, { content: string }> | null {
  const source = record(value);
  if (!source || !Object.hasOwn(source, 'files')) return null;
  const files = record(source.files);
  if (!files)
    throw new ApplicationError(
      'SYNC_REMOTE_INVALID',
      'Custom sync response has invalid files',
      409,
    );
  const contents: Record<string, { content: string }> = {};
  for (const [name, candidate] of Object.entries(files)) {
    const file = record(candidate);
    if (typeof file?.content !== 'string')
      throw new ApplicationError(
        'SYNC_REMOTE_INVALID',
        `Custom sync response has invalid file ${name}`,
        409,
      );
    contents[name] = { content: file.content };
  }
  return contents;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
