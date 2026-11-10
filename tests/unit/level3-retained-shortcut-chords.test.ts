import { quickCommandReference } from '../../packages/plugins/automation/src/client/shortcut-references.ts';
import { expect, it, vi } from 'vitest';
import {
  normalizeBinding,
  parseLegacyShortcut,
  presentBinding,
  type ShortcutCommandId,
  type ShortcutRevision,
} from '@axterm/plugin-api/shortcuts';
import { ShortcutRegistry } from '../../packages/infra/shortcuts/src/client/registry.ts';
const id = (value: string) => value as ShortcutCommandId;
it('retains original physical Slash and F11 keys and Meta wheel-up metadata in the public protocol', () => {
  expect(normalizeBinding({ code: 'Slash', modifiers: ['alt'] }, 'linux')).toEqual({
    code: 'Slash',
    modifiers: ['alt'],
  });
  expect(normalizeBinding({ code: 'F11', modifiers: ['alt', 'shift'] }, 'linux')).toEqual({
    code: 'F11',
    modifiers: ['alt', 'shift'],
  });
  expect(parseLegacyShortcut('meta+wheelup', 'macos')).toEqual({
    kind: 'wheel',
    direction: 'up',
    modifiers: ['meta'],
  });
});
it('retains CommandOrControl and Alt slash aliases with DSH canonical physical keys and keycaps', () => {
  expect(parseLegacyShortcut('CommandOrControl+Shift+L', 'macos')).toEqual({
    kind: 'keyboard',
    binding: { code: 'KeyL', modifiers: ['shift', 'meta'] },
  });
  expect(parseLegacyShortcut('CommandOrControl+Shift+L', 'linux')).toEqual({
    kind: 'keyboard',
    binding: { code: 'KeyL', modifiers: ['control', 'shift'] },
  });
  expect(parseLegacyShortcut('Alt+/', 'linux')).toEqual({
    kind: 'keyboard',
    binding: { code: 'Slash', modifiers: ['alt'] },
  });
  expect(
    presentBinding(
      normalizeBinding({ code: 'KeyL', modifiers: ['meta', 'shift'] }, 'macos'),
      'macos',
    ).keys,
  ).toEqual(['⇧', '⌘', 'L']);
  expect(
    presentBinding(
      normalizeBinding({ code: 'KeyL', modifiers: ['control', 'shift'] }, 'windows'),
      'windows',
    ).keys.join(''),
  ).toBe('Ctrl+Shift+L');
});
it('blocks original Alt-R action collision and reserved Control-K while retaining actual fixed ownership', () => {
  expect(
    quickCommandReference(
      normalizeBinding({ code: 'KeyP', modifiers: ['control', 'shift'] }, 'linux'),
      [{ id: 'qc-1', name: '部署', shortcut: 'CommandOrControl+Shift+P' }],
      'linux',
      (name) => name,
    ),
  ).toEqual([{ id: 'quick-command.qc-1', label: '部署' }]);

  const registry = new ShortcutRegistry('desktop', 'linux'),
    run = vi.fn();
  const off = registry.register({
    id: id('app.reloadCurrentTab'),
    label: () => 'Reload',
    aliases: [],
    defaults: { 'desktop:linux': { code: 'KeyR', modifiers: ['alt'] } },
    regions: ['page'],
    modals: [],
    resolve: () => ({ status: 'handled', run }),
  });
  expect(() =>
    registry.register({
      id: id('app.newTab'),
      label: () => 'New',
      aliases: [],
      defaults: { 'desktop:linux': { code: 'KeyR', modifiers: ['alt'] } },
      regions: ['page'],
      modals: [],
      resolve: () => ({ status: 'handled', run }),
    }),
  ).toThrow('Conflicting');
  const fixed = registry.registerFixed({
    id: id('workspace.palette'),
    label: () => 'Palette',
    keys: ['Ctrl', 'K'],
    bindings: [{ code: 'KeyK', modifiers: ['control'] }],
    group: 'application',
  });
  registry.configure({
    ...registry.config.getSnapshot(),
    revision: crypto.randomUUID() as ShortcutRevision,
    document: {
      schemaVersion: 2,
      profiles: {
        'desktop:linux': { 'app.reloadCurrentTab': { code: 'KeyK', modifiers: ['control'] } },
      },
    },
  });
  expect(registry.catalog.getSnapshot()[0]?.conflicts).toEqual(['workspace.palette']);
  expect(
    registry.dispatch(
      {
        code: 'KeyK',
        control: true,
        alt: false,
        shift: false,
        meta: false,
        repeat: false,
        composing: false,
        defaultPrevented: false,
      },
      { region: 'page', modal: null, target: null },
      vi.fn(),
    ).status,
  ).toBe('blocked');
  expect(run).not.toHaveBeenCalled();
  fixed();
  off();
  expect(registry.catalog.getSnapshot()).toEqual([]);
});
