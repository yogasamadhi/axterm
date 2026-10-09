import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  SshConnectionHandle,
  SshTransport,
} from '../../packages/runtime/src/ports/ssh-transport';
import { createRuntimeClient } from '../../packages/client/src/api-client';
import { startRuntime } from '../../packages/runtime/src/bootstrap/runtime';

const runtimes: Awaited<ReturnType<typeof startRuntime>>[] = [];
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.close()));
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

function successfulTransport(): SshTransport {
  return {
    async connect() {
      const handle: SshConnectionHandle = {
        id: randomUUID(),
        onClose: () => () => {},
        async openShell() {
          throw new Error('unused');
        },
        async openSftp() {
          throw new Error('unused');
        },
        async exec() {
          return { stdout: '', stderr: '', exitCode: 0 };
        },
        async forwardOut() {
          throw new Error('unused');
        },
        async forwardIn() {
          return 0;
        },
        async unforwardIn() {},
        async close() {},
      };
      return handle;
    },
  };
}

async function launch(dataDirectory: string) {
  const runtime = await startRuntime({
    generation: randomUUID(),
    appVersion: '0.10.0',
    mode: 'headless',
    dataDirectory,
    sshTransport: successfulTransport(),
  });
  runtimes.push(runtime);
  return runtime;
}

describe('connection history Runtime contract', () => {
  it('persists, sorts, reconnects, promotes, deletes, clears and obeys the privacy setting', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'axterm-history-runtime-'));
    directories.push(directory);
    let runtime = await launch(directory);
    let client = createRuntimeClient({ resolve: async () => runtime.bootstrap() });
    await client.status();

    const first = await client.createQuickConnection(
      {
        name: 'First target',
        hostname: 'first.example',
        username: 'operator',
        authType: 'password',
      },
      'runtime-history-secret-marker',
    );
    await vi.waitFor(async () => {
      expect((await client.connections()).find(({ id }) => id === first.id)?.state).toBe('ready');
      expect((await client.connectionHistory()).total).toBe(1);
    });
    const second = await client.createQuickConnection({
      name: 'Frequent target',
      hostname: 'frequent.example',
      username: 'operator',
      authType: 'agent',
    });
    await vi.waitFor(async () => {
      expect((await client.connections()).find(({ id }) => id === second.id)?.state).toBe('ready');
      expect((await client.connectionHistory()).total).toBe(2);
    });
    const secondAgain = await client.createQuickConnection({
      name: 'Frequent target',
      hostname: 'frequent.example',
      username: 'operator',
      authType: 'agent',
    });
    await vi.waitFor(async () => {
      expect((await client.connections()).find(({ id }) => id === secondAgain.id)?.state).toBe(
        'ready',
      );
      expect((await client.connectionHistory({ sort: 'frequency' })).items[0]).toMatchObject({
        hostname: 'frequent.example',
        count: 2,
      });
    });
    const pageBeforeRestart = await client.connectionHistory({ sort: 'recent', limit: 1 });
    expect(pageBeforeRestart.nextCursor).not.toBeNull();
    expect(
      (
        await client.connectionHistory({
          sort: 'recent',
          limit: 1,
          cursor: pageBeforeRestart.nextCursor!,
        })
      ).items,
    ).toHaveLength(1);

    client.dispose();
    await runtime.close();
    runtimes.splice(runtimes.indexOf(runtime), 1);
    expect((await readFile(join(directory, 'axterm.sqlite'))).toString('utf8')).not.toContain(
      'runtime-history-secret-marker',
    );

    runtime = await launch(directory);
    client = createRuntimeClient({ resolve: async () => runtime.bootstrap() });
    const persisted = await client.connectionHistory({ sort: 'frequency' });
    expect(persisted.items).toHaveLength(2);
    expect(
      (
        await client.connectionHistory({
          sort: 'recent',
          limit: 1,
          cursor: pageBeforeRestart.nextCursor!,
        })
      ).items,
    ).toHaveLength(1);
    const firstItem = persisted.items.find(({ hostname }) => hostname === 'first.example')!;
    const reconnectKey = randomUUID();
    const reconnected = await client.reconnectConnectionHistory(
      firstItem,
      'another-one-use-secret',
      undefined,
      reconnectKey,
    );
    expect(
      await client.reconnectConnectionHistory(
        firstItem,
        'another-one-use-secret',
        undefined,
        reconnectKey,
      ),
    ).toEqual(reconnected);
    await vi.waitFor(async () => {
      expect(
        (await client.connections()).find(({ id }) => id === reconnected.connection.id)?.state,
      ).toBe('ready');
    });
    await expect(client.deleteConnectionHistory(firstItem)).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      status: 412,
    });
    await expect(
      client.connectionHistory({
        sort: 'recent',
        limit: 1,
        cursor: pageBeforeRestart.nextCursor!,
      }),
    ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED', status: 412 });

    const refreshed = await client.connectionHistory({ sort: 'recent' });
    const promotable = refreshed.items.find(({ id }) => id === firstItem.id)!;
    const tree = await client.bookmarkTree();
    const promoteKey = randomUUID();
    const promoted = await client.promoteConnectionHistory(
      promotable,
      tree,
      { title: 'Saved from history' },
      promoteKey,
    );
    expect(promoted).toMatchObject({
      createdHost: true,
      bookmark: { title: 'Saved from history', protocol: 'ssh' },
      tree: { revision: tree.revision + 1 },
    });
    expect(
      await client.promoteConnectionHistory(
        promotable,
        tree,
        { title: 'Saved from history' },
        promoteKey,
      ),
    ).toEqual(promoted);

    const afterPromotion = await client.connectionHistory();
    const removable = afterPromotion.items.find(({ hostname }) => hostname === 'frequent.example')!;
    const deleteKey = randomUUID();
    const deleted = await client.deleteConnectionHistory(removable, deleteKey);
    expect(await client.deleteConnectionHistory(removable, deleteKey)).toEqual(deleted);
    const beforeClear = await client.connectionHistory();
    const clearKey = randomUUID();
    const cleared = await client.clearConnectionHistory(beforeClear, clearKey);
    expect(cleared.deletedCount).toBe(1);
    expect(await client.clearConnectionHistory(beforeClear, clearKey)).toEqual(cleared);

    await client.createQuickConnection({
      name: 'Before privacy disable',
      hostname: 'privacy-before.example',
      username: 'operator',
      authType: 'agent',
    });
    await vi.waitFor(async () => expect((await client.connectionHistory()).total).toBe(1));
    const settings = await client.settings();
    await client.updateSettings(settings, { privacy: { connectionHistoryEnabled: false } });
    expect((await client.connectionHistory()).items).toEqual([]);
    const disabledConnection = await client.createQuickConnection({
      name: 'After privacy disable',
      hostname: 'privacy-after.example',
      username: 'operator',
      authType: 'agent',
    });
    await vi.waitFor(async () => {
      expect(
        (await client.connections()).find(({ id }) => id === disabledConnection.id)?.state,
      ).toBe('ready');
    });
    expect((await client.connectionHistory()).items).toEqual([]);
    client.dispose();
  });
});
