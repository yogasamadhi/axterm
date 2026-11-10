// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it } from 'vitest';
import type { AiModel, AiRunModel, AiState } from '../src/client/index.ts';
import { AiRunProjection } from '../src/client/run-projection.ts';
import { useSelectedRun } from '../src/client/ui/use-ai-facts.ts';
it('replaces a retired React reader after reconnecting to the same Host generation without subscribing to its closed instance', async () => {
  const environment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
  const previous = environment.IS_REACT_ACT_ENVIRONMENT;
  environment.IS_REACT_ACT_ENVIRONMENT = true;
  const generation = crypto.randomUUID(),
    id = crypto.randomUUID(),
    date = new Date().toISOString();
  const baseline = {
    generation,
    cursor: 0,
    revision: 0,
    providers: [],
    models: [],
    runs: [],
    conversations: [],
    approvals: [],
    engines: [],
  };
  let metadata: AiState = { status: 'ready', baseline, detailRevision: 0 };
  const listeners = new Set<() => void>();
  const readers: { closed: boolean }[] = [];
  const model = {
    getSnapshot: () => metadata,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    openRun: async () => {
      const owner = { closed: false };
      readers.push(owner);
      const visible = new AiRunProjection({
        id,
        engineId: 'pi',
        useCase: 'chat',
        state: 'running',
        createdAt: date,
        updatedAt: date,
        version: 1,
      }).snapshot();
      const state = { status: 'ready', visible };
      return {
        getSnapshot: () => state,
        subscribe: () => {
          if (owner.closed) throw new Error('AI_RUN_MODEL_CLOSED');
          return () => {};
        },
        dispose: async () => {
          owner.closed = true;
        },
      } as unknown as AiRunModel;
    },
  } as unknown as AiModel;
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  function Probe() {
    const selected = useSelectedRun(model, id);
    return createElement('output', null, selected.value?.id ?? 'pending');
  }
  const publish = (state: AiState) => {
    metadata = state;
    for (const listener of listeners) listener();
  };
  try {
    await act(async () => {
      root.render(createElement(Probe));
    });
    expect(readers).toHaveLength(1);
    expect(container.textContent).toBe(id);
    await act(async () => publish({ status: 'connecting' }));
    expect(readers[0]!.closed).toBe(true);
    expect(container.textContent).toBe('pending');
    await act(async () => publish({ status: 'ready', baseline, detailRevision: 0 }));
    expect(readers).toHaveLength(2);
    expect(readers[1]!.closed).toBe(false);
    expect(container.textContent).toBe(id);
  } finally {
    await act(async () => root.unmount());
    container.remove();
    if (previous === undefined) delete environment.IS_REACT_ACT_ENVIRONMENT;
    else environment.IS_REACT_ACT_ENVIRONMENT = previous;
  }
  expect(readers.every((reader) => reader.closed)).toBe(true);
  expect(listeners.size).toBe(0);
});
