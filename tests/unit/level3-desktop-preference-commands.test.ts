import { expect, it, vi } from 'vitest';
import {
  DEFAULT_DESKTOP_WINDOW_PREFERENCES,
  type DesktopWindowBaseline,
} from '@axterm/plugin-api/desktop';
import { DesktopPreferenceCommands } from '../../packages/plugins/desktop/src/client/preferences-commands.ts';
function fixture() {
  let baseline: DesktopWindowBaseline = {
    type: 'baseline',
    generation: crypto.randomUUID(),
    cursor: 0,
    record: { version: 0, preferences: { ...DEFAULT_DESKTOP_WINDOW_PREFERENCES } },
    native: null,
    application: 'unavailable',
  };
  const listeners = new Set<() => void>();
  return {
    getSnapshot: () => ({ status: 'ready' as const, baseline }),
    subscribe: (fn: () => void) => {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
    accept: () => {
      baseline = { ...baseline, cursor: 1, record: { ...baseline.record, version: 1 } };
      for (const fn of listeners) fn();
    },
    retire: () => {
      baseline = { ...baseline, generation: crypto.randomUUID() };
      for (const fn of listeners) fn();
    },
  };
}
it('captures immutable patch/key/version/generation and explicitly retries an unknown outcome', async () => {
  const facts = fixture(),
    review = facts.getSnapshot().baseline,
    patch = { opacity: 0.7 };
  const update = vi
    .fn()
    .mockRejectedValueOnce(Error('lost reply'))
    .mockImplementationOnce(async () => {
      facts.accept();
      return { version: 1, cursor: 1 };
    });
  const commands = new DesktopPreferenceCommands({ ...facts, update });
  const pending = commands.save(patch, review.record.version, review.generation);
  patch.opacity = 0.2;
  await expect(pending).rejects.toThrow('UNCERTAIN');
  const original = update.mock.calls[0];
  expect(original?.[1]).toEqual({ opacity: 0.7 });
  expect(() => commands.save({ opacity: 0.3 }, 0, review.generation)).toThrow('BUSY');
  await commands.retry();
  expect(update.mock.calls[1]).toEqual(original);
  await commands.close();
});
it('retires an unknown intent without sending it to a new Host generation', async () => {
  const facts = fixture(),
    review = facts.getSnapshot().baseline,
    update = vi.fn(async () => {
      throw Error('lost reply');
    }),
    commands = new DesktopPreferenceCommands({ ...facts, update });
  await expect(commands.save({ opacity: 0.7 }, 0, review.generation)).rejects.toThrow('UNCERTAIN');
  facts.retire();
  await expect(commands.retry()).rejects.toThrow('SAVE_FAILED');
  expect(update).toHaveBeenCalledOnce();
  await commands.close();
});
