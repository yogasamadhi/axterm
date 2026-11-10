import type { Context } from '@deepseek-ai/cordis';
import { randomUUID } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import type { RenameUpdate } from '@axterm/plugin-api/automation';
import { FileRenameModel } from '../../packages/plugins/automation/src/client/file-renames.ts';
import {
  RemoteStream,
  type RemoteStreamOptions,
} from '../../packages/infra/gateway/src/client/remote-stream.ts';
it('replaces a transient review generation on retry without replaying mutations and drains its observer on disposal', async () => {
  const generations: string[] = [];
  let active = 0;
  const run = vi.fn(async () => ({
    ok: true,
    value: { previewId: randomUUID(), renamed: 0, items: [], finishedAt: new Date().toISOString() },
  }));
  const context = {
    remote: {
      $stream: <Item>(options: RemoteStreamOptions<Item>) =>
        new RemoteStream(
          { generation: { getSnapshot: () => undefined, subscribe: () => () => {} } },
          options,
        ),
      automation: {
        runFileRename: run,
        watchFileRenames: async function* (signal: AbortSignal): AsyncGenerator<RenameUpdate> {
          const generation = randomUUID();
          generations.push(generation);
          active++;
          const abort = Promise.withResolvers<void>();
          const notify = () => abort.resolve();
          signal.addEventListener('abort', notify, { once: true });
          try {
            if (signal.aborted) return;
            const text = JSON.stringify({
              generation,
              revision: 0,
              previews: [],
              running: [],
              recoveries: [],
            });
            yield { type: 'begin', generation, revision: 0 };
            yield { type: 'chunk', offset: 0, text, final: true };
            yield { type: 'commit', revision: 0 };
            if (!signal.aborted) await abort.promise;
          } finally {
            signal.removeEventListener('abort', notify);
            active--;
          }
        },
      },
    },
  } as unknown as Context;
  const model = new FileRenameModel(context);
  try {
    await vi.waitFor(() => expect(model.getSnapshot().status).toBe('ready'));
    await model.run(randomUUID(), randomUUID(), new AbortController().signal);
    await model.retry();
    await vi.waitFor(() => {
      const state = model.getSnapshot();
      expect(state.status === 'ready' && state.baseline.generation).toBe(generations[1]);
    });
    expect(generations).toHaveLength(2);
    expect(run).toHaveBeenCalledTimes(1);
    expect(active).toBe(1);
  } finally {
    await model.dispose();
  }
  expect(active).toBe(0);
  await expect(model.run(randomUUID(), randomUUID(), new AbortController().signal)).rejects.toThrow(
    'RENAME_MODEL_CLOSED',
  );
});
