import { describe, expect, it, vi } from 'vitest';
import { syncProfileSchema, type SyncProfile } from '@workspace/contracts';
import { ApplicationError } from '../../application/errors';
import { CustomSyncProvider, GistSyncProvider, WebDavSyncProvider } from './http-sync-providers';

const envelope = '{"formatVersion":1,"encrypted":false,"document":{}}\n';

function profile(
  provider: SyncProfile['provider'],
  endpointUrl: string,
  remoteId = 'remote-1',
  format: SyncProfile['format'] = 'axterm-sync-v1',
): SyncProfile {
  return syncProfileSchema.parse({
    id: '00000000-0000-4000-8000-000000000111',
    provider,
    format,
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
  it('rejects old-format profiles before making any provider request', async () => {
    for (const [provider, endpoint] of [
      ['github', 'https://api.github.com/gists'],
      ['gitee', 'https://gitee.com/api/v5/gists'],
      ['webdav', 'https://dav.example.test/storage/'],
      ['custom', 'https://sync.example.test/api'],
    ] as const) {
      const fetcher = vi.fn(async () => new Response(null, { status: 404 }));
      const adapter =
        provider === 'webdav'
          ? new WebDavSyncProvider(fetcher as typeof fetch)
          : provider === 'custom'
            ? new CustomSyncProvider(fetcher as typeof fetch)
            : new GistSyncProvider(provider, fetcher as typeof fetch);
      const context = {
        // Simulate a preserved pre-removal database row bypassing the public schema.
        profile: {
          ...profile(provider, endpoint, 'old-profile'),
          format: 'legacy-legacy-prototype-v1',
        } as unknown as SyncProfile,
        accessSecret: 'test-secret',
      };
      await expect(adapter.load(context, new AbortController().signal)).rejects.toMatchObject({
        code: 'SYNC_FORMAT_UNSUPPORTED',
      });
      expect(fetcher).not.toHaveBeenCalled();
    }
  });

  it('reads WebDAV backup bytes without UTF-8 decoding', async () => {
    const remoteBytes = Buffer.from([0xff, 0x00, 0x7b, 0xc3, 0x28, 0x0a]);
    const fetcher = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response(remoteBytes, { status: 200, headers: { ETag: '"bytes-r1"' } }),
    );
    const provider = new WebDavSyncProvider(fetcher as typeof fetch);

    const backup = await provider.readBackup(
      {
        profile: profile('webdav', 'https://dav.example.test/storage/', 'legacy.json'),
        accessSecret: 'dav-secret',
      },
      new AbortController().signal,
    );

    expect(Buffer.from(backup!)).toEqual(remoteBytes);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0]?.[1]?.method).toBe('GET');
  });

  it('bounds a raw backup response before accepting it', async () => {
    const fetcher = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response(null, {
          status: 200,
          headers: { 'Content-Length': String(24 * 1024 * 1024 + 1) },
        }),
    );
    const provider = new WebDavSyncProvider(fetcher as typeof fetch);

    await expect(
      provider.readBackup(
        {
          profile: profile('webdav', 'https://dav.example.test/storage/', 'legacy.json'),
          accessSecret: 'dav-secret',
        },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: 'PAYLOAD_TOO_LARGE' });
  });

  it('backs up malformed raw Custom objects byte-for-byte while normal loads reject invalid UTF-8', async () => {
    const remoteBytes = Buffer.from([0xff, 0x00, 0x7b, 0xc3, 0x28, 0x0a]);
    const fetcher = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response(remoteBytes, { status: 200 }),
    );
    const provider = new CustomSyncProvider(fetcher as typeof fetch);
    const context = {
      profile: profile('custom', 'https://sync.example.test/raw', 'custom-user'),
      accessSecret: 'custom-secret',
    };

    const backup = await provider.readBackup(context, new AbortController().signal);

    expect(Buffer.from(backup!)).toEqual(remoteBytes);
    await expect(provider.load(context, new AbortController().signal)).rejects.toMatchObject({
      code: 'SYNC_REMOTE_INVALID',
    });
  });

  it('loads GitHub gist content with header-only credentials and a bounded revision', async () => {
    const fetcher = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      json(
        {
          files: { 'axterm-sync-v1.json': { content: envelope } },
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

  it('loads a truncated GitHub Gist through its validated raw URL without forwarding credentials', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        json(
          {
            files: {
              'axterm-sync-v1.json': {
                content: 'partial',
                size: Buffer.byteLength(envelope),
                truncated: true,
                raw_url:
                  'https://gist.githubusercontent.com/alice/remote-1/raw/0123456789abcdef0123/axterm-sync-v1.json',
              },
            },
            updated_at: '2026-02-01T12:00:00.000Z',
          },
          { headers: { ETag: '"gist-large-v1"' } },
        ),
      )
      .mockResolvedValueOnce(new Response(envelope));
    const provider = new GistSyncProvider('github', fetcher as typeof fetch);

    const loaded = await provider.load(
      {
        profile: profile('github', 'https://api.github.com/gists'),
        accessSecret: 'github-secret',
      },
      new AbortController().signal,
    );

    expect(loaded).toMatchObject({ contents: envelope, revision: 'etag:"gist-large-v1"' });
    expect(String(fetcher.mock.calls[1]?.[0])).toBe(
      'https://gist.githubusercontent.com/alice/remote-1/raw/0123456789abcdef0123/axterm-sync-v1.json',
    );
    expect(new Headers(fetcher.mock.calls[1]?.[1]?.headers).has('Authorization')).toBe(false);
    expect(fetcher.mock.calls[1]?.[1]?.redirect).toBe('error');
  });

  it('backs up truncated GitHub Gist raw bytes and rejects untrusted raw URLs', async () => {
    const remoteBytes = Buffer.from([0xff, 0x00, 0x7b, 0xc3, 0x28, 0x0a]);
    const makeMetadata = (rawUrl: string) =>
      json({
        files: {
          'axterm-sync-v1.json': {
            content: 'partial',
            size: remoteBytes.byteLength,
            truncated: true,
            raw_url: rawUrl,
          },
        },
      });
    const safeUrl =
      'https://gist.githubusercontent.com/alice/remote-1/raw/0123456789abcdef0123/axterm-sync-v1.json';
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(makeMetadata(safeUrl))
      .mockResolvedValueOnce(new Response(remoteBytes));
    const provider = new GistSyncProvider('github', fetcher as typeof fetch);
    const context = {
      profile: profile('github', 'https://api.github.com/gists'),
      accessSecret: 'github-secret',
    };

    const backup = await provider.readBackup(context, new AbortController().signal);

    expect(Buffer.from(backup!)).toEqual(remoteBytes);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(new Headers(fetcher.mock.calls[1]?.[1]?.headers).has('Authorization')).toBe(false);

    const unsafeFetcher = vi.fn(async () => makeMetadata('https://attacker.example/raw'));
    await expect(
      new GistSyncProvider('github', unsafeFetcher as typeof fetch).readBackup(
        context,
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: 'SYNC_REMOTE_INVALID' });
    expect(unsafeFetcher).toHaveBeenCalledTimes(1);
  });

  it('fails closed for truncated Gitee Gists without making a raw-file request', async () => {
    const fetcher = vi.fn(async () =>
      json({
        files: {
          'axterm-sync-v1.json': {
            content: 'partial',
            truncated: true,
            raw_url: 'https://gitee.com/alice/gist/raw/0123456789abcdef0123/axterm-sync-v1.json',
          },
        },
      }),
    );
    const provider = new GistSyncProvider('gitee', fetcher as typeof fetch);

    const context = {
      profile: profile('gitee', 'https://gitee.com/api/v5/gists'),
      accessSecret: 'gitee-secret',
    };
    await expect(provider.readBackup(context, new AbortController().signal)).rejects.toMatchObject({
      code: 'SYNC_GITEE_TRUNCATED',
    });
    await expect(provider.load(context, new AbortController().signal)).rejects.toMatchObject({
      code: 'SYNC_GITEE_TRUNCATED',
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('does not treat a truncated Gitee Gist file list as a missing sync object', async () => {
    const fetcher = vi.fn(async () =>
      json({ truncated: true, files: { 'other.json': { content: 'unrelated' } } }),
    );
    const provider = new GistSyncProvider('gitee', fetcher as typeof fetch);
    const context = {
      profile: profile('gitee', 'https://gitee.com/api/v5/gists'),
      accessSecret: 'gitee-secret',
    };

    await expect(provider.readBackup(context, new AbortController().signal)).rejects.toMatchObject({
      code: 'SYNC_GITEE_TRUNCATED',
    });
    await expect(provider.load(context, new AbortController().signal)).rejects.toMatchObject({
      code: 'SYNC_GITEE_TRUNCATED',
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('requires a Git clone when a large truncated GitHub raw response cannot be verified', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        json({
          files: {
            'axterm-sync-v1.json': {
              content: 'partial',
              size: 24 * 1024 * 1024 + 1,
              truncated: true,
              raw_url:
                'https://gist.githubusercontent.com/alice/remote-1/raw/0123456789abcdef0123/axterm-sync-v1.json',
            },
          },
        }),
      )
      .mockResolvedValueOnce(
        new Response(null, {
          status: 200,
          headers: { 'Content-Length': String(24 * 1024 * 1024 + 1) },
        }),
      );
    const provider = new GistSyncProvider('github', fetcher as typeof fetch);

    await expect(
      provider.readBackup(
        {
          profile: profile('github', 'https://api.github.com/gists'),
          accessSecret: 'github-secret',
        },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: 'SYNC_GIST_CLONE_REQUIRED' });
  });

  it('does not treat a truncated GitHub Gist file list as a missing sync object', async () => {
    const fetcher = vi.fn(async () =>
      json({ truncated: true, files: { 'other.json': { content: 'unrelated' } } }),
    );
    const provider = new GistSyncProvider('github', fetcher as typeof fetch);

    await expect(
      provider.readBackup(
        {
          profile: profile('github', 'https://api.github.com/gists'),
          accessSecret: 'github-secret',
        },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: 'SYNC_GIST_CLONE_REQUIRED' });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('rejects a large truncated raw response whose bytes do not match GitHub metadata', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        json({
          files: {
            'axterm-sync-v1.json': {
              content: 'partial',
              size: 10_000_001,
              truncated: true,
              raw_url:
                'https://gist.githubusercontent.com/alice/remote-1/raw/0123456789abcdef0123/axterm-sync-v1.json',
            },
          },
        }),
      )
      .mockResolvedValueOnce(new Response('short response'));
    const provider = new GistSyncProvider('github', fetcher as typeof fetch);

    await expect(
      provider.readBackup(
        {
          profile: profile('github', 'https://api.github.com/gists'),
          accessSecret: 'github-secret',
        },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: 'SYNC_GIST_CLONE_REQUIRED' });
  });

  it('uses the uploaded Gist content when the PATCH response marks it truncated', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        json(
          { files: { 'axterm-sync-v1.json': { content: envelope } } },
          { headers: { ETag: '"gist-r1"' } },
        ),
      )
      .mockResolvedValueOnce(
        json(
          {
            files: {
              'axterm-sync-v1.json': {
                content: envelope.slice(0, 10),
                truncated: true,
                raw_url:
                  'https://gist.githubusercontent.com/alice/remote-1/raw/0123456789abcdef0123/axterm-sync-v1.json',
              },
            },
          },
          { headers: { ETag: '"gist-r2"' } },
        ),
      );
    const provider = new GistSyncProvider('github', fetcher as typeof fetch);

    await expect(
      provider.save(
        {
          profile: profile('github', 'https://api.github.com/gists'),
          accessSecret: 'github-secret',
        },
        envelope,
        'etag:"gist-r1"',
        new AbortController().signal,
      ),
    ).resolves.toMatchObject({ contents: envelope });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('rejects a stale Gist upload before PATCH', async () => {
    const fetcher = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      json(
        { files: { 'axterm-sync-v1.json': { content: envelope } } },
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
      ['https://dav.example.test/storage/axterm/desktop.json', 'GET'],
      ['https://dav.example.test/storage/axterm/', 'MKCOL'],
      ['https://dav.example.test/storage/axterm/desktop.json', 'PUT'],
    ]);
    const putHeaders = new Headers(fetcher.mock.calls[2]![1]?.headers);
    expect(putHeaders.get('If-Match')).toBe('"r1"');
    expect(putHeaders.get('Authorization')).toBe(
      `Basic ${Buffer.from('alice:dav-secret').toString('base64')}`,
    );
  });

  it('keeps Axterm-format documents in the independent WebDAV collection', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(new Response(envelope, { status: 200, headers: { ETag: '"r1"' } }))
      .mockResolvedValueOnce(new Response('', { status: 405 }))
      .mockResolvedValueOnce(new Response(null, { status: 204, headers: { ETag: '"r2"' } }));
    const provider = new WebDavSyncProvider(fetcher as typeof fetch);
    const context = {
      profile: profile(
        'webdav',
        'https://dav.example.test/storage/',
        'desktop.json',
        'axterm-sync-v1',
      ),
      accessSecret: 'dav-secret',
    };

    await provider.save(context, envelope, 'etag:"r1"', new AbortController().signal);

    expect(fetcher.mock.calls.map(([url, init]) => [url, init?.method])).toEqual([
      ['https://dav.example.test/storage/axterm/desktop.json', 'GET'],
      ['https://dav.example.test/storage/axterm/', 'MKCOL'],
      ['https://dav.example.test/storage/axterm/desktop.json', 'PUT'],
    ]);
  });

  it('creates a missing Axterm-format Gist file without replacing the legacy file', async () => {
    for (const providerType of ['github', 'gitee'] as const) {
      const legacyContents = `${providerType.toUpperCase()}_LEGACY_BYTES`;
      let remoteFiles: Record<string, { content: string }> = {
        'axterm-sync.json': { content: legacyContents },
      };
      let revision = 1;
      const fetcher = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        if (init?.method === 'PATCH') {
          const body = JSON.parse(String(init.body)) as {
            files: Record<string, { content: string }>;
          };
          remoteFiles = { ...remoteFiles, ...body.files };
          revision += 1;
        }
        return json(
          {
            files: remoteFiles,
            updated_at: '2026-09-22T00:00:00.000Z',
          },
          { headers: { ETag: `"gist-r${revision}"` } },
        );
      });
      const provider = new GistSyncProvider(providerType, fetcher as typeof fetch);
      const context = {
        profile: profile(
          providerType,
          `http://127.0.0.1/${providerType}/gists`,
          `${providerType}-migration`,
          'axterm-sync-v1',
        ),
        accessSecret: `${providerType}-secret`,
      };

      await expect(provider.load(context, new AbortController().signal)).resolves.toBeNull();
      await expect(
        provider.save(context, envelope, null, new AbortController().signal),
      ).resolves.toMatchObject({ contents: envelope, revision: 'etag:"gist-r2"' });

      expect(remoteFiles).toEqual({
        'axterm-sync.json': { content: legacyContents },
        'axterm-sync-v1.json': { content: envelope },
      });
      expect(fetcher.mock.calls.map(([, init]) => init?.method)).toEqual(['GET', 'GET', 'PATCH']);
      const patchBody = JSON.parse(String(fetcher.mock.calls[2]![1]?.body)) as {
        description: string;
        files: Record<string, { content: string }>;
      };
      expect(patchBody).toEqual({
        description: 'Axterm configuration synchronization v1',
        files: { 'axterm-sync-v1.json': { content: envelope } },
      });
    }
  });

  it('merges a missing Axterm-format Custom file into the named-file container', async () => {
    const legacyContents = 'CUSTOM_LEGACY_BYTES';
    let remoteFiles: Record<string, { content: string }> = {
      'axterm-sync.json': { content: legacyContents },
    };
    let revision = 1;
    const fetcher = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'PUT') {
        const body = JSON.parse(String(init.body)) as {
          files: Record<string, { content: string }>;
        };
        remoteFiles = body.files;
        revision += 1;
      }
      return json(
        {
          files: remoteFiles,
          updated_at: '2026-09-22T00:00:00.000Z',
        },
        { headers: { ETag: `"custom-r${revision}"` } },
      );
    });
    const provider = new CustomSyncProvider(fetcher as typeof fetch);
    const context = {
      profile: profile(
        'custom',
        'http://127.0.0.1/custom-sync',
        'custom-migration',
        'axterm-sync-v1',
      ),
      accessSecret: 'custom-secret',
    };

    await expect(provider.load(context, new AbortController().signal)).resolves.toBeNull();
    await expect(
      provider.save(context, envelope, null, new AbortController().signal),
    ).resolves.toMatchObject({ contents: envelope, revision: 'etag:"custom-r2"' });

    expect(remoteFiles).toEqual({
      'axterm-sync.json': { content: legacyContents },
      'axterm-sync-v1.json': { content: envelope },
    });
    expect(new Headers(fetcher.mock.calls[2]![1]?.headers).get('If-Match')).toBe('"custom-r1"');
    expect(new Headers(fetcher.mock.calls[2]![1]?.headers).has('If-None-Match')).toBe(false);
  });

  it('refuses to overwrite a raw Custom legacy object with the Axterm format', async () => {
    const rawLegacy = '{"formatVersion":1,"encrypted":false,"document":{}}';
    const fetcher = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response(rawLegacy, { status: 200, headers: { ETag: '"raw-r1"' } }),
    );
    const provider = new CustomSyncProvider(fetcher as typeof fetch);
    const context = {
      profile: profile(
        'custom',
        'http://127.0.0.1/raw-custom-sync',
        'raw-migration',
        'axterm-sync-v1',
      ),
      accessSecret: 'custom-secret',
    };

    await expect(provider.load(context, new AbortController().signal)).resolves.toBeNull();
    await expect(
      provider.save(context, envelope, null, new AbortController().signal),
    ).rejects.toMatchObject({
      code: 'SYNC_REMOTE_INVALID',
      message: 'Custom sync endpoint must support named files before Axterm format can be uploaded',
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls.every(([, init]) => init?.method === 'GET')).toBe(true);
  });

  it('uses a distinct Axterm v1 filename for each Gist variant and custom payloads', async () => {
    for (const providerType of ['github', 'gitee'] as const) {
      const fetcher = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
        json({ files: { 'axterm-sync-v1.json': { content: envelope } } }),
      );
      const provider = new GistSyncProvider(providerType, fetcher as typeof fetch);
      const context = {
        profile: profile(
          providerType,
          providerType === 'github'
            ? 'https://api.github.com/gists'
            : 'https://gitee.com/api/v5/gists',
          'remote-2',
          'axterm-sync-v1',
        ),
        accessSecret: `${providerType}-secret`,
      };

      const loaded = await provider.load(context, new AbortController().signal);
      expect(loaded).toMatchObject({
        contents: envelope,
      });
      await provider.save(context, envelope, loaded!.revision, new AbortController().signal);

      const body = JSON.parse(String(fetcher.mock.calls[2]![1]?.body)) as {
        description: string;
        files: Record<string, { content: string }>;
      };
      expect(body).toEqual({
        description: 'Axterm configuration synchronization v1',
        files: { 'axterm-sync-v1.json': { content: envelope } },
      });
      expect(new Headers(fetcher.mock.calls[0]![1]?.headers).get('Authorization')).toBe(
        providerType === 'github' ? 'Bearer github-secret' : 'token gitee-secret',
      );
    }

    const customFetcher = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      json({ files: { 'axterm-sync-v1.json': { content: envelope } } }),
    );
    const custom = new CustomSyncProvider(customFetcher as typeof fetch);
    const customContext = {
      profile: profile('custom', 'https://sync.example.test/api', 'user-7', 'axterm-sync-v1'),
      accessSecret: 'custom-secret',
    };
    const customLoaded = await custom.load(customContext, new AbortController().signal);
    await custom.save(
      customContext,
      envelope,
      customLoaded!.revision,
      new AbortController().signal,
    );

    const customBody = JSON.parse(String(customFetcher.mock.calls[2]![1]?.body)) as {
      files: Record<string, { content: string }>;
    };
    expect(customBody.files).toEqual({ 'axterm-sync-v1.json': { content: envelope } });
  });

  it('uses short-lived JWT auth for a custom server', async () => {
    const fetcher = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      json({ files: { 'axterm-sync-v1.json': { content: envelope } } }),
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
