import { randomUUID } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import {
  aiContextPreviewSchema,
  aiModelSchema,
  type AiContextPreviewInput,
} from '@axterm/plugin-api/ai';
import type { AiState } from '../../packages/plugins/ai/src/client/index.ts';
import { TerminalExplanationOwner } from '../../packages/plugins/ai/src/client/ui/terminal-explanation-owner.ts';
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
});
function fixture() {
  const terminalId = randomUUID(),
    generation = randomUUID(),
    listeners = new Set<() => void>();
  const now = new Date().toISOString();
  let state: AiState = {
    status: 'ready',
    detailRevision: 0,
    baseline: {
      generation,
      cursor: 0,
      revision: 0,
      models: [
        aiModelSchema.parse({
          id: randomUUID(),
          providerId: randomUUID(),
          name: 'Explicit model',
          model: 'fixture',
          capabilities: ['chat'],
          createdAt: now,
          updatedAt: now,
          version: 1,
        }),
      ],
      providers: [],
      runs: [],
      conversations: [],
      approvals: [],
      engines: [],
    },
  };
  let exists = true,
    active = true;
  const preview = (input: AiContextPreviewInput) =>
    aiContextPreviewSchema.parse({
      request: input,
      system: '',
      context: '',
      sources: [],
      prompt: input.prompt.replaceAll('visible-secret', '[REDACTED]'),
      reviewReceipt: 'a'.repeat(64),
      reviewExpiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
  const model = {
    getSnapshot: () => state,
    subscribe: (fn: () => void) => {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
    previewContext: vi.fn(async (input: AiContextPreviewInput, signal?: AbortSignal) => {
      signal?.throwIfAborted();
      return preview(input);
    }),
    startRun: vi.fn(),
  };
  const show = vi.fn();
  const owner = new TerminalExplanationOwner(
    model,
    (id, requireActive) => id === terminalId && exists && (!requireActive || active),
    () => 'Explain',
    show,
  );
  cleanups.push(() => owner.dispose());
  return {
    owner,
    model,
    show,
    listeners,
    generation,
    terminalId,
    preview,
    input: { terminalId, generation, selection: 'visible-secret terminal output' },
    expire(reason: 'generation' | 'target') {
      if (reason === 'generation' && state.status === 'ready')
        state = { ...state, baseline: { ...state.baseline, generation: randomUUID() } };
      else active = false;
      for (const fn of [...listeners]) fn();
      owner.refresh();
    },
    remove() {
      exists = false;
      owner.refresh();
    },
    unconfigured() {
      if (state.status === 'ready')
        state = { ...state, baseline: { ...state.baseline, models: [] } };
    },
  };
}
it('opens only the bounded Host-redacted draft and never admits a Run or command', async () => {
  const f = fixture();
  await expect(
    f.owner.open({ ...f.input, selection: 'old-output\n' + 'x'.repeat(16_000) + 'visible-secret' }),
  ).resolves.toBe('opened');
  const request = f.model.previewContext.mock.calls[0]![0];
  expect(request).toMatchObject({
    useCase: 'explainOutput',
    terminalId: f.terminalId,
    context: '',
    includeConversationHistory: false,
  });
  expect(request.prompt.length).toBeLessThanOrEqual(16_384);
  expect(request.prompt).not.toContain('old-output');
  expect(f.owner.getSnapshot()).toMatchObject({
    terminalId: f.terminalId,
    generation: f.generation,
  });
  expect(f.owner.getSnapshot()!.prompt).toContain('[REDACTED]');
  expect(JSON.stringify(f.owner.getSnapshot())).not.toContain('visible-secret');
  expect(f.show).toHaveBeenCalledExactlyOnceWith(f.terminalId);
  expect(f.model.startRun).not.toHaveBeenCalled();
  f.owner.consume('wrong-nonce');
  expect(f.owner.getSnapshot()).toBeDefined();
  f.owner.consume(f.owner.getSnapshot()!.nonce);
  expect(f.owner.getSnapshot()).toBeUndefined();
  f.remove();
  await f.owner.dispose();
  expect(f.listeners.size).toBe(0);
  expect(f.owner.resourceCount()).toBe(0);
});
it.each(['generation', 'target'] as const)(
  'cancels a pending preview when its %s retires and refuses late publication',
  async (reason) => {
    const f = fixture(),
      deferred = Promise.withResolvers<ReturnType<typeof f.preview>>();
    f.model.previewContext.mockImplementationOnce(async () => deferred.promise);
    const pending = f.owner.open(f.input),
      rejected = expect(pending).rejects.toThrow();
    await Promise.resolve();
    const signal = f.model.previewContext.mock.calls[0]![1]!;
    f.expire(reason);
    expect(signal.aborted).toBe(true);
    deferred.resolve(f.preview(f.model.previewContext.mock.calls[0]![0]));
    await rejected;
    expect(f.owner.getSnapshot()).toBeUndefined();
    expect(f.show).not.toHaveBeenCalled();
    expect(f.owner.resourceCount()).toBe(0);
  },
);
it('refuses concurrent admission, aborts and drains on unload, and releases every observer', async () => {
  const f = fixture(),
    deferred = Promise.withResolvers<ReturnType<typeof f.preview>>();
  f.model.previewContext.mockImplementationOnce(async () => deferred.promise);
  const pending = f.owner.open(f.input),
    rejected = expect(pending).rejects.toThrow();
  await Promise.resolve();
  await expect(f.owner.open(f.input)).rejects.toThrow('AI_EXPLANATION_UNAVAILABLE');
  let drained = false;
  const closing = f.owner.dispose().then(() => {
    drained = true;
  });
  expect(f.model.previewContext.mock.calls[0]![1]!.aborted).toBe(true);
  expect(drained).toBe(false);
  deferred.resolve(f.preview(f.model.previewContext.mock.calls[0]![0]));
  await rejected;
  await closing;
  expect(f.listeners.size).toBe(0);
  expect(f.owner.resourceCount()).toBe(0);
  expect(f.show).not.toHaveBeenCalled();
  await expect(f.owner.open(f.input)).rejects.toThrow();
});
it('reports a missing configured model without previewing or starting work', async () => {
  const f = fixture();
  f.unconfigured();
  await expect(f.owner.open(f.input)).resolves.toBe('unconfigured');
  expect(f.model.previewContext).not.toHaveBeenCalled();
  expect(f.model.startRun).not.toHaveBeenCalled();
  expect(f.show).not.toHaveBeenCalled();
});
