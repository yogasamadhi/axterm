import { describe, expect, it, vi } from 'vitest';
import { COMMAND_HISTORY_MAX_ITEMS } from '@workspace/contracts';
import { etagFor } from './product-repository';
import { ProductDatabase } from './database';
import { CommandHistoryRepository } from './command-history-repository';

describe('CommandHistoryRepository', () => {
  it('aggregates exact lines and supports bounded recent, frequency and literal search pages', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-12T04:00:00.000Z'));
    const database = await ProductDatabase.open();
    const history = new CommandHistoryRepository(database);
    try {
      const frequent = history.record('git status');
      vi.setSystemTime(new Date('2026-09-12T04:01:00.000Z'));
      const repeated = history.record('git status');
      vi.setSystemTime(new Date('2026-09-12T04:02:00.000Z'));
      const literal = history.record('printf 100%_done');

      expect(repeated).toMatchObject({ id: frequent.id, count: 2, version: 2 });
      expect(history.list({ sort: 'recent' }).items.map(({ id }) => id)).toEqual([
        literal.id,
        repeated.id,
      ]);
      expect(history.list({ sort: 'frequency' }).items.map(({ id }) => id)).toEqual([
        repeated.id,
        literal.id,
      ]);
      expect(history.list({ search: '%_', limit: 50 }).items).toEqual([literal]);

      const firstPage = history.list({ sort: 'recent', limit: 1 });
      expect(firstPage.nextCursor).not.toBeNull();
      expect(
        history.list({ sort: 'recent', limit: 1, cursor: firstPage.nextCursor! }).items[0]?.id,
      ).toBe(repeated.id);
      history.record('echo cursor-change');
      expect(() =>
        history.list({ sort: 'recent', limit: 1, cursor: firstPage.nextCursor! }),
      ).toThrowError(expect.objectContaining({ code: 'PRECONDITION_FAILED' }));

      const persistedEvents = database.all<{ payload: string }>(
        "SELECT payload FROM domain_events WHERE type='command-history.recorded'",
      );
      expect(persistedEvents).not.toHaveLength(0);
      expect(persistedEvents.map(({ payload }) => payload).join('\n')).not.toMatch(
        /git status|printf 100%_done|echo cursor-change/u,
      );
    } finally {
      database.close();
      vi.useRealTimers();
    }
  });

  it('retains only 200 distinct commands and enforces item and collection ETags', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-12T05:00:00.000Z'));
    const database = await ProductDatabase.open();
    const history = new CommandHistoryRepository(database);
    try {
      for (let index = 0; index < COMMAND_HISTORY_MAX_ITEMS + 5; index += 1) {
        vi.setSystemTime(new Date(Date.UTC(2026, 8, 12, 5, 0, index)));
        history.record(`echo command-${index}`);
      }
      const page = history.list({ limit: COMMAND_HISTORY_MAX_ITEMS });
      expect(page.total).toBe(COMMAND_HISTORY_MAX_ITEMS);
      expect(page.items[0]?.command).toBe('echo command-204');
      expect(page.items.at(-1)?.command).toBe('echo command-5');
      expect(page.revision).toBe(206);

      const item = page.items[0]!;
      expect(() => history.delete(item.id, etagFor(99))).toThrowError(
        expect.objectContaining({ code: 'PRECONDITION_FAILED' }),
      );
      history.delete(item.id, etagFor(item.version));
      const state = history.state();
      expect(() => history.clear('"command-history-v1"')).toThrowError(
        expect.objectContaining({ code: 'PRECONDITION_FAILED' }),
      );
      expect(history.clear(state.etag).deletedCount).toBe(COMMAND_HISTORY_MAX_ITEMS - 1);
      expect(history.list().items).toEqual([]);
    } finally {
      database.close();
      vi.useRealTimers();
    }
  });
});
