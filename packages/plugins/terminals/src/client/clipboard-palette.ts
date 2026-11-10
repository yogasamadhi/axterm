import type { Context } from '@deepseek-ai/cordis';
import type { TerminalsModel } from './index.ts';
/** Read-only keyboard reservations keep their original palette entry, owned by the terminal view. */
export function installClipboardPalette(
  ctx: Context,
  model: Pick<TerminalsModel, 'getSnapshot'>,
): void {
  ctx.inject(['workspacePaletteUi'], (scope) => {
    scope.effect(() =>
      scope.workspacePaletteUi.registerSource('terminal-input', () => {
        const workspace = ctx.workspaceUi.getSnapshot(),
          id = workspace.activeTabId;
        const tab = id ? workspace.tabs.find((tab) => tab.id === id) : undefined;
        const facts = model.getSnapshot(),
          generation = facts.status === 'ready' ? facts.baseline.generation : undefined;
        return ctx.shortcuts.fixedCatalog
          .getSnapshot()
          .filter((row) => row.id === 'terminal.copy' || row.id === 'terminal.paste')
          .map((row) => {
            const action = row.id === 'terminal.copy' ? 'copy' : 'paste';
            const text = ctx.locale.bind('palette');
            const available =
              !!id &&
              tab?.kind === 'terminal' &&
              (action === 'copy'
                ? ctx.terminalViewUi.selectionAvailable(id)
                : facts.status === 'ready' &&
                  facts.baseline.sessions.some(
                    (session) => session.id === id && session.state === 'ready',
                  ));
            return {
              id: action,
              label: row.label,
              aliases: row.aliases ?? [],
              group: 'terminal' as const,
              shortcuts: row.keys.length ? [row.keys.join('+')] : [],
              unavailableReason: available
                ? undefined
                : text(action === 'copy' ? 'palette.requiresSelection' : 'palette.requiresSession'),
              execute: async () => {
                if (!available || !id) throw Error('TERMINAL_INPUT_UNAVAILABLE');
                if (action === 'paste') {
                  const current = model.getSnapshot();
                  if (current.status !== 'ready' || current.baseline.generation !== generation)
                    throw Error('TERMINAL_INPUT_RETIRED');
                }
                await ctx.terminalViewUi.run(id, action);
              },
            };
          });
      }),
    );
  });
}
