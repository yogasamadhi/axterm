import { installClipboardPalette } from './clipboard-palette.ts';
import type { Context } from '@deepseek-ai/cordis';
import type { ShortcutMessageKey } from '@axterm/ui/shortcuts';
import type { TerminalViewAction } from '@axterm/ui/workspace';
import {
  createShortcutDefaults,
  type ShortcutBinding,
  type ShortcutCommandId,
} from '@axterm/plugin-api/shortcuts';
import type { TerminalsModel } from './index.ts';
/** The terminal plugin captures current targets before dispatch; no input replay or new Agent/service loop. */
export function installTerminalShortcuts(
  ctx: Context,
  model: Pick<TerminalsModel, 'getSnapshot'>,
): void {
  installClipboardPalette(ctx, model);
  const t = ctx.locale.bind('shortcuts');
  const bindings: readonly [
    string,
    ShortcutMessageKey,
    ShortcutBinding | undefined,
    ShortcutBinding | undefined,
    TerminalViewAction | 'reload' | 'reload-all' | 'duplicate' | 'next-pane' | 'new',
  ][] = [
    [
      'app.newTab',
      'shortcuts.action.newLocalTerminal',
      { code: 'KeyQ', modifiers: ['alt'] },
      undefined,
      'new',
    ],
    [
      'app.reloadCurrentTab',
      'shortcuts.action.reloadCurrentTab',
      { code: 'KeyR', modifiers: ['alt'] },
      undefined,
      'reload',
    ],
    [
      'app.reloadAll',
      'shortcuts.action.reloadAllTabs',
      { code: 'KeyY', modifiers: ['alt'] },
      undefined,
      'reload-all',
    ],
    [
      'app.duplicateTab',
      'shortcuts.action.duplicateCurrentTab',
      { code: 'KeyC', modifiers: ['alt'] },
      undefined,
      'duplicate',
    ],
    [
      'app.cloneToNextLayout',
      'shortcuts.action.cloneToNextPane',
      { code: 'Slash', modifiers: ['alt'] },
      undefined,
      'next-pane',
    ],
    [
      'terminal.clear',
      'shortcuts.action.clearScrollback',
      { code: 'KeyL', modifiers: ['control'] },
      { code: 'KeyL', modifiers: ['meta'] },
      'clear',
    ],
    [
      'terminal.search',
      'shortcuts.action.searchTerminal',
      { code: 'KeyF', modifiers: ['control'] },
      { code: 'KeyF', modifiers: ['meta'] },
      'search',
    ],
    [
      'terminal.pasteSelected',
      'shortcuts.action.pasteSelection',
      { code: 'Insert', modifiers: ['alt'] },
      undefined,
      'paste-selection',
    ],
    ['terminal.zoominTerminal', 'shortcuts.action.zoomInTerminal', undefined, undefined, 'zoom-in'],
    [
      'terminal.zoomoutTerminal',
      'shortcuts.action.zoomOutTerminal',
      undefined,
      undefined,
      'zoom-out',
    ],
    [
      'terminal.showNormalBuffer',
      'shortcuts.action.showNormalBuffer',
      { code: 'ArrowUp', modifiers: ['control'] },
      { code: 'ArrowUp', modifiers: ['meta'] },
      'normal-buffer',
    ],
  ];
  for (const [id, label, other, mac, action] of bindings)
    for (const alternate of [false, true])
      ctx.effect(() =>
        ctx.shortcuts.register({
          id: (id + (alternate ? '.alternate' : '')) as ShortcutCommandId,
          label: () => t(label),
          messageKey: label,
          aliases: [],
          defaults: alternate
            ? id === 'terminal.clear'
              ? createShortcutDefaults({ code: 'KeyL', modifiers: ['control', 'shift'] }, null)
              : {}
            : createShortcutDefaults(other, mac ?? other),
          regions:
            action === 'clear' ||
            action === 'search' ||
            action === 'paste-selection' ||
            action === 'normal-buffer' ||
            action === 'zoom-in' ||
            action === 'zoom-out'
              ? ['terminal']
              : ['page', 'editable', 'terminal'],
          modals: [],
          resolve: () => {
            const state = model.getSnapshot(),
              workspace = ctx.workspaceUi.getSnapshot();
            const id = workspace.activeTabId;
            if (['search', 'clear', 'normal-buffer', 'zoom-in', 'zoom-out'].includes(action)) {
              if (!id || workspace.tabs.find((tab) => tab.id === id)?.kind !== 'terminal')
                return { status: 'blocked', reason: 'no-tab' };
              const target = id;
              return {
                status: 'handled',
                run: () => {
                  void Promise.resolve()
                    .then(() => ctx.terminalViewUi.run(target, action as TerminalViewAction))
                    .catch(() => {});
                },
              };
            }
            if (state.status !== 'ready') return { status: 'blocked', reason: 'not-ready' };
            if (action === 'paste-selection' && (!id || !ctx.terminalViewUi.selectionAvailable(id)))
              return { status: 'blocked', reason: 'no-selection' };
            const generation = state.baseline.generation;
            if (action !== 'new' && !state.baseline.sessions.some((session) => session.id === id))
              return { status: 'pass' };
            const targets =
              action === 'reload-all'
                ? state.baseline.sessions.map((session) => session.id)
                : id
                  ? [id]
                  : [];
            return {
              status: 'handled',
              run: () => {
                const current = model.getSnapshot();
                if (current.status !== 'ready' || current.baseline.generation !== generation)
                  return;
                const task =
                  action === 'new'
                    ? ctx.workspaceUi.invokeAction('new-terminal')
                    : action === 'reload-all'
                      ? Promise.allSettled(targets.map((id) => ctx.terminalSessionUi.reload(id)))
                      : action === 'reload'
                        ? ctx.terminalSessionUi.reload(id!)
                        : action === 'duplicate' || action === 'next-pane'
                          ? ctx.terminalSessionUi.duplicate(id!, action === 'next-pane')
                          : ctx.terminalViewUi.run(id!, action);
                void task.catch(() => {});
              },
            };
          },
        }),
      );
  // Copy/paste remain fixed xterm/editor input with the retained Windows copy/interruption arbitration.
  const mac = ctx.shortcuts.platform === 'macos';
  for (const [name, label, code] of [
    ['copy', 'shortcuts.action.copySelection', 'KeyC'],
    ['paste', 'shortcuts.action.paste', 'KeyV'],
  ] as const)
    ctx.effect(() =>
      ctx.shortcuts.registerFixed({
        id: ('terminal.' + name) as ShortcutCommandId,
        label: () => t(label),
        messageKey: label,
        keys: [mac ? '⌘' : 'Ctrl', code.slice(3)],
        group: 'input',
        bindings: mac
          ? [{ code, modifiers: ['meta'] }]
          : [
              { code, modifiers: ['control'] },
              { code, modifiers: ['control', 'shift'] },
            ],
      }),
    );
}
