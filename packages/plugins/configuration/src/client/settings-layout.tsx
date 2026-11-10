import type {} from './locales.ts';
import { filterSettingsCategories, moveSettingsCategory } from './settings-search.ts';
import { Search } from 'lucide-react';
import { useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import type { PropsLocale } from '@axterm/ui';
import type { SettingsRenderShare } from '@axterm/ui/workspace';
import type { SettingsNavigation } from './settings-navigation.ts';
import styles from './ui.module.css';
export function SettingsLayout({
  navigation,
  t,
  renderSlot,
  general,
  loadError,
  password,
  sync,
}: {
  navigation: SettingsNavigation;
  general: ReactNode;
  loadError?: ReactNode;
  password: ReactNode;
  sync: ReactNode;
} & PropsLocale<'configuration'> &
  SettingsRenderShare) {
  const view = useSyncExternalStore(navigation.subscribe, navigation.getSnapshot);
  const [query, setQuery] = useState('');
  const sidebar = useRef<HTMLElement>(null);
  const frameTitle =
    view.selected === 'terminal'
      ? t('settings.terminalTitle')
      : view.selected === 'shortcuts'
        ? t('settings.shortcutsTitle')
        : view.selected === 'sync'
          ? t('settings.syncTitle')
          : view.selected === 'legal'
            ? t('legal.title')
            : view.selected === 'password'
              ? t('settings.passwordTitle')
              : t(`section.${view.selected}`);
  const frameDescription =
    view.selected === 'common'
      ? t('settings.generalDescription')
      : view.selected === 'terminal'
        ? t('settings.terminalDescription')
        : view.selected === 'shortcuts'
          ? t('settings.shortcutsDescription')
          : view.selected === 'ai'
            ? t('settings.aiDescription')
            : view.selected === 'legal'
              ? t('legal.description')
              : t('settings.categoryDescription');
  const visible = filterSettingsCategories(query, ({ id }) => t(`section.${id}`))
    .filter(({ id }) => view.available.includes(id))
    .map(({ id }) => id);
  return (
    <>
      {view.tab === 'setting' ? (
        <div className={`${styles.settingsLayout} settings-item-${view.selected}`}>
          <aside
            ref={sidebar}
            className={`${styles.settingsNavigation} settings-category-sidebar`}
            aria-label={t('settings.items')}
            onKeyDown={(event) => {
              if (event.target instanceof HTMLInputElement) return;
              const key = event.key;
              if (key !== 'Home' && key !== 'End' && key !== 'ArrowDown' && key !== 'ArrowUp')
                return;
              const target = moveSettingsCategory(
                visible.map((id) => ({ id })),
                view.selected,
                key,
              );
              if (!target) return;
              event.preventDefault();
              navigation.select(target);
              sidebar.current
                ?.querySelector<HTMLButtonElement>(`[data-settings-category="${target}"]`)
                ?.focus();
            }}
          >
            <label className={styles.settingsSearch}>
              <input
                maxLength={1024}
                aria-label={t('settings.search')}
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
              <Search size={15} aria-hidden="true" />
            </label>
            {visible.map((section) => (
              <button
                type="button"
                key={section}
                data-settings-category={section}
                aria-current={view.selected === section ? 'page' : undefined}
                className={view.selected === section ? styles.active : undefined}
                onClick={() => navigation.select(section)}
              >
                {t(`section.${section}`)}
              </button>
            ))}
            {!visible.length && <p>{t('settings.noMatch')}</p>}
          </aside>
          <div
            className={`${styles.settingsContent} panel-page`}
            data-settings-category-content={view.selected}
          >
            <header
              className={`${styles.panelHeading} panel-heading`}
              data-settings-frame-heading={view.selected}
            >
              <div>
                <small>{t('tab.setting')}</small>
                <h1>{frameTitle}</h1>
                <p>{frameDescription}</p>
              </div>
            </header>
            {loadError}
            {view.selected === 'common' && general}
            {view.selected === 'password' && password}
            {view.selected === 'sync' && sync}
            {view.selected !== 'common' &&
              renderSlot(`settings.${view.selected}`, { section: view.selected })}
          </div>
        </div>
      ) : (
        <div className={`${styles.settingsContent} ${styles.secondaryContent}`}>
          {renderSlot(`settings.${view.tab}`, { section: view.tab })}
        </div>
      )}
    </>
  );
}
