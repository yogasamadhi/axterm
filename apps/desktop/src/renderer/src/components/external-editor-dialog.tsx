import { useEffect, useRef, useState } from 'react';
import type { createRuntimeClient } from '@workspace/client';
import type { ExternalEditorSession } from '@workspace/contracts';
import { ExternalLink, RefreshCw, Upload, X } from 'lucide-react';
import { useI18n } from '../i18n/context';

type Client = ReturnType<typeof createRuntimeClient>;

export function ExternalEditorDialog({
  client,
  initial,
  onUploaded,
  onClose,
}: {
  client: Client;
  initial: ExternalEditorSession;
  onUploaded(): void;
  onClose(): void;
}) {
  const { language, x } = useI18n();
  const [session, setSession] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const closing = useRef(false);

  async function refresh() {
    if (closing.current) return;
    try {
      setSession(await client.getExternalEditor(initial.id));
      setError('');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : x('externalEditor.checkError'));
    }
  }

  useEffect(() => {
    const timer = window.setInterval(() => void refresh(), 750);
    return () => window.clearInterval(timer);
  });

  async function upload() {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      setSession(await client.pushExternalEditorChanges(initial.id));
      onUploaded();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : x('externalEditor.uploadError'));
      await refresh();
    } finally {
      setBusy(false);
    }
  }

  async function close() {
    if (closing.current) return;
    closing.current = true;
    setBusy(true);
    try {
      await client.closeExternalEditor(initial.id);
      onClose();
    } catch (cause) {
      closing.current = false;
      setBusy(false);
      setError(cause instanceof Error ? cause.message : x('externalEditor.cleanupError'));
    }
  }

  return (
    <div className="modal-backdrop">
      <section
        className="modal external-editor-dialog"
        role="dialog"
        aria-label={x('externalEditor.title')}
      >
        <header>
          <div>
            <strong>{x('externalEditor.title')}</strong>
            <small>{session.fileName}</small>
          </div>
          <button
            type="button"
            aria-label={x('externalEditor.closeSession')}
            onClick={() => void close()}
          >
            <X size={15} />
          </button>
        </header>
        <div className={`external-editor-state ${session.state}`}>
          <ExternalLink size={18} />
          <div>
            <strong>{externalEditorStateLabel(session.state, x)}</strong>
            <p>{session.message ?? x('externalEditor.openedHint')}</p>
          </div>
        </div>
        <dl>
          <dt>{x('externalEditor.remoteFile')}</dt>
          <dd>{session.remotePath}</dd>
          <dt>{x('externalEditor.copyExpires')}</dt>
          <dd>{new Date(session.expiresAt).toLocaleString(language)}</dd>
        </dl>
        {error && <p role="alert">{error}</p>}
        <footer>
          <button type="button" disabled={busy} onClick={() => void refresh()}>
            <RefreshCw size={14} /> {x('externalEditor.checkChanges')}
          </button>
          <button
            type="button"
            disabled={busy || session.state !== 'changed'}
            onClick={() => void upload()}
          >
            <Upload size={14} />{' '}
            {busy ? x('externalEditor.uploading') : x('externalEditor.uploadChanges')}
          </button>
          <button type="button" disabled={busy} onClick={() => void close()}>
            {x('externalEditor.finishCleanup')}
          </button>
        </footer>
      </section>
    </div>
  );
}

function externalEditorStateLabel(
  state: ExternalEditorSession['state'],
  x: ReturnType<typeof useI18n>['x'],
): string {
  if (state === 'changed') return x('externalEditor.changed');
  if (state === 'saved') return x('externalEditor.saved');
  if (state === 'conflict') return x('externalEditor.conflict');
  if (state === 'error') return x('externalEditor.copyUnavailable');
  return x('externalEditor.waitingForSave');
}
