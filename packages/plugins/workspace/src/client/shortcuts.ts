import type { Context } from '@deepseek-ai/cordis';
import type { WorkspaceUi } from '@axterm/ui/workspace';
import type {} from '@axterm/ui/shortcuts';
import { createShortcutDefaults, type ShortcutCommandId } from '@axterm/plugin-api/shortcuts';
/** Workspace owns only captured tab/pane presentation actions, never domain orchestration. */
export function installWorkspaceShortcuts(ctx: Context, workspace: WorkspaceUi): void {
  const t = ctx.locale.bind('shortcuts');
  for (const [id, label, code, modifiers] of [
    ['app.closeCurrentTab', 'shortcuts.action.closeCurrentTab', 'KeyW', ['alt']],
    ['app.prevTab', 'shortcuts.action.previousTab', 'Tab', ['control', 'shift']],
    ['app.nextTab', 'shortcuts.action.nextTab', 'Tab', ['control']],
  ] as const)
    for (const alternate of [false, true])
      ctx.effect(() =>
        ctx.shortcuts.register({
          id: (id + (alternate ? '.alternate' : '')) as ShortcutCommandId,
          label: () => t(label),
          messageKey: label,
          aliases: [],
          defaults: alternate ? {} : createShortcutDefaults({ code, modifiers }),
          regions: ['page', 'editable', 'terminal'],
          modals: [],
          resolve: () => {
            const state = workspace.getSnapshot(),
              id = state.activeTabId;
            if (
              state.navigation.find((item) => item.id === state.section)?.view === 'section' &&
              code === 'KeyW'
            )
              return { status: 'handled', run: () => workspace.selectSection('hosts') };
            if (!id || !state.tabs.length) return { status: 'blocked', reason: 'no-tab' };
            if (code === 'KeyW')
              return {
                status: 'handled',
                run: () => {
                  void workspace.closeTab(id).catch(() => {});
                },
              };
            const at = state.tabs.findIndex((tab) => tab.id === id),
              next =
                state.tabs[
                  (at +
                    (modifiers.some((value) => value === 'shift') ? -1 : 1) +
                    state.tabs.length) %
                    state.tabs.length
                ]!;
            return { status: 'handled', run: () => workspace.selectTab(next.id) };
          },
        }),
      );
}
