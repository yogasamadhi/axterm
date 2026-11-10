import { expect, it, vi } from 'vitest';
import type { SettingsSectionSlot } from '@axterm/ui/workspace';
import { SettingsNavigation } from '../../packages/plugins/configuration/src/client/settings-navigation.ts';
function fixture() {
  const active = new Set<SettingsSectionSlot>();
  const listeners = new Map<SettingsSectionSlot, () => void>();
  const navigation = new SettingsNavigation({
    has: (slot) => active.has(slot),
    subscribe: (slot, changed) => {
      listeners.set(slot, changed);
      return () => {
        listeners.delete(slot);
      };
    },
  });
  return {
    navigation,
    listeners,
    contribute(slot: SettingsSectionSlot) {
      active.add(slot);
      listeners.get(slot)?.();
    },
    withdraw(slot: SettingsSectionSlot) {
      active.delete(slot);
      listeners.get(slot)?.();
    },
  };
}
it('keeps real built-in surfaces and exposes additional categories only while their owners contribute', () => {
  const f = fixture();
  expect(f.navigation.getSnapshot()).toEqual({
    selected: 'common',
    tab: 'setting',
    tabs: ['setting'],
    available: ['common', 'sync', 'password'],
  });
  expect(() => f.navigation.select('terminal')).toThrow('UNAVAILABLE');
  f.contribute('settings.terminal');
  f.navigation.select('terminal');
  expect(f.navigation.getSnapshot().selected).toBe('terminal');
  f.withdraw('settings.terminal');
  expect(f.navigation.getSnapshot()).toEqual({
    selected: 'common',
    tab: 'setting',
    tabs: ['setting'],
    available: ['common', 'sync', 'password'],
  });
  f.navigation.close();
});
it('keeps stable snapshots for unrelated entry changes and releases all subscriptions on close', () => {
  const f = fixture();
  const before = f.navigation.getSnapshot(),
    changed = vi.fn();
  f.navigation.subscribe(changed);
  f.contribute('settings.common');
  expect(f.navigation.getSnapshot()).toBe(before);
  expect(changed).not.toHaveBeenCalled();
  f.contribute('settings.ai');
  expect(changed).toHaveBeenCalledTimes(1);
  f.navigation.close();
  f.navigation.close();
  expect(f.listeners.size).toBe(0);
  expect(() => f.navigation.select('common')).toThrow('CLOSED');
  expect(() => f.navigation.subscribe(() => {})).toThrow('CLOSED');
});

it('keeps Profiles in a contributed top tab and returns to Settings when its owner withdraws', () => {
  const f = fixture();
  f.contribute('settings.profiles');
  expect(f.navigation.getSnapshot().tabs).toEqual(['setting', 'profiles']);
  expect(f.navigation.getSnapshot().available).not.toContain('profiles');
  f.navigation.select('profiles');
  expect(f.navigation.getSnapshot().tab).toBe('profiles');
  f.withdraw('settings.profiles');
  expect(f.navigation.getSnapshot().tab).toBe('setting');
  f.navigation.close();
});
