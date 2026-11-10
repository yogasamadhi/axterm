import { useState } from 'react';
import { Dialog, DialogContent, DialogTitle } from '@axterm/ui/controls';
import { useTransferActions } from './use-transfer-actions';
import type { Transfer } from '@axterm/plugin-api/transfers';
import {
  ArrowDownToLine,
  ArrowUpFromLine,
  CheckCircle2,
  Pause,
  Play,
  RotateCcw,
  Server,
  Square,
  X,
} from 'lucide-react';
import { useI18n } from './i18n.tsx';
import { cx } from './styles.ts';
import type { TransfersMessageKey } from './locales.ts';
import { TRANSFER_PAGE_SIZE, visibleTransferCount } from './paging.ts';

export function TransferCenter({
  transfers,
  loadError,
  onClose,
  onRetryLoad,
  onCancel,
  onRetry,
  onPause,
  onResume,
  onClear,
  onOpenFiles,
  uncertain,
  pendingRows,
}: {
  transfers: readonly Transfer[];
  loadError: boolean;
  onClose(): void;
  onRetryLoad(): Promise<unknown>;
  onCancel(id: string): Promise<unknown>;
  onRetry(id: string): Promise<unknown>;
  onPause(id: string): Promise<unknown>;
  onResume(id: string): Promise<unknown>;
  onClear(): Promise<unknown>;
  onOpenFiles(): Promise<unknown>;
  uncertain: boolean;
  pendingRows: ReadonlySet<string>;
}) {
  const { x } = useI18n();
  const actions = useTransferActions();
  const pending = (id: string) => actions.pending.has(id) || pendingRows.has(id);
  // The Runtime keeps up to 500 transfer rows. Rendering all of them on every
  // update would rebuild an unbounded list, so the panel shows a bounded page
  // and grows it only when the user asks for more.
  const [expandedRows, setExpandedRows] = useState(0);
  const visibleCount = visibleTransferCount(transfers.length, expandedRows);
  const visibleTransfers = transfers.slice(0, visibleCount);
  const active = transfers.filter((transfer) =>
    ['queued', 'preparing', 'running', 'paused', 'awaiting-decision'].includes(transfer.state),
  );
  const activeBytes = active.reduce((sum, transfer) => sum + transfer.bytesTransferred, 0);
  const activeTotal = active.reduce((sum, transfer) => sum + (transfer.totalBytes ?? 0), 0);
  const overallProgress = activeTotal ? Math.round((activeBytes / activeTotal) * 100) : 0;
  const completed =
    !loadError &&
    transfers.some((transfer) => ['succeeded', 'failed', 'canceled'].includes(transfer.state));
  return (
    <Dialog
      open
      modal={false}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent
        asChild
        onInteractOutside={(event) => {
          const target = event.detail.originalEvent.target;
          if (target instanceof Element && target.closest('[data-transfers-trigger]'))
            event.preventDefault();
        }}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          document.querySelector<HTMLElement>('[data-transfers-trigger]')?.focus();
        }}
      >
        <section className={cx('transfer-center')} aria-label={x('app.transferCenter')}>
          <header role="presentation">
            <div>
              <DialogTitle asChild>
                <strong>{x('app.transferCenter')}</strong>
              </DialogTitle>
              <small>
                {loadError
                  ? x('app.transferLoadFailed')
                  : transfers.length
                    ? x('app.transferTaskSummary', {
                        count: transfers.length,
                        active: active.length
                          ? ` · ${active.length} ${x('app.running')} · ${overallProgress}%`
                          : '',
                      })
                    : x('app.noTasks')}
              </small>
            </div>
            <button onClick={onClose} aria-label={x('app.closeTransferCenter')}>
              <X size={14} />
            </button>
          </header>
          <div className={cx('transfer-center-list')}>
            {(actions.failed || uncertain) && (
              <div className={cx('transfer-center-error')} role="alert">
                <span>{x('app.transferActionFailed')}</span>
                <button type="button" onClick={() => actions.run('reload', onRetryLoad)}>
                  {x('app.retry')}
                </button>
              </div>
            )}
            {loadError && (
              <div className={cx('transfer-center-error')} role="alert">
                <span>{x('app.transferLoadFailed')}</span>
                <button type="button" onClick={() => actions.run('reload', onRetryLoad)}>
                  {x('app.retry')}
                </button>
              </div>
            )}
            {!loadError &&
              visibleTransfers.map((transfer) => {
                const running = ['queued', 'preparing', 'running', 'awaiting-decision'].includes(
                  transfer.state,
                );
                const progress = transfer.totalBytes
                  ? Math.min(
                      100,
                      Math.round((transfer.bytesTransferred / transfer.totalBytes) * 100),
                    )
                  : 0;
                return (
                  <article key={transfer.id} aria-busy={pending(transfer.id)}>
                    <span className={cx(`transfer-icon ${transfer.direction}`)}>
                      {transfer.direction === 'upload' ? (
                        <ArrowUpFromLine size={14} />
                      ) : transfer.direction === 'download' ? (
                        <ArrowDownToLine size={14} />
                      ) : (
                        <Server size={14} />
                      )}
                    </span>
                    <div>
                      <strong>
                        {transfer.direction === 'upload'
                          ? x('app.upload')
                          : transfer.direction === 'download'
                            ? x('app.download')
                            : x('app.remoteCopy')}{' '}
                        · {transfer.id.slice(0, 8)}
                      </strong>
                      <span>
                        <i style={{ width: `${progress}%` }} />
                      </span>
                      <small>
                        {x(transferStateKey(transfer.state))} ·{' '}
                        {formatBytes(transfer.bytesTransferred)}
                        {transfer.totalBytes ? ` / ${formatBytes(transfer.totalBytes)}` : ''}
                        {transfer.bytesPerSecond
                          ? ` · ${formatBytes(transfer.bytesPerSecond)}/s`
                          : ''}
                      </small>
                      {transfer.state === 'failed' &&
                        transfer.errorCode === 'TRANSFER_ATOMIC_REPLACE_UNAVAILABLE' && (
                          <small className={cx('transfer-recovery-note')}>
                            {x('app.transferAtomicUnavailable')}
                          </small>
                        )}
                      {['failed', 'canceled'].includes(transfer.state) &&
                        transfer.retryAvailability !== 'available' && (
                          <small className={cx('transfer-recovery-note')}>
                            {x(
                              transfer.retryAvailability === 'connection-unavailable'
                                ? 'app.transferReconnectRequired'
                                : 'app.transferReselectRequired',
                            )}
                          </small>
                        )}
                      {(transfer.source || transfer.destination) && (
                        <small title={`${transfer.source ?? ''} → ${transfer.destination ?? ''}`}>
                          {transfer.source ?? x('app.unknownSource')} →{' '}
                          {transfer.destination ?? x('app.unknownDestination')}
                        </small>
                      )}
                      {transfer.state === 'failed' &&
                        transfer.errorCode !== 'TRANSFER_ATOMIC_REPLACE_UNAVAILABLE' && (
                          <small className={cx('transfer-recovery-note')}>
                            {x('app.transferActionFailed')}
                          </small>
                        )}
                    </div>
                    <span className={cx('transfer-actions')}>
                      {transfer.state === 'running' ? (
                        <>
                          <button
                            disabled={pending(transfer.id)}
                            onClick={() => actions.run(transfer.id, () => onPause(transfer.id))}
                            aria-label={x('app.pause')}
                            title={x('app.pause')}
                          >
                            <Pause size={12} />
                          </button>
                          <button
                            disabled={pending(transfer.id)}
                            onClick={() => actions.run(transfer.id, () => onCancel(transfer.id))}
                            aria-label={x('app.cancel')}
                            title={x('app.cancel')}
                          >
                            <Square size={11} />
                          </button>
                        </>
                      ) : transfer.state === 'paused' ? (
                        <>
                          <button
                            disabled={pending(transfer.id)}
                            onClick={() => actions.run(transfer.id, () => onResume(transfer.id))}
                            aria-label={x('app.resume')}
                            title={x('app.resume')}
                          >
                            <Play size={12} />
                          </button>
                          <button
                            disabled={pending(transfer.id)}
                            onClick={() => actions.run(transfer.id, () => onCancel(transfer.id))}
                            aria-label={x('app.cancel')}
                            title={x('app.cancel')}
                          >
                            <Square size={11} />
                          </button>
                        </>
                      ) : running ? (
                        <button
                          disabled={pending(transfer.id)}
                          onClick={() => actions.run(transfer.id, () => onCancel(transfer.id))}
                          aria-label={x('app.cancel')}
                          title={x('app.cancel')}
                        >
                          <Square size={11} />
                        </button>
                      ) : ['failed', 'canceled'].includes(transfer.state) &&
                        transfer.retryAvailability === 'available' ? (
                        <button
                          disabled={pending(transfer.id)}
                          onClick={() => actions.run(transfer.id, () => onRetry(transfer.id))}
                          aria-label={x('app.retry')}
                          title={x('app.retry')}
                        >
                          <RotateCcw size={12} />
                        </button>
                      ) : ['failed', 'canceled'].includes(transfer.state) ? (
                        <button
                          onClick={() => actions.run('files', onOpenFiles)}
                          aria-label={x('app.transferReselect')}
                          title={x('app.transferReselect')}
                        >
                          <ArrowDownToLine size={12} />
                        </button>
                      ) : (
                        <CheckCircle2 size={15} className={cx('transfer-complete')} />
                      )}
                    </span>
                  </article>
                );
              })}
            {!loadError && transfers.length > visibleTransfers.length && (
              <button
                type="button"
                className={cx('transfer-center-more')}
                onClick={() => setExpandedRows((rows) => rows + TRANSFER_PAGE_SIZE)}
              >
                {x('app.transferShowMore', { count: transfers.length - visibleTransfers.length })}
              </button>
            )}
            {!loadError && !transfers.length && (
              <div className={cx('transfer-center-empty')}>
                <ArrowDownToLine size={22} />
                <span>{x('app.transferEmpty')}</span>
              </div>
            )}
          </div>
          <footer role="presentation">
            <button onClick={() => actions.run('files', onOpenFiles)}>
              {x('app.openFileWorkspace')}
            </button>
            <button
              onClick={() => actions.run('clear', onClear)}
              disabled={!completed || pending('clear')}
            >
              {x('app.clearCompleted')}
            </button>
          </footer>
        </section>
      </DialogContent>
    </Dialog>
  );
}

function transferStateKey(state: Transfer['state']): TransfersMessageKey {
  return (
    {
      queued: 'app.transferQueued',
      preparing: 'app.transferPreparing',
      running: 'app.transferRunning',
      paused: 'app.transferPaused',
      'awaiting-decision': 'app.transferAwaitingDecision',
      succeeded: 'app.transferSucceeded',
      failed: 'app.transferFailed',
      canceled: 'app.transferCanceled',
    } as const
  )[state];
}

function formatBytes(value: number) {
  if (value < 1024) return `${value} B`;
  if (value < 1024 ** 2) return `${(value / 1024).toFixed(1)} KiB`;
  return `${(value / 1024 ** 2).toFixed(1)} MiB`;
}
