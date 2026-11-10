import { useSyncExternalStore } from 'react';
import type { Context } from '@deepseek-ai/cordis';
import type { PropsLocale } from '@axterm/ui';
import type { TerminalFactsModel } from '../facts.ts';
import { TerminalHistoryCommands } from './commands.ts';
import { CommandHistoryPopover } from './popover.tsx';
import { CommandHistorySettingsPanel } from './settings.tsx';
import { cssText } from './history.module.css';
export function installTerminalHistoryUi(ctx: Context, model: TerminalFactsModel): void {
  ctx.inject(['configurationActions', 'terminalDraftUi'], (owner) => {
    if (!owner.configurationActions.setCommandHistoryEnabled)
      throw Error('TERMINAL_HISTORY_CONFIGURATION_CAPABILITY_MISSING');
    const commands = new TerminalHistoryCommands(
      model,
      owner.configurationActions,
      owner.terminalDraftUi,
    );
    owner.provide('terminalHistoryUi', {
      remove: async (id, version, generation) => {
        const state = model.getSnapshot();
        if (state.status !== 'ready' || state.baseline.generation !== generation)
          throw Error('TERMINAL_HISTORY_RETIRED');
        const item = state.baseline.history.items.find(
          (item) => item.id === id && item.version === version,
        );
        if (!item) throw Error('TERMINAL_HISTORY_ITEM_RETIRED');
        await commands.remove(item);
      },
    });
    owner.effect(() => () => commands.close());
    owner.effect(() => {
      const style = document.createElement('style');
      style.dataset.axtermOwner = '@axterm/plugin-terminals';
      style.textContent = cssText;
      document.head.append(style);
      return () => style.remove();
    });
    owner.slots.inject('workspace.status', function* () {
      yield owner.slots.register(
        {
          name: 'workspace.status',
          id: 'terminals.command-history',
          locale: 'terminals',
          order: 30,
        },
        function HistoryStatus({ t }: PropsLocale<'terminals'>) {
          const workspace = useSyncExternalStore(
            owner.workspaceUi.subscribe,
            owner.workspaceUi.getSnapshot,
          );
          const active = workspace.tabs.find(
            (tab) => tab.id === workspace.activeTabId && tab.kind === 'terminal',
          );
          return (
            <CommandHistoryPopover
              model={model}
              configuration={owner.configurationActions}
              commands={commands}
              activeTerminalId={active?.id}
              x={t}
            />
          );
        },
      );
    });
    owner.slots.inject('settings.terminal', function* () {
      yield owner.slots.register(
        {
          name: 'settings.terminal',
          id: 'terminals.command-history-settings',
          locale: 'terminals',
          order: 80,
        },
        function HistorySettings({ t }: PropsLocale<'terminals'>) {
          return (
            <CommandHistorySettingsPanel
              configuration={owner.configurationActions}
              commands={commands}
              x={t}
            />
          );
        },
      );
    });
  });
}
