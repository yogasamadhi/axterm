import syncPresentationDictionaries from './sync-presentation-locales.json' with { type: 'json' };
import { cssText as syncCss } from './sync-presentation.module.css';
import { installLegalUi } from './legal-ui.tsx';
import { installBehaviorPreferences } from './behavior-ui.tsx';
import { SettingsNavigation, settingsSections } from './settings-navigation.ts';
import { installSettingsWorkspaceTabs } from './settings-workspace-tabs.tsx';
import { SettingsLayout } from './settings-layout.tsx';
import type { SettingsRenderShare } from '@axterm/ui/workspace';
import { SyncPanel } from './sync-ui.tsx';
import type { SyncModel } from './sync.ts';
import { ConfigurationPortablePanel, portablePresentationCss } from './portable-ui.tsx';
import type { ConfigurationPortableModel } from './portable.ts';
import type {} from '@axterm/ui/workspace';
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { Context } from '@deepseek-ai/cordis';
import type { PropsLocale } from '@axterm/ui';
import { BUILT_IN_LOCALES } from '@axterm/ui/presentation';
import {
  Button,
  Label,
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
  Input,
} from '@axterm/ui/controls';
import { SavedCredentialsPanel } from './credential-ui.tsx';
import type { SavedCredentialsModel } from './credentials.ts';
import type { SettingsModel } from './index.ts';
import { dictionaries } from './locales.ts';
import styles, { cssText } from './ui.module.css';
/** Configuration owns commands, presentation adapters and its actual settings surface. */
export function installSettingsUi(
  ctx: Context,
  model: SettingsModel,
  credentials: SavedCredentialsModel,
  portable: ConfigurationPortableModel,
  sync: SyncModel,
): void {
  installBehaviorPreferences(ctx, model);
  installLegalUi(ctx, model);
  ctx.effect(() => ctx.locale.register('configuration', dictionaries));
  ctx.effect(() => ctx.locale.register('syncPresentation', syncPresentationDictionaries));
  const navigation = new SettingsNavigation({
    has: (slot) => ctx.slots.entries(slot).length > 0,
    subscribe: (slot, changed) => ctx.slots.subscribe(slot, changed),
  });
  ctx.effect(() => () => navigation.close());
  ctx.effect(() => {
    const style = document.createElement('style');
    style.dataset.plugin = '@axterm/plugin-configuration';
    style.textContent = cssText + '\n' + syncCss + '\n' + portablePresentationCss;
    document.head.append(style);
    return () => style.remove();
  });
  ctx.effect(() =>
    ctx.workspaceUi.registerNavigation({
      id: 'settings',
      label: {
        en: dictionaries.en.title,
        ja: dictionaries.ja.title,
        'zh-CN': dictionaries['zh-CN'].title,
        'zh-TW': dictionaries['zh-TW'].title,
      },
      icon: '⚙',
      view: 'section',
      chrome: 'settings',
      order: 100,
    }),
  );
  for (const section of settingsSections)
    ctx.effect(() =>
      ctx.workspaceUi.registerAction('settings.open.' + section, () => {
        navigation.select(section);
        ctx.workspaceUi.selectSection('settings');
      }),
    );
  installSettingsWorkspaceTabs(ctx, navigation);
  ctx.slots.inject('workspace.toolbar', function* () {
    yield ctx.slots.register(
      {
        name: 'workspace.toolbar',
        id: 'configuration.settings',
        order: 100,
        locale: 'configuration',
      },
      function SettingsTrigger({ t }: PropsLocale<'configuration'>) {
        return (
          <Button
            variant="ghost"
            size="icon"
            className={styles.trigger}
            data-configuration-settings-trigger=""
            aria-label={t('title')}
            title={t('title')}
            onClick={() =>
              void ctx.workspaceUi.invokeAction('settings.open.common').catch(() => {})
            }
          >
            ⚙
          </Button>
        );
      },
    );
  });
  ctx.slots.inject('workspace.section', function* () {
    yield ctx.slots.register(
      {
        name: 'workspace.section',
        key: 'settings',
        locale: 'configuration',
        children: {
          'settings.common': { kind: 'list', scope: 'root' },
          'settings.terminal': { kind: 'list', scope: 'root' },
          'settings.shortcuts': { kind: 'list', scope: 'root' },
          'settings.sync': { kind: 'list', scope: 'root' },
          'settings.ai': { kind: 'list', scope: 'root' },
          'settings.password': { kind: 'list', scope: 'root' },
          'settings.legal': { kind: 'list', scope: 'root' },
          'settings.profiles': { kind: 'list', scope: 'root' },
          'settings.themes': { kind: 'list', scope: 'root' },
          'settings.widgets': { kind: 'list', scope: 'root' },
        },
      },
      function SettingsEntry({
        t,
        renderSlot,
      }: PropsLocale<'configuration'> & SettingsRenderShare) {
        const settings = useSyncExternalStore(model.subscribe, model.getSnapshot);
        const locale = useSyncExternalStore(ctx.locale.subscribe, ctx.locale.getSnapshot);
        const theme = useSyncExternalStore(ctx.theme.subscribe, ctx.theme.getSnapshot);
        useSyncExternalStore(
          (notify) => ctx.slots.subscribe('settings.common', notify),
          () => ctx.slots.getVersion('settings.common'),
        );
        const knownCommon = new Set([
          'desktop.updater',
          'desktop.preferences',
          'configuration.activityRail',
          'configuration.behavior',
          'workspace.startup',
          'connections.proxy',
          'desktop.diagnostics',
        ]);
        const contribution = (id: string) =>
          renderSlot('settings.common', { section: 'common' }, { only: id });
        const [languageNotice, setLanguageNotice] = useState<'saved' | 'failed'>();
        const [saving, setSaving] = useState(false);
        const [notice, setNotice] = useState<
          | 'saved'
          | 'failed'
          | 'privacyFailed'
          | 'appearanceFailed'
          | 'loadFailed'
          | 'appearanceUpdated'
        >();
        const busy = useRef(false);
        const alive = useRef(true);
        useEffect(() => {
          alive.current = true;
          return () => {
            alive.current = false;
          };
        }, []);
        const ready = settings.status === 'ready';
        async function run(
          operation: () => Promise<void>,
          failure: 'failed' | 'privacyFailed' | 'appearanceFailed' | 'loadFailed' = 'failed',
          success: 'saved' | 'appearanceUpdated' | null = 'saved',
        ) {
          if (busy.current) return;
          busy.current = true;
          setSaving(true);
          setNotice(undefined);
          try {
            await operation();
            if (alive.current) setNotice(success ?? undefined);
            return true;
          } catch {
            if (alive.current) setNotice(failure);
            return false;
          } finally {
            busy.current = false;
            if (alive.current) setSaving(false);
          }
        }
        return (
          <section className={styles.page} data-configuration-settings="" aria-label={t('title')}>
            <SettingsLayout
              loadError={
                !ready && (
                  <div className="settings-load-error" role="alert">
                    <p>{t('loadFailed')}</p>
                    <Button
                      disabled={saving}
                      onClick={() => void run(() => model.retry(), 'loadFailed', null)}
                    >
                      {t('retry')}
                    </Button>
                  </div>
                )
              }
              navigation={navigation}
              t={t}
              renderSlot={renderSlot}
              general={
                <>
                  <section
                    className={`${styles.presentationSurface} surface language-settings-panel`}
                    aria-labelledby="language-settings-title"
                  >
                    <header>
                      <div>
                        <small>{t('settingsEyebrow')}</small>
                        <h2 id="language-settings-title">{t('language.title')}</h2>
                      </div>
                    </header>
                    <p className={styles.hint}>{t('language.description')}</p>
                    <Label htmlFor="application-language">{t('language.title')}</Label>
                    <Select
                      value={locale.active}
                      disabled={!ready || saving}
                      onValueChange={(value) => {
                        setLanguageNotice(undefined);
                        void run(() => ctx.locale.setLocale(value), 'failed', null).then(
                          (saved) => {
                            if (alive.current && saved !== undefined)
                              setLanguageNotice(saved ? 'saved' : 'failed');
                          },
                        );
                      }}
                    >
                      <SelectTrigger
                        id="application-language"
                        data-testid="application-language"
                        data-language-id={locale.active}
                        aria-label={t('language.title')}
                      >
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {locale.locales
                          .filter((item) => BUILT_IN_LOCALES.some((id) => id === item.id))
                          .map((item) => (
                            <SelectItem key={item.id} value={item.id}>
                              <span aria-hidden="true">
                                {
                                  { en: '🇺🇸', ja: '🇯🇵', 'zh-CN': '🇨🇳', 'zh-TW': '🇹🇼' }[
                                    item.id as 'en' | 'ja' | 'zh-CN' | 'zh-TW'
                                  ]
                                }
                              </span>{' '}
                              {item.label}
                            </SelectItem>
                          ))}
                      </SelectContent>
                    </Select>
                    <p className={styles.hint}>
                      {saving ? t('language.saving') : t('language.fallback')}
                    </p>
                    {languageNotice && (
                      <p className={styles.hint} role="status">
                        {t(languageNotice === 'saved' ? 'language.saved' : 'language.saveFailed')}
                      </p>
                    )}
                  </section>
                  {contribution('desktop.updater')}
                  <section
                    className={`${styles.presentationSurface} surface settings-privacy-panel`}
                    aria-label={t('settings.privacy')}
                  >
                    <header>
                      <div>
                        <small>{t('settings.privacy')}</small>
                        <h3>{t('settings.addressDisplay')}</h3>
                      </div>
                      <Label className={styles.checkLabel}>
                        <Input
                          className={styles.check}
                          type="checkbox"
                          checked={ready ? settings.baseline.settings.privacy.hideAddresses : false}
                          disabled={!ready || saving}
                          onChange={(event) => {
                            const hideAddresses = event.currentTarget.checked;
                            void run(
                              () => model.writeObservedSettings({ privacy: { hideAddresses } }),
                              'privacyFailed',
                            );
                          }}
                        />
                        {t('settings.hideAddresses')}
                      </Label>
                    </header>
                    <p className={styles.hint}>{t('settings.hideAddressesHint')}</p>
                    {(notice === 'privacyFailed' || notice === 'saved') && (
                      <p
                        className={styles.hint}
                        role={notice === 'privacyFailed' ? 'alert' : 'status'}
                      >
                        {notice === 'privacyFailed'
                          ? t('privacyFailed')
                          : t(
                              ready && settings.baseline.settings.privacy.hideAddresses
                                ? 'settings.addressesHidden'
                                : 'settings.addressesVisible',
                            )}
                      </p>
                    )}
                  </section>
                  <section
                    className={`${styles.preferenceGroup} settings-preference-group`}
                    aria-labelledby="settings-appearance-group"
                  >
                    <h2 id="settings-appearance-group">{t('settings.appearanceGroup')}</h2>
                    <Label htmlFor="application-appearance">{t('appearance')}</Label>
                    <Select
                      value={theme.preference}
                      disabled={!ready || saving}
                      onValueChange={(value) => {
                        void run(
                          () => ctx.theme.setTheme(value),
                          'appearanceFailed',
                          'appearanceUpdated',
                        );
                      }}
                    >
                      <SelectTrigger
                        id="application-appearance"
                        data-testid="application-appearance"
                        aria-label={t('appearance')}
                      >
                        <SelectValue placeholder={t('appearance')} />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="dark">{t('dark')}</SelectItem>
                        <SelectItem value="light">{t('light')}</SelectItem>
                        <SelectItem value="system">{t('system')}</SelectItem>
                      </SelectContent>
                    </Select>

                    {contribution('desktop.preferences')}
                    {contribution('workspace.startup')}
                    {contribution('configuration.activityRail')}
                    {contribution('configuration.behavior')}
                  </section>
                  <section
                    className={`${styles.preferenceGroup} settings-preference-group`}
                    aria-labelledby="settings-connection-group"
                  >
                    <h2 id="settings-connection-group">{t('settings.connectionGroup')}</h2>
                    {contribution('connections.proxy')}
                  </section>
                  <ConfigurationPortablePanel ctx={ctx} model={portable} t={t} />
                  {contribution('desktop.diagnostics')}
                  {ctx.slots
                    .entries('settings.common')
                    .map((entry) => entry.options.id)
                    .filter((id): id is string => !!id && !knownCommon.has(id))
                    .map((id) => (
                      <div key={id}>{contribution(id)}</div>
                    ))}
                </>
              }
              password={<SavedCredentialsPanel model={credentials} t={t} />}
              sync={<SyncPanel ctx={ctx} model={sync} credentials={credentials} t={t} />}
            />
            <p
              className={styles.notice}
              role={
                notice === 'failed' ||
                notice === 'privacyFailed' ||
                notice === 'appearanceFailed' ||
                notice === 'loadFailed'
                  ? 'alert'
                  : 'status'
              }
              aria-live="polite"
            >
              {notice && notice !== 'failed' && notice !== 'saved' ? t(notice) : ''}
            </p>
          </section>
        );
      },
    );
  });
}
