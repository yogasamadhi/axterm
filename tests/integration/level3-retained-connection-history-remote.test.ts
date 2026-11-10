import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import type * as Ssh2 from 'ssh2';
import { afterEach, expect, it, vi } from 'vitest';
import * as Connections from '../../packages/plugins/connections/src/client/index.ts';
import type { CatalogHistoryQuery } from '@axterm/plugin-api/catalog';
import { remoteProfile, remoteValue } from '../fixtures/level3-remote-profile.ts';
const ssh = createRequire(
  new URL('../../packages/plugins/connections/package.json', import.meta.url),
)('ssh2') as typeof Ssh2;
const closes: (() => Promise<unknown>)[] = [],
  directories: string[] = [];
afterEach(async () => {
  for (const close of closes.splice(0).reverse()) await close();
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});
const secret = 'runtime-history-secret-marker';
const authentications = new Map<number, number>();
async function endpoint() {
  const peers = new Set<Ssh2.Connection>();
  let boundPort = 0;
  const server = new ssh.Server(
    { hostKeys: [ssh.utils.generateKeyPairSync('ecdsa', { bits: 256 }).private] },
    (peer) => {
      peers.add(peer);
      peer.on('error', () => {});
      peer.on('close', () => peers.delete(peer));
      peer.on('authentication', (context) => {
        if (context.method === 'password' && context.password === secret) {
          authentications.set(boundPort, (authentications.get(boundPort) ?? 0) + 1);
          context.accept();
        } else context.reject(['password']);
      });
    },
  );
  closes.push(async () => {
    for (const peer of peers) peer.end();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw Error('SSH fixture did not bind');
  boundPort = address.port;
  authentications.set(boundPort, 0);
  return address.port;
}
async function launch(home: string) {
  const runtime = await remoteProfile(home, { application: true });
  closes.push(() => runtime.close());
  await runtime.client.plugin(Connections);
  const model = runtime.client.connectionsModel;
  await vi.waitFor(() => expect(model.getSnapshot().status).toBe('ready'));
  const generation = runtime.application.ctx.runtimeIdentity.generation;
  return {
    ...runtime,
    model,
    generation,
    history: (query: CatalogHistoryQuery = {}) =>
      remoteValue(runtime.client.remote.catalog.listConnectionHistory(generation, query)),
  };
}
async function ready(runtime: Awaited<ReturnType<typeof launch>>, id: string) {
  const answered = new Set<string>();
  await vi.waitFor(
    async () => {
      const state = runtime.model.getSnapshot();
      if (state.status !== 'ready') throw Error('Connection baseline unavailable');
      for (const challenge of state.baseline.interactions.filter(
        (item) => item.connectionId === id,
      ))
        if (!answered.has(challenge.id)) {
          answered.add(challenge.id);
          expect(challenge.kind).toBe('unknownHostKey');
          await runtime.model.respondInteraction(challenge.id, { accepted: true, remember: true });
        }
      const current = runtime.model.getSnapshot();
      expect(
        current.status === 'ready' &&
          current.baseline.connections.find((item) => item.id === id)?.state,
      ).toBe('ready');
    },
    { timeout: 5000 },
  );
}
async function connect(
  runtime: Awaited<ReturnType<typeof launch>>,
  port: number,
  name: string,
  username = 'operator',
) {
  const connection = await runtime.model.createConnection(randomUUID(), {
    target: { name, hostname: '127.0.0.1', port, username, authType: 'password' },
    temporarySecret: secret,
  });
  await ready(runtime, connection.id);
  return connection;
}
it('retains persistent history sorting, pagination, stale cursors, reconnect, promotion, deletion and privacy through actual authenticated Profile restarts', async () => {
  const firstPort = await endpoint(),
    frequentPort = await endpoint(),
    home = await mkdtemp(join(tmpdir(), 'axterm-owned-history-'));
  directories.push(home);
  let runtime = await launch(home);
  await connect(runtime, firstPort, 'First target');
  await vi.waitFor(async () => expect((await runtime.history()).total).toBe(1));
  await connect(runtime, frequentPort, 'Frequent target');
  await vi.waitFor(async () => expect((await runtime.history()).total).toBe(2));
  await connect(runtime, frequentPort, 'Frequent target');
  await vi.waitFor(async () =>
    expect((await runtime.history({ sort: 'frequency' })).items[0]).toMatchObject({
      port: frequentPort,
      count: 2,
    }),
  );
  const page = await runtime.history({ sort: 'recent', limit: 1 });
  expect(page.nextCursor).not.toBeNull();
  expect(
    (await runtime.history({ sort: 'recent', limit: 1, cursor: page.nextCursor! })).items,
  ).toHaveLength(1);
  await runtime.close();
  for (const suffix of ['', '-wal']) {
    const bytes = await readFile(join(home, 'data-v2', 'axterm.sqlite') + suffix).catch(
      (error: NodeJS.ErrnoException) => {
        if (suffix && error.code === 'ENOENT') return Buffer.alloc(0);
        throw error;
      },
    );
    expect(bytes.includes(secret)).toBe(false);
  }
  runtime = await launch(home);
  const persisted = await runtime.history({ sort: 'frequency' });
  expect(persisted.items).toHaveLength(2);
  expect(persisted.items[0]).toMatchObject({ port: frequentPort, count: 2 });
  expect(
    (await runtime.history({ sort: 'recent', limit: 1, cursor: page.nextCursor! })).items,
  ).toHaveLength(1);
  const first = persisted.items.find((item) => item.port === firstPort)!,
    key = randomUUID(),
    version = `"v${first.version}"`;
  const beforeAuthentication = authentications.get(firstPort)!;
  const reconnected = await runtime.model.reconnectConnectionHistory(
    key,
    first.id,
    { temporarySecret: secret },
    version,
  );
  expect(
    await runtime.model.reconnectConnectionHistory(
      key,
      first.id,
      { temporarySecret: secret },
      version,
    ),
  ).toMatchObject({
    id: reconnected.id,
    hostId: reconnected.hostId,
    createdAt: reconnected.createdAt,
  });
  await ready(runtime, reconnected.id);
  expect(authentications.get(firstPort)).toBe(beforeAuthentication + 1);
  await vi.waitFor(async () =>
    expect(
      (await runtime.history()).items.find((item) => item.id === first.id)!.version,
    ).toBeGreaterThan(first.version),
  );
  expect((await runtime.history()).items.find((item) => item.id === first.id)!.count).toBe(
    first.count + 1,
  );
  await expect(
    remoteValue(
      runtime.client.remote.catalog.deleteConnectionHistory(randomUUID(), first.id, version),
    ),
  ).rejects.toMatchObject({ code: 'catalog/failure', details: { reason: 'precondition-failed' } });
  await expect(
    runtime.history({ sort: 'recent', limit: 1, cursor: page.nextCursor! }),
  ).rejects.toMatchObject({ code: 'catalog/failure', details: { reason: 'precondition-failed' } });
  const refreshed = await runtime.history({ sort: 'recent' }),
    promotable = refreshed.items.find((item) => item.id === first.id)!,
    tree = await remoteValue(runtime.client.remote.catalog.getBookmarkTree()),
    promoteKey = randomUUID();
  const promoted = await remoteValue(
    runtime.client.remote.catalog.promoteConnectionHistoryToBookmark(
      promoteKey,
      first.id,
      { title: 'Saved from history' },
      `"v${promotable.version}"`,
      tree.etag,
    ),
  );
  expect(promoted.createdHost).toBe(true);
  expect(promoted.treeRevision).toBe(tree.revision + 1);
  expect(
    await remoteValue(runtime.client.remote.catalog.getBookmark(promoted.bookmarkId)),
  ).toMatchObject({ title: 'Saved from history', protocol: 'ssh' });
  expect(
    await remoteValue(
      runtime.client.remote.catalog.promoteConnectionHistoryToBookmark(
        promoteKey,
        first.id,
        { title: 'Saved from history' },
        `"v${promotable.version}"`,
        tree.etag,
      ),
    ),
  ).toEqual(promoted);
  const after = await runtime.history(),
    removable = after.items.find((item) => item.port === frequentPort)!,
    deleteKey = randomUUID(),
    deleted = await remoteValue(
      runtime.client.remote.catalog.deleteConnectionHistory(
        deleteKey,
        removable.id,
        `"v${removable.version}"`,
      ),
    );
  expect(
    await remoteValue(
      runtime.client.remote.catalog.deleteConnectionHistory(
        deleteKey,
        removable.id,
        `"v${removable.version}"`,
      ),
    ),
  ).toEqual(deleted);
  const beforeClear = await runtime.history(),
    clearKey = randomUUID(),
    cleared = await remoteValue(
      runtime.client.remote.catalog.clearConnectionHistory(clearKey, beforeClear.etag),
    );
  expect(cleared.deletedCount).toBe(1);
  expect(
    await remoteValue(
      runtime.client.remote.catalog.clearConnectionHistory(clearKey, beforeClear.etag),
    ),
  ).toEqual(cleared);
  await connect(runtime, firstPort, 'Before privacy disable', 'privacy-before');
  await vi.waitFor(async () => expect((await runtime.history()).total).toBe(1));
  const settings = await remoteValue(runtime.client.remote.configuration.getSettings());
  await runtime.client.settingsModel.updateSettings(
    randomUUID(),
    { privacy: { connectionHistoryEnabled: false } },
    `"v${settings.version}"`,
  );
  expect((await runtime.history()).items).toEqual([]);
  await connect(runtime, firstPort, 'After privacy disable', 'privacy-after');
  expect((await runtime.history()).items).toEqual([]);
}, 20000);
