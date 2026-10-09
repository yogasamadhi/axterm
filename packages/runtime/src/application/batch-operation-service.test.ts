import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { BatchOperationRepository } from '../adapters/sqlite/batch-operation-repository';
import { BookmarkRepository } from '../adapters/sqlite/bookmark-repository';
import { ProductDatabase } from '../adapters/sqlite/database';
import { ProductRepository } from '../adapters/sqlite/product-repository';
import type { ConnectionService } from './connection-service';
import { BookmarkTreeService } from './bookmark-tree-service';
import { RealtimeHub } from './realtime-hub';
import { BatchOperationService } from './batch-operation-service';

interface FakeConnection {
  id: string;
  state: 'ready' | 'closed';
}

class FakeConnections {
  private readonly connections = new Map<string, FakeConnection>();
  activeExec = 0;
  maximumActiveExec = 0;
  readonly commands: string[] = [];

  create() {
    const connection = { id: randomUUID(), state: 'ready' as const };
    this.connections.set(connection.id, connection);
    return {
      ...connection,
      hostId: randomUUID(),
      reconnectAttempt: 0,
      nextReconnectAt: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
  }

  get(id: string) {
    const connection = this.connections.get(id)!;
    return {
      ...connection,
      hostId: randomUUID(),
      reconnectAttempt: 0,
      nextReconnectAt: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
  }

  async exec(_id: string, input: { command: string; signal?: AbortSignal }) {
    this.commands.push(input.command);
    this.activeExec += 1;
    this.maximumActiveExec = Math.max(this.maximumActiveExec, this.activeExec);
    try {
      await delay(20, input.signal);
      return {
        stdout: `output:${input.command}`,
        stderr: '',
        exitCode: input.command === 'fail' ? 7 : 0,
      };
    } finally {
      this.activeExec -= 1;
    }
  }

  async close(id: string) {
    this.connections.delete(id);
  }
}

describe('BatchOperationService', () => {
  it('runs ordered steps over SSH bookmarks with bounded concurrency and persisted summaries', async () => {
    const database = await ProductDatabase.open();
    try {
      const product = new ProductRepository(database);
      const bookmarks = new BookmarkTreeService(new BookmarkRepository(database));
      const bookmarkIds = createBookmarks(product, bookmarks, 4);
      const connections = new FakeConnections();
      const service = new BatchOperationService(
        new BatchOperationRepository(database),
        product,
        bookmarks,
        connections as unknown as ConnectionService,
        new RealtimeHub(),
      );
      const operation = service.create(
        {
          name: 'Fleet health',
          bookmarkIds,
          concurrency: 2,
          connectionTimeoutMs: 5_000,
          steps: [step('First', 'one'), step('Second', 'two')],
        },
        randomUUID(),
      );
      const complete = await waitForCompletion(service, operation.id);

      expect(complete).toMatchObject({
        state: 'succeeded',
        targetCount: 4,
        completedCount: 4,
        succeededCount: 4,
        failedCount: 0,
      });
      expect(connections.maximumActiveExec).toBe(2);
      expect(complete.targets.every((target) => target.steps[0]?.name === 'First')).toBe(true);
      expect(JSON.stringify(complete)).not.toContain('output:');
      expect(
        JSON.stringify(
          database.all("SELECT payload FROM domain_events WHERE type LIKE 'batch-operation.%'"),
        ),
      ).not.toContain('one');
    } finally {
      database.close();
    }
  });

  it('stops an active run and marks remaining targets and steps canceled', async () => {
    const database = await ProductDatabase.open();
    try {
      const product = new ProductRepository(database);
      const bookmarks = new BookmarkTreeService(new BookmarkRepository(database));
      const connections = new FakeConnections();
      const service = new BatchOperationService(
        new BatchOperationRepository(database),
        product,
        bookmarks,
        connections as unknown as ConnectionService,
        new RealtimeHub(),
      );
      const operation = service.create(
        {
          name: 'Cancelable',
          bookmarkIds: createBookmarks(product, bookmarks, 3),
          concurrency: 1,
          steps: [step('Wait', 'wait')],
        },
        randomUUID(),
      );
      service.cancel(operation.id);
      const complete = await waitForCompletion(service, operation.id);

      expect(complete.state).toBe('canceled');
      expect(complete.canceledCount).toBe(3);
      expect(complete.targets.every(({ state }) => state === 'canceled')).toBe(true);
    } finally {
      database.close();
    }
  });

  it('marks unfinished persisted work interrupted after a Runtime restart', async () => {
    const database = await ProductDatabase.open();
    try {
      const repository = new BatchOperationRepository(database);
      const now = new Date().toISOString();
      const targetId = randomUUID();
      repository.create({
        id: randomUUID(),
        name: 'Interrupted',
        state: 'running',
        concurrency: 1,
        targetCount: 1,
        completedCount: 0,
        succeededCount: 0,
        failedCount: 0,
        canceledCount: 0,
        targets: [
          {
            bookmarkId: targetId,
            title: 'Server',
            state: 'running',
            steps: [
              {
                stepId: randomUUID(),
                name: 'Check',
                state: 'running',
                exitCode: null,
                startedAt: now,
              },
            ],
            startedAt: now,
          },
        ],
        createdAt: now,
        updatedAt: now,
        version: 1,
      });

      const recovered = new BatchOperationRepository(database).list()[0]!;
      expect(recovered).toMatchObject({
        state: 'interrupted',
        completedCount: 1,
        failedCount: 1,
        targets: [
          {
            state: 'failed',
            errorCode: 'RUNTIME_INTERRUPTED',
            steps: [{ state: 'canceled', errorCode: 'RUNTIME_INTERRUPTED' }],
          },
        ],
      });
    } finally {
      database.close();
    }
  });
});

function createBookmarks(
  product: ProductRepository,
  bookmarks: BookmarkTreeService,
  count: number,
): string[] {
  let tree = bookmarks.snapshot();
  const ids: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const host = product.createHost({
      groupId: null,
      name: `Host ${index + 1}`,
      hostname: `server-${index + 1}.example`,
      port: 22,
      username: 'operator',
      authType: 'agent',
      credentialRef: null,
      passphraseCredentialRef: null,
      jumpHostId: null,
      favorite: false,
    });
    tree = bookmarks.createBookmark(
      { protocol: 'ssh', hostId: host.id, title: `Server ${index + 1}` },
      tree.etag,
    );
    ids.push(tree.bookmarks.find(({ hostId }) => hostId === host.id)!.id);
  }
  return ids;
}

function step(name: string, command: string) {
  return { id: randomUUID(), name, command, delayMs: 0, continueOnError: false };
}

async function waitForCompletion(service: BatchOperationService, id: string) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const operation = service.get(id);
    if (['succeeded', 'failed', 'canceled', 'interrupted'].includes(operation.state))
      return operation;
    await delay(5);
  }
  throw new Error('Batch operation did not finish');
}

function delay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const timer = setTimeout(resolve, milliseconds);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(signal.reason);
      },
      { once: true },
    );
  });
}
