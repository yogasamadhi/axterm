import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  bookmarkTreeSchema,
  bootstrapResponseSchema,
  deleteSshBookmarkResultSchema,
  hostSchema,
  sshBookmarkMutationResultSchema,
} from '../../packages/contracts/src/index';
import { createRuntimeClient } from '../../packages/client/src/api-client';
import { startRuntime } from '../../packages/runtime/src/bootstrap/runtime';

const runtimes: Awaited<ReturnType<typeof startRuntime>>[] = [];
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.close()));
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function launch(dataDirectory: string) {
  const runtime = await startRuntime({
    generation: randomUUID(),
    appVersion: '0.10.0',
    mode: 'headless',
    dataDirectory,
  });
  runtimes.push(runtime);
  return runtime;
}

describe('Bookmark Runtime API', () => {
  it('enforces both aggregate preconditions for atomic SSH Bookmark create and delete', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'axterm-ssh-bookmark-runtime-'));
    directories.push(directory);
    const runtime = await launch(directory);
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
    };
    const initial = bookmarkTreeSchema.parse(
      await (await fetch(`${runtime.baseUrl}/api/v1/bookmark-tree`, { headers })).json(),
    );
    const body = JSON.stringify({
      host: {
        name: 'atomic-gateway',
        hostname: 'gateway.example.test',
        port: 2202,
        username: 'operator',
        authType: 'agent',
        credentialRef: null,
        passphraseCredentialRef: null,
        jumpHostId: null,
        favorite: true,
      },
      bookmark: {
        groupId: null,
        title: 'Atomic Gateway',
        color: null,
        description: '',
        profileId: null,
      },
    });

    const preflight = await fetch(`${runtime.baseUrl}/api/v1/ssh-bookmarks/example`, {
      method: 'OPTIONS',
      headers: {
        Origin: runtime.baseUrl,
        'Access-Control-Request-Method': 'DELETE',
        'Access-Control-Request-Headers': 'If-Match, X-Bookmark-Tree-If-Match',
      },
    });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get('access-control-allow-headers')).toContain(
      'X-Bookmark-Tree-If-Match',
    );

    const missingCreatePrecondition = await fetch(`${runtime.baseUrl}/api/v1/ssh-bookmarks`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body,
    });
    expect(missingCreatePrecondition.status).toBe(428);

    const createdResponse = await fetch(`${runtime.baseUrl}/api/v1/ssh-bookmarks`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json', 'If-Match': initial.etag },
      body,
    });
    expect(createdResponse.status).toBe(201);
    const created = sshBookmarkMutationResultSchema.parse(await createdResponse.json());
    expect(createdResponse.headers.get('etag')).toBe(created.tree.etag);
    expect(createdResponse.headers.get('x-host-etag')).toBe(`"v${created.host.version}"`);
    expect(created.bookmark.hostId).toBe(created.host.id);

    const staleCreate = await fetch(`${runtime.baseUrl}/api/v1/ssh-bookmarks`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json', 'If-Match': initial.etag },
      body: body.replaceAll('atomic-gateway', 'orphan-candidate'),
    });
    expect(staleCreate.status).toBe(412);
    expect(
      hostSchema
        .array()
        .parse(await (await fetch(`${runtime.baseUrl}/api/v1/hosts`, { headers })).json()),
    ).toEqual([created.host]);

    const missingHostPrecondition = await fetch(
      `${runtime.baseUrl}/api/v1/ssh-bookmark-hosts/${created.host.id}`,
      {
        method: 'DELETE',
        headers: { ...headers, 'X-Bookmark-Tree-If-Match': created.tree.etag },
      },
    );
    expect(missingHostPrecondition.status).toBe(428);
    const missingTreePrecondition = await fetch(
      `${runtime.baseUrl}/api/v1/ssh-bookmark-hosts/${created.host.id}`,
      {
        method: 'DELETE',
        headers: { ...headers, 'If-Match': `"v${created.host.version}"` },
      },
    );
    expect(missingTreePrecondition.status).toBe(428);
    const staleTreePrecondition = await fetch(
      `${runtime.baseUrl}/api/v1/ssh-bookmark-hosts/${created.host.id}`,
      {
        method: 'DELETE',
        headers: {
          ...headers,
          'If-Match': `"v${created.host.version}"`,
          'X-Bookmark-Tree-If-Match': initial.etag,
        },
      },
    );
    expect(staleTreePrecondition.status).toBe(412);
    const staleHostPrecondition = await fetch(
      `${runtime.baseUrl}/api/v1/ssh-bookmark-hosts/${created.host.id}`,
      {
        method: 'DELETE',
        headers: {
          ...headers,
          'If-Match': '"v99"',
          'X-Bookmark-Tree-If-Match': created.tree.etag,
        },
      },
    );
    expect(staleHostPrecondition.status).toBe(412);

    const deletedResponse = await fetch(
      `${runtime.baseUrl}/api/v1/ssh-bookmark-hosts/${created.host.id}`,
      {
        method: 'DELETE',
        headers: {
          ...headers,
          'If-Match': `"v${created.host.version}"`,
          'X-Bookmark-Tree-If-Match': created.tree.etag,
        },
      },
    );
    expect(deletedResponse.status).toBe(200);
    const deleted = deleteSshBookmarkResultSchema.parse(await deletedResponse.json());
    expect(deleted.bookmarkIds).toEqual([created.bookmark.id]);
    expect(deleted.tree.revision).toBe(created.tree.revision + 1);
    expect(deleted.tree.bookmarks).toEqual([]);
    expect(
      hostSchema
        .array()
        .parse(await (await fetch(`${runtime.baseUrl}/api/v1/hosts`, { headers })).json()),
    ).toEqual([]);
  });

  it('updates and deletes one SSH Bookmark through the typed aggregate client', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'axterm-ssh-bookmark-row-runtime-'));
    directories.push(directory);
    const runtime = await launch(directory);
    const client = createRuntimeClient({ resolve: async () => runtime.bootstrap() });

    let tree = await client.bookmarkTree();
    tree = await client.createBookmarkGroup(tree, { name: 'Source' });
    tree = await client.createBookmarkGroup(tree, { name: 'Destination' });
    const source = tree.groups.find(({ name }) => name === 'Source')!;
    const destination = tree.groups.find(({ name }) => name === 'Destination')!;
    const saved = await client.createSshBookmark(tree, {
      host: {
        name: 'row-target',
        hostname: 'old.example.test',
        port: 22,
        username: 'operator',
        authType: 'agent',
      },
      bookmark: { groupId: source.id, title: 'Row target' },
    });
    tree = await client.createBookmark(saved.tree, {
      protocol: 'ssh',
      hostId: saved.host.id,
      groupId: source.id,
      title: 'Shared target',
    });
    const sharedBookmark = tree.bookmarks.find(({ id }) => id !== saved.bookmark.id)!;

    const updated = await client.updateSshBookmark(tree, saved.host, saved.bookmark.id, {
      host: { hostname: 'new.example.test', port: 2202, username: 'deploy' },
      bookmark: {
        groupId: destination.id,
        title: 'Updated row target',
        color: '#aabbcc',
        description: 'Updated from the protocol form',
      },
    });
    expect(updated.tree.revision).toBe(tree.revision + 1);
    expect(updated.host).toMatchObject({
      hostname: 'new.example.test',
      port: 2202,
      username: 'deploy',
      version: saved.host.version + 1,
    });
    expect(updated.bookmark).toMatchObject({
      groupId: destination.id,
      title: 'Updated row target',
      color: '#aabbcc',
      connectionDisplay: 'deploy@new.example.test:2202',
      position: 0,
    });
    expect(
      updated.tree.bookmarks
        .filter(({ groupId }) => groupId === source.id)
        .map(({ id, position }) => ({ id, position })),
    ).toEqual([{ id: sharedBookmark.id, position: 0 }]);

    const retained = await client.deleteSshBookmark(
      updated.tree,
      updated.host,
      updated.bookmark.id,
    );
    expect(retained).toMatchObject({
      hostId: updated.host.id,
      hostDeleted: false,
      remainingBookmarkIds: [sharedBookmark.id],
      retainedBy: ['bookmark'],
    });
    const removed = await client.deleteSshBookmark(retained.tree, updated.host, sharedBookmark.id);
    expect(removed).toMatchObject({
      hostId: updated.host.id,
      hostDeleted: true,
      remainingBookmarkIds: [],
      retainedBy: [],
    });

    const bootstrap = runtime.bootstrap();
    const login = await fetch(`${runtime.baseUrl}/api/v1/auth/bootstrap`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ bootstrapToken: bootstrap.bootstrapToken }),
    });
    const token = bootstrapResponseSchema.parse(await login.json()).sessionToken;
    expect(
      hostSchema.array().parse(
        await (
          await fetch(`${runtime.baseUrl}/api/v1/hosts`, {
            headers: {
              Authorization: `Bearer ${token}`,
              'X-Runtime-Generation': runtime.metadata.generation,
            },
          })
        ).json(),
      ),
    ).toEqual([]);
    client.dispose();
  });

  it('persists nested bookmarks, enforces the tree ETag and rejects descendant moves', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'axterm-bookmark-runtime-'));
    directories.push(directory);
    let runtime = await launch(directory);
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
    };
    const rawTree = await fetch(`${runtime.baseUrl}/api/v1/bookmark-tree`, { headers });
    expect(rawTree.status).toBe(200);
    expect(rawTree.headers.get('etag')).toBe('"bookmark-tree-v1"');
    const missingIfMatch = await fetch(`${runtime.baseUrl}/api/v1/bookmark-groups`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Missing precondition' }),
    });
    expect(missingIfMatch.status).toBe(428);
    expect(await missingIfMatch.json()).toMatchObject({ code: 'PRECONDITION_REQUIRED' });

    let client = createRuntimeClient({ resolve: async () => runtime.bootstrap() });

    const empty = await client.bookmarkTree();
    const withRoot = await client.createBookmarkGroup(empty, {
      name: 'Production',
      color: '#0088cc',
      description: 'Production systems',
    });
    const root = withRoot.groups[0]!;
    const withChild = await client.createBookmarkGroup(withRoot, {
      parentId: root.id,
      name: 'Asia',
    });
    const child = withChild.groups.find((group) => group.name === 'Asia')!;
    const saved = await client.createSshBookmark(withChild, {
      host: {
        name: 'gateway',
        hostname: 'gateway.example.test',
        port: 2202,
        username: 'operator',
        authType: 'agent',
        credentialRef: null,
        passphraseCredentialRef: null,
        jumpHostId: null,
        favorite: true,
      },
      bookmark: {
        groupId: child.id,
        title: 'Gateway',
        description: 'Primary bastion',
      },
    });
    const { host, tree: complete } = saved;

    await expect(client.createBookmarkGroup(empty, { name: 'stale' })).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      status: 412,
    });
    await expect(
      client.moveBookmarkTreeNode(complete, {
        source: { kind: 'group', id: root.id },
        target: { kind: 'group', id: child.id },
        position: 'inside',
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT', status: 409 });

    expect(complete.bookmarks[0]).toMatchObject({
      hostId: host.id,
      connectionDisplay: 'operator@gateway.example.test:2202',
    });
    client.dispose();
    await runtime.close();
    runtimes.splice(runtimes.indexOf(runtime), 1);

    runtime = await launch(directory);
    client = createRuntimeClient({ resolve: async () => runtime.bootstrap() });
    expect(await client.bookmarkTree()).toEqual(complete);
    client.dispose();
  });
});
