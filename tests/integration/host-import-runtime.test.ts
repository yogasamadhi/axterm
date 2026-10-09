import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  bookmarkTreeSchema,
  bootstrapResponseSchema,
  hostSchema,
  sshConfigImportResultSchema,
} from '../../packages/contracts/src/index';
import { createRuntimeClient } from '../../packages/client/src/api-client';
import { startRuntime } from '../../packages/runtime/src/bootstrap/runtime';

const runtimes: Awaited<ReturnType<typeof startRuntime>>[] = [];
const servers: ReturnType<typeof createServer>[] = [];
const clients: Array<{ dispose(): void }> = [];
const directories: string[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) client.dispose();
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.close()));
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
          server.closeAllConnections();
        }),
    ),
  );
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function launchFixture() {
  const directory = await mkdtemp(join(tmpdir(), 'axterm-import-runtime-'));
  directories.push(directory);
  const configPath = join(directory, 'ssh-config');
  await writeFile(
    configPath,
    `Host gateway
  HostName gateway.example.test
  User operator
Host application
  HostName application.example.test
  User operator
  ProxyJump gateway
`,
    'utf8',
  );
  const hostToken = 'host-import-token-that-never-reaches-the-renderer';
  const host = createServer((request, response) => {
    if (request.headers.authorization !== `Bearer ${hostToken}`) {
      response.writeHead(401).end();
      return;
    }
    if (request.method === 'POST' && request.url === '/host/v1/grants/import-grant/resolve') {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(
        JSON.stringify({
          grantId: 'import-grant',
          kind: 'file',
          name: 'ssh-config',
          permissions: ['read'],
          createdAt: '2026-09-12T00:00:00.000Z',
          path: configPath,
        }),
      );
      return;
    }
    response.writeHead(404).end();
  });
  servers.push(host);
  host.listen(0, '127.0.0.1');
  await once(host, 'listening');
  const address = host.address() as AddressInfo;
  const runtime = await startRuntime({
    generation: randomUUID(),
    appVersion: '0.10.0',
    mode: 'desktop',
    dataDirectory: directory,
    hostCapabilityUrl: `http://127.0.0.1:${address.port}`,
    hostCapabilityToken: hostToken,
  });
  runtimes.push(runtime);
  return runtime;
}

describe('SSH Config import Runtime contract', () => {
  it('returns a typed atomic report and stays unchanged on a repeated client import', async () => {
    const runtime = await launchFixture();
    const client = createRuntimeClient({ resolve: async () => runtime.bootstrap() });
    clients.push(client);
    const before = await client.bookmarkTree();

    const imported = sshConfigImportResultSchema.parse(
      await client.importHosts('import-grant', null, before),
    );
    expect(imported.summary).toMatchObject({ imported: 2, linked: 0, unchanged: 0 });
    expect(imported.tree.revision).toBe(before.revision + 1);
    expect(imported.createdHosts).toHaveLength(2);
    expect(imported.createdBookmarks).toHaveLength(2);

    const repeated = await client.importHosts('import-grant', null, imported.tree);
    expect(repeated.summary).toMatchObject({ imported: 0, linked: 0, unchanged: 2 });
    expect(repeated.tree).toEqual(imported.tree);
    expect(await client.hosts()).toHaveLength(2);
  });

  it('commits one editable preview once and keeps a repeated full preview import safe', async () => {
    const runtime = await launchFixture();
    const client = createRuntimeClient({ resolve: async () => runtime.bootstrap() });
    clients.push(client);
    const before = await client.bookmarkTree();
    const preview = await client.previewSshConfigImport({ grantId: 'import-grant' });
    expect(preview.summary).toMatchObject({ imported: 2, selected: 2, skipped: 0 });
    expect(preview.items.every(({ draft }) => draft?.selected)).toBe(true);
    const drafts = preview.items.flatMap(({ draft }) => (draft ? [draft] : []));
    const edited = drafts.map((draft) =>
      draft.name === 'application' ? { ...draft, title: 'Edited application' } : draft,
    );
    const imported = await client.commitSshConfigImport(
      { previewId: preview.previewId, groupId: null, items: edited },
      before,
    );
    expect(imported.summary).toMatchObject({ imported: 2, linked: 0, unchanged: 0 });
    expect(imported.tree.bookmarks.some(({ title }) => title === 'Edited application')).toBe(true);

    await expect(
      client.commitSshConfigImport(
        { previewId: preview.previewId, groupId: null, items: edited },
        imported.tree,
      ),
    ).rejects.toMatchObject({ status: 412, code: 'PRECONDITION_FAILED' });

    const repeatedPreview = await client.previewSshConfigImport({ grantId: 'import-grant' });
    expect(repeatedPreview.summary).toMatchObject({ imported: 0, unchanged: 2, selected: 0 });
    const repeated = await client.commitSshConfigImport(
      {
        previewId: repeatedPreview.previewId,
        groupId: null,
        items: repeatedPreview.items.flatMap(({ draft }) =>
          draft ? [{ ...draft, selected: true }] : [],
        ),
      },
      imported.tree,
    );
    expect(repeated.summary).toMatchObject({ imported: 0, unchanged: 2 });
    expect(repeated.tree).toEqual(imported.tree);
    expect(await client.hosts()).toHaveLength(2);
  });

  it('requires the tree precondition and leaves no Host after a stale import', async () => {
    const runtime = await launchFixture();
    const bootstrap = runtime.bootstrap();
    const login = await fetch(`${runtime.baseUrl}/api/v1/auth/bootstrap`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ bootstrapToken: bootstrap.bootstrapToken }),
    });
    const token = bootstrapResponseSchema.parse(await login.json()).sessionToken;
    const headers = {
      Authorization: `Bearer ${token}`,
      'X-Runtime-Generation': runtime.metadata.generation,
      'Content-Type': 'application/json',
    };
    const tree = bookmarkTreeSchema.parse(
      await (await fetch(`${runtime.baseUrl}/api/v1/bookmark-tree`, { headers })).json(),
    );
    const body = JSON.stringify({ grantId: 'import-grant', groupId: null });
    const missing = await fetch(`${runtime.baseUrl}/api/v1/hosts/import`, {
      method: 'POST',
      headers,
      body,
    });
    expect(missing.status).toBe(428);
    expect(await missing.json()).toMatchObject({ code: 'PRECONDITION_REQUIRED' });

    const changedTree = await fetch(`${runtime.baseUrl}/api/v1/bookmark-groups`, {
      method: 'POST',
      headers: { ...headers, 'If-Match': tree.etag },
      body: JSON.stringify({ name: 'Concurrent group' }),
    });
    expect(changedTree.status).toBe(201);
    const current = bookmarkTreeSchema.parse(await changedTree.json());
    const stale = await fetch(`${runtime.baseUrl}/api/v1/hosts/import`, {
      method: 'POST',
      headers: { ...headers, 'If-Match': tree.etag },
      body,
    });
    expect(stale.status).toBe(412);
    expect(await stale.json()).toMatchObject({ code: 'PRECONDITION_FAILED' });
    expect(
      hostSchema
        .array()
        .parse(await (await fetch(`${runtime.baseUrl}/api/v1/hosts`, { headers })).json()),
    ).toEqual([]);

    const importedResponse = await fetch(`${runtime.baseUrl}/api/v1/hosts/import`, {
      method: 'POST',
      headers: { ...headers, 'If-Match': current.etag },
      body,
    });
    expect(importedResponse.status).toBe(201);
    const imported = sshConfigImportResultSchema.parse(await importedResponse.json());
    expect(importedResponse.headers.get('etag')).toBe(imported.tree.etag);
    const repeatedResponse = await fetch(`${runtime.baseUrl}/api/v1/hosts/import`, {
      method: 'POST',
      headers: { ...headers, 'If-Match': imported.tree.etag },
      body,
    });
    expect(repeatedResponse.status).toBe(200);
    const repeated = sshConfigImportResultSchema.parse(await repeatedResponse.json());
    expect(repeated.tree).toEqual(imported.tree);
    expect(repeated.createdHosts).toEqual([]);
    expect(repeated.createdBookmarks).toEqual([]);
  });
});
