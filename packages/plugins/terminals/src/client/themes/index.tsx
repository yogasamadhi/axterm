import { useSyncExternalStore } from 'react';
import type { Context } from '@deepseek-ai/cordis';
import type { PropsLocale } from '@axterm/ui';
import type { AiThemeUi } from '@axterm/ui/workspace';
import type { TerminalFactsModel } from '../facts.ts';
import type { TerminalAssetsModel } from '../assets.ts';
import { TerminalThemeCommands } from './commands.ts';
import { TerminalThemeAssetPicker } from './assets.ts';
import { TerminalThemeWorkspace } from './panel.tsx';
import { cssText } from './themes.module.css';
/** Own the settings contribution; optional AI remains a separately withdrawable selected capability. */
export function installTerminalThemesUi(
  ctx: Context,
  model: TerminalFactsModel,
  assets: TerminalAssetsModel,
): void {
  const picker = new TerminalThemeAssetPicker(assets, ctx.fileGrantActions);
  const commands = new TerminalThemeCommands(model, ctx.configurationActions, (visual) =>
    picker.protect(visual.background.assetId),
  );
  const lifetime = new AbortController();
  const pending = new Set<Promise<unknown>>();
  const track = <T,>(task: Promise<T>): Promise<T> => {
    pending.add(task);
    void task.then(
      () => pending.delete(task),
      () => pending.delete(task),
    );
    return task;
  };
  const retire = () => {
    const task = picker.reset();
    pending.add(task);
    void task.then(
      () => pending.delete(task),
      () => pending.delete(task),
    );
  };
  ctx.effect(() => async () => {
    lifetime.abort();
    const closed = await Promise.allSettled([commands.close(), picker.close()]);
    await Promise.allSettled([...pending]);
    if (closed.some((value) => value.status === 'rejected'))
      throw Error('TERMINAL_THEME_UI_DRAIN_FAILED');
  });
  let ai: AiThemeUi | undefined;
  const listeners = new Set<() => void>();
  const getAi = () => ai,
    subscribeAi = (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    };
  const changed = () => {
    for (const listener of [...listeners]) listener();
  };
  ctx.inject(['aiThemeUi'], (owner) => {
    const service = owner.aiThemeUi;
    ai = service;
    changed();
    owner.effect(() => () => {
      if (ai === service) {
        ai = undefined;
        changed();
      }
    });
  });
  ctx.effect(() => () => {
    listeners.clear();
  });
  ctx.effect(() => {
    const style = document.createElement('style');
    style.dataset.axtermOwner = '@axterm/plugin-terminals/themes';
    style.textContent = cssText;
    document.head.append(style);
    return () => style.remove();
  });
  ctx.slots.inject('settings.themes', function* () {
    yield ctx.slots.register(
      { name: 'settings.themes', id: 'terminals.themes', locale: 'terminals' },
      function Themes({ t }: PropsLocale<'terminals'>) {
        const ai = useSyncExternalStore(subscribeAi, getAi);
        return (
          <TerminalThemeWorkspace
            model={model}
            configuration={ctx.configurationActions}
            workspace={ctx.workspaceUi}
            visuals={ctx.terminalVisualUi}
            commands={commands}
            assets={picker}
            {...(ai ? { ai } : {})}
            x={t}
            retire={retire}
            signal={lifetime.signal}
            track={track}
          />
        );
      },
    );
  });
}
