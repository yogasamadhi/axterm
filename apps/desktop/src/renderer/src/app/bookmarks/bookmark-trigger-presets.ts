import type { Bookmark } from '@workspace/contracts';
import type { AxtermMessageKey } from '../../i18n/core';

type BookmarkTrigger = Bookmark['triggers'][number];

// Presets are opt-in starting points, represented by user intent rather than
// a stored copy of a trigger rule. The user can inspect and edit the result.
export const BOOKMARK_TRIGGER_PRESET_OPTIONS: Array<{
  id: 'pager-space' | 'password-alert';
  labelKey: AxtermMessageKey;
  nameKey: AxtermMessageKey;
}> = [
  {
    id: 'pager-space',
    labelKey: 'bookmarkTriggers.pagerPreset',
    nameKey: 'bookmarkTriggers.pagerName',
  },
  {
    id: 'password-alert',
    labelKey: 'bookmarkTriggers.passwordPreset',
    nameKey: 'bookmarkTriggers.passwordName',
  },
];

export function buildBookmarkTriggerPreset(
  id: (typeof BOOKMARK_TRIGGER_PRESET_OPTIONS)[number]['id'],
  name: string,
): Omit<BookmarkTrigger, 'id'> {
  const shared = { name, enabled: true, sendEnter: false, mode: 'cooldown' as const };
  if (id === 'pager-space') {
    return {
      ...shared,
      match: { type: 'text', value: '--More--', caseSensitive: false },
      action: { type: 'send', value: ' ' },
      cooldownMs: 900,
    };
  }
  return {
    ...shared,
    match: {
      type: 'regex',
      value: 'password(?: for [^:\\r\\n]+)?[ \\t]*:',
      caseSensitive: false,
    },
    action: { type: 'notify', value: '' },
    cooldownMs: 10_000,
  };
}
