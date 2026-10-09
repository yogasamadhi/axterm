import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AiRun } from '../../packages/contracts/src';
import { waitForAiResult } from '../../apps/desktop/src/renderer/src/app/ai/wait-for-ai-result';

const run: AiRun = {
  id: 'run',
  version: 1,
  createdAt: '2026-10-03T00:00:00.000Z',
  updatedAt: '2026-10-03T00:00:00.000Z',
  state: 'running',
  useCase: 'generateCommand',
};
const messages = { timeout: 'bounded timeout', failed: 'safe failure' };
afterEach(() => vi.useRealTimers());

describe('terminal-owned AI result wait', () => {
  it('rejects a successful read that returns after the terminal canceled', async () => {
    vi.useFakeTimers();
    let resolve!: (run: AiRun) => void;
    const client = {
      aiRun: vi.fn(
        () =>
          new Promise<AiRun>((done) => {
            resolve = done;
          }),
      ),
      cancelAi: vi.fn(async (_id: string) => {}),
    };
    const controller = new AbortController();
    const result = waitForAiResult(client, run, controller.signal, messages);
    const assertion = expect(result).rejects.toMatchObject({ name: 'AbortError' });
    await vi.advanceTimersByTimeAsync(200);
    controller.abort();
    resolve({ ...run, state: 'succeeded', result: 'stale command' });
    await assertion;
    expect(client.cancelAi).toHaveBeenCalledExactlyOnceWith('run');
    expect(vi.getTimerCount()).toBe(0);
  });
  it('cancels a late-created run when the original signal was already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const client = { aiRun: vi.fn(), cancelAi: vi.fn(async (_id: string) => {}) };
    await expect(waitForAiResult(client, run, controller.signal, messages)).rejects.toMatchObject({
      name: 'AbortError',
    });
    expect(client.aiRun).not.toHaveBeenCalled();
    expect(client.cancelAi).toHaveBeenCalledExactlyOnceWith('run');
  });
  it('releases a polling timer and listener when canceled before the next read', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const client = { aiRun: vi.fn(), cancelAi: vi.fn(async (_id: string) => {}) };
    const result = waitForAiResult(client, run, controller.signal, messages);
    const assertion = expect(result).rejects.toMatchObject({ name: 'AbortError' });
    controller.abort();
    await assertion;
    expect(client.aiRun).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    expect(client.cancelAi).toHaveBeenCalledTimes(1);
  });
  it('uses the fixed 20 second budget and never leaves a retry timer behind', async () => {
    vi.useFakeTimers();
    const client = { aiRun: vi.fn(async () => run), cancelAi: vi.fn(async (_id: string) => {}) };
    const controller = new AbortController();
    const result = waitForAiResult(client, run, controller.signal, messages);
    const assertion = expect(result).rejects.toThrow('bounded timeout');
    await vi.advanceTimersByTimeAsync(20_000);
    await assertion;
    expect(client.cancelAi).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    controller.abort();
    expect(client.cancelAi).toHaveBeenCalledTimes(1);
  });
});
