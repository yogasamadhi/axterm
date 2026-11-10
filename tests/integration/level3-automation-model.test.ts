import type { Context } from '@deepseek-ai/cordis';
import { randomUUID } from 'node:crypto';
import { setImmediate } from 'node:timers/promises';
import { expect, it, vi } from 'vitest';
import type { AutomationUpdate } from '@axterm/plugin-api/automation';
import { AutomationModel } from '../../packages/plugins/automation/src/client/index.ts';
import {
  RemoteStream,
  type RemoteStreamOptions,
} from '../../packages/infra/gateway/src/client/remote-stream.ts';
function fixture() {
  const delta = Promise.withResolvers<void>();
  const generation = randomUUID();
  const baseline = {
    quickCommands: { revision: 1, etag: '"quick-command-tree-v1"', groups: [], commands: [] },
    triggers: { revision: 1, etag: '"trigger-list-v1"', triggers: [] },
    batches: [],
  };
  const context = {
    remote: {
      $stream: <Item>(options: RemoteStreamOptions<Item>) =>
        new RemoteStream(
          { generation: { getSnapshot: () => undefined, subscribe: () => () => {} } },
          options,
        ),
      automation: {
        createQuickCommandGroup: async () => ({ ok: true, value: { ids: [], cursor: 1 } }),
        watchAutomation: async function* (signal: AbortSignal): AsyncGenerator<AutomationUpdate> {
          const names = ['quickCommands', 'triggers', 'batches'] as const;
          yield { type: 'begin', generation, cursor: 0, mode: 'baseline', collections: names };
          for (const collection of names)
            yield {
              type: 'chunk',
              collection,
              offset: 0,
              final: true,
              text: JSON.stringify(baseline[collection]),
            };
          yield { type: 'commit', cursor: 0 };
          let off = () => {};
          const aborted = new Promise<void>((resolve) => {
            const abort = () => resolve();
            signal.addEventListener('abort', abort, { once: true });
            off = () => signal.removeEventListener('abort', abort);
            if (signal.aborted) resolve();
          });
          try {
            await Promise.race([delta.promise, aborted]);
            if (signal.aborted) return;
            yield {
              type: 'begin',
              generation,
              cursor: 1,
              mode: 'delta',
              collections: ['quickCommands'],
            };
            yield {
              type: 'chunk',
              collection: 'quickCommands',
              offset: 0,
              final: true,
              text: JSON.stringify({
                ...baseline.quickCommands,
                revision: 2,
                etag: '"quick-command-tree-v2"',
              }),
            };
            yield { type: 'commit', cursor: 1 };
            await aborted;
          } finally {
            off();
          }
        },
      },
    },
  } as unknown as Context;
  return { model: new AutomationModel(context), delta };
}
it('resolves a successful command only after its committed fact cursor reaches the Client model', async () => {
  const f = fixture();
  try {
    await vi.waitFor(() => expect(f.model.getSnapshot().status).toBe('ready'));
    let settled = false;
    const command = f.model
      .createQuickCommandGroup(
        randomUUID(),
        { name: 'Folder', parentId: null },
        '"quick-command-tree-v1"',
      )
      .then(() => {
        settled = true;
      });
    await setImmediate();
    expect(settled).toBe(false);
    f.delta.resolve();
    await command;
    const snapshot = f.model.getSnapshot();
    expect(snapshot.status === 'ready' && snapshot.baseline.cursor).toBe(1);
  } finally {
    await f.model.dispose();
  }
});
it('cancels a cursor waiter and drains the generation when the model is disposed', async () => {
  const f = fixture();
  await vi.waitFor(() => expect(f.model.getSnapshot().status).toBe('ready'));
  const waiting = expect(
    f.model.createQuickCommandGroup(
      randomUUID(),
      { name: 'Folder', parentId: null },
      '"quick-command-tree-v1"',
    ),
  ).rejects.toThrow('AUTOMATION_MODEL_CLOSED');
  await setImmediate();
  await f.model.dispose();
  await waiting;
});
