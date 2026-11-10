import { RemoteError } from '@axterm/plugin-api';
import { afterEach, expect, it, vi } from 'vitest';
import {
  terminalSessionSchema,
  commandHistoryItemSchema,
  commandHistoryPageSchema,
  type TerminalFactsBaseline,
  type TerminalBaseline,
} from '@axterm/plugin-api/terminals';
import { aiModelSchema, type AiBaseline } from '@axterm/plugin-api/ai';
import type { TranslateNS } from '@axterm/ui';
import type { AiCommandSuggestionsUi } from '@axterm/ui/workspace';
import { TerminalSuggestionOwner } from '../../packages/plugins/terminals/src/client/suggestions/owner.ts';
afterEach(() => vi.useRealTimers());
function fixture(integrated = true) {
  let generation = crypto.randomUUID();
  const id = crypto.randomUUID(),
    listeners = new Set<() => void>(),
    session = terminalSessionSchema.parse({
      id,
      kind: 'local',
      title: 'Fixture',
      state: 'ready',
      createdAt: new Date().toISOString(),
    });
  const item = commandHistoryItemSchema.parse({
    id: crypto.randomUUID(),
    command: 'git status',
    count: 3,
    lastUsedAt: new Date().toISOString(),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    version: 1,
  });
  const history = commandHistoryPageSchema.parse({
    revision: 1,
    etag: '"command-history-v1"',
    sort: 'recent',
    search: '',
    limit: 200,
    total: 1,
    items: [item],
    nextCursor: null,
  });
  const model = aiModelSchema.parse({
    id: crypto.randomUUID(),
    providerId: crypto.randomUUID(),
    name: 'Fixture',
    model: 'fixture',
    capabilities: ['chat'],
    version: 1,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
  const ai = {
    getSnapshot: () => ({
      status: 'ready' as const,
      baseline: {
        generation,
        cursor: 0,
        revision: 1,
        providers: [],
        models: [model],
        conversations: [],
        runs: [],
        approvals: [],
        engines: [],
      } satisfies AiBaseline,
    }),
    subscribe: (_listener: () => void) => () => {},
    retry: async () => {},
    suggestCommands: vi.fn(
      async (
        _input: Parameters<AiCommandSuggestionsUi['suggestCommands']>[0],
        _signal?: AbortSignal,
      ) => '["git status"]',
    ),
  };
  const send = vi.fn((_text: string) => true),
    focus = vi.fn(),
    remove = vi.fn(async () => {}),
    changed = vi.fn();
  const t: TranslateNS<'terminals'> = (key) => key;
  const owner = new TerminalSuggestionOwner({
    id,
    generation,
    sessions: {
      getSnapshot: () => ({
        status: 'ready' as const,
        baseline: {
          type: 'baseline',
          generation,
          revision: 1,
          sessions: [session],
        } satisfies TerminalBaseline,
      }),
    },
    facts: {
      getSnapshot: () => ({
        status: 'ready' as const,
        baseline: {
          generation,
          cursor: 1,
          profiles: [],
          themes: [],
          history,
        } satisfies TerminalFactsBaseline,
      }),
      subscribe: (listener) => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
    },
    enabled: () => true,
    active: () => true,
    position: () => ({ position: { left: 8, top: 20 }, reverse: false }),
    ai: () => ai,
    remove,
    send,
    focus,
    t,
    changed,
  });
  if (integrated) owner.integration('active');
  return {
    owner,
    ai,
    send,
    focus,
    item,
    listeners,
    retire: () => {
      generation = crypto.randomUUID();
      for (const listener of [...listeners]) listener();
    },
  };
}
it('derives canonical history after a prompt and arrow/Enter selection inserts only the suffix without execution', async () => {
  vi.useFakeTimers();
  const f = fixture();
  f.owner.userInput('password');
  await vi.advanceTimersByTimeAsync(80);
  expect(f.owner.getSnapshot()).toBeUndefined();
  f.owner.prompt('A');
  f.owner.userInput('git ');
  await vi.advanceTimersByTimeAsync(80);
  expect(f.owner.getSnapshot()?.items.map((item) => item.command)).toEqual(['git status']);
  expect(f.owner.key({ type: 'keydown', key: 'ArrowDown' })).toBe(true);
  expect(f.owner.key({ type: 'keydown', key: 'Enter' })).toBe(true);
  expect(f.send).toHaveBeenCalledExactlyOnceWith('status');
  expect(f.send.mock.calls[0]?.[0]).not.toMatch(/[\r\n]/);
  expect(f.owner.getSnapshot()).toBeUndefined();
  await f.owner.close();
  expect(f.listeners.size).toBe(0);
});
it('retains an aborted AI call slot and joins its real completion, discarding results for the previous prefix', async () => {
  vi.useFakeTimers();
  const f = fixture(),
    gate = Promise.withResolvers<string>();
  f.ai.suggestCommands.mockImplementationOnce(() => gate.promise);
  f.owner.prompt('A');
  f.owner.userInput('git ');
  await vi.advanceTimersByTimeAsync(80);
  const pending = f.owner.requestAi();
  await Promise.resolve();
  f.owner.userInput('s');
  await vi.advanceTimersByTimeAsync(80);
  expect(f.ai.suggestCommands.mock.calls[0]?.[1]?.aborted).toBe(true);
  await expect(f.owner.requestAi()).rejects.toThrow('BUSY');
  let closed = false;
  const closing = f.owner.close().then(() => {
    closed = true;
  });
  await Promise.resolve();
  expect(closed).toBe(false);
  gate.resolve('["git stale"]');
  await pending;
  await closing;
  expect(f.send).not.toHaveBeenCalled();
  expect(f.listeners.size).toBe(0);
});
it('never retargets an old-generation selection or delete to a replacement Host', async () => {
  vi.useFakeTimers();
  const f = fixture();
  f.owner.prompt('A');
  f.owner.userInput('git ');
  await vi.advanceTimersByTimeAsync(80);
  const item = f.owner.getSnapshot()!.items[0]!;
  f.retire();
  f.owner.select(item);
  await expect(f.owner.remove(item)).rejects.toThrow();
  expect(f.send).not.toHaveBeenCalled();
  expect(f.ai.suggestCommands).not.toHaveBeenCalled();
  await f.owner.close();
});
it('keeps a failed AI response visible after releasing its completed slot', async () => {
  vi.useFakeTimers();
  const f = fixture();
  f.ai.suggestCommands.mockRejectedValueOnce(Error('controlled request failure'));
  f.owner.prompt('A');
  f.owner.userInput('git ');
  await vi.advanceTimersByTimeAsync(80);
  await expect(f.owner.requestAi()).rejects.toThrow('controlled request');
  expect(f.owner.getSnapshot()).toMatchObject({
    aiLoading: false,
    aiError: 'app.aiSuggestionsFailed',
  });
  await f.owner.close();
});

it('refuses forged prompts before Host confirmation, throughout replay and after integration withdrawal', async () => {
  vi.useFakeTimers();
  const f = fixture(false);
  const hidden = async () => {
    f.owner.prompt('A');
    f.owner.userInput('git ');
    await vi.advanceTimersByTimeAsync(80);
    expect(f.owner.getSnapshot()).toBeUndefined();
    await expect(f.owner.requestAi()).rejects.toThrow('TERMINAL_SUGGESTION_AI_UNAVAILABLE');
    expect(f.ai.suggestCommands).not.toHaveBeenCalled();
    expect(f.send).not.toHaveBeenCalled();
  };
  await hidden();
  f.owner.integration('active');
  f.owner.replay(true);
  await hidden();
  f.owner.replay(false);
  f.owner.userInput('git ');
  await vi.advanceTimersByTimeAsync(80);
  expect(f.owner.getSnapshot()).toBeUndefined();
  f.owner.prompt('A');
  f.owner.userInput('git ');
  await vi.advanceTimersByTimeAsync(80);
  expect(f.owner.getSnapshot()?.items.map((item) => item.command)).toEqual(['git status']);
  f.owner.prompt('E;git status');
  f.owner.userInput('git ');
  await vi.advanceTimersByTimeAsync(80);
  expect(f.owner.getSnapshot()).toBeUndefined();
  f.owner.prompt('A');
  f.owner.userInput('git ');
  await vi.advanceTimersByTimeAsync(80);
  expect(f.owner.getSnapshot()).toBeDefined();
  f.owner.prompt('C');
  expect(f.owner.getSnapshot()).toBeUndefined();
  f.owner.integration('unavailable');
  await hidden();
  await f.owner.close();
  await hidden();
  expect(f.listeners.size).toBe(0);
});

it('localizes the public suggestion deadline without displaying raw model errors or issuing another request', async () => {
  vi.useFakeTimers();
  const f = fixture();
  f.owner.prompt('A');
  f.owner.userInput('git ');
  await vi.advanceTimersByTimeAsync(80);
  f.ai.suggestCommands.mockRejectedValueOnce(
    new RemoteError('ai/failure', 'PRIVATE_MODEL_TIMEOUT', { reason: 'expired' }),
  );
  await expect(f.owner.requestAi()).rejects.toMatchObject({ code: 'ai/failure' });
  expect(f.owner.getSnapshot()?.aiError).toBe('app.aiSuggestionsTimeout');
  expect(JSON.stringify(f.owner.getSnapshot())).not.toContain('PRIVATE_MODEL_TIMEOUT');
  expect(f.ai.suggestCommands).toHaveBeenCalledOnce();
  await f.owner.close();
});
