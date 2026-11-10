import { useSyncExternalStore } from 'react';
import { ArrowDownToLine } from 'lucide-react';
import type { Context } from '@deepseek-ai/cordis';
import type { PropsLocale } from '@axterm/ui';
import type {} from '@axterm/ui/workspace';
import type {} from '@axterm/ui/presentation';
import { TransferCenter } from './center.tsx';
import { TransferUiCommands } from './commands.ts';
import { TransfersI18n } from './i18n.tsx';
import { dictionaries } from './locales.ts';
import { cx, cssText } from './styles.ts';
import type { TransfersModel } from '../index.ts';
export function installTransferUi(ctx: Context, model: TransfersModel) {
  const commands = new TransferUiCommands(ctx.transferActions);
  const listeners = new Set<() => void>();
  let open = false,
    closing = false;
  const subscribe = (fn: () => void) => {
    listeners.add(fn);
    return () => listeners.delete(fn);
  };
  const setOpen = (next: boolean) => {
    if (closing) return;
    open = next;
    for (const fn of listeners) fn();
  };
  ctx.effect(() => ctx.locale.register('transfers', dictionaries));
  ctx.effect(() => {
    const style = document.createElement('style');
    style.dataset.axtermOwner = '@axterm/plugin-transfers';
    style.textContent = cssText;
    document.head.append(style);
    return () => style.remove();
  });
  ctx.effect(() => ctx.workspaceUi.registerAction('transfers.toggle', () => setOpen(!open)));
  ctx.inject(['workspacePaletteUi'], (owner) => {
    owner.effect(() =>
      owner.workspacePaletteUi.registerSource('transfers', () => [
        {
          id: 'center',
          label: ctx.locale.bind('transfers')('app.transferCenter'),
          aliases: [],
          group: 'sections',
          shortcuts: [],
          execute: () => {
            if (closing) throw Error('TRANSFER_UI_CLOSED');
            setOpen(true);
          },
        },
      ]),
    );
  });
  ctx.slots.inject('workspace.status', function* () {
    yield ctx.slots.register(
      { name: 'workspace.status', id: 'transfers', locale: 'transfers', order: 50 },
      function Status({ t }: PropsLocale<'transfers'>) {
        const state = useSyncExternalStore(model.subscribe, model.getSnapshot);
        const expanded = useSyncExternalStore(subscribe, () => open);
        const items = state.status === 'ready' ? state.baseline.items : [];
        const active = items.filter((item) =>
          ['queued', 'preparing', 'running', 'paused', 'awaiting-decision'].includes(item.state),
        );
        return (
          <button
            data-transfers-trigger
            className={cx(active.length ? 'status-transfer active' : 'status-transfer')}
            aria-expanded={expanded}
            onClick={() => setOpen(!open)}
          >
            <ArrowDownToLine size={12} />
            {t('app.transfers')}{' '}
            {active.length ? t('app.transfersRunning', { count: active.length }) : items.length}
          </button>
        );
      },
    );
  });
  ctx.slots.inject('workspace.overlay', function* () {
    yield ctx.slots.register(
      { name: 'workspace.overlay', id: 'transfers', locale: 'transfers' },
      function Overlay({ t }: PropsLocale<'transfers'>) {
        const state = useSyncExternalStore(model.subscribe, model.getSnapshot);
        const visible = useSyncExternalStore(subscribe, () => open);
        const jobs = useSyncExternalStore(commands.subscribe, commands.getSnapshot);
        if (!visible) return null;
        const retry = async () => {
          for (const job of jobs) if (job.state === 'uncertain') await commands.retry(job.row);
          await model.retry();
        };
        return (
          <TransfersI18n x={t}>
            <TransferCenter
              transfers={state.status === 'ready' ? state.baseline.items : []}
              loadError={state.status === 'error'}
              onClose={() => setOpen(false)}
              onRetryLoad={retry}
              onCancel={(id) => commands.run(id, (key) => model.cancel(key, id))}
              onPause={(id) => commands.run(id, (key) => model.pause(key, id))}
              onResume={(id) => commands.run(id, (key) => model.resume(key, id))}
              onRetry={(id) => commands.run(id, (key) => model.retryTransfer(key, id))}
              onClear={() => commands.run('clear', (key) => model.clearCompleted(key))}
              uncertain={jobs.some((job) => job.state === 'uncertain')}
              pendingRows={new Set(jobs.map((job) => job.row))}
              onOpenFiles={async () => {
                await ctx.filesWorkspaceUi.open();
                setOpen(false);
              }}
            />
          </TransfersI18n>
        );
      },
    );
  });
  ctx.effect(() => async () => {
    closing = true;
    listeners.clear();
    await commands.close();
  });
}
