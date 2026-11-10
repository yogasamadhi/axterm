import '@axterm/ui/workspace';
import type {} from '@axterm/ui/shortcuts';
import { quickCommandReference } from '../shortcut-references.ts';
import { useSyncExternalStore } from 'react';
import { Command } from 'lucide-react';
import type { Context } from '@deepseek-ai/cordis';
import type { PropsLocale } from '@axterm/ui';
import type { AutomationModel } from '../index.ts';
import { AutomationUiCommands } from './commands.ts';
import { QuickCommandRunner } from './quick-run.ts';
import { AutomationUi, useAutomation, useI18n } from './context.tsx';
import { QuickCommandWorkspace } from './quick-command-workspace.tsx';
import { TriggerWorkspace } from './trigger-workspace.tsx';
import { BatchOperationWorkspace } from './batch-operation-workspace.tsx';
import { QuickCommandPopover } from './quick-command-popover.tsx';
import { dictionaries } from './locales.ts';
import { cx, cssText } from './styles.ts';
export function installAutomationUi(ctx: Context, model: AutomationModel): void {
  ctx.inject(['shortcuts'], (owner) => {
    owner.effect(() =>
      owner.shortcuts.registerConflictSource((binding) => {
        const state = model.getSnapshot();
        return state.status === 'ready'
          ? quickCommandReference(
              binding,
              state.baseline.quickCommands.commands,
              owner.shortcuts.platform,
              (name) => ctx.locale.bind('shortcuts')('shortcuts.quickCommandNamed', { name }),
            )
          : [];
      }),
    );
  });
  const commands = new AutomationUiCommands(model, ctx.workspaceUi, ctx.fileGrantActions),
    runner = new QuickCommandRunner(
      ctx.terminalSessionsView,
      ctx.workspaceUi,
      ctx.terminalInputUi,
      ctx.terminalDraftUi,
      () => navigator.clipboard.readText(),
    );
  const services = {
    model,
    commands,
    runner,
    workspace: ctx.workspaceUi,
    catalog: ctx.catalogActions,
    terminals: ctx.terminalSessionsView,
  };
  ctx.provide('automationWorkspaceUi', {
    open: (section) => commands.open(section),
    runBatchGrant: (id, generation, signal) => commands.runBatchGrant(id, generation, signal),
  });
  ctx.effect(() => async () => {
    await runner.close();
    await commands.close();
  });
  ctx.effect(() =>
    ctx.remote.$on('automation/trigger-fired', (event) => {
      if (event.actionType === 'notify') commands.notify('notify', event.name);
    }),
  );
  ctx.effect(() =>
    ctx.remote.$on('automation/trigger-session-disabled', () => commands.notify('limit')),
  );
  ctx.effect(() => ctx.locale.register('automation', dictionaries));
  ctx.effect(() => {
    const style = document.createElement('style');
    style.dataset.axtermOwner = '@axterm/plugin-automation';
    style.dataset.plugin = '@axterm/plugin-automation';
    style.textContent = cssText;
    document.head.append(style);
    return () => style.remove();
  });
  ctx.effect(() =>
    ctx.workspaceUi.registerNavigation({
      id: 'commands',
      label: {
        en: dictionaries.en['panels.quickCommands'],
        ja: dictionaries.ja['panels.quickCommands'],
        'zh-CN': dictionaries['zh-CN']['panels.quickCommands'],
        'zh-TW': dictionaries['zh-TW']['panels.quickCommands'],
      },
      icon: <Command size={18} />,
      view: 'section',
      chrome: 'settings',
      order: 40,
    }),
  );
  for (const [section, order, label] of [
    ['quick-commands', 30, 'settings.savedCommands'],
    ['triggers', 40, 'panels.triggers'],
  ] as const)
    ctx.slots.inject('workspace.section-toolbar', function* () {
      yield ctx.slots.register(
        {
          name: 'workspace.section-toolbar',
          id: 'automation.' + section,
          order,
          locale: 'automation',
        },
        function Tab({ t }: PropsLocale<'automation'>) {
          const state = useSyncExternalStore(commands.subscribe, commands.getSnapshot),
            workspace = useSyncExternalStore(
              ctx.workspaceUi.subscribe,
              ctx.workspaceUi.getSnapshot,
            );
          return (
            <button
              type="button"
              data-settings-destination={section}
              aria-current={
                workspace.section === 'commands' && state.section === section ? 'page' : undefined
              }
              onClick={() => commands.open(section)}
            >
              {t(label)}
              {section === 'triggers' && (
                <>
                  {' '}
                  <sup>{t('panels.beta')}</sup>
                </>
              )}
            </button>
          );
        },
      );
    });
  ctx.slots.inject('workspace.section', function* () {
    yield ctx.slots.register(
      { name: 'workspace.section', key: 'commands', locale: 'automation' },
      function Panel({ t }: PropsLocale<'automation'>) {
        return (
          <AutomationUi services={services} translate={t}>
            <CommandsPanel />
          </AutomationUi>
        );
      },
    );
  });
  ctx.slots.inject('workspace.status', function* () {
    yield ctx.slots.register(
      {
        name: 'workspace.status',
        id: 'automation.quick-commands',
        order: 20,
        locale: 'automation',
      },
      function Popover({ t }: PropsLocale<'automation'>) {
        return (
          <AutomationUi services={services} translate={t}>
            <QuickCommandPopover />
          </AutomationUi>
        );
      },
    );
  });
  ctx.slots.inject('workspace.overlay', function* () {
    yield ctx.slots.register(
      { name: 'workspace.overlay', id: 'automation.outcomes', order: 22, locale: 'automation' },
      function Outcomes({ t }: PropsLocale<'automation'>) {
        const state = useSyncExternalStore(commands.subscribe, commands.getSnapshot);
        return state.uncertain || state.cleanup || state.notice || state.fileError ? (
          <div role="alert" className={cx('automation-outcome')}>
            {state.notice
              ? t(
                  state.notice.kind === 'notify'
                    ? 'app.triggerNotification'
                    : 'app.triggerLimitReached',
                  { name: state.notice.name },
                )
              : t(
                  state.cleanup
                    ? 'common.operationFailed'
                    : state.uncertain
                      ? 'batchCli.unknownOutcome'
                      : state.fileError!,
                )}
            {(state.notice || state.fileError) && (
              <button onClick={() => commands.dismissNotice()} aria-label={t('common.close')}>
                ×
              </button>
            )}
            {(state.uncertain || state.cleanup) && (
              <button
                disabled={state.busy}
                onClick={() =>
                  void (state.cleanup ? commands.retryCleanup() : commands.retry()).catch(() => {})
                }
              >
                {t('common.retry')}
              </button>
            )}
          </div>
        ) : null;
      },
    );
  });
}
function CommandsPanel() {
  const { commands, model } = useAutomation(),
    state = useSyncExternalStore(commands.subscribe, commands.getSnapshot),
    facts = useSyncExternalStore(model.subscribe, model.getSnapshot),
    { x } = useI18n();
  const section = state.section,
    title =
      section === 'quick-commands'
        ? 'panels.quickCommands'
        : section === 'batch-operations'
          ? 'panels.batchOperations'
          : 'panels.triggers',
    description =
      section === 'quick-commands'
        ? 'panels.quickCommandsDescription'
        : section === 'batch-operations'
          ? 'panels.batchOperationsDescription'
          : 'panels.triggersDescription';
  return (
    <div className={cx('automation-root panel-page')}>
      <header className={cx('panel-heading')}>
        <div>
          <small>{x('panels.productivity')}</small>
          <h1>{x(title)}</h1>
          <p>{x(description)}</p>
        </div>
      </header>
      <nav className={cx('commands-workspace-tabs')} aria-label={x('panels.commandTools')}>
        {(['quick-commands', 'batch-operations', 'triggers'] as const).map((value) => (
          <button
            key={value}
            aria-selected={section === value}
            onClick={() => commands.open(value)}
          >
            {x(
              value === 'quick-commands'
                ? 'panels.quickCommands'
                : value === 'batch-operations'
                  ? 'panels.batchOperations'
                  : 'panels.triggers',
            )}
            {value === 'triggers' && (
              <>
                {' '}
                <sup>{x('panels.beta')}</sup>
              </>
            )}
          </button>
        ))}
      </nav>
      {facts.status === 'error' ? (
        <div role="alert">
          {x('common.operationFailed')}
          <button onClick={() => void model.retry().catch(() => {})}>{x('common.retry')}</button>
        </div>
      ) : section === 'quick-commands' ? (
        <QuickCommandWorkspace />
      ) : section === 'batch-operations' ? (
        <BatchOperationWorkspace />
      ) : (
        <TriggerWorkspace />
      )}
    </div>
  );
}
