import { describe, expect, it } from 'vitest';
import {
  filterSettingsCategories,
  moveSettingsCategory,
  SETTINGS_CATEGORIES,
} from '../../apps/desktop/src/renderer/src/app/settings-navigation';

describe('settings navigation', () => {
  it('covers every Electerm settings category and filters by labels or concepts', () => {
    expect(SETTINGS_CATEGORIES.map(({ id }) => id)).toEqual([
      'common',
      'terminal',
      'shortcuts',
      'sync',
      'ai',
      'password',
    ]);
    expect(filterSettingsCategories('webdav').map(({ id }) => id)).toEqual(['sync']);
    expect(filterSettingsCategories('vault').map(({ id }) => id)).toEqual(['password']);
    expect(filterSettingsCategories('missing')).toEqual([]);
  });

  it('supports wrapping arrows and deterministic Home/End keyboard movement', () => {
    expect(moveSettingsCategory(SETTINGS_CATEGORIES, 'password', 'ArrowDown')).toBe('common');
    expect(moveSettingsCategory(SETTINGS_CATEGORIES, 'common', 'ArrowUp')).toBe('password');
    expect(moveSettingsCategory(SETTINGS_CATEGORIES, 'terminal', 'Home')).toBe('common');
    expect(moveSettingsCategory(SETTINGS_CATEGORIES, 'terminal', 'End')).toBe('password');
    expect(moveSettingsCategory([], 'terminal', 'ArrowDown')).toBeUndefined();
  });
});
