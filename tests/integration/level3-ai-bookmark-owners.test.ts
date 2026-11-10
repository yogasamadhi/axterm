import { expect, it, vi } from 'vitest';
import { aiRunSchema, type AiRunCommandOutcome, type AiRequestInput } from '@axterm/plugin-api/ai';
import {
  createSshBookmarkSchema,
  bookmarkTreeSchema,
  type CatalogBaseline,
  type CatalogReceipt,
} from '@axterm/plugin-api/catalog';
import type { AiState } from '../../packages/plugins/ai/src/client/index.ts';
import type { ClientFactsState } from '@axterm/plugin-api/types';
import { AiRunAdmissions } from '../../packages/plugins/ai/src/client/run-admissions.ts';
import { AiBookmarkFlow } from '../../packages/plugins/ai/src/client/ui/bookmark-flow.ts';
const draft = {
  name: 'Owned AI host',
  title: 'Reviewed AI bookmark',
  hostname: 'example.test',
  port: 22,
  username: 'fixture',
  authType: 'password',
  favorite: false,
  description: 'Explicitly reviewed metadata',
};
function fixture() {
  const generation = crypto.randomUUID(),
    now = new Date().toISOString();
  const run = aiRunSchema.parse({
    id: crypto.randomUUID(),
    engineId: 'pi',
    useCase: 'createBookmark',
    state: 'queued',
    version: 1,
    createdAt: now,
    updatedAt: now,
  });
  let state: AiState = {
    status: 'ready',
    detailRevision: 0,
    baseline: {
      generation,
      cursor: 0,
      revision: 0,
      providers: [],
      models: [],
      conversations: [],
      runs: [],
      approvals: [],
      engines: [],
    },
  };
  const listeners = new Set<() => void>();
  const model = {
    getSnapshot: () => state,
    subscribe: (fn: () => void) => {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
    startRun: vi.fn(async (_key: string, _input: AiRequestInput) => run),
    getRun: vi.fn(async (_id: string) => run),
    getRunCommandOutcome: vi.fn(
      async (_generation: string, _key: string): Promise<AiRunCommandOutcome> => ({
        status: 'missing',
      }),
    ),
    cancelRun: vi.fn(async (_key: string, id: string, _generation?: string) => ({
      ids: [id],
      cursor: 1,
    })),
  };
  let catalogState: ClientFactsState<CatalogBaseline> = {
    status: 'ready',
    baseline: {
      generation,
      cursor: 0,
      hosts: [],
      hostGroups: [],
      connectionProfiles: [],
      bookmarks: bookmarkTreeSchema.parse({
        revision: 1,
        etag: '"bookmark-tree-v1"',
        groups: [],
        bookmarks: [],
      }),
      history: {
        revision: 1,
        etag: '"connection-history-v1"',
        sort: 'recent',
        limit: 25,
        total: 0,
        items: [],
        nextCursor: null,
      },
    },
  };
  const catalogListeners = new Set<() => void>();
  const catalog = {
    getSnapshot: () => catalogState,
    subscribe: (fn: () => void) => {
      catalogListeners.add(fn);
      return () => {
        catalogListeners.delete(fn);
      };
    },
    retry: async () => {},
    createSshBookmark: vi.fn(async (..._args: unknown[]): Promise<CatalogReceipt> => ({
      ids: [],
      cursor: 1,
    })),
  };
  const admissions = new AiRunAdmissions(model);
  const flow = new AiBookmarkFlow(model, catalog, admissions);
  return {
    generation,
    run,
    model,
    listeners,
    catalog,
    catalogListeners,
    admissions,
    flow,
    publish(next: AiState) {
      state = next;
      for (const fn of [...listeners]) fn();
    },
    finish(result = JSON.stringify(draft)) {
      const completed = { ...run, state: 'succeeded' as const, result };
      model.getRun.mockResolvedValue(completed);
      if (state.status !== 'ready') throw new Error('Fixture unavailable');
      state = {
        status: 'ready',
        detailRevision: 0,
        baseline: { ...state.baseline, runs: [{ ...completed, hasResult: true }] },
      };
      for (const fn of [...listeners]) fn();
    },
    catalogCursor(cursor: number) {
      if (catalogState.status !== 'ready') throw new Error('Fixture unavailable');
      catalogState = { status: 'ready', baseline: { ...catalogState.baseline, cursor } };
      for (const fn of [...catalogListeners]) fn();
    },
  };
}
it('recovers an accepted Run after lost admission acknowledgment without repeating a model request', async () => {
  const f = fixture();
  f.model.startRun.mockRejectedValue(new Error('Lost acknowledgment'));
  f.model.getRunCommandOutcome.mockResolvedValue({ status: 'accepted', id: f.run.id });
  const owned = await f.admissions.start({
    modelId: crypto.randomUUID(),
    useCase: 'createBookmark',
    prompt: 'Visible request',
  });
  expect(owned).toEqual({ run: f.run, generation: f.generation });
  expect(f.model.startRun).toHaveBeenCalledTimes(1);
  expect(f.model.getRunCommandOutcome).toHaveBeenCalledExactlyOnceWith(
    f.generation,
    f.model.startRun.mock.calls[0]![0],
  );
  await f.admissions.close();
  expect(f.model.cancelRun).not.toHaveBeenCalled();
});
it('retains unknown admission identities, bounds capacity and refuses an unresolved same-generation drain', async () => {
  const f = fixture();
  f.model.startRun.mockRejectedValue(new Error('Lost acknowledgment'));
  for (let i = 0; i < 8; i++)
    await expect(
      f.admissions.start({
        modelId: crypto.randomUUID(),
        useCase: 'createBookmark',
        prompt: 'Visible request',
      }),
    ).rejects.toThrow();
  await expect(
    f.admissions.start({
      modelId: crypto.randomUUID(),
      useCase: 'createBookmark',
      prompt: 'Another request',
    }),
  ).rejects.toThrow('CAPACITY');
  await expect(f.admissions.close()).rejects.toThrow('DRAIN_FAILED');
  expect(f.model.startRun).toHaveBeenCalledTimes(8);
});
it('owns an accepted identity even if its result read fails and cancels only its captured generation', async () => {
  const f = fixture();
  f.model.startRun.mockRejectedValue(new Error('Lost acknowledgment'));
  f.model.getRunCommandOutcome.mockResolvedValue({ status: 'accepted', id: f.run.id });
  f.model.getRun.mockRejectedValue(new Error('Read interrupted'));
  await expect(
    f.admissions.start({
      modelId: crypto.randomUUID(),
      useCase: 'createBookmark',
      prompt: 'Visible request',
    }),
  ).rejects.toThrow('Read interrupted');
  await f.admissions.close();
  expect(f.model.cancelRun).toHaveBeenCalledExactlyOnceWith(
    expect.any(String),
    f.run.id,
    f.generation,
  );
});
it('joins late admission and actual cancellation on close without sending an old cleanup into a replacement Host', async () => {
  const f = fixture(),
    accepted = Promise.withResolvers<typeof f.run>(),
    cancel = Promise.withResolvers<{ ids: string[]; cursor: number }>();
  f.model.startRun.mockImplementation(() => accepted.promise);
  f.model.cancelRun.mockImplementation(() => cancel.promise);
  const opening = f.admissions.start({
    modelId: crypto.randomUUID(),
    useCase: 'createBookmark',
    prompt: 'Visible request',
  });
  const outcome = Promise.allSettled([opening]);
  await Promise.resolve();
  let stopped = false;
  const close = f.admissions.close().then(() => {
    stopped = true;
  });
  accepted.resolve(f.run);
  await vi.waitFor(() =>
    expect(f.model.cancelRun).toHaveBeenCalledExactlyOnceWith(
      expect.any(String),
      f.run.id,
      f.generation,
    ),
  );
  expect(stopped).toBe(false);
  cancel.resolve({ ids: [f.run.id], cursor: 1 });
  await close;
  expect((await outcome)[0]!.status).toBe('rejected');
  const next = fixture();
  next.model.startRun.mockRejectedValue(new Error('Lost acknowledgment'));
  await expect(
    next.admissions.start({
      modelId: crypto.randomUUID(),
      useCase: 'createBookmark',
      prompt: 'Visible request',
    }),
  ).rejects.toThrow();
  next.publish({
    status: 'ready',
    detailRevision: 0,
    baseline: {
      ...(next.model.getSnapshot() as Extract<AiState, { status: 'ready' }>).baseline,
      generation: crypto.randomUUID(),
    },
  });
  await next.admissions.close();
  expect(next.model.cancelRun).not.toHaveBeenCalled();
});
it('uses a bounded metadata observation instead of polling, parses strict visible draft output and never opens a tool-capable work run', async () => {
  const f = fixture();
  const generating = f.flow.generate({
    modelId: crypto.randomUUID(),
    prompt: 'Create a controlled SSH bookmark',
  });
  await vi.waitFor(() => expect(f.listeners.size).toBe(1));
  expect(f.model.startRun.mock.calls[0]![1]).toMatchObject({
    mode: 'chat',
    useCase: 'createBookmark',
    context: '',
    attachmentIds: [],
    includeConversationHistory: false,
  });
  expect(f.model.startRun.mock.calls[0]![1].tool).toBeUndefined();
  f.finish();
  expect(await generating).toEqual(draft);
  expect(f.model.getRun).toHaveBeenCalledTimes(1);
  expect(f.listeners.size).toBe(0);
  await f.flow.close();
  await f.admissions.close();
  expect(f.model.cancelRun).not.toHaveBeenCalled();
});
it('keeps an exact save request after uncertainty, observes accepted Catalog facts and never repeats an already accepted save', async () => {
  const f = fixture();
  const input = createSshBookmarkSchema.parse({
    host: {
      name: 'Owned AI host',
      hostname: 'example.test',
      username: 'fixture',
      authType: 'password',
    },
    bookmark: { title: 'Reviewed AI bookmark' },
  });
  f.catalog.createSshBookmark.mockRejectedValueOnce(new Error('Lost acknowledgment'));
  await expect(f.flow.save(input)).rejects.toThrow('Lost acknowledgment');
  const original = structuredClone(f.catalog.createSshBookmark.mock.calls[0]);
  input.host.name = 'Changed input';
  const saving = f.flow.save(input);
  await vi.waitFor(() => expect(f.catalogListeners.size).toBe(1));
  expect(f.catalog.createSshBookmark.mock.calls[1]).toEqual(original);
  f.catalogCursor(1);
  await saving;
  await f.flow.close();
  await f.admissions.close();
});
it('cancels an unfinished generation when the dialog closes and joins actual Client command completion', async () => {
  const f = fixture(),
    cancel = Promise.withResolvers<{ ids: string[]; cursor: number }>();
  f.model.cancelRun.mockImplementation(() => cancel.promise);
  const generating = f.flow.generate({ modelId: crypto.randomUUID(), prompt: 'Visible request' });
  const outcome = Promise.allSettled([generating]);
  await vi.waitFor(() => expect(f.listeners.size).toBe(1));
  let stopped = false;
  const close = f.flow.close().then(() => {
    stopped = true;
  });
  await vi.waitFor(() => expect(f.model.cancelRun).toHaveBeenCalledTimes(1));
  expect(stopped).toBe(false);
  cancel.resolve({ ids: [f.run.id], cursor: 1 });
  await close;
  await f.admissions.close();
  expect((await outcome)[0]!.status).toBe('rejected');
  expect(f.listeners.size).toBe(0);
});
it('withdraws stale output before publishing a draft and refuses secret-bearing or extra generated fields', async () => {
  const f = fixture();
  const generating = f.flow.generate({ modelId: crypto.randomUUID(), prompt: 'Visible request' });
  await vi.waitFor(() => expect(f.listeners.size).toBe(1));
  f.publish({
    status: 'ready',
    detailRevision: 0,
    baseline: {
      ...(f.model.getSnapshot() as Extract<AiState, { status: 'ready' }>).baseline,
      generation: crypto.randomUUID(),
    },
  });
  await expect(generating).rejects.toThrow('RETIRED');
  await f.flow.close();
  await f.admissions.close();
  expect(f.model.cancelRun).not.toHaveBeenCalled();
  const invalid = fixture();
  const failed = invalid.flow.generate({ modelId: crypto.randomUUID(), prompt: 'Visible request' });
  await vi.waitFor(() => expect(invalid.listeners.size).toBe(1));
  invalid.finish(JSON.stringify({ ...draft, password: 'UNREVIEWED_SECRET' }));
  await expect(failed).rejects.toThrow();
  await invalid.flow.close();
  await invalid.admissions.close();
});
