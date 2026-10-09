import { describe, expect, it } from 'vitest';
import { settingsSchema, type ActivityRailItem } from '../../packages/contracts/src';
import {
  orderedActivityRailItems,
  VISIBLE_ACTIVITY_RAIL_ITEM_IDS,
} from '../../apps/desktop/src/renderer/src/app/activity-rail';

function savedSettings(items: ActivityRailItem[]) {
  return settingsSchema.parse({
    appearance: { theme: 'dark', language: 'zh-CN' },
    workspace: { restoreLayout: true, aiInspectorOpen: false, activityRailItems: items },
    terminal: { autoReconnectTerminal: false, restoreTerminalSessionOnReload: false },
    version: 1,
  });
}

describe('activity rail compatibility', () => {
  it('filters retired shortcuts from a valid saved configuration without changing its order or data', () => {
    const settings = savedSettings([
      'widgets',
      'quickConnect',
      'setting',
      'bookmarks',
      'terminalThemes',
      'newBookmark',
      'settingSync',
    ]);
    expect(orderedActivityRailItems(settings)).toEqual(['setting', 'bookmarks', 'newBookmark']);
    expect(settings.workspace.activityRailItems).toEqual([
      'widgets',
      'quickConnect',
      'setting',
      'bookmarks',
      'terminalThemes',
      'newBookmark',
      'settingSync',
    ]);
  });

  it('keeps navigation available when a saved configuration contains only retired shortcuts', () => {
    expect(
      orderedActivityRailItems(
        savedSettings(['quickConnect', 'terminalThemes', 'settingSync', 'widgets']),
      ),
    ).toEqual(VISIBLE_ACTIVITY_RAIL_ITEM_IDS);
  });

  it('uses the remaining defaults while settings load and preserves a single selected destination', () => {
    expect(orderedActivityRailItems(undefined)).toEqual(VISIBLE_ACTIVITY_RAIL_ITEM_IDS);
    expect(orderedActivityRailItems(savedSettings(['bookmarks']))).toEqual([
      'newBookmark',
      'bookmarks',
    ]);
  });

  it('keeps creation and bookmarks available together without mutating a saved configuration', () => {
    const settings = savedSettings(['setting', 'newBookmark']);
    expect(orderedActivityRailItems(settings)).toEqual(['setting', 'newBookmark', 'bookmarks']);
    expect(settings.workspace.activityRailItems).toEqual(['setting', 'newBookmark']);
    expect(orderedActivityRailItems(savedSettings(['newBookmark']))).toEqual([
      'newBookmark',
      'bookmarks',
    ]);
    expect(orderedActivityRailItems(savedSettings(['setting', 'bookmarks']))).toEqual([
      'setting',
      'newBookmark',
      'bookmarks',
    ]);
  });

  it('restores the fixed bookmark shortcut when a saved configuration omitted it', () => {
    const settings = savedSettings(['settingSync', 'setting', 'widgets']);
    expect(orderedActivityRailItems(settings)).toEqual(['newBookmark', 'bookmarks', 'setting']);
    expect(settings.workspace.activityRailItems).toEqual(['settingSync', 'setting', 'widgets']);
  });
});
