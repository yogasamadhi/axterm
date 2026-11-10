import type { Context } from '@deepseek-ai/cordis';
import { createHash } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { LegalDocumentsModel } from '../../packages/plugins/configuration/src/client/legal.ts';
import type { SettingsState } from '../../packages/plugins/configuration/src/client/index.ts';
import { settingsSchema } from '@axterm/plugin-api/configuration';
function fixture() {
  const text = 'Package license\n',
    id = 'a'.repeat(24),
    generation = crypto.randomUUID(),
    listeners = new Set<() => void>();
  let facts: SettingsState = {
    status: 'ready',
    baseline: {
      generation,
      cursor: 0,
      settings: settingsSchema.parse({
        appearance: { theme: 'dark', language: 'en' },
        workspace: { restoreLayout: false, aiInspectorOpen: false },
        version: 1,
      }),
    },
  };
  const descriptor = {
    id,
    name: 'LICENSE',
    bytes: Buffer.byteLength(text),
    sha256: createHash('sha256').update(text).digest('hex'),
  };
  const dispose = vi.fn();
  let gate = false,
    entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const ctx = {
    remote: {
      configuration: {
        listLegalDocuments: async () => ({
          ok: true,
          value: { generation, documents: [descriptor] },
        }),
        readLegalDocument: (_id: string, signal: AbortSignal) => ({
          dispose,
          async *[Symbol.asyncIterator]() {
            entered();
            if (gate)
              await new Promise<void>((_resolve, reject) => {
                signal.addEventListener('abort', () => reject(Error('aborted')), { once: true });
                if (signal.aborted) reject(Error('aborted'));
              });
            yield { offset: 0, text };
          },
        }),
      },
    },
  } as unknown as Context;
  const model = new LegalDocumentsModel(ctx, {
    getSnapshot: () => facts,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  });
  return {
    model,
    id,
    text,
    dispose,
    descriptor,
    listeners,
    started,
    hold: () => {
      gate = true;
    },
    retire: () => {
      facts = { status: 'error', message: 'carrier lost' };
      for (const listener of listeners) listener();
    },
  };
}
it('publishes complete immutable metadata and returns text only after digest verification', async () => {
  const f = fixture();
  await f.model.load();
  const state = f.model.getSnapshot();
  expect(state.status).toBe('ready');
  if (state.status !== 'ready') throw Error('missing baseline');
  expect(Object.isFrozen(state.baseline.documents)).toBe(true);
  expect(await f.model.read(f.id, new AbortController().signal)).toBe(f.text);
  expect(f.dispose).toHaveBeenCalledOnce();
  await f.model.close();
  expect(f.listeners.size).toBe(0);
});
it('cancels generation-bound reads and drains their actual pending work', async () => {
  const f = fixture();
  await f.model.load();
  f.hold();
  const reading = f.model.read(f.id, new AbortController().signal);
  await f.started;
  f.retire();
  await expect(reading).rejects.toThrow('aborted');
  expect(f.dispose).toHaveBeenCalledOnce();
  expect(f.model.getSnapshot().status).toBe('connecting');
  await f.model.close();
  expect(f.listeners.size).toBe(0);
});
