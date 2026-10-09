import { useTransferActions } from './use-transfer-actions';
import type { Transfer } from '@workspace/contracts';
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
import { useI18n } from '../../i18n/context';
import type { AxtermMessageKey } from '../../i18n/core';

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
  onChanged,
  onOpenFiles,
}: {
  transfers: Transfer[];
  loadError: boolean;
  onClose(): void;
  onRetryLoad(): void;
  onCancel(id: string): Promise<unknown>;
  onRetry(id: string): Promise<unknown>;
  onPause(id: string): Promise<unknown>;
  onResume(id: string): Promise<unknown>;
  onClear(): Promise<unknown>;
  onChanged(): Promise<unknown>;
  onOpenFiles(): void;
}) {
  const { x } = useI18n();
  const actions = useTransferActions(onChanged);
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
    <aside className="transfer-center" aria-label={x('app.transferCenter')}>
      <header>
        <div>
          <strong>{x('app.transferCenter')}</strong>
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
      <div className="transfer-center-list">
        {actions.failed && (
          <div className="transfer-center-error" role="alert">
            <span>{x('app.transferActionFailed')}</span>
            <button type="button" onClick={onRetryLoad}>
              {x('app.retry')}
            </button>
          </div>
        )}
        {loadError && (
          <div className="transfer-center-error" role="alert">
            <span>{x('app.transferLoadFailed')}</span>
            <button type="button" onClick={onRetryLoad}>
              {x('app.retry')}
            </button>
          </div>
        )}
        {!loadError &&
          transfers.slice(0, 20).map((transfer) => {
            const running = ['queued', 'preparing', 'running', 'awaiting-decision'].includes(
              transfer.state,
            );
            const progress = transfer.totalBytes
              ? Math.min(100, Math.round((transfer.bytesTransferred / transfer.totalBytes) * 100))
              : 0;
            return (
              <article key={transfer.id} aria-busy={actions.pending.has(transfer.id)}>
                <span className={`transfer-icon ${transfer.direction}`}>
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
                    {x(transferStateKey(transfer.state))} · {formatBytes(transfer.bytesTransferred)}
                    {transfer.totalBytes ? ` / ${formatBytes(transfer.totalBytes)}` : ''}
                    {transfer.bytesPerSecond ? ` · ${formatBytes(transfer.bytesPerSecond)}/s` : ''}
                  </small>
                  {transfer.state === 'failed' &&
                    transfer.errorCode === 'TRANSFER_ATOMIC_REPLACE_UNAVAILABLE' && (
                      <small className="transfer-recovery-note">
                        {x('app.transferAtomicUnavailable')}
                      </small>
                    )}
                  {['failed', 'canceled'].includes(transfer.state) &&
                    transfer.retryAvailability !== 'available' && (
                      <small className="transfer-recovery-note">
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
                      <small className="transfer-recovery-note">
                        {x('app.transferActionFailed')}
                      </small>
                    )}
                </div>
                {transfer.state === 'running' ? (
                  <>
                    <button
                      disabled={actions.pending.has(transfer.id)}
                      onClick={() => actions.run(transfer.id, () => onPause(transfer.id))}
                      title={x('app.pause')}
                    >
                      <Pause size={12} />
                    </button>
                    <button
                      disabled={actions.pending.has(transfer.id)}
                      onClick={() => actions.run(transfer.id, () => onCancel(transfer.id))}
                      title={x('app.cancel')}
                    >
                      <Square size={11} />
                    </button>
                  </>
                ) : transfer.state === 'paused' ? (
                  <>
                    <button
                      disabled={actions.pending.has(transfer.id)}
                      onClick={() => actions.run(transfer.id, () => onResume(transfer.id))}
                      title={x('app.resume')}
                    >
                      <Play size={12} />
                    </button>
                    <button
                      disabled={actions.pending.has(transfer.id)}
                      onClick={() => actions.run(transfer.id, () => onCancel(transfer.id))}
                      title={x('app.cancel')}
                    >
                      <Square size={11} />
                    </button>
                  </>
                ) : running ? (
                  <button
                    disabled={actions.pending.has(transfer.id)}
                    onClick={() => actions.run(transfer.id, () => onCancel(transfer.id))}
                    title={x('app.cancel')}
                  >
                    <Square size={11} />
                  </button>
                ) : ['failed', 'canceled'].includes(transfer.state) &&
                  transfer.retryAvailability === 'available' ? (
                  <button
                    disabled={actions.pending.has(transfer.id)}
                    onClick={() => actions.run(transfer.id, () => onRetry(transfer.id))}
                    title={x('app.retry')}
                  >
                    <RotateCcw size={12} />
                  </button>
                ) : ['failed', 'canceled'].includes(transfer.state) ? (
                  <button onClick={onOpenFiles} title={x('app.transferReselect')}>
                    <ArrowDownToLine size={12} />
                  </button>
                ) : (
                  <CheckCircle2 size={15} className="transfer-complete" />
                )}
              </article>
            );
          })}
        {!loadError && !transfers.length && (
          <div className="transfer-center-empty">
            <ArrowDownToLine size={22} />
            <span>{x('app.transferEmpty')}</span>
          </div>
        )}
      </div>
      <footer>
        <button onClick={onOpenFiles}>{x('app.openFileWorkspace')}</button>
        <button
          onClick={() => actions.run('clear', onClear)}
          disabled={!completed || actions.pending.has('clear')}
        >
          {x('app.clearCompleted')}
        </button>
      </footer>
    </aside>
  );
}

function transferStateKey(state: Transfer['state']): AxtermMessageKey {
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
