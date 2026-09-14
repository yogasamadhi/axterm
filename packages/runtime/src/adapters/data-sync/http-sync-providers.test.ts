import { describe, expect, it, vi } from 'vitest';
import { syncProfileSchema, type SyncProfile } from '@workspace/contracts';
import { ApplicationError } from '../../application/errors';
import { CustomSyncProvider, GistSyncProvider, WebDavSyncProvider } from './http-sync-providers';

const envelope = '{"formatVersion":1,"encrypted":false,"document":{}}\n';

function profile(
  provider: SyncProfile['provider'],
  endpointUrl: string,
  remoteId = 'remote-1',
): SyncProfile {
  return syncProfileSchema.parse({
    id: '00000000-0000-4000-8000-000000000111',
    provider,
    name: `${provider} sync`,
    endpointUrl,
    remoteId,
    username: provider === 'webdav' ? 'alice' : null,
    accessCredentialConfigured: true,
    encryptionConfigured: false,
    selectedCategories: ['settings'],
    autoSyncEnabled: false,
    autoSyncIntervalMinutes: 5,
    autoSyncDirection: 'upload',
    state: 'idle',
    remoteRevision: null,
    lastSyncAt: null,
    lastErrorCode: null,
    pendingPreviewId: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    version: 1,
  });
}

function json(value: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'Content-Type': 'application/json', ...init.headers },
    ...init,
  });
}

describe('HTTP sync providers', () => {
  it('loads GitHub gist content with header-only credentials and a bounded revision', async () => {
    const fetcher = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      json(
        {
          files: { 'axterm-sync.json': { content: envelope } },
          updated_at: '2026-02-01T12:00:00.000Z',
        },
        { headers: { ETag: '"gist-v4"' } },
      ),
    );
    const provider = new GistSyncProvider('github', fetcher as typeof fetch);
    const result = await provider.load(
      {
        profile: profile('github', 'https://api.github.com/gists'),
        accessSecret: 'github-secret',
      },
      new AbortController().signal,
    );

    expect(result).toMatchObject({ contents: envelope, revision: 'etag:"gist-v4"' });
    const [url, init] = fetcher.mock.calls[0]!;
    expect(url).toBe('https://api.github.com/gists/remote-1');
    expect(String(url)).not.toContain('github-secret');
    expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer github-secret');
  });

  it('rejects a stale Gist upload before PATCH', async () => {
    const fetcher = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      json(
        { files: { 'axterm-sync.json': { content: envelope } } },
        { headers: { ETag: '"newer"' } },
      ),
    );
    const provider = new GistSyncProvider('gitee', fetcher as typeof fetch);

    await expect(
      provider.save(
        {
          profile: profile('gitee', 'https://gitee.com/api/v5/gists'),
          accessSecret: 'gitee-secret',
        },
        envelope,
        'etag:"older"',
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: 'SYNC_REMOTE_CONFLICT' });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('creates the WebDAV collection and uses conditional PUT', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(new Response(envelope, { status: 200, headers: { ETag: '"r1"' } }))
      .mockResolvedValueOnce(new Response('', { status: 405 }))
      .mockResolvedValueOnce(new Response(null, { status: 204, headers: { ETag: '"r2"' } }));
    const provider = new WebDavSyncProvider(fetcher as typeof fetch);
    const context = {
      profile: profile('webdav', 'https://dav.example.test/storage/', 'desktop.json'),
      accessSecret: 'dav-secret',
    };

    const result = await provider.save(
      context,
      envelope,
      'etag:"r1"',
      new AbortController().signal,
    );

    expect(result.revision).toBe('etag:"r2"');
    expect(fetcher.mock.calls.map(([url, init]) => [url, init?.method])).toEqual([
      ['https://dav.example.test/storage/electerm/desktop.json', 'GET'],
      ['https://dav.example.test/storage/electerm/', 'MKCOL'],
      ['https://dav.example.test/storage/electerm/desktop.json', 'PUT'],
    ]);
    const putHeaders = new Headers(fetcher.mock.calls[2]![1]?.headers);
    expect(putHeaders.get('If-Match')).toBe('"r1"');
    expect(putHeaders.get('Authorization')).toBe(
      `Basic ${Buffer.from('alice:dav-secret').toString('base64')}`,
    );
  });

  it('uses Electerm-compatible short-lived JWT auth for a custom server', async () => {
    const fetcher = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      json({ files: { 'axterm-sync.json': { content: envelope } } }),
    );
    const provider = new CustomSyncProvider(fetcher as typeof fetch);
    await provider.load(
      {
        profile: profile('custom', 'https://sync.example.test/api', 'user-7'),
        accessSecret: 'jwt-secret',
      },
      new AbortController().signal,
    );

    const [url, init] = fetcher.mock.calls[0]!;
    const authorization = new Headers(init?.headers).get('Authorization')!;
    const token = authorization.slice('Bearer '.length);
    const payload = JSON.parse(Buffer.from(token.split('.')[1]!, 'base64url').toString('utf8')) as {
      id: string;
      exp: number;
      iat: number;
    };
    expect(url).toBe('https://sync.example.test/api');
    expect(String(url)).not.toContain('jwt-secret');
    expect(payload.id).toBe('user-7');
    expect(payload.exp - payload.iat).toBe(300);
  });

  it('does not expose an authentication response body', async () => {
    const fetcher = vi.fn(
      async () => new Response('provider says token=super-secret', { status: 403 }),
    );
    const provider = new GistSyncProvider('github', fetcher as typeof fetch);
    let caught: unknown;
    try {
      await provider.load(
        {
          profile: profile('github', 'https://api.github.com/gists'),
          accessSecret: 'super-secret',
        },
        new AbortController().signal,
      );
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ApplicationError);
    expect(String((caught as Error).message)).toBe('Sync provider rejected credentials');
    expect(JSON.stringify(caught)).not.toContain('super-secret');
  });
});
