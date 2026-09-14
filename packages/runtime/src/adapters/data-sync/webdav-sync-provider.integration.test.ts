import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { syncProfileSchema, type SyncProfile } from '@workspace/contracts';
import { WebDavSyncProvider } from './http-sync-providers';

const username = '同步用户';
const password = 'LOCAL_VAULT_ONLY_SECRET';
const authorization = `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;

describe('WebDavSyncProvider integration', () => {
  let fixture: WebDavFixture;

  beforeEach(async () => {
    fixture = await WebDavFixture.open();
  });

  afterEach(async () => {
    await fixture.close();
  });

  it('round-trips through a real loopback WebDAV boundary and rejects stale writes', async () => {
    const provider = new WebDavSyncProvider();
    const context = {
      profile: profile(fixture.endpoint),
      accessSecret: password,
    };
    const signal = new AbortController().signal;

    await expect(provider.load(context, signal)).resolves.toBeNull();
    const first = await provider.save(context, '{"revision":1}\n', null, signal);
    expect(first).toMatchObject({ contents: '{"revision":1}\n', revision: 'etag:"r1"' });
    await expect(provider.load(context, signal)).resolves.toMatchObject({
      contents: '{"revision":1}\n',
      revision: 'etag:"r1"',
    });
    expect(fixture.lastAuthorization).toBe(authorization);
    expect(fixture.putCount).toBe(1);

    fixture.replaceRemotely('{"revision":2}\n');
    await expect(
      provider.save(context, '{"revision":3}\n', first.revision, signal),
    ).rejects.toMatchObject({ code: 'SYNC_REMOTE_CONFLICT', status: 409 });
    expect(fixture.putCount).toBe(1);
    expect(fixture.contents).toBe('{"revision":2}\n');
  });
});

function profile(endpointUrl: string): SyncProfile {
  return syncProfileSchema.parse({
    id: '00000000-0000-4000-8000-000000000222',
    provider: 'webdav',
    name: 'Loopback WebDAV',
    endpointUrl,
    remoteId: 'desktop.json',
    username,
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

class WebDavFixture {
  readonly server: Server;
  readonly endpoint: string;
  contents: string | null = null;
  etag: string | null = null;
  putCount = 0;
  lastAuthorization: string | undefined;
  private revision = 0;

  private constructor(server: Server, endpoint: string) {
    this.server = server;
    this.endpoint = endpoint;
  }

  static async open(): Promise<WebDavFixture> {
    const server = createServer((request, response) => fixture.handle(request, response));
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const port = (server.address() as AddressInfo).port;
    const fixture = new WebDavFixture(server, `http://127.0.0.1:${port}/storage/`);
    return fixture;
  }

  replaceRemotely(contents: string): void {
    this.contents = contents;
    this.etag = `"r${++this.revision}"`;
  }

  async close(): Promise<void> {
    await new Promise<void>((resolve, reject) =>
      this.server.close((error) => (error ? reject(error) : resolve())),
    );
  }

  private handle(request: IncomingMessage, response: ServerResponse): void {
    this.lastAuthorization = request.headers.authorization;
    if (this.lastAuthorization !== authorization) {
      response.writeHead(401).end();
      return;
    }
    if (request.url === '/storage/electerm/' && request.method === 'MKCOL') {
      response.writeHead(201).end();
      return;
    }
    if (request.url !== '/storage/electerm/desktop.json') {
      response.writeHead(404).end();
      return;
    }
    if (request.method === 'GET') {
      if (this.contents === null) {
        response.writeHead(404).end();
        return;
      }
      response.writeHead(200, {
        'Content-Type': 'application/json',
        ETag: this.etag!,
      });
      response.end(this.contents);
      return;
    }
    if (request.method !== 'PUT') {
      response.writeHead(405).end();
      return;
    }
    if (
      (this.etag && request.headers['if-match'] !== this.etag) ||
      (!this.etag && request.headers['if-none-match'] !== '*')
    ) {
      response.writeHead(412).end();
      return;
    }
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      this.putCount += 1;
      this.contents = Buffer.concat(chunks).toString('utf8');
      this.etag = `"r${++this.revision}"`;
      response.writeHead(204, { ETag: this.etag }).end();
    });
  }
}
