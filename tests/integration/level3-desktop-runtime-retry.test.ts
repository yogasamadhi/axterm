import type { Context } from '@deepseek-ai/cordis';
import type { RuntimeBaseline } from '@axterm/plugin-api';
import {
  RemoteStream,
  type RemoteStreamOptions,
} from '../../packages/infra/gateway/src/client/remote-stream.ts';
import { DesktopRuntimeModel } from '../../packages/plugins/desktop/src/client/index.ts';
import { expect, it, vi } from 'vitest';

it('recovers a terminated Runtime observation once and joins its actual cancellation before disposal', async () => {
  const drained = Promise.withResolvers<void>();
  let opens = 0,
    aborts = 0;
  const ctx = {
    remote: {
      $stream: (options: RemoteStreamOptions<RuntimeBaseline>) =>
        new RemoteStream(
          { generation: { getSnapshot: () => undefined, subscribe: () => () => {} } },
          options,
        ),
      desktop: {
        watchRuntime: (signal: AbortSignal) =>
          (async function* () {
            if (++opens === 1) throw Error('SECRET_RUNTIME_CANARY');
            try {
              yield {
                type: 'baseline',
                health: { status: 'ok' },
                version: { apiVersion: 'v1', appVersion: '0.10.0' },
                metadata: {
                  runtimeId: 'fixture',
                  generation: 'fixture-generation',
                  state: 'ready',
                  startedAt: new Date().toISOString(),
                  pid: 1,
                  mode: 'desktop',
                },
              } satisfies RuntimeBaseline;
              await new Promise<void>((resolve) => {
                const abort = () => {
                  aborts++;
                  resolve();
                };
                signal.addEventListener('abort', abort, { once: true });
                if (signal.aborted) abort();
              });
            } finally {
              await drained.promise;
            }
          })(),
      },
    },
  } as unknown as Context;
  const model = new DesktopRuntimeModel(ctx);
  await vi.waitFor(() => expect(model.getSnapshot().status).toBe('error'));
  expect(JSON.stringify(model.getSnapshot())).not.toContain('SECRET_RUNTIME_CANARY');
  const first = model.retry();
  expect(model.retry()).toBe(first);
  await first;
  await vi.waitFor(() => expect(model.getSnapshot().status).toBe('ready'));
  expect(opens).toBe(2);
  let closed = false;
  const closing = model.dispose().then(() => {
    closed = true;
  });
  await vi.waitFor(() => expect(aborts).toBe(1));
  expect(closed).toBe(false);
  await expect(model.retry()).rejects.toThrow('disposed');
  drained.resolve();
  await closing;
  expect(closed).toBe(true);
  expect(opens).toBe(2);
});
