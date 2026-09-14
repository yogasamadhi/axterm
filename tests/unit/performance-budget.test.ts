import { performance } from 'node:perf_hooks';
import type { Bookmark, BookmarkGroup, BookmarkTree } from '../../packages/contracts/src/index';
import type { GrantedDirectoryEntry } from '../../packages/contracts/src/host-capabilities/desktop';
import { ProductDatabase } from '../../packages/runtime/src/adapters/sqlite/database';
import { ProductRepository } from '../../packages/runtime/src/adapters/sqlite/product-repository';
import { TerminalService } from '../../packages/runtime/src/application/terminal-service';
import type { TerminalChannel } from '../../packages/runtime/src/ports/terminal-channel';
import { TERMINAL_REPLAY_MAX_BYTES } from '../../packages/contracts/src/index';
import {
  filterFileEntries,
  sortFileEntries,
} from '../../apps/desktop/src/renderer/src/app/file-list-model';
import { buildVisibleBookmarkTree } from '../../apps/desktop/src/renderer/src/app/bookmarks/tree-model';
import { calculateVirtualWindow } from '../../apps/desktop/src/renderer/src/app/virtual-window';
import { describe, expect, it } from 'vitest';

const timestamp = '2026-09-14T00:00:00.000Z';
const budgets = {
  bookmarkProjectionMs: 1_500,
  fileFilterSortMs: 1_500,
  terminal64MiBMs: 4_000,
  transferHistoryQueryMs: 1_500,
} as const;

class ProfileTerminalChannel implements TerminalChannel {
  private readonly dataListeners = new Set<(data: Uint8Array) => void>();
  private readonly exitListeners = new Set<(exitCode: number | null) => void>();

  write(): void {}
  resize(): void {}
  signal(): void {}
  pause(): void {}
  resume(): void {}
  async close(): Promise<void> {}

  onData(listener: (data: Uint8Array) => void): () => void {
    this.dataListeners.add(listener);
    return () => this.dataListeners.delete(listener);
  }

  onExit(listener: (exitCode: number | null) => void): () => void {
    this.exitListeners.add(listener);
    return () => this.exitListeners.delete(listener);
  }

  emitData(data: Uint8Array): void {
    for (const listener of this.dataListeners) listener(data);
  }
}

function measured<T>(operation: () => T): { value: T; durationMs: number } {
  const startedAt = performance.now();
  const value = operation();
  return { value, durationMs: performance.now() - startedAt };
}

function id(value: number): string {
  return `00000000-0000-4000-8000-${value.toString().padStart(12, '0')}`;
}

function largeBookmarkTree(size: number): BookmarkTree {
  const group: BookmarkGroup = {
    id: id(1),
    parentId: null,
    name: 'Production',
    color: null,
    description: '',
    position: 0,
    createdAt: timestamp,
    updatedAt: timestamp,
    version: 1,
  };
  const bookmarks: Bookmark[] = Array.from({ length: size }, (_, index) => ({
    id: id(index + 10),
    groupId: group.id,
    protocol: 'ssh',
    hostId: id(99_999),
    title: `Server ${index.toString().padStart(5, '0')}`,
    color: null,
    description: index === size - 1 ? 'needle performance target' : '',
    position: index,
    profileId: null,
    connectionProfileId: null,
    quickCommands: [],
    triggers: [],
    ftp: null,
    telnet: null,
    serial: null,
    rdp: null,
    vnc: null,
    spice: null,
    web: null,
    connectionDisplay: `operator@host-${index}.example.test:22`,
    createdAt: timestamp,
    updatedAt: timestamp,
    version: 1,
  }));
  return { revision: 1, etag: '"bookmark-tree-v1"', groups: [group], bookmarks };
}

function largeDirectory(size: number): GrantedDirectoryEntry[] {
  return Array.from({ length: size }, (_, index) => ({
    name: `${index % 20 === 0 ? '.' : ''}artifact-${(size - index).toString().padStart(5, '0')}.${index % 3 === 0 ? 'log' : 'txt'}`,
    path: `build/artifact-${index}`,
    type: index % 31 === 0 ? 'directory' : 'file',
    size: index * 37,
    mode: index % 2 === 0 ? 0o644 : 0o755,
    modifiedAt: new Date(Date.UTC(2026, 0, 1, 0, 0, index % 60)).toISOString(),
  }));
}

describe('Phase 21 performance budgets', () => {
  it('projects and searches a 10k bookmark tree within the interaction budget', () => {
    const tree = largeBookmarkTree(10_000);
    const projection = measured(() =>
      buildVisibleBookmarkTree(tree, {
        expandedGroupIds: new Set([tree.groups[0]!.id]),
        query: '',
      }),
    );
    const search = measured(() =>
      buildVisibleBookmarkTree(tree, {
        expandedGroupIds: new Set(),
        query: 'needle performance target',
      }),
    );

    expect(projection.value.rows).toHaveLength(10_001);
    expect(search.value.matchedRowKeys).toHaveLength(1);
    expect(projection.durationMs).toBeLessThan(budgets.bookmarkProjectionMs);
    expect(search.durationMs).toBeLessThan(budgets.bookmarkProjectionMs);
  });

  it('filters and sorts 10k directory entries while keeping the mounted window bounded', () => {
    const entries = largeDirectory(10_000);
    const result = measured(() =>
      sortFileEntries(filterFileEntries(entries, false, 'artifact'), {
        property: 'modifiedAt',
        direction: 'desc',
      }),
    );
    const windows = [0, 160_000, 319_600, Number.MAX_SAFE_INTEGER].map((scrollTop) =>
      calculateVirtualWindow({
        itemCount: result.value.length,
        rowHeight: 32,
        scrollTop,
        viewportHeight: 640,
        overscan: 6,
      }),
    );

    expect(result.value).toHaveLength(9_500);
    expect(result.durationMs).toBeLessThan(budgets.fileFilterSortMs);
    expect(windows.every((window) => window.visibleCount <= 32)).toBe(true);
    expect(windows.at(-1)).toEqual({
      start: result.value.length,
      end: result.value.length,
      visibleCount: 0,
    });
  });

  it('retains a fixed replay ceiling while consuming a simulated 64 MiB terminal stream', async () => {
    const channel = new ProfileTerminalChannel();
    const service = new TerminalService({ open: () => channel });
    try {
      const terminal = service.createLocal({ cols: 80, rows: 24 });
      const chunk = Buffer.alloc(64 * 1024, 120);
      const result = measured(() => {
        for (let index = 0; index < 1_024; index += 1) channel.emitData(chunk);
        return Buffer.byteLength(service.recentOutput(terminal.id));
      });

      expect(result.value).toBeLessThanOrEqual(TERMINAL_REPLAY_MAX_BYTES);
      expect(result.durationMs).toBeLessThan(budgets.terminal64MiBMs);
    } finally {
      await service.closeAll();
    }
  });

  it('queries a bounded 500-row view from 10k persisted transfer records', async () => {
    const database = await ProductDatabase.open();
    try {
      database.transaction(() => {
        for (let index = 0; index < 10_000; index += 1) {
          database.run(
            `INSERT INTO transfer_history(
              id, connection_id, direction, state, source, destination,
              bytes_transferred, total_bytes, bytes_per_second, error_code,
              created_at, updated_at, version
            ) VALUES (?, ?, 'upload', 'succeeded', ?, ?, ?, ?, ?, NULL, ?, ?, 1)`,
            id(index + 100_000),
            id(500_000),
            `/source/${index}`,
            `/destination/${index}`,
            index,
            10_000,
            1_024,
            timestamp,
            new Date(Date.UTC(2026, 0, 1, 0, 0, index % 60, index % 1_000)).toISOString(),
          );
        }
      });
      const result = measured(() => new ProductRepository(database).listTransfers());

      expect(result.value).toHaveLength(500);
      expect(result.value[0]!.updatedAt >= result.value.at(-1)!.updatedAt).toBe(true);
      expect(result.durationMs).toBeLessThan(budgets.transferHistoryQueryMs);
    } finally {
      database.close();
    }
  });
});
