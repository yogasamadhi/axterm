import type { ActivityRailItem, Settings } from '@workspace/contracts';

export const VISIBLE_ACTIVITY_RAIL_ITEM_IDS = [
  'newBookmark',
  'bookmarks',
  'setting',
] as const satisfies readonly ActivityRailItem[];

export type VisibleActivityRailItem = (typeof VISIBLE_ACTIVITY_RAIL_ITEM_IDS)[number];

function isVisibleActivityRailItem(item: ActivityRailItem): item is VisibleActivityRailItem {
  return VISIBLE_ACTIVITY_RAIL_ITEM_IDS.some((visible) => visible === item);
}

export function orderedActivityRailItems(
  settings: Settings | undefined,
): VisibleActivityRailItem[] {
  // Keep existing settings readable without restoring the retired sidebar shortcuts.
  const visible = settings?.workspace.activityRailItems.filter(isVisibleActivityRailItem) ?? [];
  if (!visible.length) return [...VISIBLE_ACTIVITY_RAIL_ITEM_IDS];
  if (!visible.includes('bookmarks')) {
    const createIndex = visible.indexOf('newBookmark');
    visible.splice(createIndex < 0 ? 0 : createIndex + 1, 0, 'bookmarks');
  }
  if (!visible.includes('newBookmark'))
    visible.splice(visible.indexOf('bookmarks'), 0, 'newBookmark');
  return visible;
}
