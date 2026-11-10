import type { Context } from '@deepseek-ai/cordis';
import type { AxtermKeyboardApi, ShortcutCommandId } from '@axterm/plugin-api/shortcuts';
import { createShortcutDefaults } from '@axterm/plugin-api/shortcuts';
import type { DesktopRuntimeModel } from './index.ts';
import type { DesktopPreferencesModel } from './preferences-model.ts';
import type { DesktopPreferenceCommands } from './preferences-commands.ts';
import type {} from '@axterm/ui/workspace';
import type { DesktopWindowUi } from '@axterm/ui/workspace';
/** Window presentation delegates to the owning trusted shell; no business invocation crosses this bridge. */
export function installDesktopShortcuts(
  ctx: Context,
  model: DesktopRuntimeModel,
  preferences: DesktopPreferencesModel,
  commands: DesktopPreferenceCommands,
): void {
  const keyboard = (window as Window & { axtermDesktopKeyboard?: AxtermKeyboardApi })
    .axtermDesktopKeyboard;
  if (!keyboard) return;
  const pending = new Set<Promise<unknown>>();
  let closed = false;
  const track = <T>(task: Promise<T>): Promise<T> => {
    pending.add(task);
    void task.then(
      () => pending.delete(task),
      () => pending.delete(task),
    );
    return task;
  };
  const windowUi: DesktopWindowUi = {
    getState() {
      const state = model.getSnapshot();
      if (closed || state.status !== 'ready' || pending.size >= 32)
        return Promise.reject(Error('DESKTOP_WINDOW_UNAVAILABLE'));
      const generation = state.baseline.metadata.generation;
      return track(
        keyboard.windowState(generation).then((value) => {
          const current = model.getSnapshot();
          if (
            closed ||
            current.status !== 'ready' ||
            current.baseline.metadata.generation !== generation
          )
            throw Error('DESKTOP_WINDOW_RETIRED');
          return value;
        }),
      );
    },
    act(action): Promise<void> {
      const state = model.getSnapshot();
      if (closed || state.status !== 'ready' || pending.size >= 32)
        return Promise.reject(Error('DESKTOP_WINDOW_UNAVAILABLE'));
      if (action !== 'zoom-in' && action !== 'zoom-out')
        return track(
          action === 'close'
            ? ctx.shortcuts.closeWindow()
            : keyboard.windowAction(state.baseline.metadata.generation, action),
        );
      const facts = preferences.getSnapshot();
      if (
        facts.status !== 'ready' ||
        facts.baseline.generation !== state.baseline.metadata.generation
      )
        return Promise.reject(Error('DESKTOP_WINDOW_UNAVAILABLE'));
      const task = commands.save(
        {
          zoomFactor: Math.max(
            0.5,
            Math.min(
              8,
              Math.round(
                (facts.baseline.record.preferences.zoomFactor +
                  (action === 'zoom-in' ? 0.1 : -0.1)) *
                  10,
              ) / 10,
            ),
          ),
        },
        facts.baseline.record.version,
        facts.baseline.generation,
      );
      return track(task);
    },
  };
  ctx.provide('desktopWindowUi', windowUi);
  ctx.effect(() => async () => {
    closed = true;
    await Promise.allSettled([...pending]);
  });
  const t = ctx.locale.bind('shortcuts');
  for (const [id, label, code, modifiers, mac, action] of [
    [
      'app.togglefullscreen',
      'shortcuts.action.toggleFullscreen',
      'KeyF',
      ['alt'],
      ['alt'],
      'fullscreen',
    ],
    ['app.zoomin', 'shortcuts.action.zoomInWindow', 'Equal', ['control'], ['meta'], 'zoom-in'],
    ['app.zoomout', 'shortcuts.action.zoomOutWindow', 'Minus', ['control'], ['meta'], 'zoom-out'],
  ] as const)
    for (const alternate of [false, true])
      ctx.effect(() =>
        ctx.shortcuts.register({
          id: (id + (alternate ? '.alternate' : '')) as ShortcutCommandId,
          label: () => t(label),
          messageKey: label,
          aliases: [],
          defaults: alternate
            ? {}
            : createShortcutDefaults({ code, modifiers }, { code, modifiers: mac }),
          regions: ['page', 'editable', 'terminal'],
          modals: [],
          resolve: () => {
            const state = model.getSnapshot();
            if (state.status !== 'ready' || closed)
              return { status: 'blocked', reason: 'not-ready' };
            const generation = state.baseline.metadata.generation;
            return {
              status: 'handled',
              run: () => {
                const current = model.getSnapshot();
                if (
                  current.status === 'ready' &&
                  current.baseline.metadata.generation === generation
                )
                  void windowUi.act(action).catch(() => {});
              },
            };
          },
        }),
      );
}
