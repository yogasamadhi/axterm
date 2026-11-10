import { TerminalRecoveryCommands } from './recovery-preferences.ts';
import { TerminalRecoverySettingsPanel } from './settings-panel.tsx';
import { RemoteMonitorBar } from './monitor-panel.tsx';
import { DropdownMenuItem } from '@axterm/ui/controls';
import { TerminalRecordingCommands } from './recording.ts';
import { useSyncExternalStore } from 'react';
import { Info, PlayCircle, StopCircle, Save } from 'lucide-react';
import type { Context } from '@deepseek-ai/cordis';
import type { PropsLocale } from '@axterm/ui';
import { Button } from '@axterm/ui/controls';
import type { TerminalsModel } from '../index.ts';
import { BatchInput } from './batch-panel.tsx';
import { TerminalInformationPanel } from './information-panel.tsx';
import { TerminalInformationModel } from './information-model.ts';
import { TerminalMonitorCommands } from './preferences.ts';
import { cssText } from './tools.module.css';
/** One window's pure view flags; canonical business facts stay in the paired models. */
export function installTerminalTools(
  ctx: Context,
  model: TerminalsModel,
  sinks: ReadonlyMap<string, (data: string) => boolean>,
) {
  let open = false;
  const listeners = new Set<() => void>(),
    info = new TerminalInformationModel(ctx),
    commands = new TerminalMonitorCommands(ctx.configurationActions),
    recording = new TerminalRecordingCommands(model, ctx.fileGrantActions),
    recovery = new TerminalRecoveryCommands(ctx.configurationActions);
  const subscribe = (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    getSnapshot = () => open;
  let observation: (() => void) | undefined,
    observedKey = '';
  const synchronize = (force = false) => {
    const state = model.getSnapshot(),
      workspace = ctx.workspaceUi.getSnapshot(),
      settings = ctx.configurationActions.getSnapshot();
    const session =
      state.status === 'ready'
        ? state.baseline.sessions.find((item) => item.id === workspace.activeTabId)
        : undefined;
    const enabled =
      !document.hidden &&
      session?.state === 'ready' &&
      ((open && (session.kind === 'local' || session.kind === 'ssh')) ||
        (session?.kind === 'ssh' &&
          settings.status === 'ready' &&
          state.status === 'ready' &&
          settings.baseline.generation === state.baseline.generation &&
          settings.baseline.settings.monitor.remoteMonitorBarEnabled));
    const key =
      enabled && state.status === 'ready' && session
        ? state.baseline.generation + ':' + session.id
        : '';
    if (!force && key === observedKey) return;
    observation?.();
    observation = undefined;
    observedKey = key;
    if (key && state.status === 'ready' && session)
      observation = info.observe(session.id, state.baseline.generation);
  };
  const visibility = () => synchronize();
  const offModel = model.subscribe(visibility),
    offWorkspace = ctx.workspaceUi.subscribe(visibility),
    offSettings = ctx.configurationActions.subscribe(visibility);
  document.addEventListener('visibilitychange', visibility);
  const stopObservations = () => {
    offModel();
    offWorkspace();
    offSettings();
    document.removeEventListener('visibilitychange', visibility);
    observation?.();
  };
  synchronize();
  const toggle = () => {
    open = !open;
    synchronize();
    for (const listener of [...listeners]) listener();
  };
  ctx.effect(() => () => {
    stopObservations();
    listeners.clear();
    return Promise.all([info.close(), commands.close(), recording.close(), recovery.close()]).then(
      () => {},
    );
  });
  ctx.effect(() => {
    const style = document.createElement('style');
    style.dataset.axtermOwner = '@axterm/plugin-terminals/tools';
    style.textContent = cssText;
    document.head.append(style);
    return () => style.remove();
  });
  ctx.slots.inject('settings.terminal', function* () {
    yield ctx.slots.register(
      {
        name: 'settings.terminal',
        id: 'terminals.recovery-settings',
        locale: 'terminals',
        order: 40,
      },
      function RecoverySettings({ t }: PropsLocale<'terminals'>) {
        return (
          <TerminalRecoverySettingsPanel
            configuration={ctx.configurationActions}
            commands={commands}
            recovery={recovery}
            x={t}
          />
        );
      },
    );
  });
  function RecordingMenu({ tabId, t }: { tabId: string } & PropsLocale<'terminals'>) {
    const state = useSyncExternalStore(model.subscribe, model.getSnapshot),
      command = useSyncExternalStore(recording.subscribe, recording.getSnapshot);
    const session =
      state.status === 'ready'
        ? state.baseline.sessions.find((session) => session.id === tabId)
        : undefined;
    if (!session) return null;
    const busy = command.busy.includes(tabId),
      uncertain = command.uncertain.includes(tabId),
      active = session.recording?.state === 'active';
    return (
      <>
        <DropdownMenuItem
          asChild
          data-recording-action="toggle"
          disabled={busy || (!uncertain && session.state !== 'ready')}
          onSelect={() => {
            void (uncertain ? recording.retry(tabId) : recording.run(tabId)).catch(() => {});
          }}
        >
          <button type="button">
            {active ? <StopCircle size={14} /> : <PlayCircle size={14} />}
            <span>
              {t(
                uncertain
                  ? 'common.retry'
                  : active
                    ? 'terminal.stopRecording'
                    : 'terminal.startRecording',
              )}
            </span>
          </button>
        </DropdownMenuItem>
        <DropdownMenuItem
          asChild
          data-recording-action="save"
          disabled={busy || uncertain || session.state !== 'ready'}
          onSelect={() => {
            void recording.run(tabId, true).catch(() => {});
          }}
        >
          <button type="button">
            <Save size={14} />
            <span>{t('terminal.saveLog')}</span>
          </button>
        </DropdownMenuItem>
      </>
    );
  }
  for (const name of ['workspace.tab-menu', 'terminal.context-menu'] as const) {
    ctx.slots.inject(name, function* () {
      yield ctx.slots.register(
        { name, id: 'terminals.recording-menu', locale: 'terminals', order: 15 },
        RecordingMenu,
      );
    });
  }
  ctx.slots.inject('workspace.status', function* () {
    yield ctx.slots.register(
      { name: 'workspace.status', id: 'terminals.tools', locale: 'terminals', order: 10 },
      function Tools({ t }: PropsLocale<'terminals'>) {
        const workspace = useSyncExternalStore(
            ctx.workspaceUi.subscribe,
            ctx.workspaceUi.getSnapshot,
          ),
          state = useSyncExternalStore(model.subscribe, model.getSnapshot);
        if (state.status !== 'ready') return null;
        const generation = state.baseline.generation;
        const tabs = state.baseline.sessions.map((session) => ({
          id: session.id,
          title: workspace.tabs.find((tab) => tab.id === session.id)?.title ?? session.title,
          kind: session.kind,
          disconnected: session.state !== 'ready',
        }));
        return (
          <>
            <BatchInput
              key={generation}
              tabs={tabs}
              activeTerminalId={workspace.activeTabId}
              x={t}
              send={(id, data) => {
                const current = model.getSnapshot();
                if (
                  current.status !== 'ready' ||
                  current.baseline.generation !== generation ||
                  !current.baseline.sessions.some(
                    (session) => session.id === id && session.state === 'ready',
                  ) ||
                  data.length > 16385
                )
                  return false;
                return sinks.get(id)?.(data) ?? false;
              }}
            />
          </>
        );
      },
    );
  });
  ctx.slots.inject('workspace.status', function* () {
    yield ctx.slots.register(
      {
        name: 'workspace.status',
        id: 'terminals.information-toggle',
        locale: 'terminals',
        order: 40,
      },
      function InformationToggle({ t }: PropsLocale<'terminals'>) {
        const workspace = useSyncExternalStore(
            ctx.workspaceUi.subscribe,
            ctx.workspaceUi.getSnapshot,
          ),
          opened = useSyncExternalStore(subscribe, getSnapshot);
        return (
          <button
            type="button"
            className={opened ? 'status-information active' : 'status-information'}
            data-terminal-information-toggle
            aria-label={t('terminalInfo.title')}
            aria-expanded={opened}
            disabled={
              !workspace.tabs.some(
                (tab) => tab.id === workspace.activeTabId && tab.kind === 'terminal',
              )
            }
            onClick={toggle}
          >
            <Info size={12} />
            {t('app.information')}
          </button>
        );
      },
    );
  });
  ctx.slots.inject('workspace.status', function* () {
    yield ctx.slots.register(
      {
        name: 'workspace.status',
        id: 'terminals.recording-status',
        locale: 'terminals',
        order: 88,
      },
      function RecordingStatus({ t }: PropsLocale<'terminals'>) {
        const state = useSyncExternalStore(recording.subscribe, recording.getSnapshot);
        return state.failed ? (
          <span role="alert">
            {t('terminal.saveLogError')} <Button onClick={recording.dismiss}>{t('dismiss')}</Button>
          </span>
        ) : null;
      },
    );
  });
  ctx.slots.inject('workspace.auxiliary', function* () {
    yield ctx.slots.register(
      { name: 'workspace.auxiliary', id: 'terminals.information', locale: 'terminals' },
      function Information({ t }: PropsLocale<'terminals'>) {
        const workspace = useSyncExternalStore(
            ctx.workspaceUi.subscribe,
            ctx.workspaceUi.getSnapshot,
          ),
          state = useSyncExternalStore(model.subscribe, model.getSnapshot),
          settings = useSyncExternalStore(
            ctx.configurationActions.subscribe,
            ctx.configurationActions.getSnapshot,
          ),
          opened = useSyncExternalStore(subscribe, getSnapshot),
          sample = useSyncExternalStore(info.subscribe, info.getSnapshot),
          command = useSyncExternalStore(commands.subscribe, commands.getSnapshot);
        const session =
          state.status === 'ready'
            ? state.baseline.sessions.find((item) => item.id === workspace.activeTabId)
            : undefined;
        const generation = state.status === 'ready' ? state.baseline.generation : undefined;
        const eligible =
          opened &&
          session?.state === 'ready' &&
          (session.kind === 'local' || session.kind === 'ssh');
        if (
          !opened ||
          settings.status !== 'ready' ||
          (workspace.sidebarOpen && workspace.section === 'settings')
        )
          return null;
        const data =
          sample.status === 'ready' &&
          sample.baseline.generation === generation &&
          sample.baseline.snapshot.terminalId === session?.id
            ? sample.baseline.snapshot
            : undefined;
        return (
          <>
            <TerminalInformationPanel
              open
              x={t}
              language={ctx.locale.getLocale().active}
              terminal={
                session
                  ? {
                      id: session.id,
                      title:
                        workspace.tabs.find((tab) => tab.id === session.id)?.title ?? session.title,
                      kind: session.kind,
                      disconnected: session.state !== 'ready',
                    }
                  : undefined
              }
              selectedItems={settings.baseline.settings.monitor.terminalInformationItems}
              onSelectedItemsChange={(items) => {
                if (!command.busy && !command.uncertain)
                  void commands
                    .save({
                      ...settings.baseline.settings.monitor,
                      terminalInformationItems: items,
                    })
                    .catch(() => {});
              }}
              onClose={toggle}
              query={{
                data,
                isFetching: eligible && sample.status === 'connecting',
                isPending: eligible && sample.status === 'connecting',
                isError: sample.status === 'error',
                refetch: () => synchronize(true),
              }}
            />
            {command.uncertain && (
              <div role="alert">
                <Button onClick={() => void commands.retry().catch(() => {})}>
                  {t('common.retry')}
                </Button>
              </div>
            )}
          </>
        );
      },
    );
  });
  ctx.slots.inject('workspace.monitor', function* () {
    yield ctx.slots.register(
      { name: 'workspace.monitor', id: 'terminals.monitor', locale: 'terminals' },
      function Monitor({ t }: PropsLocale<'terminals'>) {
        const state = useSyncExternalStore(model.subscribe, model.getSnapshot),
          workspace = useSyncExternalStore(ctx.workspaceUi.subscribe, ctx.workspaceUi.getSnapshot),
          settings = useSyncExternalStore(
            ctx.configurationActions.subscribe,
            ctx.configurationActions.getSnapshot,
          ),
          sample = useSyncExternalStore(info.subscribe, info.getSnapshot),
          command = useSyncExternalStore(commands.subscribe, commands.getSnapshot);
        const session =
          state.status === 'ready'
            ? state.baseline.sessions.find((item) => item.id === workspace.activeTabId)
            : undefined;
        if (settings.status !== 'ready' || state.status !== 'ready' || session?.kind !== 'ssh')
          return null;
        const data =
          sample.status === 'ready' &&
          sample.baseline.generation === state.baseline.generation &&
          sample.baseline.snapshot.terminalId === session.id
            ? sample.baseline.snapshot
            : undefined;
        return (
          <RemoteMonitorBar
            x={t}
            language={ctx.locale.getLocale().active}
            visible={settings.baseline.settings.monitor.remoteMonitorBarEnabled}
            items={settings.baseline.settings.monitor.remoteMonitorBarItems}
            terminal={{
              id: session.id,
              title: session.title,
              kind: session.kind,
              disconnected: session.state !== 'ready',
            }}
            query={{
              data,
              isPending: sample.status === 'connecting',
              isError: sample.status === 'error',
            }}
            onOpenInformation={() => {
              if (!open) toggle();
            }}
            onOpenSettings={() => {
              void ctx.workspaceUi.invokeAction('settings.open.terminal').catch(() => {});
            }}
            onDisable={() => {
              if (!command.busy && !command.uncertain)
                void commands
                  .save({ ...settings.baseline.settings.monitor, remoteMonitorBarEnabled: false })
                  .catch(() => {});
            }}
          />
        );
      },
    );
  });
  return { recording };
}
