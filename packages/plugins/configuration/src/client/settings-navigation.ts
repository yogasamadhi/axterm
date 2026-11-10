import type {
  SettingsCategoryId,
  SettingsSectionId,
  SettingsSectionSlot,
  SettingsTabId,
} from '@axterm/ui/workspace';
export const settingsCategories: readonly SettingsCategoryId[] = [
  'common',
  'terminal',
  'shortcuts',
  'sync',
  'ai',
  'password',
  'legal',
];
export const contributedSettingsTabs = ['profiles', 'themes', 'widgets'] as const;
export const settingsSections: readonly SettingsSectionId[] = [
  ...settingsCategories,
  ...contributedSettingsTabs,
];
const builtins = new Set<SettingsCategoryId>(['common', 'password', 'sync']);
export interface SettingsContributions {
  has(slot: SettingsSectionSlot): boolean;
  subscribe(slot: SettingsSectionSlot, changed: () => void): () => void;
}
export interface SettingsNavigationSnapshot {
  readonly selected: SettingsCategoryId;
  readonly tab: SettingsTabId;
  readonly available: readonly SettingsCategoryId[];
  readonly tabs: readonly SettingsTabId[];
}
/** UI arrangement only. Withdrawal falls back to a real surface and releases its subscription. */
export class SettingsNavigation {
  private state: SettingsNavigationSnapshot;
  private readonly listeners = new Set<() => void>();
  private readonly stops: (() => void)[];
  private closed = false;
  constructor(private readonly contributions: SettingsContributions) {
    this.state = { selected: 'common', tab: 'setting', ...this.available() };
    this.stops = settingsSections.map((section) =>
      contributions.subscribe(`settings.${section}`, () => this.refresh()),
    );
    this.refresh();
  }
  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => {
    this.assertOpen();
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  select(section: SettingsSectionId): void {
    this.assertOpen();
    if (settingsCategories.includes(section as SettingsCategoryId)) {
      if (!this.state.available.includes(section as SettingsCategoryId))
        throw new Error('SETTINGS_SECTION_UNAVAILABLE');
      if (this.state.tab !== 'setting' || this.state.selected !== section)
        this.publish({ ...this.state, tab: 'setting', selected: section as SettingsCategoryId });
    } else {
      if (!this.state.tabs.includes(section as SettingsTabId))
        throw new Error('SETTINGS_SECTION_UNAVAILABLE');
      if (this.state.tab !== section)
        this.publish({ ...this.state, tab: section as SettingsTabId });
    }
  }
  selectSettings(): void {
    this.assertOpen();
    if (this.state.tab !== 'setting') this.publish({ ...this.state, tab: 'setting' });
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const stop of this.stops) stop();
    this.listeners.clear();
  }
  private available() {
    return {
      available: Object.freeze(
        settingsCategories.filter(
          (section) => builtins.has(section) || this.contributions.has(`settings.${section}`),
        ),
      ),
      tabs: Object.freeze<SettingsTabId[]>([
        'setting',
        ...contributedSettingsTabs.filter((tab) => this.contributions.has(`settings.${tab}`)),
      ]),
    };
  }
  private refresh() {
    if (this.closed) return;
    const { available, tabs } = this.available();
    if (
      available.length === this.state.available.length &&
      available.every((v, i) => v === this.state.available[i]) &&
      tabs.length === this.state.tabs.length &&
      tabs.every((v, i) => v === this.state.tabs[i])
    )
      return;
    this.publish({
      available,
      tabs,
      selected: available.includes(this.state.selected) ? this.state.selected : 'common',
      tab: tabs.includes(this.state.tab) ? this.state.tab : 'setting',
    });
  }
  private publish(state: SettingsNavigationSnapshot) {
    this.state = Object.freeze(state);
    for (const listener of this.listeners) listener();
  }
  private assertOpen() {
    if (this.closed) throw new Error('SETTINGS_NAVIGATION_CLOSED');
  }
}
