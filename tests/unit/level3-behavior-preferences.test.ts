import { expect, it, vi } from 'vitest';
import { settingsSchema, type SettingsBaseline } from '@axterm/plugin-api/configuration';
import { BehaviorPreferenceCommands } from '../../packages/plugins/configuration/src/client/behavior-commands.ts';
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
  const owner = new BehaviorPreferenceCommands({ ...facts, updateSettings: write });
  const saving = owner.save({ terminal: { screenReaderMode: true } });
  await vi.waitFor(() => expect(write).toHaveBeenCalledOnce());
  let closed = false;
  const closing = owner.close().then(() => {
    closed = true;
  });
  await Promise.resolve();
  expect(closed).toBe(false);
  expect(() => owner.save({ terminal: { screenReaderMode: true } })).toThrow('BUSY');
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
  const owner = new BehaviorPreferenceCommands({ ...facts, updateSettings: write });
  await expect(owner.save({ terminal: { screenReaderMode: true } })).rejects.toThrow(
    'OUTCOME_UNCERTAIN',
  );
  facts.retire();
  await expect(owner.retry()).rejects.toThrow('SAVE_FAILED');
  expect(owner.getSnapshot().uncertain).toBe(false);
  expect(write).toHaveBeenCalledOnce();
  await owner.close();
});

it('reconciles an unknown preference with the original immutable input and etag', async () => {
  const facts = fixture(),
    write = vi
      .fn()
      .mockRejectedValueOnce(Error('lost reply'))
      .mockImplementationOnce(async () => {
        facts.accept();
        return { cursor: 1, version: 2 };
      });
  const owner = new BehaviorPreferenceCommands({ ...facts, updateSettings: write });
  const input = { fileManager: { refreshOnFocus: true } };
  await expect(owner.save(input)).rejects.toThrow('OUTCOME_UNCERTAIN');
  input.fileManager.refreshOnFocus = false;
  expect(() => owner.save({ workspace: { showTabNumber: false } })).toThrow('BUSY');
  await owner.retry();
  expect(write.mock.calls[1]).toEqual(write.mock.calls[0]);
  expect(write.mock.calls[1]![1]).toEqual({ fileManager: { refreshOnFocus: true } });
  await owner.close();
});
