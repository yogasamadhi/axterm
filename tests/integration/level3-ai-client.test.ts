import type { Context } from '@deepseek-ai/cordis';
import { randomUUID } from 'node:crypto';
import { setImmediate } from 'node:timers/promises';
import { afterEach, expect, it, vi } from 'vitest';
import type { AiUpdate, AiCollection } from '@axterm/plugin-api/ai';
import { AiModel } from '../../packages/plugins/ai/src/client/index.ts';
import {
  RemoteStream,
  type RemoteStreamOptions,
} from '../../packages/infra/gateway/src/client/remote-stream.ts';

afterEach(() => vi.useRealTimers());
function fixture() {
  const generation = randomUUID();
  const streams: RemoteStream<unknown>[] = [];
  let active = 0;
  const ctx = {
    remote: {
      $stream: <T>(options: RemoteStreamOptions<T>) => {
        const stream = new RemoteStream(
          {
            generation: {
              getSnapshot: () => undefined,
              subscribe: () => () => {},
            },
          },
          options,
        );
        streams.push(stream as RemoteStream<unknown>);
        return stream;
      },
      ai: {
        cancelRun: async () => ({ ok: true, value: { ids: [], cursor: 1 } }),
        watchAi: async function* (signal: AbortSignal): AsyncGenerator<AiUpdate> {
          active++;
          const collections: AiCollection[] = [
            'providers',
            'models',
            'conversations',
            'runs',
            'approvals',
            'engines',
          ];
          let off = () => {};
          try {
            yield {
              type: 'begin',
              mode: 'baseline',
              generation,
              cursor: 0,
              revision: 0,
              collections,
            };
            for (const collection of collections)
              yield { type: 'chunk', collection, offset: 0, text: '[]', final: true };
            yield { type: 'commit', cursor: 0, revision: 0 };
            await new Promise<void>((resolve) => {
              const abort = () => resolve();
              signal.addEventListener('abort', abort, { once: true });
              off = () => signal.removeEventListener('abort', abort);
              if (signal.aborted) abort();
            });
          } finally {
            off();
            active--;
          }
        },
      },
    },
  } as unknown as Context;
  return { model: new AiModel(ctx), streams, active: () => active };
}
it('cleans rejected cursor subscriptions without leaking timers or consuming waiter capacity', async () => {
  const f = fixture();
  try {
    await vi.waitFor(() => expect(f.model.getSnapshot().status).toBe('ready'));
    const listeners = Array.from({ length: 256 }, () => f.model.subscribe(() => {}));
    vi.useFakeTimers();
    for (let index = 0; index < 40; index++)
      await expect(f.model.cancelRun(randomUUID(), randomUUID())).rejects.toThrow(
        'AI_MODEL_OBSERVER_CAPACITY',
      );
    expect(vi.getTimerCount()).toBe(0);
    for (const off of listeners) off();
    const waiting = expect(f.model.cancelRun(randomUUID(), randomUUID())).rejects.toThrow(
      'AI_MODEL_CLOSED',
    );
    await setImmediate();
    expect(vi.getTimerCount()).toBe(1);
    await f.model.dispose();
    await waiting;
    expect(vi.getTimerCount()).toBe(0);
    expect(f.active()).toBe(0);
  } finally {
    await f.model.dispose();
  }
});
it('retains a failed actual stream drain and returns the same failure on repeated close', async () => {
  const f = fixture();
  await vi.waitFor(() => expect(f.model.getSnapshot().status).toBe('ready'));
  const stream = f.streams[0]!;
  const original = stream.dispose.bind(stream);
  const failure = new Error('actual stream failed to drain');
  const dispose = vi.spyOn(stream, 'dispose').mockRejectedValue(failure);
  try {
    const first = f.model.dispose();
    expect(f.model.dispose()).toBe(first);
    await expect(first).rejects.toBe(failure);
    await expect(f.model.dispose()).rejects.toBe(failure);
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(() => f.model.retry()).toThrow('AI_MODEL_CLOSED');
  } finally {
    dispose.mockRestore();
    await original();
  }
});
