import { expect, it } from 'vitest';
import { ShortcutReferences } from '../../packages/infra/shortcuts/src/client/references.ts';
import { quickCommandReference } from '../../packages/plugins/automation/src/client/shortcut-references.ts';
import { normalizeBinding } from '@axterm/plugin-api/shortcuts';
import type { ShortcutCommandId } from '@axterm/plugin-api/shortcuts';
const binding = normalizeBinding({ code: 'KeyZ', modifiers: ['alt', 'shift'] }, 'macos');
it('reports first matching Quick Command metadata with legacy aliases and no wheel entry', () => {
  const rows = [
    { id: 'a', name: 'First', shortcut: 'Option+Shift+Z' },
    { id: 'b', name: 'Second', shortcut: 'alt+shift+z' },
    { id: 'c', name: 'Wheel', shortcut: 'meta+wheelup' },
  ];
  expect(quickCommandReference(binding, rows, 'macos', (name) => `Quick ${name}`)).toEqual([
    { id: 'quick-command.a', label: 'Quick First' },
  ]);
  expect(
    quickCommandReference(
      normalizeBinding({ code: 'KeyK', modifiers: ['meta'] }, 'macos'),
      rows,
      'macos',
      (name) => name,
    ),
  ).toEqual([]);
});
it('preserves application precedence and retires only the owned metadata source', () => {
  const references = new ShortcutReferences();
  const off = references.register((candidate) =>
    quickCommandReference(
      candidate,
      [{ id: 'a', name: 'First', shortcut: 'alt+shift+z' }],
      'macos',
      (name) => name,
    ),
  );
  expect(references.describe(binding, ['app.newTab' as ShortcutCommandId])).toEqual([]);
  expect(references.describe(binding, [])).toEqual([{ id: 'quick-command.a', label: 'First' }]);
  off();
  off();
  expect(references.describe(binding, [])).toEqual([]);
  references.close();
  expect(() => references.register(() => [])).toThrow('UNAVAILABLE');
});
