import type { Context } from '@deepseek-ai/cordis';
import { RemoteStream } from '../../packages/infra/gateway/src/client/remote-stream.ts';
import type { RemoteStreamOptions } from '../../packages/infra/gateway/src/client/remote-stream.ts';
import type { DesktopLaunch } from '@axterm/plugin-api/session-intents';
import { expect, it, vi } from 'vitest';
import { DesktopLaunchModel } from '../../packages/plugins/desktop/src/client/launches.ts';
it('reads the real RemoteStream envelope once, keeps the source out of observable state, and joins actual launch cancellation', async () => {
  const pending = Promise.withResolvers<boolean>(),
    launched = vi.fn((_source: string, _signal: AbortSignal) => pending.promise),
    generation = { id: 1, host: { home: '/fixture' } };
  const event = { id: crypto.randomUUID(), source: 'ssh://operator:SECRET_CANARY@host.test' };
  const ctx = {
    remote: {
      $stream: (options: RemoteStreamOptions<DesktopLaunch>) =>
        new RemoteStream(
          { generation: { getSnapshot: () => generation, subscribe: () => () => {} } },
          options,
        ),
      desktop: {
        watchDesktopLaunches: (_windowId: string, signal: AbortSignal) =>
          (async function* () {
            yield event;
            await new Promise<void>((resolve) => {
              signal.addEventListener('abort', () => resolve(), { once: true });
              if (signal.aborted) resolve();
            });
          })(),
      },
    },
  } as unknown as Context;
  const model = new DesktopLaunchModel(ctx, crypto.randomUUID(), launched);
  await vi.waitFor(() =>
    expect(launched).toHaveBeenCalledExactlyOnceWith(event.source, expect.any(AbortSignal)),
  );
  expect(JSON.stringify(model.getSnapshot())).not.toContain('SECRET_CANARY');
  let done = false;
  const closed = model.close().then(() => {
    done = true;
  });
  expect(launched.mock.calls[0]![1].aborted).toBe(true);
  expect(done).toBe(false);
  pending.resolve(false);
  await closed;
  expect(launched).toHaveBeenCalledTimes(1);
});
