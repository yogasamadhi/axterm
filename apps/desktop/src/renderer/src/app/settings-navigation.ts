export const SETTINGS_CATEGORIES = [
  {
    id: 'common',
    label: 'Common',
    translationKey: 'common',
    keywords: 'general runtime diagnostics window network privacy',
  },
  {
    id: 'terminal',
    label: 'Terminal',
    translationKey: 'terminal',
    keywords: 'shell profile appearance behavior recovery',
  },
  {
    id: 'shortcuts',
    label: 'Shortcuts',
    translationKey: 'settingShortcuts',
    keywords: 'keyboard hotkey history',
  },
  {
    id: 'sync',
    label: 'Setting sync',
    translationKey: 'settingSync',
    keywords: 'backup import export cloud webdav gist',
  },
  { id: 'ai', label: 'AI', translationKey: 'aiConfig', keywords: 'provider model assistant api' },
  {
    id: 'password',
    label: 'Password',
    translationKey: 'password',
    keywords: 'credential vault secret key',
  },
] as const;

export type SettingsCategoryId = (typeof SETTINGS_CATEGORIES)[number]['id'];

export function filterSettingsCategories(
  query: string,
  labelFor: (category: (typeof SETTINGS_CATEGORIES)[number]) => string = ({ label }) => label,
): readonly (typeof SETTINGS_CATEGORIES)[number][] {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return SETTINGS_CATEGORIES;
  return SETTINGS_CATEGORIES.filter((category) =>
    `${labelFor(category)} ${category.label} ${category.keywords}`
      .toLocaleLowerCase()
      .includes(needle),
  );
}

export function moveSettingsCategory(
  visible: readonly { id: SettingsCategoryId }[],
  current: SettingsCategoryId,
  key: 'ArrowUp' | 'ArrowDown' | 'Home' | 'End',
): SettingsCategoryId | undefined {
  if (!visible.length) return undefined;
  if (key === 'Home') return visible[0]!.id;
  if (key === 'End') return visible.at(-1)!.id;
  const currentIndex = Math.max(
    0,
    visible.findIndex(({ id }) => id === current),
  );
  const offset = key === 'ArrowDown' ? 1 : -1;
  return visible[(currentIndex + offset + visible.length) % visible.length]!.id;
}
