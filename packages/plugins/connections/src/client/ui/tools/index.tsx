import '@axterm/ui/workspace';
import { useSyncExternalStore } from 'react';
import { Network } from 'lucide-react';
import type { Context } from '@deepseek-ai/cordis';
import type { PropsLocale } from '@axterm/ui';
import type { CatalogClientActions } from '@axterm/plugin-api/catalog';
import type { ConnectionsModel } from '../../index.ts';
import { TunnelOperations } from './operations.ts';
import { ProxySave } from './proxy-save.ts';
import { ToolsI18n } from './i18n.tsx';
import { TunnelsPanel } from './tunnels.tsx';
import { ProxySettingsPanel } from './proxy.tsx';
import { KnownHostKeysPanel } from './known-hosts.tsx';
import { dictionaries } from './locales.ts';
import { cx, cssText } from './styles.ts';
export function installConnectionTools(ctx: Context, model: ConnectionsModel): void {
  const operations = new TunnelOperations(model);
  ctx.provide('tunnelWorkspaceUi', { start: (input, signal) => operations.start(input, signal) });
  ctx.effect(() => () => operations.close());
  ctx.effect(() => ctx.locale.register('connection-tools', dictionaries));
  ctx.effect(() => {
    const style = document.createElement('style');
    style.dataset.axtermOwner = '@axterm/plugin-connections';
    style.dataset.plugin = '@axterm/plugin-connections';
    style.textContent = cssText;
    document.head.append(style);
    return () => style.remove();
  });
  ctx.inject(['catalogActions'], (owner) => {
    owner.effect(() =>
      owner.workspaceUi.registerNavigation({
        id: 'tunnels',
        label: {
          en: dictionaries.en['tunnels.title'],
          ja: dictionaries.ja['tunnels.title'],
          'zh-CN': dictionaries['zh-CN']['tunnels.title'],
          'zh-TW': dictionaries['zh-TW']['tunnels.title'],
        },
        icon: <Network size={18} />,
        view: 'section',
        chrome: 'settings',
        order: 30,
      }),
    );
    owner.slots.inject('workspace.section-toolbar', function* () {
      yield owner.slots.register(
        {
          name: 'workspace.section-toolbar',
          id: 'connections.tunnels',
          order: 70,
          locale: 'connection-tools',
        },
        function Tab({ t }: PropsLocale<'connection-tools'>) {
          const state = useSyncExternalStore(
            owner.workspaceUi.subscribe,
            owner.workspaceUi.getSnapshot,
          );
          return (
            <button
              type="button"
              data-settings-destination="tunnels"
              aria-current={state.section === 'tunnels' ? 'page' : undefined}
              onClick={() => owner.workspaceUi.selectSection('tunnels')}
            >
              {t('tunnels.title')}
            </button>
          );
        },
      );
    });
    owner.slots.inject('workspace.section', function* () {
      yield owner.slots.register(
        { name: 'workspace.section', key: 'tunnels', locale: 'connection-tools' },
        function Tunnels(props: PropsLocale<'connection-tools'>) {
          const language = useSyncExternalStore(
            owner.locale.subscribe,
            owner.locale.getSnapshot,
          ).active;
          return (
            <ToolsI18n value={{ x: props.t, language }}>
              <TunnelWorkspace
                model={model}
                operations={operations}
                catalog={owner.catalogActions}
              />
            </ToolsI18n>
          );
        },
      );
    });
    owner.slots.inject('workspace.sidebar', function* () {
      yield owner.slots.register(
        { name: 'workspace.sidebar', key: 'tunnels', locale: 'connection-tools' },
        function Sidebar(props: PropsLocale<'connection-tools'>) {
          return <p className={cx('hint tools-sidebar')}>{props.t('tunnels.description')}</p>;
        },
      );
    });
  });
  ctx.inject(['configurationActions', 'savedCredentialActions'], (owner) => {
    const save = new ProxySave(owner.configurationActions, owner.savedCredentialActions);
    owner.effect(() => () => save.close());
    owner.slots.inject('settings.common', function* () {
      yield owner.slots.register(
        { name: 'settings.common', id: 'connections.proxy', order: 40, locale: 'connection-tools' },
        function ConnectionSettings(props: PropsLocale<'connection-tools'>) {
          const language = useSyncExternalStore(
            owner.locale.subscribe,
            owner.locale.getSnapshot,
          ).active;
          return (
            <ToolsI18n value={{ x: props.t, language }}>
              <div className={cx('tools-root')}>
                <ProxySettingsPanel
                  model={model}
                  settings={owner.configurationActions}
                  workflow={save}
                />
                <KnownHostKeysPanel model={model} operations={operations} />
              </div>
            </ToolsI18n>
          );
        },
      );
    });
  });
  ctx.slots.inject('workspace.overlay', function* () {
    yield ctx.slots.register(
      {
        name: 'workspace.overlay',
        id: 'connections.tools-outcome',
        order: 15,
        locale: 'connection-tools',
      },
      function ToolsOutcome(props: PropsLocale<'connection-tools'>) {
        const state = useSyncExternalStore(operations.subscribe, operations.getSnapshot);
        return state.uncertain && !state.busy ? (
          <div role="alert" className={cx('tools-outcome')}>
            {props.t('tools.uncertain')}{' '}
            <button onClick={() => void operations.retry().catch(() => {})}>
              {props.t('tools.checkAgain')}
            </button>
          </div>
        ) : null;
      },
    );
  });
}
function TunnelWorkspace({
  model,
  operations,
  catalog,
}: {
  model: ConnectionsModel;
  operations: TunnelOperations;
  catalog: CatalogClientActions;
}) {
  const facts = useSyncExternalStore(model.subscribe, model.getSnapshot),
    hosts = useSyncExternalStore(catalog.subscribe, catalog.getSnapshot);
  return (
    <div className={cx('tools-root tools-workspace')}>
      <TunnelsPanel
        model={model}
        operations={operations}
        hosts={hosts.status === 'ready' ? hosts.baseline.hosts : []}
        connections={facts.status === 'ready' ? facts.baseline.connections : []}
      />
    </div>
  );
}
