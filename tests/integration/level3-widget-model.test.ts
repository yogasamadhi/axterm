import type { Context } from '@deepseek-ai/cordis';
import { randomUUID } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import type { WidgetUpdate } from '@axterm/plugin-api/automation';
import { WidgetModel } from '../../packages/plugins/automation/src/client/widgets.ts';
import {
  RemoteStream,
  type RemoteStreamOptions,
} from '../../packages/infra/gateway/src/client/remote-stream.ts';
it('keeps unknown starts across same-generation reconnects, checks only their receipt and never resends their password', async () => {
  let generation = randomUUID(),
    active = 0;
  const start = vi.fn(async () => {
      throw Error('Transport lost');
    }),
    outcome = vi.fn(async (key: string, selected: string) => ({
      ok: true,
      value: { key, generation: selected, status: 'completed', cursor: 0 },
    }));
  const ctx = {
    remote: {
      $stream: <Item>(options: RemoteStreamOptions<Item>) =>
        new RemoteStream(
          { generation: { getSnapshot: () => undefined, subscribe: () => () => {} } },
          options,
        ),
      automation: {
        startLocalSshServerWidget: start,
        getWidgetCommandOutcome: outcome,
        watchWidgets: async function* (signal: AbortSignal): AsyncGenerator<WidgetUpdate> {
          const done = Promise.withResolvers<void>();
          const abort = () => done.resolve();
          signal.addEventListener('abort', abort, { once: true });
          active++;
          try {
            if (signal.aborted) return;
            yield {
              type: 'baseline',
              generation,
              cursor: 0,
              definitions: [],
              instances: [],
              mcpTools: [],
            };
            if (!signal.aborted) await done.promise;
          } finally {
            signal.removeEventListener('abort', abort);
            active--;
          }
        },
      },
    },
  } as unknown as Context;
  const model = new WidgetModel(ctx);
  try {
    await vi.waitFor(() => expect(model.getSnapshot().status).toBe('ready'));
    await expect(
      model.startSsh({ grantId: 'grant', password: 'PRIVATE_WIDGET_PASSWORD' }),
    ).rejects.toThrow('WIDGET_OUTCOME_UNKNOWN');
    const unknown = model.getSnapshot().uncertain!;
    expect(JSON.stringify(model.getSnapshot())).not.toContain('PRIVATE_WIDGET_PASSWORD');
    await model.retry();
    await vi.waitFor(() => expect(model.getSnapshot().status).toBe('ready'));
    expect(model.getSnapshot().uncertain).toEqual(unknown);
    await model.checkOutcome();
    expect(outcome).toHaveBeenCalledWith(unknown.key, unknown.generation);
    expect(model.getSnapshot().uncertain).toBeUndefined();
    expect(start).toHaveBeenCalledOnce();
    generation = randomUUID();
    await model.retry();
    await vi.waitFor(() => expect(model.generation()).toBe(generation));
    expect(active).toBe(1);
  } finally {
    await model.dispose();
  }
  expect(active).toBe(0);
});
