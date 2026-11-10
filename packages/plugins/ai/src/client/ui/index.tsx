import { TerminalExplanationOwner } from './terminal-explanation-owner.ts';
import type { Context } from '@deepseek-ai/cordis';
import type { PropsLocale } from '@axterm/ui';
import type {
  WorkspaceTabRegistration,
  WorkspaceSessionOwner,
  WorkspacePanelOwner,
} from '@axterm/ui/workspace';
import type { AiModel } from '../index.ts';
import { useSyncExternalStore } from 'react';
import { Bot, WandSparkles } from 'lucide-react';
import { Button, Tooltip, TooltipTrigger, TooltipContent } from '@axterm/ui/controls';
import { AiPanel } from './ai-panel.tsx';
import { AiPanelActions } from './panel-actions.ts';
import { AiI18nProvider } from './i18n.tsx';
import { dictionaries } from './locales.ts';
import { AiBookmarkLauncher } from './bookmark-flow.ts';
import { AiBookmarkDialog } from './bookmark-dialog.tsx';
import styles, { cssText } from './ui.module.css';
/** UI-only contributions. The renderer remains the sole owner of the React root. */
export function installAiUi(ctx: Context, model: AiModel): void {
  ctx.effect(() => ctx.locale.register('ai', dictionaries));
  const workspace = ctx.workspaceUi;
  const actions = new AiPanelActions(
    model,
    ctx.savedCredentialActions,
    ctx.fileGrantActions,
    (id, text, signal) => {
      const terminal = ctx.get('terminalDraftUi');
      if (!terminal) return Promise.reject(new Error('TERMINAL_DRAFT_UNAVAILABLE'));
      return terminal.insertDraft(id, text, signal);
    },
  );
  ctx.effect(() => () => actions.dispose());
  ctx.effect(() => {
    const style = document.createElement('style');
    style.dataset.axtermOwner = '@axterm/plugin-ai';
    style.dataset.plugin = '@axterm/plugin-ai';
    style.textContent = cssText;
    document.head.append(style);
    return () => style.remove();
  });
  ctx.inject(['catalogActions'], (owner) => {
    const launcher = new AiBookmarkLauncher(model, owner.catalogActions);
    owner.effect(() => () => launcher.dispose());
    owner.effect(() => model.subscribe(() => launcher.retireGeneration()));
    owner.effect(() => owner.catalogActions.subscribe(() => launcher.retireGeneration()));
    owner.effect(() =>
      owner.workspaceUi.registerAction('ai-create-bookmark', () => launcher.open()),
    );
    owner.slots.inject('workspace.toolbar', function* () {
      yield owner.slots.register(
        { name: 'workspace.toolbar', id: 'ai.bookmark', locale: 'ai', order: 42 },
        function BookmarkButton({ t, section }: PropsLocale<'ai'> & WorkspacePanelOwner) {
          const state = useSyncExternalStore(launcher.subscribe, launcher.getSnapshot);
          if (section !== 'hosts') return null;
          return (
            <>
              <Button
                data-ai-bookmark-trigger
                disabled={!!state.flow || state.busy}
                onClick={() => launcher.open()}
              >
                <WandSparkles size={14} />
                {t('aiBookmark.title')}
              </Button>
              {state.failed && <span role="alert">{t('common.operationFailed')}</span>}
            </>
          );
        },
      );
    });
    owner.slots.inject('workspace.empty.actions', function* () {
      yield owner.slots.register(
        { name: 'workspace.empty.actions', id: 'ai.empty-bookmark', order: 30, locale: 'ai' },
        function EmptyBookmark({ t, paneIndex }: PropsLocale<'ai'> & WorkspacePanelOwner) {
          const state = useSyncExternalStore(launcher.subscribe, launcher.getSnapshot);
          return (
            <button disabled={!!state.flow || state.busy} onClick={() => launcher.open()}>
              {paneIndex === undefined ? <WandSparkles size={13} /> : <Bot size={14} />}
              {t('empty.aiBookmark')}
            </button>
          );
        },
      );
    });
    owner.slots.inject('workspace.overlay', function* () {
      yield owner.slots.register(
        { name: 'workspace.overlay', id: 'ai.bookmark', locale: 'ai', order: 25 },
        function BookmarkOverlay({ t }: PropsLocale<'ai'>) {
          const state = useSyncExternalStore(launcher.subscribe, launcher.getSnapshot);
          const facts = useSyncExternalStore(
            owner.catalogActions.subscribe,
            owner.catalogActions.getSnapshot,
          );
          const locale = useSyncExternalStore(owner.locale.subscribe, owner.locale.getSnapshot);
          if (!state.flow || facts.status !== 'ready') return null;
          return (
            <AiI18nProvider
              value={{ language: locale.active, x: (key, variables) => t(key, variables) }}
            >
              <AiBookmarkDialog
                flow={state.flow}
                bookmarkTree={facts.baseline.bookmarks}
                defaultGroupId={null}
                onClose={() => {
                  void launcher.close();
                }}
                onSaved={() => launcher.close()}
              />
            </AiI18nProvider>
          );
        },
      );
    });
  });
  let target: string | undefined;
  const rememberTarget = () => {
    const state = workspace.getSnapshot();
    const active = state.tabs.find((tab) => tab.id === state.activeTabId);
    if (active?.kind === 'terminal') target = active.id;
    if (target && !state.tabs.some((tab) => tab.id === target && tab.kind === 'terminal'))
      target = undefined;
  };
  ctx.effect(() => workspace.subscribe(rememberTarget));
  rememberTarget();
  let tab: WorkspaceTabRegistration | undefined;
  const open = () => {
    rememberTarget();
    tab ??= workspace.registerTab(
      { id: 'axterm.ai', kind: 'ai', title: ctx.locale.resolveText(label) },
      async () => {
        tab = undefined;
      },
    );
    tab.activate();
    const state = workspace.getSnapshot();
    if ((state.sidebarSection ?? state.section) === 'ai' && state.sidebarOpen)
      workspace.toggleSidebar();
  };
  const label = {
    en: dictionaries.en['panels.aiAssistant'],
    ja: dictionaries.ja['panels.aiAssistant'],
    'zh-CN': dictionaries['zh-CN']['panels.aiAssistant'],
    'zh-TW': dictionaries['zh-TW']['panels.aiAssistant'],
  };
  ctx.effect(() => () => tab?.dispose());
  ctx.effect(() =>
    ctx.locale.subscribe(() => {
      tab?.update({ id: 'axterm.ai', kind: 'ai', title: ctx.locale.resolveText(label) });
    }),
  );
  ctx.effect(() =>
    workspace.registerNavigation({
      id: 'ai',
      label,
      icon: <Bot size={18} aria-hidden="true" />,
      order: 70,
    }),
  );
  ctx.effect(() => workspace.registerAction('open-ai', () => open()));
  const explanations = new TerminalExplanationOwner(
    model,
    (id, requireActive) => {
      const state = workspace.getSnapshot();
      return (
        (!requireActive || state.activeTabId === id) &&
        state.tabs.some((tab) => tab.id === id && tab.kind === 'terminal')
      );
    },
    () => ctx.locale.bind('ai')('ai.explainTerminalPrompt'),
    (id) => {
      open();
      target = id;
    },
  );
  ctx.provide('aiTerminalExplanationUi', explanations);
  ctx.effect(() => () => explanations.dispose());
  ctx.effect(() => workspace.subscribe(explanations.refresh));
  function View({
    t,
    embedded = false,
    active = true,
    settingsOnly = false,
  }: PropsLocale<'ai'> & { embedded?: boolean; active?: boolean; settingsOnly?: boolean }) {
    const layout = useSyncExternalStore(workspace.subscribe, workspace.getSnapshot);
    const locale = useSyncExternalStore(ctx.locale.subscribe, ctx.locale.getSnapshot);
    const draft = useSyncExternalStore(explanations.subscribe, explanations.getSnapshot);
    const terminalId = layout.tabs.some((tab) => tab.id === target && tab.kind === 'terminal')
      ? target
      : undefined;
    return (
      <AiI18nProvider value={{ language: locale.active, x: (key, variables) => t(key, variables) }}>
        <AiPanel
          client={actions}
          activeTerminalId={terminalId}
          requestedDraft={
            active && !settingsOnly && draft?.terminalId === terminalId ? draft : undefined
          }
          onDraftConsumed={() => {
            if (draft) explanations.consume(draft.nonce);
          }}
          embedded={embedded}
          active={active}
          settingsOnly={settingsOnly}
        />
      </AiI18nProvider>
    );
  }
  ctx.slots.inject('settings.ai', function* () {
    yield ctx.slots.register(
      { name: 'settings.ai', id: 'ai.providers', locale: 'ai' },
      function ProviderSettings(props: PropsLocale<'ai'>) {
        return <View {...props} settingsOnly />;
      },
    );
  });
  ctx.slots.inject('workspace.toolbar', function* () {
    yield ctx.slots.register(
      { name: 'workspace.toolbar', id: 'ai.open', order: 70, locale: 'ai' },
      function OpenAi({ t }: PropsLocale<'ai'>) {
        return (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                data-ai-sidebar-toggle
                data-activity-item="ai"
                variant="ghost"
                className={styles['ai-open-workspace']}
                aria-label={t('panels.aiInspector')}
                title={t('panels.aiInspector')}
                onClick={() => {
                  rememberTarget();
                  const state = workspace.getSnapshot();
                  if ((state.sidebarSection ?? state.section) === 'ai' && state.sidebarOpen)
                    workspace.toggleSidebar();
                  else workspace.selectSection('ai', { sidebar: true });
                }}
              >
                <Bot size={19} strokeWidth={1.65} />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="left" sideOffset={8}>
              {t('panels.aiInspector')}
            </TooltipContent>
          </Tooltip>
        );
      },
    );
  });
  ctx.slots.inject('workspace.sidebar', function* () {
    yield ctx.slots.register(
      { name: 'workspace.sidebar', key: 'ai', locale: 'ai' },
      function AiSidebar(props: PropsLocale<'ai'>) {
        const state = useSyncExternalStore(workspace.subscribe, workspace.getSnapshot);
        if (state.tabs.some((tab) => tab.id === state.activeTabId && tab.kind === 'ai'))
          return (
            <Button data-ai-open-workspace onClick={open}>
              {props.t('panels.aiAssistant')}
            </Button>
          );
        return (
          <>
            <Button data-ai-open-workspace onClick={open}>
              {props.t('ai.chatWorkspace')}
            </Button>
            <View {...props} embedded />
          </>
        );
      },
    );
  });
  ctx.slots.inject('workspace.session', function* () {
    yield ctx.slots.register(
      { name: 'workspace.session', key: 'ai', locale: 'ai' },
      function AiWorkspace(props: PropsLocale<'ai'> & WorkspaceSessionOwner) {
        return <View {...props} />;
      },
    );
  });
}
