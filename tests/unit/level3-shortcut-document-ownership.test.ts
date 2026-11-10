import { expect, it, vi } from 'vitest';
import { settingsSchema, type SettingsBaseline } from '@axterm/plugin-api/configuration';
import { ShortcutDocumentCommands } from '../../packages/plugins/configuration/src/client/shortcut-commands.ts';
function fixture() {
  let baseline: SettingsBaseline = {
    generation: crypto.randomUUID(),
    cursor: 0,
    settings: settingsSchema.parse({
      appearance: { theme: 'dark', language: 'en' },
      workspace: { restoreLayout: true, aiInspectorOpen: false },
      version: 1,
    }),
  };
  const listeners = new Set<() => void>();
  return {
    getSnapshot: () => ({ status: 'ready' as const, baseline }),
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    accept() {
      baseline = { ...baseline, cursor: 1 };
      for (const listener of listeners) listener();
    },
    retire() {
      baseline = { ...baseline, generation: crypto.randomUUID() };
      for (const listener of listeners) listener();
    },
    listeners,
  };
}
it('joins the actual pending preference write during close and accepts an already observed receipt', async () => {
  const facts = fixture();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const write = vi.fn(async () => {
    await gate;
    facts.accept();
    return { cursor: 1, version: 2 };
  });
  const owner = new ShortcutDocumentCommands({ ...facts, setShortcutDocument: write });
  const saving = owner.save({ schemaVersion: 1, profiles: {} });
  await vi.waitFor(() => expect(write).toHaveBeenCalledOnce());
  let closed = false;
  const closing = owner.close().then(() => {
    closed = true;
  });
  await Promise.resolve();
  expect(closed).toBe(false);
  expect(() => owner.save({ schemaVersion: 1, profiles: {} })).toThrow('BUSY');
  release();
  await saving;
  await closing;
  expect(facts.listeners.size).toBe(0);
  expect(write).toHaveBeenCalledOnce();
});
it('retires an unknown intent on generation change without submitting its bytes to the replacement Host', async () => {
  const facts = fixture();
  const write = vi.fn(async () => {
    throw Error('connection lost');
  });
  const owner = new ShortcutDocumentCommands({ ...facts, setShortcutDocument: write });
  await expect(owner.save({ schemaVersion: 1, profiles: {} })).rejects.toThrow('OUTCOME_UNCERTAIN');
  facts.retire();
  await expect(owner.retry()).rejects.toThrow('SAVE_FAILED');
  expect(owner.getSnapshot().uncertain).toBe(false);
  expect(write).toHaveBeenCalledOnce();
  await owner.close();
});

it('retries an unknown write with its exact receipt key and refuses a different draft', async () => {
  const facts = fixture(),
    write = vi
      .fn()
      .mockRejectedValueOnce(Error('lost reply'))
      .mockImplementationOnce(async () => {
        facts.accept();
        return { cursor: 1, version: 2 };
      });
  const owner = new ShortcutDocumentCommands({ ...facts, setShortcutDocument: write }),
    generation = facts.getSnapshot().baseline.generation,
    raw = JSON.stringify({ schemaVersion: 1, profiles: {} });
  await expect(owner.writeRaw(raw, generation)).rejects.toThrow('OUTCOME_UNCERTAIN');
  expect(() =>
    owner.writeRaw(JSON.stringify({ schemaVersion: 2, profiles: {} }), generation),
  ).toThrow('OUTCOME_UNCERTAIN');
  await owner.writeRaw(raw, generation);
  expect(write.mock.calls[1]).toEqual(write.mock.calls[0]);
  await owner.close();
});

it('keeps reset metadata immutable when reconciling an unknown document write', async () => {
  const facts = fixture(),
    write = vi
      .fn()
      .mockRejectedValueOnce(Error('lost reply'))
      .mockImplementationOnce(async () => {
        facts.accept();
        return { cursor: 1, version: 2 };
      });
  const owner = new ShortcutDocumentCommands({ ...facts, setShortcutDocument: write }),
    generation = facts.getSnapshot().baseline.generation,
    raw = JSON.stringify({ schemaVersion: 2, profiles: { 'desktop:macos': {} } });
  await expect(owner.writeRaw(raw, generation, true)).rejects.toThrow('OUTCOME_UNCERTAIN');
  expect(() => owner.writeRaw(raw, generation, false)).toThrow('OUTCOME_UNCERTAIN');
  await owner.writeRaw(raw, generation, true);
  expect(write.mock.calls[1]).toEqual(write.mock.calls[0]);
  expect(write.mock.calls[0]![4]).toBe(true);
  await owner.close();
});
