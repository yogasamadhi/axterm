import { expect, it, vi } from 'vitest';
import { settingsSchema, type SettingsBaseline } from '@axterm/plugin-api/configuration';
import { TerminalKeyBarCommands } from '../../packages/plugins/terminals/src/client/keybar/commands.ts';
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
  const owner = new TerminalKeyBarCommands({ ...facts, setTerminalShortcutBarButtons: write });
  const saving = owner.save([]);
  await vi.waitFor(() => expect(write).toHaveBeenCalledOnce());
  let closed = false;
  const closing = owner.close().then(() => {
    closed = true;
  });
  await Promise.resolve();
  expect(closed).toBe(false);
  expect(() => owner.save([])).toThrow('BUSY');
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
  const owner = new TerminalKeyBarCommands({ ...facts, setTerminalShortcutBarButtons: write });
  await expect(owner.save([])).rejects.toThrow('OUTCOME_UNCERTAIN');
  facts.retire();
  await expect(owner.retry()).rejects.toThrow('SAVE_FAILED');
  expect(owner.getSnapshot().uncertain).toBe(false);
  expect(write).toHaveBeenCalledOnce();
  await owner.close();
});
