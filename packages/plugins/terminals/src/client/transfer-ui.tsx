import type { TerminalSelectionContext } from '@axterm/ui/workspace';
import type { PropsRenderSlots } from '@axterm/ui';
import { Bot } from 'lucide-react';
import { useLayoutEffect, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import {
  Download,
  ListChecks,
  Upload,
  Copy,
  ClipboardPaste,
  Eraser,
  Search,
  AlignLeft,
} from 'lucide-react';
import type { Context } from '@deepseek-ai/cordis';
import type { PropsLocale } from '@axterm/ui';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuPortal,
  DropdownMenuTrigger,
} from '@axterm/ui/controls';
import type { TerminalsModel } from './index.ts';
import type { TerminalViewAction } from '@axterm/ui/workspace';
import type { TerminalTransferState } from '@axterm/plugin-api/terminals';
import { TerminalTransferUiOwner } from './transfer-owner.ts';
import { TerminalTransferRecoveryDialog } from './transfer-recovery-dialog.tsx';
import type { TerminalRecoveryModel } from './transfer-recovery.ts';
import { transferCx as cx, cssText } from './transfer-styles.ts';
type Text = PropsLocale<'terminals'>['t'];
export function installTerminalTransferUi(ctx: Context, model: TerminalsModel) {
  const owner = new TerminalTransferUiOwner(model, ctx.fileGrantActions);
  let menu: { id: string; x: number; y: number; selection: TerminalSelectionContext } | undefined;
  const listeners = new Set<() => void>();
  const subscribe = (fn: () => void) => {
    listeners.add(fn);
    return () => listeners.delete(fn);
  };
  const setMenu = (value: typeof menu) => {
    if (menu !== value) menu?.selection.dispose();
    menu = value;
    for (const fn of listeners) fn();
  };
  ctx.effect(() => {
    const style = document.createElement('style');
    style.dataset.axtermOwner = '@axterm/plugin-terminals/transfers';
    style.textContent = cssText;
    document.head.append(style);
    return () => style.remove();
  });
  ctx.effect(() => {
    const context = (event: MouseEvent) => {
      if (!(event.target instanceof Element)) return;
      const target = event.target.closest<HTMLElement>('[data-terminal-id]');
      const id = target?.dataset.terminalId;
      if (!id) return;
      if (ctx.workspaceUi.getSnapshot().activeTabId !== id) ctx.workspaceUi.selectTab(id);
      event.preventDefault();
      event.stopPropagation();
      const selection = ctx.terminalViewUi.captureContext(id);
      setMenu({ id, x: event.clientX, y: event.clientY, selection });
    };
    const blur = () => setMenu(undefined);
    document.addEventListener('contextmenu', context);
    window.addEventListener('blur', blur);
    return () => {
      document.removeEventListener('contextmenu', context);
      window.removeEventListener('blur', blur);
    };
  });
  ctx.slots.inject('workspace.overlay', function* () {
    yield ctx.slots.register(
      {
        name: 'workspace.overlay',
        id: 'terminals.transfers',
        locale: 'terminals',
        children: { 'terminal.context-menu': { kind: 'list', scope: 'root' } },
      },
      function Transfers({
        t,
        renderSlot,
      }: PropsLocale<'terminals'> & PropsRenderSlots<'terminal.context-menu'>) {
        const state = useSyncExternalStore(model.subscribe, model.getSnapshot),
          workspace = useSyncExternalStore(ctx.workspaceUi.subscribe, ctx.workspaceUi.getSnapshot),
          ui = useSyncExternalStore(owner.subscribe, owner.getSnapshot),
          context = useSyncExternalStore(subscribe, () => menu);
        const [host, setHost] = useState<HTMLElement | null>(null);
        const session =
          state.status === 'ready'
            ? state.baseline.sessions.find((value) => value.id === workspace.activeTabId)
            : undefined;
        const sessionId = session?.id;
        useLayoutEffect(() => {
          setHost(
            sessionId
              ? document.querySelector<HTMLElement>(`[data-terminal-id="${sessionId}"]`)
              : null,
          );
        }, [sessionId]);
        const run = (operation: Promise<unknown>) => {
          void operation.catch(() => {});
        };
        const closeMenu = () => setMenu(undefined),
          transfer = session?.transfer;
        return (
          <>
            {host &&
              transfer &&
              createPortal(
                <TransferIndicator
                  transfer={transfer}
                  t={t}
                  busy={ui.busy.includes(session!.id)}
                  cancel={() => run(owner.cancel(session!.id))}
                />,
                host,
              )}
            {context && (
              <DropdownMenu
                open
                modal={false}
                onOpenChange={(open) => {
                  if (!open) closeMenu();
                }}
              >
                <DropdownMenuTrigger asChild>
                  <button
                    aria-hidden
                    tabIndex={-1}
                    style={{
                      position: 'fixed',
                      left: context.x,
                      top: context.y,
                      width: 0,
                      height: 0,
                      padding: 0,
                      border: 0,
                      pointerEvents: 'none',
                    }}
                  />
                </DropdownMenuTrigger>
                <DropdownMenuPortal>
                  <DropdownMenuContent
                    asChild
                    align="start"
                    sideOffset={0}
                    collisionPadding={6}
                    onCloseAutoFocus={(event) => {
                      event.preventDefault();
                      (
                        host?.querySelector<HTMLElement>('.terminal-normal-buffer footer button') ??
                        host?.querySelector<HTMLElement>('.xterm-helper-textarea')
                      )?.focus();
                    }}
                  >
                    <div className={cx('terminal-context-menu')} aria-label={t('terminal.menu')}>
                      {(
                        [
                          ['copy', 'interaction.copy', Copy, true],
                          ['paste', 'interaction.paste', ClipboardPaste, false],
                          ['paste-selection', 'interaction.pasteSelected', ClipboardPaste, true],
                          ['explain', 'terminal.explainWithAi', Bot, true],
                          ['select-all', 'interaction.selectAll', ListChecks, false],
                          ['clear', 'interaction.clear', Eraser, false],
                          ['search', 'interaction.search', Search, false],
                          ['normal-buffer', 'terminal.normalBuffer', AlignLeft, false],
                        ] as const
                      ).map(([action, label, Icon, selection]) => (
                        <DropdownMenuItem
                          asChild
                          key={action}
                          disabled={selection && !context.selection.hasSelection}
                          onSelect={() => {
                            const task = context.selection.run(action satisfies TerminalViewAction);
                            closeMenu();
                            run(task);
                          }}
                        >
                          <button>
                            <Icon size={14} />
                            {t(label)}
                          </button>
                        </DropdownMenuItem>
                      ))}
                      {renderSlot('terminal.context-menu', { tabId: context.id })}
                      {(['upload', 'download'] as const).map((direction) => (
                        <DropdownMenuItem
                          asChild
                          key={direction}
                          disabled={
                            ui.busy.includes(context.id) ||
                            (!!transfer &&
                              ['waiting-selection', 'waiting-peer', 'transferring'].includes(
                                transfer.state,
                              ))
                          }
                          onPointerUp={(event) => {
                            if (event.button !== 0) event.preventDefault();
                          }}
                          onSelect={() => {
                            closeMenu();
                            run(owner.start(context.id, direction));
                          }}
                        >
                          <button type="button">
                            {direction === 'upload' ? <Upload size={14} /> : <Download size={14} />}
                            <span>
                              {t(
                                direction === 'upload'
                                  ? 'terminal.xmodemSend'
                                  : 'terminal.xmodemReceive',
                              )}
                            </span>
                          </button>
                        </DropdownMenuItem>
                      ))}
                      <DropdownMenuItem
                        asChild
                        onPointerUp={(event) => {
                          if (event.button !== 0) event.preventDefault();
                        }}
                        onSelect={() => {
                          closeMenu();
                          run(owner.reviewRecovery());
                        }}
                      >
                        <button type="button">
                          <ListChecks size={14} />
                          <span>{t('terminal.recoveryMenu')}</span>
                        </button>
                      </DropdownMenuItem>
                    </div>
                  </DropdownMenuContent>
                </DropdownMenuPortal>
              </DropdownMenu>
            )}
            {ui.recovery && (
              <Recovery
                model={ui.recovery}
                error={ui.error}
                t={t}
                close={() => run(owner.closeRecovery())}
              />
            )}
            {(ui.error || ui.uncertain.length > 0) && (
              <div className={cx('transfer-ui-error')} role="alert">
                {t('terminal.startTransferError')}
                {ui.uncertain.map((id) => (
                  <button key={id} onClick={() => run(owner.retry(id))}>
                    {t('app.retry')}
                  </button>
                ))}
                <button onClick={() => owner.dismiss()}>{t('common.close')}</button>
              </div>
            )}
          </>
        );
      },
    );
  });
  ctx.effect(() => async () => {
    setMenu(undefined);
    await owner.close();
    listeners.clear();
  });
}
function TransferIndicator({
  transfer,
  t,
  busy,
  cancel,
}: {
  transfer: TerminalTransferState;
  t: Text;
  busy: boolean;
  cancel(): void;
}) {
  const key = (
    {
      'waiting-selection': 'terminal.waitingFileSelection',
      'waiting-peer': 'terminal.waitingPeer',
      transferring: 'terminal.transferring',
      completed: 'terminal.transferCompleted',
      failed: 'terminal.transferFailed',
      canceled: 'terminal.transferCanceled',
    } as const
  )[transfer.state];
  return (
    <div className={cx(`terminal-transfer-indicator ${transfer.state}`)} role="status">
      <div>
        <strong>{transfer.protocol.toUpperCase()}</strong>
        <span>
          {transfer.state === 'transferring' && transfer.fileName
            ? transfer.fileName
            : t(key, {
                detail: transfer.errorCode
                  ? ` · ${transfer.errorCode === 'TRANSFER_DESTINATION_UNSUPPORTED' ? t('terminal.destinationFilesystemUnsupported') : transfer.errorCode}`
                  : '',
              })}
        </span>
      </div>
      {transfer.state === 'transferring' && (
        <progress
          max={Math.max(1, transfer.totalBytes ?? 1)}
          value={Math.min(transfer.transferredBytes ?? 0, Math.max(1, transfer.totalBytes ?? 1))}
        />
      )}{' '}
      {['waiting-selection', 'waiting-peer', 'transferring'].includes(transfer.state) && (
        <button disabled={busy} onClick={cancel}>
          {t('common.cancel')}
        </button>
      )}
    </div>
  );
}
function Recovery({
  model,
  t,
  close,
  error,
}: {
  model: TerminalRecoveryModel;
  t: Text;
  close(): void;
  error: boolean;
}) {
  const state = useSyncExternalStore(model.subscribe, model.getSnapshot);
  const retry =
    state.status === 'error' || (state.status === 'ready' && state.uncertain)
      ? () => {
          void model.retry().catch(() => {});
        }
      : undefined;
  return (
    <TerminalTransferRecoveryDialog
      x={t}
      records={state.status === 'ready' ? state.records : []}
      busy={state.status === 'connecting' || (state.status === 'ready' && state.busy)}
      error={
        error || state.status === 'error' || (state.status === 'ready' && state.error)
          ? t('terminal.recoveryActionFailed')
          : undefined
      }
      retry={retry}
      onRemove={(id) => {
        void model.change(id, 'remove').catch(() => {});
      }}
      onForget={(id) => {
        void model.change(id, 'forget').catch(() => {});
      }}
      onClose={close}
    />
  );
}
