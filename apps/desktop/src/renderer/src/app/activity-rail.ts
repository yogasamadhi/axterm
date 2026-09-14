import { ACTIVITY_RAIL_ITEM_IDS, type ActivityRailItem, type Settings } from '@workspace/contracts';

export function orderedActivityRailItems(settings: Settings | undefined): ActivityRailItem[] {
  return settings?.workspace.activityRailItems ?? [...ACTIVITY_RAIL_ITEM_IDS];
}
