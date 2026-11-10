import { useState, useSyncExternalStore } from 'react';
import { ExternalLink, RefreshCw, Upload, X } from 'lucide-react';
import { Dialog, DialogContent, DialogTitle } from '@axterm/ui/controls';
import { useI18n } from './i18n.tsx';
import { cx } from './styles.ts';
import type { FilesSessionOwner } from './session-owner.ts';
export function ExternalEditorDialog({
  owner,
  id,
  onUploaded,
  onClose,
}: {
  owner: FilesSessionOwner;
  id: string;
  onUploaded(): void;
  onClose(): void;
}) {
  const { x, language } = useI18n();
  const model = owner.editors;
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const state = useSyncExternalStore(model.subscribe, model.getSnapshot),
    session =
      state.status === 'ready'
        ? state.baseline.sessions.find((session) => session.id === id)
        : undefined;
  async function push() {
    if (busy || !session) return;
    setBusy(true);
    try {
      await owner.commands.file((key, signal) => owner.files.pushExternalEditor(key, id, signal));
      onUploaded();
      setError('');
    } catch {
      setError(x('externalEditor.uploadError'));
    } finally {
      setBusy(false);
    }
  }
  async function close() {
    if (busy) return;
    setBusy(true);
    try {
      await owner.commands.file((key, signal) => owner.files.closeExternalEditor(key, id, signal));
      owner.externalSessions.delete(id);
      onClose();
    } catch {
      setError(x('externalEditor.cleanupError'));
      setBusy(false);
    }
  }
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) void close();
      }}
    >
      <DialogContent asChild overlayClassName={cx('modal-backdrop')}>
        <section className={cx('modal external-editor-dialog')}>
          <header>
            <div>
              <DialogTitle asChild>
                <strong>{x('externalEditor.title')}</strong>
              </DialogTitle>
              <small>{session?.fileName ?? ''}</small>
            </div>
            <button
              type="button"
              aria-label={x('externalEditor.closeSession')}
              disabled={busy}
              onClick={() => void close()}
            >
              <X size={15} />
            </button>
          </header>
          <div className={cx('external-editor-state ' + (session?.state ?? 'error'))}>
            <ExternalLink size={19} />
            <div>
              <strong>
                {session
                  ? x(
                      (
                        {
                          watching: 'externalEditor.waitingForSave',
                          changed: 'externalEditor.changed',
                          saved: 'externalEditor.saved',
                          conflict: 'externalEditor.conflict',
                          error: 'externalEditor.copyUnavailable',
                        } as const
                      )[session.state],
                    )
                  : x('externalEditor.checkError')}
              </strong>
              <p>{x('externalEditor.openedHint')}</p>
            </div>
          </div>
          {session && (
            <dl>
              <div>
                <dt>{x('externalEditor.remoteFile')}</dt>
                <dd>{session.remotePath}</dd>
              </div>
              <div>
                <dt>{x('externalEditor.copyExpires')}</dt>
                <dd>{new Date(session.expiresAt).toLocaleString(language)}</dd>
              </div>
            </dl>
          )}
          {error && (
            <p className={cx('form-error')} role="alert">
              {error}
            </p>
          )}
          <footer>
            <button disabled={busy} onClick={() => void model.retry()}>
              <RefreshCw size={13} />
              {x('externalEditor.checkChanges')}
            </button>
            <button
              disabled={
                busy || !session || !['changed', 'conflict', 'saved'].includes(session.state)
              }
              onClick={() => void push()}
            >
              <Upload size={13} />
              {x('externalEditor.uploadChanges')}
            </button>
            <button disabled={busy} onClick={() => void close()}>
              {x('common.close')}
            </button>
          </footer>
        </section>
      </DialogContent>
    </Dialog>
  );
}
