import { useState, useSyncExternalStore } from 'react';
import type { Context } from '@deepseek-ai/cordis';
import type { PropsLocale } from '@axterm/ui';
import type { NamedWorkspaces } from './named-workspaces.ts';
import dictionaries from './startup-locales.json' with { type: 'json' };
import styles from './startup.module.css';
export { dictionaries as startupDictionaries };
declare module '@axterm/ui' {
  interface LocaleNamespaceMap {
    startupSettings: keyof typeof dictionaries.en;
  }
}
const cls = (...names: string[]) =>
  names.map((name) => name + ' ' + (styles[name] ?? '')).join(' ');
export function installStartupSettings(ctx: Context, commands: NamedWorkspaces) {
  ctx.inject(['catalogActions'], (owner) =>
    owner.slots.inject('settings.common', function* () {
      yield owner.slots.register(
        { name: 'settings.common', id: 'workspace.startup', locale: 'startupSettings' },
        function StartupSettings({ t }: PropsLocale<'startupSettings'>) {
          const state = useSyncExternalStore(
              owner.configurationActions.subscribe,
              owner.configurationActions.getSnapshot,
            ),
            catalog = useSyncExternalStore(
              owner.catalogActions.subscribe,
              owner.catalogActions.getSnapshot,
            ),
            command = useSyncExternalStore(commands.subscribe, commands.getSnapshot),
            [override, setOverride] = useState<'bookmarks' | 'workspace'>(),
            [saved, setSaved] = useState(false);
          const settings = state.status === 'ready' ? state.baseline.settings : undefined,
            startup = settings?.workspace.startupSessions ?? [],
            mode = override ?? (typeof startup === 'string' ? 'workspace' : 'bookmarks'),
            busy = command.busy || command.uncertain;
          const save = (value: typeof startup) => {
            setSaved(false);
            void commands.setStartupSessions(value).then(
              () => setSaved(true),
              () => undefined,
            );
          };
          return (
            <section
              className={cls('surface', 'stack', 'behavior-settings')}
              aria-labelledby="behavior-settings-title"
              data-startup-settings=""
            >
              <h3 id="behavior-settings-title">{t('behaviorSettings.title')}</h3>
              <p className={cls('hint')}>{t('behaviorSettings.description')}</p>
              <fieldset className={cls('monitor-settings-group')}>
                <legend>{t('behaviorSettings.startup')}</legend>
                <div className={cls('segmented', 'compact-segmented')} role="tablist">
                  <button
                    type="button"
                    role="tab"
                    aria-selected={mode === 'bookmarks'}
                    className={mode === 'bookmarks' ? cls('active') : ''}
                    onClick={() => {
                      setOverride('bookmarks');
                      if (!Array.isArray(startup)) save([]);
                    }}
                  >
                    {t('behaviorSettings.startupBookmarks')}
                  </button>
                  <button
                    type="button"
                    role="tab"
                    aria-selected={mode === 'workspace'}
                    className={mode === 'workspace' ? cls('active') : ''}
                    onClick={() => setOverride('workspace')}
                  >
                    {t('behaviorSettings.startupWorkspace')}
                  </button>
                </div>
                {mode === 'bookmarks' ? (
                  <label className={cls('field', 'compact-field')}>
                    <span>{t('behaviorSettings.startupBookmarks')}</span>
                    <select
                      aria-label={t('behaviorSettings.startupBookmarks')}
                      multiple
                      size={Math.min(
                        7,
                        Math.max(
                          3,
                          catalog.status === 'ready'
                            ? catalog.baseline.bookmarks.bookmarks.length
                            : 3,
                        ),
                      )}
                      disabled={!settings || catalog.status !== 'ready' || busy}
                      value={Array.isArray(startup) ? startup : []}
                      onChange={(event) =>
                        save(
                          [...event.currentTarget.selectedOptions]
                            .map((option) => option.value)
                            .slice(0, 20),
                        )
                      }
                    >
                      {catalog.status === 'ready' && catalog.baseline.bookmarks.bookmarks.length ? (
                        catalog.baseline.bookmarks.bookmarks.map((bookmark) => (
                          <option key={bookmark.id} value={bookmark.id}>
                            {bookmark.title} · {bookmark.protocol.toUpperCase()}
                          </option>
                        ))
                      ) : (
                        <option disabled value="">
                          {t('behaviorSettings.noStartupBookmarks')}
                        </option>
                      )}
                    </select>
                    <small className={cls('hint')}>
                      {t('behaviorSettings.startupBookmarksHint')}
                    </small>
                  </label>
                ) : (
                  <label className={cls('field', 'compact-field')}>
                    <span>{t('behaviorSettings.startupWorkspace')}</span>
                    <select
                      aria-label={t('behaviorSettings.startupWorkspace')}
                      value={typeof startup === 'string' ? startup : ''}
                      disabled={!settings || busy}
                      onChange={(event) => save(event.currentTarget.value || [])}
                    >
                      <option value="">{t('behaviorSettings.noStartupWorkspace')}</option>
                      {settings?.workspace.namedWorkspaces.map((workspace) => (
                        <option key={workspace.id} value={workspace.id}>
                          {workspace.name}
                        </option>
                      ))}
                    </select>
                    <small className={cls('hint')}>
                      {t('behaviorSettings.startupWorkspaceHint')}
                    </small>
                  </label>
                )}
              </fieldset>
              {saved && <p role="status">{t('behaviorSettings.saved')}</p>}
              {command.failed && commands.isStartupChange && (
                <p role="alert">
                  {t('behaviorSettings.saveFailed')}
                  {command.uncertain && (
                    <button
                      type="button"
                      disabled={command.busy}
                      onClick={() => {
                        void commands.retry().then(
                          () => setSaved(true),
                          () => undefined,
                        );
                      }}
                    >
                      {t('common.retry')}
                    </button>
                  )}
                </p>
              )}
            </section>
          );
        },
      );
    }),
  );
}
