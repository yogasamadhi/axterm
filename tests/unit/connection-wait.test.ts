import type { Connection } from '../../packages/contracts/src';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  waitForConnectionReady,
  type ConnectionWaitContext,
} from '../../apps/desktop/src/renderer/src/app/connections/wait-for-connection';

function context(controller = new AbortController()): ConnectionWaitContext {
  return {
    list: vi.fn(async () => [{ id: 'target', state: 'connecting' } as Connection]),
    isDisposed: () => false,
    generation: () => 'generation-a',
    signal: controller.signal,
    x: (key) => key,
  };
}
afterEach(() => vi.useRealTimers());

describe('owned Client connection waits', () => {
  it('returns the target once ready and releases its timer and abort listener', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const input = context(controller);
    const remove = vi.spyOn(controller.signal, 'removeEventListener');
    input.list = vi
      .fn()
      .mockResolvedValueOnce([{ id: 'target', state: 'connecting' }])
      .mockResolvedValue([{ id: 'target', state: 'ready' }]);
    const pending = waitForConnectionReady(input, 'target');
    await vi.advanceTimersByTimeAsync(200);
    await expect(pending).resolves.toMatchObject({ id: 'target', state: 'ready' });
    expect(vi.getTimerCount()).toBe(0);
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
  });
  it('aborts a pending pause immediately and leaves no owned timer', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const pending = waitForConnectionReady(context(controller), 'target');
    const rejected = expect(pending).rejects.toThrow('app.closed');
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(1);
    controller.abort();
    await rejected;
    expect(vi.getTimerCount()).toBe(0);
  });
  it('rejects a changed generation or disposed owner before reading connections', async () => {
    const input = context();
    await expect(waitForConnectionReady(input, 'target', 'old-generation')).rejects.toThrow(
      'app.runtimeRestarted',
    );
    expect(input.list).not.toHaveBeenCalled();
    input.isDisposed = () => true;
    await expect(waitForConnectionReady(input, 'target')).rejects.toThrow('app.closed');
    expect(input.list).not.toHaveBeenCalled();
  });
  it.each(['generation', 'disposed'] as const)(
    'rejects a ready response when the %s changes during the request',
    async (change) => {
      const input = context();
      let resolveList!: (value: Connection[]) => void;
      input.list = () => new Promise((resolve) => (resolveList = resolve));
      const pending = waitForConnectionReady(input, 'target', 'generation-a');
      if (change === 'generation') input.generation = () => 'generation-b';
      else input.isDisposed = () => true;
      resolveList([{ id: 'target', state: 'ready' } as Connection]);
      await expect(pending).rejects.toThrow(
        change === 'generation' ? 'app.runtimeRestarted' : 'app.closed',
      );
    },
  );
  it('bounds an unavailable connection wait and releases all scheduled work', async () => {
    vi.useFakeTimers();
    const pending = waitForConnectionReady(context(), 'target', undefined, 1_000);
    const rejected = expect(pending).rejects.toThrow('app.sshWaitTimeout');
    await vi.advanceTimersByTimeAsync(1_000);
    await rejected;
    expect(vi.getTimerCount()).toBe(0);
  });
});
