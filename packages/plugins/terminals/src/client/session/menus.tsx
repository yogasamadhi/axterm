import { useSyncExternalStore } from 'react';
import type { Context } from '@deepseek-ai/cordis';
import type { PropsLocale } from '@axterm/ui';
import { Button, DropdownMenuItem } from '@axterm/ui/controls';
import type { TerminalsModel } from '../index.ts';
import type { TerminalSessionActions } from './actions.ts';
/** Domain-owned tab controls arrive through the selected Slot, never Workspace business imports. */
export function installSessionMenus(
  ctx: Context,
  model: TerminalsModel,
  actions: TerminalSessionActions,
): void {
  ctx.slots.inject('workspace.tab-menu', function* () {
    yield ctx.slots.register(
      { name: 'workspace.tab-menu', id: 'terminals.session-menu', locale: 'terminals', order: 10 },
      function SessionMenu({ tabId, t }: { tabId: string } & PropsLocale<'terminals'>) {
        const state = useSyncExternalStore(model.subscribe, model.getSnapshot),
          command = useSyncExternalStore(actions.subscribe, actions.getSnapshot);
        const session =
          state.status === 'ready'
            ? state.baseline.sessions.find((session) => session.id === tabId)
            : undefined;
        if (!session) return null;
        const busy = command.busy.includes(tabId);
        const uncertain = command.uncertain.includes(tabId);
        return (
          <>
            <DropdownMenuItem
              data-session-action="new"
              onSelect={() => {
                void actions.newTab(tabId).catch(() => {});
              }}
            >
              {t('app.newTab')}
            </DropdownMenuItem>
            <DropdownMenuItem
              data-session-action="duplicate"
              disabled={busy || uncertain}
              onSelect={() => {
                void actions.duplicate(tabId).catch(() => {});
              }}
            >
              {t('app.duplicateTab')}
            </DropdownMenuItem>
            <DropdownMenuItem
              data-session-action="clone-pane"
              disabled={busy || uncertain}
              onSelect={() => {
                void actions.duplicate(tabId, true).catch(() => {});
              }}
            >
              {t('app.cloneToNextPane')}
            </DropdownMenuItem>
            <DropdownMenuItem
              data-session-action="reload"
              disabled={busy || uncertain}
              onSelect={() => {
                void actions.reload(tabId).catch(() => {});
              }}
            >
              {t('app.reconnectSession')}
            </DropdownMenuItem>
            <DropdownMenuItem
              data-session-action="reload-all"
              disabled={command.busy.length > 0 || command.uncertain.length > 0}
              onSelect={() => {
                void actions.reloadAll().catch(() => {});
              }}
            >
              {t('app.reconnectAllSessions')}
            </DropdownMenuItem>
            <DropdownMenuItem
              data-session-action="disconnect"
              disabled={busy || (session.state === 'closed' && !uncertain)}
              onSelect={() => {
                void actions.disconnect(tabId).catch(() => {});
              }}
            >
              {t(uncertain ? 'common.retry' : 'fileManager.disconnect')}
            </DropdownMenuItem>
          </>
        );
      },
    );
  });
  ctx.slots.inject('workspace.status', function* () {
    yield ctx.slots.register(
      { name: 'workspace.status', id: 'terminals.session-status', locale: 'terminals', order: 85 },
      function SessionStatus({ t }: PropsLocale<'terminals'>) {
        const state = useSyncExternalStore(actions.subscribe, actions.getSnapshot);
        return state.failed ? (
          <span role="alert">
            {t('app.reconnectSessionError')}{' '}
            <Button variant="ghost" onClick={actions.dismiss}>
              {t('dismiss')}
            </Button>
          </span>
        ) : null;
      },
    );
  });
}
