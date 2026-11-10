// @vitest-environment jsdom
import { renderHook, waitFor } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import type { AiModel, AiRunModel } from '../src/client/index.ts';
import { useSelectedRun } from '../src/client/ui/use-ai-facts.ts';
const snapshot = { status: 'ready', baseline: { generation: 'reader-fixture' } };
function model(openRun: (id: string) => Promise<AiRunModel>): AiModel {
  return { getSnapshot: () => snapshot, subscribe: () => () => {}, openRun } as unknown as AiModel;
}
it('contains a synchronous run-reader capacity failure in the feature retry state', async () => {
  const openRun = vi.fn(() => {
    throw Error('AI_RUN_MODEL_CAPACITY');
  });
  const owner = model(openRun);
  const view = renderHook(() => useSelectedRun(owner, 'run'));
  try {
    await waitFor(() => expect(view.result.current.unavailable).toBe(true));
    expect(openRun).toHaveBeenCalledTimes(1);
  } finally {
    view.unmount();
  }
});
it('disposes a late run reader after the view closes instead of publishing it', async () => {
  const pending = Promise.withResolvers<AiRunModel>(),
    dispose = vi.fn(async () => {}),
    openRun = vi.fn(() => pending.promise),
    owner = model(openRun);
  const view = renderHook(() => useSelectedRun(owner, 'run'));
  await waitFor(() => expect(openRun).toHaveBeenCalledTimes(1));
  view.unmount();
  pending.resolve({ dispose } as unknown as AiRunModel);
  await waitFor(() => expect(dispose).toHaveBeenCalledTimes(1));
});
