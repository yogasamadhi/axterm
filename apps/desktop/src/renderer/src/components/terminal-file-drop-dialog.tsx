import { useEffect, useRef, type MouseEvent } from 'react';
import { createPortal } from 'react-dom';
import type { TerminalDropBehavior } from './terminal-file-drop-model';
import { useI18n } from '../i18n/context';

export function TerminalFileDropDialog({
  names,
  canUpload,
  onSelect,
  onCancel,
}: {
  names: string[];
  canUpload: boolean;
  onSelect(action: Exclude<TerminalDropBehavior, 'ask'>): void;
  onCancel(): void;
}) {
  const { t, x } = useI18n();
  const dialogRef = useRef<HTMLElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);

  useEffect(() => cancelRef.current?.focus(), []);

  return createPortal(
    <div
      className="terminal-paste-backdrop terminal-file-drop-backdrop"
      onMouseDown={(event: MouseEvent<HTMLDivElement>) => {
        if (event.target === event.currentTarget) onCancel();
      }}
    >
      <section
        ref={dialogRef}
        className="terminal-file-drop-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="terminal-file-drop-title"
        aria-describedby="terminal-file-drop-description"
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault();
            onCancel();
          } else if (event.key === 'Tab') {
            const controls =
              dialogRef.current?.querySelectorAll<HTMLButtonElement>('button:not([disabled])');
            const first = controls?.[0];
            const last = controls?.[controls.length - 1];
            if (event.shiftKey && document.activeElement === first) {
              event.preventDefault();
              last?.focus();
            } else if (!event.shiftKey && document.activeElement === last) {
              event.preventDefault();
              first?.focus();
            }
          }
        }}
      >
        <header>
          <div>
            <span className="eyebrow">FILE DROP</span>
            <h2 id="terminal-file-drop-title">{x('terminal.dropTitle')}</h2>
          </div>
          <span>{x('terminal.dropCount', { count: names.length })}</span>
        </header>
        <p id="terminal-file-drop-description">{x('terminal.dropDescription')}</p>
        <ul aria-label={x('terminal.dropList')}>
          {names.map((name, index) => (
            <li key={`${index}:${name}`}>{name}</li>
          ))}
        </ul>
        {!canUpload && <small>{x('terminal.dropUploadUnavailable')}</small>}
        <footer>
          <button ref={cancelRef} type="button" onClick={onCancel}>
            {t('cancel', 'Cancel')}
          </button>
          <button type="button" onClick={() => onSelect('path-insert')}>
            {x('terminal.insertTemporaryPaths')}
          </button>
          <button
            className="primary"
            type="button"
            disabled={!canUpload}
            onClick={() => onSelect('upload')}
          >
            {x('terminal.uploadCurrentDirectory')}
          </button>
        </footer>
      </section>
    </div>,
    document.body,
  );
}
