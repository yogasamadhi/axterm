import { afterEach, expect, it, vi } from 'vitest';
afterEach(() => vi.useRealTimers());
import { randomUUID } from 'node:crypto';
import { setImmediate } from 'node:timers/promises';
import { aiRunSchema, type AiRequestInput } from '@axterm/plugin-api/ai';
import type { AiState } from '../../packages/plugins/ai/src/client/index.ts';
import { AiRunProjection } from '../../packages/plugins/ai/src/client/run-projection.ts';
import { AiDraftService } from '../../packages/plugins/ai/src/client/draft-service.ts';
import { AXTERM_TERMINAL_THEMES } from '../../packages/plugins/terminals/src/application/theme-presets.ts';
const draft = structuredClone(AXTERM_TERMINAL_THEMES[0]);
function fixture() {
  const generation = randomUUID(),
    observers = new Set<() => void>(),
    listeners = new Set<() => void>();
  let run = aiRunSchema.parse({
      id: randomUUID(),
      version: 1,
      state: 'running',
      useCase: 'createTheme',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }),
    state: AiState = {
      status: 'ready',
      detailRevision: 0,
      baseline: {
        generation,
        cursor: 0,
        revision: 0,
        models: [],
        providers: [],
        conversations: [],
        runs: [],
        approvals: [],
        engines: [],
      },
    };
  const notify = () => {
    for (const listener of [...listeners]) listener();
  };
  let projection = new AiRunProjection(run);
  const log = {
    generation,
    getSnapshot: () => ({ status: 'ready' as const, visible: projection.snapshot() }),
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    dispose: vi.fn(async () => {
      listeners.clear();
    }),
  };
  const model = {
    getSnapshot: () => state,
    subscribe: (listener: () => void) => {
      observers.add(listener);
      return () => {
        observers.delete(listener);
      };
    },
    retry: vi.fn(async () => {}),
    startRun: vi.fn(async (_key: string, _input: AiRequestInput) => run),
    getRun: vi.fn(async () => run),
    getRunCommandOutcome: vi.fn(async () => ({ status: 'missing' as const })),
    cancelRun: vi.fn(async (_key: string, _id: string, _generation?: string) => {
      run = { ...run, state: 'canceled' };
      projection = new AiRunProjection(run);
      notify();
      return { ids: [run.id], cursor: 1 };
    }),
    drainRun: vi.fn(async () => {}),
    openRun: vi.fn(async () => log),
  };
  return {
    model,
    log,
    generation,
    observers,
    listeners,
    request: { modelId: randomUUID(), prompt: 'Muted green terminal', draft },
    finish(result = JSON.stringify(draft)) {
      run = { ...run, state: 'succeeded' };
      projection = new AiRunProjection(run);
      projection.accept({
        runId: run.id,
        cursor: 1,
        createdAt: new Date().toISOString(),
        payload: { kind: 'output', text: result, mode: 'replace' },
      });
      projection.accept({
        runId: run.id,
        cursor: 2,
        createdAt: new Date().toISOString(),
        payload: { kind: 'state', run },
      });
      notify();
    },
    retire() {
      if (state.status === 'ready')
        state = { ...state, baseline: { ...state.baseline, generation: randomUUID() } };
      for (const observer of [...observers]) observer();
    },
    run: () => run,
  };
}
it('uses the selected visible Run log and joins actual execution before returning a draft', async () => {
  const f = fixture(),
    service = new AiDraftService(f.model),
    drained = Promise.withResolvers<void>();
  f.model.drainRun.mockImplementation(() => drained.promise);
  expect(service.getSnapshot()).toBe(f.model.getSnapshot());
  const request = service.generateTheme(f.request);
  let published = false;
  void request.then(() => {
    published = true;
  });
  await setImmediate();
  f.finish('```json\n' + JSON.stringify(draft) + '\n```');
  await setImmediate();
  expect(published).toBe(false);
  expect(f.model.drainRun).toHaveBeenCalledExactlyOnceWith(f.run().id, f.generation);
  drained.resolve();
  expect(await request).toEqual(draft);
  expect(f.model.startRun).toHaveBeenCalledOnce();
  expect(f.model.startRun.mock.calls[0]?.[1]).toMatchObject({
    useCase: 'createTheme',
    mode: 'chat',
    includeConversationHistory: false,
    prompt: f.request.prompt,
  });
  expect(f.log.dispose).toHaveBeenCalledOnce();
  expect(f.model.cancelRun).not.toHaveBeenCalled();
  expect(f.observers.size + f.listeners.size).toBe(0);
  await service.close();
});
it('joins a late accepted admission on close, then cancels and drains its captured identity', async () => {
  const f = fixture(),
    admitted = Promise.withResolvers<ReturnType<typeof f.run>>(),
    drained = Promise.withResolvers<void>();
  f.model.startRun.mockImplementation(() => admitted.promise);
  f.model.drainRun.mockImplementation(() => drained.promise);
  const service = new AiDraftService(f.model),
    task = service.generateTheme(f.request),
    rejected = expect(task).rejects.toThrow();
  await setImmediate();
  let closed = false;
  const closing = service.close();
  void closing.then(() => {
    closed = true;
  });
  admitted.resolve(f.run());
  await setImmediate();
  expect(closed).toBe(false);
  expect(f.model.cancelRun).toHaveBeenCalledOnce();
  expect(f.model.openRun).not.toHaveBeenCalled();
  expect(f.model.cancelRun.mock.calls[0]?.[2]).toBe(f.generation);
  drained.resolve();
  await rejected;
  await closing;
  expect(closed).toBe(true);
});
it('rejects invalid or low-contrast visible drafts and drains the Run without saving or applying', async () => {
  const f = fixture(),
    service = new AiDraftService(f.model),
    task = service.generateTheme(f.request),
    rejected = expect(task).rejects.toThrow();
  await setImmediate();
  f.finish(
    JSON.stringify({
      ...draft,
      terminal: { ...draft.terminal, foreground: draft.terminal.background },
    }),
  );
  await rejected;
  expect(f.model.cancelRun).toHaveBeenCalledOnce();
  expect(f.model.drainRun).toHaveBeenCalledOnce();
  await service.close();
});
it('retires an old generation without sending its cancellation or drain to a new Host', async () => {
  const f = fixture(),
    service = new AiDraftService(f.model),
    task = service.generateTheme(f.request),
    rejected = expect(task).rejects.toThrow('RETIRED');
  await setImmediate();
  f.retire();
  await rejected;
  expect(f.model.cancelRun).not.toHaveBeenCalled();
  expect(f.model.drainRun).not.toHaveBeenCalled();
  expect(f.log.dispose).toHaveBeenCalledOnce();
  await service.close();
});
it('limits concurrent generation, refuses closed admission and releases every waiter on withdrawal', async () => {
  const f = fixture(),
    service = new AiDraftService(f.model),
    tasks = Array.from({ length: 4 }, () => service.generateTheme(f.request));
  const joined = Promise.allSettled(tasks);
  expect(() => service.generateTheme(f.request)).toThrow('CAPACITY');
  await setImmediate();
  await service.close();
  expect((await joined).every((value) => value.status === 'rejected')).toBe(true);
  expect(() => service.generateTheme(f.request)).toThrow('CLOSED');
  expect(f.observers.size + f.listeners.size).toBe(0);
});
it('keeps a failed execution drain owned for retry instead of claiming withdrawal succeeded', async () => {
  const f = fixture(),
    service = new AiDraftService(f.model);
  f.model.drainRun.mockRejectedValue(Error('controlled drain'));
  const task = service.generateTheme(f.request),
    rejected = expect(task).rejects.toThrow('controlled drain');
  await setImmediate();
  f.finish();
  await rejected;
  await expect(service.close()).rejects.toThrow('DRAIN_FAILED');
  f.model.drainRun.mockResolvedValue();
  await service.close();
});

it('keeps an unknown admission for readonly reconciliation and refuses a second generation request', async () => {
  const f = fixture(),
    service = new AiDraftService(f.model);
  f.model.startRun.mockRejectedValue(Error('lost response'));
  await expect(service.generateTheme(f.request)).rejects.toThrow('lost response');
  expect(() => service.generateTheme(f.request)).toThrow('OUTCOME_UNCERTAIN');
  expect(f.model.startRun).toHaveBeenCalledOnce();
  expect(f.model.getRunCommandOutcome).toHaveBeenCalledOnce();
  f.retire();
  await service.close();
  expect(f.model.cancelRun).not.toHaveBeenCalled();
});

it('shares reply-only command generation with the existing visible Run and actual execution drain', async () => {
  const f = fixture(),
    service = new AiDraftService(f.model),
    terminalId = randomUUID(),
    drain = Promise.withResolvers<void>();
  f.model.drainRun.mockImplementationOnce(() => drain.promise);
  const request = service.suggestCommands({
    modelId: f.request.modelId,
    generation: f.generation,
    terminalId,
    prefix: 'git ',
  });
  await setImmediate();
  f.finish('["git status"]');
  await setImmediate();
  let completed = false;
  void request.then(() => {
    completed = true;
  });
  expect(completed).toBe(false);
  expect(f.model.startRun.mock.calls[0]?.[1]).toMatchObject({
    useCase: 'generateCommand',
    mode: 'chat',
    terminalId,
    context: '',
    includeConversationHistory: false,
  });
  drain.resolve();
  expect(await request).toBe('["git status"]');
  await service.close();
});
it('refuses a stale terminal generation before admitting an AI suggestion Run', async () => {
  const f = fixture(),
    service = new AiDraftService(f.model);
  expect(() =>
    service.suggestCommands({
      modelId: f.request.modelId,
      generation: randomUUID(),
      terminalId: randomUUID(),
      prefix: 'git ',
    }),
  ).toThrow('RETIRED');
  expect(f.model.startRun).not.toHaveBeenCalled();
  await service.close();
});

function suggestions(f: ReturnType<typeof fixture>, service: AiDraftService, signal?: AbortSignal) {
  return service.suggestCommands(
    {
      modelId: f.request.modelId,
      generation: f.generation,
      terminalId: randomUUID(),
      prefix: 'git ',
    },
    signal,
  );
}
it('rejects a late successful log after suggestion cancellation and disposes only its captured Run', async () => {
  const f = fixture(),
    service = new AiDraftService(f.model),
    caller = new AbortController(),
    log = Promise.withResolvers<typeof f.log>();
  f.model.openRun.mockReturnValueOnce(log.promise);
  const task = suggestions(f, service, caller.signal),
    rejected = expect(task).rejects.toMatchObject({ name: 'AbortError' });
  await setImmediate();
  caller.abort();
  f.finish('["git stale"]');
  log.resolve(f.log);
  await rejected;
  expect(f.model.cancelRun).toHaveBeenCalledOnce();
  expect(f.model.cancelRun.mock.calls[0]?.slice(1)).toEqual([f.run().id, f.generation]);
  expect(f.model.drainRun).toHaveBeenCalledExactlyOnceWith(f.run().id, f.generation);
  expect(f.log.dispose).toHaveBeenCalledOnce();
  expect(f.observers.size + f.listeners.size).toBe(0);
  await service.close();
});
it('refuses pre-aborted suggestions and cancels a late accepted Run without opening its log', async () => {
  const f = fixture(),
    service = new AiDraftService(f.model),
    caller = new AbortController();
  caller.abort();
  expect(() => suggestions(f, service, caller.signal)).toThrow();
  expect(f.model.startRun).not.toHaveBeenCalled();
  const late = new AbortController(),
    accepted = Promise.withResolvers<ReturnType<typeof f.run>>();
  f.model.startRun.mockReturnValueOnce(accepted.promise);
  const task = suggestions(f, service, late.signal),
    rejected = expect(task).rejects.toMatchObject({ name: 'AbortError' });
  await setImmediate();
  late.abort();
  accepted.resolve(f.run());
  await rejected;
  expect(f.model.cancelRun).toHaveBeenCalledOnce();
  expect(f.model.openRun).not.toHaveBeenCalled();
  expect(f.model.drainRun).toHaveBeenCalledExactlyOnceWith(f.run().id, f.generation);
  await service.close();
});
it('cancels a visible suggestion wait without polling and releases the deadline and log listener', async () => {
  vi.useFakeTimers();
  const f = fixture(),
    service = new AiDraftService(f.model),
    caller = new AbortController(),
    task = suggestions(f, service, caller.signal),
    rejected = expect(task).rejects.toMatchObject({ name: 'AbortError' });
  await vi.advanceTimersByTimeAsync(0);
  expect(f.listeners.size).toBe(1);
  caller.abort();
  await rejected;
  expect(f.model.getRun).not.toHaveBeenCalled();
  expect(f.model.cancelRun).toHaveBeenCalledOnce();
  expect(f.observers.size + f.listeners.size).toBe(0);
  expect(vi.getTimerCount()).toBe(0);
  await service.close();
});
it('retains the fixed 20 second suggestion budget and never leaves a retry timer or duplicate cancellation', async () => {
  vi.useFakeTimers();
  const f = fixture(),
    service = new AiDraftService(f.model),
    caller = new AbortController(),
    task = suggestions(f, service, caller.signal),
    rejected = expect(task).rejects.toMatchObject({
      code: 'ai/failure',
      details: { reason: 'expired' },
    });
  await vi.advanceTimersByTimeAsync(19999);
  expect(f.model.cancelRun).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  await rejected;
  expect(f.model.cancelRun).toHaveBeenCalledOnce();
  expect(f.model.drainRun).toHaveBeenCalledExactlyOnceWith(f.run().id, f.generation);
  expect(vi.getTimerCount()).toBe(0);
  expect(f.observers.size + f.listeners.size).toBe(0);
  caller.abort();
  expect(f.model.cancelRun).toHaveBeenCalledOnce();
  await service.close();
});
it('keeps the independent 30 second theme budget when the shorter suggestion budget elapses', async () => {
  vi.useFakeTimers();
  const f = fixture(),
    service = new AiDraftService(f.model),
    task = service.generateTheme(f.request);
  await vi.advanceTimersByTimeAsync(25000);
  expect(f.model.cancelRun).not.toHaveBeenCalled();
  f.finish();
  expect(await task).toEqual(draft);
  expect(vi.getTimerCount()).toBe(0);
  await service.close();
});
