import { useSyncExternalStore } from 'react';
import type { Context } from '@deepseek-ai/cordis';
import type { PropsLocale } from '@axterm/ui';
import { TerminalKeyBarCommands } from './commands.ts';
import { TerminalShortcutBar } from './panel.tsx';
import { cssText } from './keybar.module.css';
/** One touch viewport/input-control owner per window, independent of the number of live terminal views. */
export function installTerminalKeyBar(
  ctx: Context,
  sinks: ReadonlyMap<string, (data: string) => boolean>,
): void {
  const commands = new TerminalKeyBarCommands(ctx.configurationActions);
  ctx.effect(() => () => commands.close());
  ctx.effect(() => {
    const style = document.createElement('style');
    style.dataset.axtermOwner = '@axterm/plugin-terminals/keybar';
    style.textContent = cssText;
    document.head.append(style);
    return () => style.remove();
  });
  ctx.slots.inject('workspace.overlay', function* () {
    yield ctx.slots.register(
      { name: 'workspace.overlay', id: 'terminals.keybar', locale: 'terminals' },
      function KeyBar({ t }: PropsLocale<'terminals'>) {
        const workspace = useSyncExternalStore(
            ctx.workspaceUi.subscribe,
            ctx.workspaceUi.getSnapshot,
          ),
          settings = useSyncExternalStore(
            ctx.configurationActions.subscribe,
            ctx.configurationActions.getSnapshot,
          ),
          command = useSyncExternalStore(commands.subscribe, commands.getSnapshot);
        const id = workspace.tabs.find(
          (tab) => tab.id === workspace.activeTabId && tab.kind === 'terminal',
        )?.id;
        if (settings.status !== 'ready') return null;
        return (
          <TerminalShortcutBar
            active={!!id}
            enabled={settings.baseline.settings.terminal.shortcutBarEnabled}
            buttons={settings.baseline.settings.terminal.shortcutBarButtons}
            x={t}
            uncertain={command.uncertain}
            onRetry={() => commands.retry()}
            onButtonsChange={(buttons) => commands.save(buttons)}
            onSend={(data) => {
              if (!id || ctx.workspaceUi.getSnapshot().activeTabId !== id) return false;
              return sinks.get(id)?.(data) ?? false;
            }}
          />
        );
      },
    );
  });
}
