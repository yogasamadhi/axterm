import { randomUUID } from 'node:crypto';
import type { Context } from '@deepseek-ai/cordis';
import { afterEach, expect, it, vi } from 'vitest';
import type {
  ConfigurationClientActions,
  SettingsBaseline,
} from '@axterm/plugin-api/configuration';
import type {
  CommandHistoryItem,
  CommandHistoryPage,
  TerminalFactsBaseline,
} from '@axterm/plugin-api/terminals';
import { TerminalHistoryCommands } from '../../packages/plugins/terminals/src/client/history/commands.ts';
import { historyPageFor } from '../../packages/plugins/terminals/src/client/history/projection.ts';
import { TerminalDirectoryTracker } from '../../packages/plugins/terminals/src/application/terminal-directory.ts';
import type { TerminalFactsState } from '../../packages/plugins/terminals/src/client/facts.ts';
afterEach(() => vi.unstubAllGlobals());
function fixture() {
  const generation = randomUUID(),
    id = randomUUID(),
    time = new Date().toISOString();
  const item: CommandHistoryItem = {
    id,
    command: 'printf SAFE_HISTORY',
    count: 1,
    version: 1,
    lastUsedAt: time,
    createdAt: time,
    updatedAt: time,
  };
  const page: CommandHistoryPage = {
    revision: 1,
    etag: '"command-history-v1"',
    sort: 'recent',
    search: '',
    limit: 200,
    total: 1,
    items: [item],
    nextCursor: null,
  };
  let state: TerminalFactsState = {
    status: 'ready',
    baseline: {
      generation,
      cursor: 1,
      profiles: [],
      themes: [],
      history: page,
    } satisfies TerminalFactsBaseline,
  };
  let settings = {
    version: 7,
    privacy: { commandHistoryEnabled: true },
  } as unknown as SettingsBaseline['settings'];
  const model = {
    getSnapshot: () => state,
    deleteCommandHistory: vi.fn(async () => ({ id, revision: 2, etag: '"command-history-v2"' })),
    clearCommandHistory: vi.fn(async () => ({
      deletedCount: 1,
      revision: 2,
      etag: '"command-history-v2"',
    })),
  };
  const configuration = {
    getSnapshot: () => ({
      status: 'ready' as const,
      baseline: { generation, cursor: 1, settings },
    }),
    setCommandHistoryEnabled: vi.fn(async () => ({ version: 8, cursor: 2 })),
  };
  const drafts = { insertDraft: vi.fn(async () => {}) };
  const commands = new TerminalHistoryCommands(
    model,
    configuration as unknown as ConfigurationClientActions,
    drafts,
  );
  return {
    generation,
    item,
    page,
    model,
    configuration,
    drafts,
    commands,
    retire: () => {
      state = {
        status: 'ready',
        baseline: { generation: randomUUID(), cursor: 0, profiles: [], themes: [], history: page },
      };
    },
    advanceSettings: () => {
      settings = { ...settings, version: 8 };
    },
  };
}
it('keeps lost history mutations on the original command, version and generation, and never retries after retirement', async () => {
  const f = fixture();
  f.model.deleteCommandHistory.mockRejectedValueOnce(Error('lost'));
  await f.commands.remove(f.item);
  expect(f.commands.getSnapshot().uncertain).toBe(true);
  const original = f.model.deleteCommandHistory.mock.calls[0];
  f.item.version = 99;
  await f.commands.retry();
  expect(f.model.deleteCommandHistory.mock.calls[1]).toEqual(original);
  f.model.clearCommandHistory.mockRejectedValueOnce(Error('lost'));
  await f.commands.clear();
  f.retire();
  await f.commands.retry();
  expect(f.model.clearCommandHistory).toHaveBeenCalledOnce();
  expect(f.commands.getSnapshot().uncertain).toBe(false);
  await f.commands.close();
});
it('uses Configuration ownership and captures the exact privacy precondition for an explicit retry', async () => {
  const f = fixture();
  f.configuration.setCommandHistoryEnabled.mockRejectedValueOnce(Error('lost'));
  await f.commands.setEnabled(false);
  f.advanceSettings();
  await f.commands.retry();
  expect(f.configuration.setCommandHistoryEnabled.mock.calls[0]).toEqual(
    f.configuration.setCommandHistoryEnabled.mock.calls[1],
  );
  expect(f.configuration.setCommandHistoryEnabled.mock.calls[0]).toEqual([
    expect.any(String),
    false,
    '"v7"',
  ]);
  await f.commands.close();
});
it('inserts only a validated draft without newline and joins uncancellable clipboard work on withdrawal', async () => {
  const f = fixture(),
    pending = Promise.withResolvers<void>();
  vi.stubGlobal('navigator', { clipboard: { writeText: vi.fn(() => pending.promise) } });
  await f.commands.insert('active', { ...f.item, command: 'forged\nexecute' });
  expect(f.drafts.insertDraft).toHaveBeenCalledWith(
    'active',
    'printf SAFE_HISTORY',
    expect.any(AbortSignal),
  );
  const copy = f.commands.copy(f.item);
  await Promise.resolve();
  let closed = false;
  const closing = f.commands.close().then(() => {
    closed = true;
  });
  expect(closed).toBe(false);
  pending.resolve();
  await copy;
  await closing;
  expect(() => f.commands.copy(f.item)).toThrow();
});
it('derives bounded search and frequency order without changing the accepted fact baseline', () => {
  const f = fixture(),
    more = { ...f.item, id: randomUUID(), command: 'printf OTHER', count: 3 };
  const page = { ...f.page, items: [f.item, more], total: 2 };
  expect(historyPageFor(page, 'frequency', '').items.map((i) => i.id)).toEqual([
    more.id,
    f.item.id,
  ]);
  expect(historyPageFor(page, 'recent', 'safe').items).toEqual([f.item]);
  expect(page.items).toEqual([f.item, more]);
  void f.commands.close();
});
it('parses fragmented safe OSC submissions and rejects sensitive, whitespace, multiline, malformed and oversized markers', () => {
  const command = vi.fn(),
    tracker = new TerminalDirectoryTracker(null, command),
    feed = (text: string) => tracker.receive(Buffer.from(text));
  feed('\x1b]633;E;printf ');
  feed('SAFE\\x3bprintf TWO\x07');
  expect(command).toHaveBeenCalledWith('printf SAFE;printf TWO');
  for (const value of [
    ' export TOKEN=secret',
    'export API_KEY=secret',
    'echo\\x0apwn',
    'printf\\q',
    'x'.repeat(17000),
  ])
    feed('\x1b]633;E;' + value + '\x07');
  expect(command).toHaveBeenCalledOnce();
  feed('\x1b]633;P;Cwd=/tmp/safe\x07');
  expect(tracker.directory).toBe('/tmp/safe');
});
it('drains the actual generated facts RPC before closing its stream and refuses new work during withdrawal', async () => {
  const { TerminalFactsModel } =
    await import('../../packages/plugins/terminals/src/client/facts.ts');
  const pending = Promise.withResolvers<{
      ok: true;
      value: { deletedCount: number; revision: number; etag: string };
    }>(),
    ended = Promise.withResolvers<void>();
  let streamClosed = false;
  const stream = {
    [Symbol.asyncIterator]() {
      return {
        next: async () => {
          await ended.promise;
          return { done: true as const, value: undefined };
        },
      };
    },
    dispose: async () => {
      streamClosed = true;
      ended.resolve();
    },
  };
  const clear = vi.fn(() => pending.promise);
  const ctx = {
    remote: { $stream: () => stream, terminals: { clearCommandHistory: clear } },
  } as unknown as Context;
  const model = new TerminalFactsModel(ctx),
    write = model.clearCommandHistory(randomUUID(), '"command-history-v1"', randomUUID());
  await Promise.resolve();
  const closing = model.dispose();
  expect(streamClosed).toBe(false);
  await expect(model.clearCommandHistory(randomUUID(), undefined, randomUUID())).rejects.toThrow(
    'MODEL_CLOSED',
  );
  pending.resolve({
    ok: true,
    value: { deletedCount: 1, revision: 2, etag: '"command-history-v2"' },
  });
  await write;
  await closing;
  expect(streamClosed).toBe(true);
  expect(clear).toHaveBeenCalledOnce();
});
