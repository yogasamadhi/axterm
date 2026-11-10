import { expect, it, vi } from 'vitest';
import { TerminalViewOwner } from '../../packages/plugins/terminals/src/client/interactions/owner.ts';
it('keeps the opening selection across redraw and menu disposal while keyboard copy stays live', async () => {
  const owner = new TerminalViewOwner();
  let live = 'CLI_SELECTED_ORIGINAL';
  const copied: string[] = [];
  owner.register('one', {
    selectionAvailable: () => !!live,
    captureSelection: () => live,
    run(_action, _signal, captured) {
      copied.push(captured?.selection ?? live);
    },
  });
  const menu = owner.captureContext('one');
  expect(menu.hasSelection).toBe(true);
  expect(JSON.stringify(menu)).not.toContain('CLI_SELECTED_ORIGINAL');
  live = 'CLI_REDRAW_1';
  const requested = menu.run('copy');
  menu.dispose();
  await requested;
  expect(copied).toEqual(['CLI_SELECTED_ORIGINAL']);
  await owner.run('one', 'copy');
  expect(copied).toEqual(['CLI_SELECTED_ORIGINAL', 'CLI_REDRAW_1']);
  await expect(menu.run('copy')).rejects.toThrow('RETIRED');
  live = '';
  const empty = owner.captureContext('one');
  expect(empty.hasSelection).toBe(false);
  empty.dispose();
  await owner.dispose();
});
it('revokes old selections on view withdrawal and cancels admitted operations before replacement delivery', async () => {
  const owner = new TerminalViewOwner(),
    delivered = vi.fn(),
    replacement = vi.fn();
  const off = owner.register('one', {
    selectionAvailable: () => true,
    captureSelection: () => 'old selection',
    run: delivered,
  });
  const old = owner.captureContext('one'),
    task = old.run('explain');
  const rejected = expect(task).rejects.toThrow();
  off();
  owner.register('one', {
    selectionAvailable: () => true,
    captureSelection: () => 'new selection',
    run: replacement,
  });
  off();
  await rejected;
  await expect(old.run('copy')).rejects.toThrow('RETIRED');
  expect(delivered).not.toHaveBeenCalled();
  expect(replacement).not.toHaveBeenCalled();
  const current = owner.captureContext('one');
  await current.run('copy');
  expect(replacement).toHaveBeenCalledWith('copy', expect.any(AbortSignal), {
    selection: 'new selection',
  });
  await owner.dispose();
  await expect(current.run('copy')).rejects.toThrow('RETIRED');
});
it('bounds retained contexts and their text, releasing capacity on cancel and unload', async () => {
  const owner = new TerminalViewOwner();
  let selection = 'x'.repeat(1024 * 1024);
  owner.register('one', {
    selectionAvailable: () => true,
    captureSelection: () => selection,
    run: () => {},
  });
  const first = owner.captureContext('one'),
    second = owner.captureContext('one');
  expect(() => owner.captureContext('one')).toThrow('CAPACITY');
  first.dispose();
  const third = owner.captureContext('one');
  second.dispose();
  third.dispose();
  selection = 'x'.repeat(1024 * 1024 + 1);
  expect(() => owner.captureContext('one')).toThrow('CAPACITY');
  selection = '';
  const contexts = Array.from({ length: 16 }, () => owner.captureContext('one'));
  expect(() => owner.captureContext('one')).toThrow('UNAVAILABLE');
  contexts[0]!.dispose();
  const final = owner.captureContext('one');
  await owner.dispose();
  await expect(final.run('copy')).rejects.toThrow('RETIRED');
  expect(() => owner.captureContext('one')).toThrow('UNAVAILABLE');
});
