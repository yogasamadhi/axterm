import { useNativeControls } from './native-controls.ts';
import { MoreActions } from './more-actions.tsx';
import { Bot, PanelRightClose } from 'lucide-react';
import { WorkspaceTabActions } from './tab-actions.ts';
import { ActivityRail } from './activity-rail.tsx';
import type { ConfigurationClientActions } from '@axterm/plugin-api/configuration';
import { installStartupSettings, startupDictionaries } from './startup-settings.tsx';
import { WorkspaceStartup } from './startup.ts';
import { namedDictionaries } from './named-menu.tsx';
import { SessionDescriptions } from './session-descriptions.ts';
import { NamedWorkspaces } from './named-workspaces.ts';
import { installWorkspaceShortcuts } from './shortcuts.ts';
import { installPalette } from './palette.tsx';
import {
  LayoutControl,
  WorkspaceTabs,
  WorkspaceSessions,
  TabToolbar,
  AllTabsControl,
} from './arrangement.tsx';
import { WorkspacePresentationOwner, PresentationStatusStore } from './presentation.ts';
import { dictionaries } from './locales.ts';
import type { PropsLocale } from '@axterm/ui';
import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { Context } from '@deepseek-ai/cordis';
import type { WorkspaceRootShare, DesktopStartupUi } from '@axterm/ui/workspace';
import type {} from '@axterm/ui';
import { WorkspaceStore } from './store.ts';
import styles, { cssText } from './workspace.module.css';
import { cssText as startupCssText } from './startup.module.css';
const classes = (...values: string[]) =>
  values.map((value) => `${value} ${styles[value] ?? ''}`).join(' ');
export const inject = ['slots', 'locale', 'shortcuts'];
/** Product chrome owns only composition and UI arrangement. Domain panels own their actions. */
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.locale.register('workspace', dictionaries));
  ctx.effect(() => ctx.locale.register('namedWorkspaces', namedDictionaries));
  ctx.effect(() => ctx.locale.register('startupSettings', startupDictionaries));
  const workspace = new WorkspaceStore();
  const descriptions = new SessionDescriptions();
  ctx.provide('workspaceSessionDescriptions', descriptions);
  ctx.effect(() => () => descriptions.close());
  let named: NamedWorkspaces | undefined;
  let tabActions: WorkspaceTabActions | undefined;
  let preferences: ConfigurationClientActions | undefined;
  const preferenceListeners = new Set<() => void>();
  const notifyPreferences = () => {
    for (const listener of [...preferenceListeners]) listener();
  };
  const getPreferences = () => preferences?.getSnapshot();
  const subscribePreferences = (listener: () => void) => {
    preferenceListeners.add(listener);
    return () => {
      preferenceListeners.delete(listener);
    };
  };

  const presentationStatus = new PresentationStatusStore();
  let presentation: WorkspacePresentationOwner | undefined;
  ctx.provide('workspaceAutosaveUi', {
    pause: () => {
      if (!presentation) return Promise.reject(Error('WORKSPACE_AUTOSAVE_UNAVAILABLE'));
      return presentation.pause();
    },
  });
  ctx.effect(() => () => presentationStatus.close());
  ctx.inject(['configurationActions'], (owner) => {
    preferences = owner.configurationActions;
    notifyPreferences();
    owner.effect(() => owner.configurationActions.subscribe(notifyPreferences));
    owner.effect(() => () => {
      if (preferences === owner.configurationActions) preferences = undefined;
      notifyPreferences();
    });
    if (
      !owner.configurationActions.bindWorkspacePresentation ||
      !owner.configurationActions.saveWorkspacePresentation
    )
      return;
    const actions = new WorkspaceTabActions(
      workspace,
      owner.configurationActions,
      descriptions,
      () => owner.get('terminalSessionUi'),
    );
    tabActions = actions;
    owner.effect(() => async () => {
      if (tabActions === actions) tabActions = undefined;
      await actions.close();
    });
    presentationStatus.set('connecting');
    const owned = new WorkspacePresentationOwner(
      workspace,
      owner.configurationActions,
      ctx.get('desktopWindow')?.presentationSlot ?? 'web',
      presentationStatus,
    );
    presentation = owned;
    const namedOwner = new NamedWorkspaces(
      workspace,
      owner.configurationActions,
      descriptions,
      () => owned.pause(),
    );
    named = namedOwner;
    installStartupSettings(owner, namedOwner);
    const installStartup = (scope: Context, native: DesktopStartupUi | undefined) => {
      const startup = new WorkspaceStartup(
        workspace,
        owner.configurationActions,
        descriptions,
        namedOwner,
        presentationStatus,
        () => scope.get('catalogActions'),
        () => scope.get('catalogStartupUi'),
        native,
        undefined,
        (number) =>
          scope.locale.resolveText({
            en: `Local ${number}`,
            ja: `ローカル ${number}`,
            'zh-CN': `本地 ${number}`,
            'zh-TW': `本機 ${number}`,
          }),
      );
      scope.effect(() => () => startup.close());
      scope.slots.inject('workspace.overlay', function* () {
        yield scope.slots.register(
          { name: 'workspace.overlay', id: 'workspace.startup' },
          function StartupStatus() {
            const state = useSyncExternalStore(startup.subscribe, startup.getSnapshot);
            return state.failed ? (
              <div role="alert">
                {scope.locale.resolveText({
                  en: 'Unable to open the configured startup sessions. Open a session or workspace to continue.',
                  ja: '起動セッションを開けませんでした。セッションまたはワークスペースを開いて続行してください。',
                  'zh-CN': '无法打开配置的启动会话。请打开会话或工作区以继续。',
                  'zh-TW': '無法開啟設定的啟動工作階段。請開啟工作階段或工作區以繼續。',
                })}
              </div>
            ) : null;
          },
        );
      });
    };
    const desktopWindow = owner.get('desktopWindow');
    if (!desktopWindow) installStartup(owner, undefined);
    else if (desktopWindow.presentationSlot === 'desktop_0')
      owner.inject(['desktopStartupUi'], (scope) => installStartup(scope, scope.desktopStartupUi));

    owner.inject(['workspacePaletteUi'], (scope) =>
      scope.effect(() =>
        scope.workspacePaletteUi.registerSource('workspaces', () => {
          let selected;
          try {
            selected = namedOwner.list();
          } catch {
            return [];
          }
          return selected.map((item) => ({
            id: item.id,
            label: item.name,
            aliases: [item.name],
            group: 'workspaces' as const,
            shortcuts: [],
            execute: () => namedOwner.load(item.id),
          }));
        }),
      ),
    );
    owner.effect(() => async () => {
      if (presentation === owned) presentation = undefined;
      if (named === namedOwner) named = undefined;
      presentationStatus.set('connecting');
      await namedOwner.close();
      await owned.close();
    });
  });
  ctx.provide('workspaceUi', workspace);
  installWorkspaceShortcuts(ctx, workspace);
  installPalette(ctx, workspace);
  ctx.effect(() => () => workspace.dispose());
  ctx.effect(() => {
    const style = document.createElement('style');
    style.dataset.axtermOwner = '@axterm/plugin-workspace';
    style.dataset.plugin = '@axterm/plugin-workspace';
    style.textContent = cssText + '\n' + startupCssText;
    document.head.append(style);
    return () => style.remove();
  });
  const subscribeToolbar = (notify: () => void) => ctx.slots.subscribe('workspace.toolbar', notify);
  const toolbarVersion = () => ctx.slots.getVersion('workspace.toolbar');
  const contextualToolbar = new Set([
    'terminals.refresh',
    'catalog.new',
    'catalog.import',
    'ai.bookmark',
    'configuration.settings',
    'plugins.manager',
    'market.browser',
    'desktop.recovery',
  ]);
  ctx.slots.register(
    {
      name: 'root',
      locale: 'workspace',
      children: {
        'workspace.toolbar': { kind: 'list', scope: 'root' },
        'workspace.sidebar': { kind: 'keyed', scope: 'root' },
        'workspace.section': { kind: 'keyed', scope: 'root' },
        'workspace.section-toolbar': { kind: 'list', scope: 'root' },
        'workspace.session': { kind: 'keyed', scope: 'root' },
        'workspace.empty': { kind: 'single', scope: 'root' },
        'workspace.status': { kind: 'list', scope: 'root' },
        'workspace.overlay': { kind: 'list', scope: 'root' },
        'workspace.monitor': { kind: 'list', scope: 'root' },
        'workspace.auxiliary': { kind: 'list', scope: 'root' },
        'workspace.tab-menu': { kind: 'list', scope: 'root' },
      },
    },
    function ProductWorkspace(props: WorkspaceRootShare & PropsLocale<'workspace'>) {
      const root = useRef<HTMLDivElement>(null);
      useNativeControls(root);
      const state = useSyncExternalStore(workspace.subscribe, workspace.getSnapshot);
      useSyncExternalStore(subscribeToolbar, toolbarVersion);
      const toolbarIds = ctx.slots
        .entries('workspace.toolbar')
        .map((entry) => entry.options.id)
        .filter((id): id is string => typeof id === 'string');
      const preferenceFacts = useSyncExternalStore(subscribePreferences, getPreferences);
      const tabPreferences =
        preferenceFacts?.status === 'ready'
          ? preferenceFacts.baseline.settings.workspace
          : undefined;
      const preferenceStatus = useSyncExternalStore(
        presentationStatus.subscribe,
        presentationStatus.getSnapshot,
      );
      const [error, setError] = useState(false);
      const owner = { section: state.section, activeTabId: state.activeTabId };
      const sectionView =
        state.navigation.find((item) => item.id === state.section)?.view === 'section';
      const settingsChrome =
        state.navigation.find((item) => item.id === state.section)?.chrome === 'settings';
      const heading = useRef<HTMLHeadingElement>(null);
      useLayoutEffect(() => {
        if (settingsChrome) heading.current?.focus();
      }, [settingsChrome]);
      const closeSection = () => workspace.closeSection();
      useEffect(() => {
        const document = root.current?.ownerDocument;
        if (!settingsChrome || !document) return;
        const escape = (event: KeyboardEvent) => {
          if (
            root.current?.isConnected &&
            (event.target === document.body || event.target === document.documentElement) &&
            event.key === 'Escape' &&
            !event.defaultPrevented &&
            !event.isComposing &&
            !document.querySelector('[role=dialog][data-state=open]')
          ) {
            event.preventDefault();
            workspace.closeSection();
            document.querySelector<HTMLButtonElement>('[data-activity-item=setting]')?.focus();
          }
        };
        document.addEventListener('keydown', escape);
        return () => document.removeEventListener('keydown', escape);
      }, [settingsChrome]);

      const sidebarSection = state.sidebarSection ?? state.section;
      const sidebarVisible = state.sidebarOpen && (!sectionView || !!state.sidebarSection);
      const sidebarLabel = state.navigation.find((item) => item.id === sidebarSection)?.label;
      const sidebarTitleText =
        sidebarLabel === undefined ? props.t('connections') : ctx.locale.resolveText(sidebarLabel);
      const title = state.navigation.find((item) => item.id === state.section)?.label;
      const titleText =
        title === undefined ? props.t('connections') : ctx.locale.resolveText(title);
      return (
        <div
          ref={root}
          className={classes(
            'app-shell',
            'section-' + state.section,
            ...(!state.sidebarOpen ? ['sidebar-collapsed'] : []),
            sectionView ? 'surface-section' : 'surface-terminal',
          )}
          data-workspace-presentation={preferenceStatus}
          data-axterm-product-workspace=""
          data-sidebar={sidebarVisible ? 'open' : 'closed'}
          data-section-chrome={settingsChrome ? 'settings' : undefined}
          onKeyDown={(event) => {
            if (
              settingsChrome &&
              event.key === 'Escape' &&
              !event.defaultPrevented &&
              !event.nativeEvent.isComposing &&
              !document.querySelector('[role=dialog][data-state=open]')
            ) {
              event.preventDefault();
              closeSection();
              document.querySelector<HTMLButtonElement>('[data-activity-item=setting]')?.focus();
            }
          }}
        >
          {!settingsChrome && <div className={classes('workspace-left-rail')} aria-hidden="true" />}
          <aside
            className={classes('app-sidebar', 'activity-bar')}
            aria-label={props.t('primaryFeatures')}
          >
            <div className={classes('activity-brand')} />
            <nav aria-label={props.t('primaryFeatures')}>
              <ActivityRail
                ctx={ctx}
                workspace={workspace}
                state={state}
                preferences={tabPreferences}
                onError={() => setError(true)}
                leading={props.renderSlot('workspace.toolbar', owner, { only: 'ai.open' })}
              />
            </nav>
          </aside>
          <aside
            className={classes(
              'workspace-sidebar',
              'section-' + sidebarSection,
              ...(sidebarSection === 'ai' && sidebarVisible ? ['ai-inspector'] : []),
            )}
            hidden={!sidebarVisible}
            aria-label={sidebarTitleText}
          >
            <header
              role="presentation"
              hidden={!sidebarVisible}
              className={classes('explorer-header')}
            >
              {sidebarSection === 'ai' ? (
                <span>
                  <Bot size={14} />
                  {sidebarTitleText}
                </span>
              ) : (
                <strong>
                  {sidebarSection === 'hosts' || sidebarSection === 'history'
                    ? props.t('hosts')
                    : titleText}
                </strong>
              )}
              <button
                aria-label={
                  sidebarSection === 'ai'
                    ? props.t('closeTab', { title: sidebarTitleText })
                    : props.t('collapseSidebar')
                }
                onClick={() => workspace.toggleSidebar()}
              >
                <PanelRightClose size={14} />
              </button>
            </header>

            {(sidebarSection === 'hosts' || sidebarSection === 'history') && (
              <nav className={classes('sidebar-tabs')} aria-label={props.t('hosts')}>
                <button
                  aria-pressed={sidebarSection === 'hosts'}
                  onClick={() => workspace.selectSection('hosts')}
                >
                  {props.t('bookmarks')}
                </button>
                <button
                  aria-pressed={sidebarSection === 'history'}
                  onClick={() => workspace.selectSection('history')}
                >
                  {props.t('history')}
                </button>
              </nav>
            )}
            {props.renderSlot(
              'workspace.sidebar',
              { ...owner, section: sidebarSection },
              { entryKey: sidebarSection },
            )}
          </aside>
          <header
            className={classes('tabbar')}
            data-has-tabs={state.tabs.length > 0 ? 'true' : 'false'}
            data-platform={document.documentElement.dataset.platform ?? 'web'}
          >
            <WorkspaceTabs
              onDuplicate={(id) =>
                Promise.resolve().then(() => {
                  if (!tabActions) throw Error('TAB_OWNER_UNAVAILABLE');
                  return tabActions.duplicate(id);
                })
              }
              tabPreferences={tabPreferences}
              workspace={workspace}
              state={state}
              t={props.t}
              renderSlot={props.renderSlot}
              onError={() => setError(true)}
            />
            <div className={classes('workspace-primary-actions')}>
              {['terminals.new', 'catalog.new-session'].map((id) => (
                <span key={id}>{props.renderSlot('workspace.toolbar', owner, { only: id })}</span>
              ))}
            </div>
            <div className={classes('workspace-toolbar')}>
              <AllTabsControl
                workspace={workspace}
                state={state}
                t={props.t}
                onError={() => setError(true)}
              />
              <LayoutControl
                workspace={workspace}
                named={named}
                x={ctx.locale.bind('namedWorkspaces')}
                state={state}
                t={props.t}
                onError={() => setError(true)}
              />
              {toolbarIds
                .filter(
                  (id) =>
                    !contextualToolbar.has(id) &&
                    ![
                      'terminals.new',
                      'catalog.pane-new-session',
                      'catalog.new-session',
                      'ai.open',
                      'desktop.window-controls',
                    ].includes(id),
                )
                .map((id) => (
                  <span key={id}>{props.renderSlot('workspace.toolbar', owner, { only: id })}</span>
                ))}
              <TabToolbar
                workspace={workspace}
                state={state}
                t={props.t}
                renderSlot={props.renderSlot}
                onError={() => setError(true)}
              />
              <MoreActions label={props.t('more')}>
                {toolbarIds
                  .filter((id) => contextualToolbar.has(id))
                  .map((id) => (
                    <div key={id}>{props.renderSlot('workspace.toolbar', owner, { only: id })}</div>
                  ))}
                {state.navigation
                  .filter((item) => !['hosts', 'ai', 'settings'].includes(item.id))
                  .map((item) => (
                    <button
                      aria-pressed={state.section === item.id && state.sidebarOpen}
                      data-workspace-section={item.id}
                      key={item.id}
                      onClick={() => {
                        workspace.selectSection(item.id);
                        if (item.action)
                          void workspace.invokeAction(item.action).catch(() => setError(true));
                      }}
                    >
                      {item.icon}
                      {ctx.locale.resolveText(item.label)}
                    </button>
                  ))}
              </MoreActions>
              {props.renderSlot('workspace.toolbar', owner, { only: 'desktop.window-controls' })}
            </div>
          </header>
          <main className={classes('workspace-main')} aria-labelledby="workspace-main-heading">
            <h1
              ref={heading}
              tabIndex={-1}
              id="workspace-main-heading"
              className={classes('sr-only')}
            >
              {sectionView
                ? titleText
                : (state.tabs.find((tab) => tab.id === state.activeTabId)?.title ??
                  props.t('terminalWorkspace'))}
            </h1>
            <WorkspaceSessions
              onDuplicate={(id) =>
                Promise.resolve().then(() => {
                  if (!tabActions) throw Error('TAB_OWNER_UNAVAILABLE');
                  return tabActions.duplicate(id);
                })
              }
              tabPreferences={tabPreferences}
              workspace={workspace}
              state={state}
              t={props.t}
              onError={() => setError(true)}
              renderSlot={props.renderSlot}
              sectionView={!!sectionView}
            />
            {settingsChrome && (
              <div className={classes('section-heading')}>
                <button
                  type="button"
                  data-section-close="left"
                  className={classes('section-close', 'settings-workspace-close', 'left')}
                  aria-label={props.t('closeSettings')}
                  onClick={closeSection}
                >
                  ×
                </button>
                <button
                  type="button"
                  data-section-close="right"
                  className={classes('section-close', 'settings-workspace-close', 'right')}
                  aria-label={props.t('closeToWorkspace')}
                  onClick={closeSection}
                >
                  ×
                </button>
                <nav
                  className={classes('section-tabs', 'settings-workspace-tabs')}
                  aria-label={titleText}
                >
                  {props.renderSlot('workspace.section-toolbar', owner)}
                </nav>
              </div>
            )}
            {sectionView &&
              props.renderSlot('workspace.section', owner, { entryKey: state.section })}
            {preferenceStatus === 'restart-required' && (
              <div role="status" data-workspace-import-restart="">
                {ctx.locale.resolveText({
                  en: 'Configuration imported. Reload this window to apply the workspace layout.',
                  ja: '設定をインポートしました。レイアウトを適用するにはウィンドウを再読み込みしてください。',
                  'zh-CN': '配置已导入。请重新加载此窗口以应用工作区布局。',
                  'zh-TW': '設定已匯入。請重新載入此視窗以套用工作區配置。',
                })}
                <button onClick={() => location.reload()}>
                  {ctx.locale.resolveText({
                    en: 'Reload window',
                    ja: 'ウィンドウを再読み込み',
                    'zh-CN': '重新加载窗口',
                    'zh-TW': '重新載入視窗',
                  })}
                </button>
              </div>
            )}
            {preferenceStatus === 'error' && (
              <div className={classes('toast')} role="alert">
                {props.t('preferencesFailed')}
                <button onClick={() => void presentation?.retry()}>
                  {props.t('retryPreferences')}
                </button>
              </div>
            )}
            {error && (
              <div className={classes('toast')} role="alert">
                {props.t('actionFailed')}
                <button aria-label={props.t('dismissError')} onClick={() => setError(false)}>
                  ×
                </button>
              </div>
            )}
            {props.renderSlot('workspace.monitor', owner)}
          </main>
          {props.renderSlot('workspace.auxiliary', owner)}
          <footer className={classes('app-statusbar')}>
            {props.renderSlot('workspace.status', owner)}
          </footer>
          {props.renderSlot('workspace.overlay', owner)}
        </div>
      );
    },
  );
}
