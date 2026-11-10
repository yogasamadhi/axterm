import type {} from './locales.ts';
import { useSyncExternalStore } from 'react';
import type { Context } from '@deepseek-ai/cordis';
import type { PropsLocale } from '@axterm/ui';
import type { SettingsNavigation } from './settings-navigation.ts';
/** Each button selects UI owned here; other domains contribute their own entries. */
export function installSettingsWorkspaceTabs(ctx: Context, navigation: SettingsNavigation): void {
  for (const [tab, order] of [
    ['setting', 10],
    ['themes', 20],
    ['profiles', 50],
    ['widgets', 60],
  ] as const)
    ctx.slots.inject('workspace.section-toolbar', function* () {
      yield ctx.slots.register(
        {
          name: 'workspace.section-toolbar',
          id: 'configuration.' + tab,
          order,
          locale: 'configuration',
        },
        function Tab({ t }: PropsLocale<'configuration'>) {
          const view = useSyncExternalStore(navigation.subscribe, navigation.getSnapshot),
            workspace = useSyncExternalStore(
              ctx.workspaceUi.subscribe,
              ctx.workspaceUi.getSnapshot,
            );
          if (!view.tabs.includes(tab)) return null;
          return (
            <button
              type="button"
              data-settings-tab={tab}
              aria-current={
                workspace.section === 'settings' && view.tab === tab ? 'page' : undefined
              }
              onClick={() => {
                if (tab === 'setting') navigation.selectSettings();
                else navigation.select(tab);
                ctx.workspaceUi.selectSection('settings');
              }}
            >
              {t(`tab.${tab}`)}
              {tab === 'widgets' && (
                <>
                  {' '}
                  <sup>
                    {ctx.locale.resolveText({
                      en: 'Beta',
                      ja: 'ベータ',
                      'zh-CN': '测试版',
                      'zh-TW': '測試版',
                    })}
                  </sup>
                </>
              )}
            </button>
          );
        },
      );
    });
  ctx.slots.inject('workspace.section-toolbar', function* () {
    yield ctx.slots.register(
      { name: 'workspace.section-toolbar', id: 'configuration.bookmarks', order: 0 },
      function Bookmarks() {
        const workspace = useSyncExternalStore(
          ctx.workspaceUi.subscribe,
          ctx.workspaceUi.getSnapshot,
        );
        const hosts = workspace.navigation.find((item) => item.id === 'hosts');
        return hosts ? (
          <button type="button" onClick={() => ctx.workspaceUi.selectSection('hosts')}>
            {ctx.locale.resolveText({
              en: 'Saved connections',
              ja: '保存済みの接続',
              'zh-CN': '已保存的连接',
              'zh-TW': '已儲存的連線',
            })}
          </button>
        ) : null;
      },
    );
  });
}
