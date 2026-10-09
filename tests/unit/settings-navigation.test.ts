import { describe, expect, it } from 'vitest';
import {
  filterSettingsCategories,
  moveSettingsCategory,
  SETTINGS_CATEGORIES,
} from '../../apps/desktop/src/renderer/src/app/settings-navigation';

describe('settings navigation', () => {
  it('covers settings and Legal/About and filters by labels or concepts', () => {
    expect(SETTINGS_CATEGORIES.map(({ id }) => id)).toEqual([
      'common',
      'terminal',
      'shortcuts',
      'sync',
      'ai',
      'password',
      'legal',
    ]);
    expect(filterSettingsCategories('webdav').map(({ id }) => id)).toEqual(['sync']);
    expect(filterSettingsCategories('vault').map(({ id }) => id)).toEqual(['password']);
    expect(filterSettingsCategories('license').map(({ id }) => id)).toEqual(['legal']);
    expect(filterSettingsCategories('missing')).toEqual([]);
  });

  it('supports wrapping arrows and deterministic Home/End keyboard movement', () => {
    expect(moveSettingsCategory(SETTINGS_CATEGORIES, 'legal', 'ArrowDown')).toBe('common');
    expect(moveSettingsCategory(SETTINGS_CATEGORIES, 'common', 'ArrowUp')).toBe('legal');
    expect(moveSettingsCategory(SETTINGS_CATEGORIES, 'terminal', 'Home')).toBe('common');
    expect(moveSettingsCategory(SETTINGS_CATEGORIES, 'terminal', 'End')).toBe('legal');
    expect(moveSettingsCategory([], 'terminal', 'ArrowDown')).toBeUndefined();
  });
});
