import { useRef } from 'react';
import type { TranslateNS } from '@axterm/ui';
import { Dialog, DialogContent, DialogTitle, DialogDescription } from '@axterm/ui/controls';
import { cx } from './styles.ts';
export function TerminalFileDropDialog({
  names,
  t,
  canUpload,
  onSelect,
  onCancel,
}: {
  names: readonly string[];
  t: TranslateNS<'terminals'>;
  canUpload: boolean;
  onSelect(action: 'upload' | 'path-insert'): void;
  onCancel(): void;
}) {
  const cancel = useRef<HTMLButtonElement>(null);
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onCancel();
      }}
    >
      <DialogContent
        asChild
        overlayClassName={cx('terminal-file-drop-backdrop')}
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          cancel.current?.focus();
        }}
      >
        <section className={cx('terminal-file-drop-dialog')}>
          <header>
            <div>
              <span className="eyebrow">FILE DROP</span>
              <DialogTitle asChild>
                <h2>{t('dropTitle')}</h2>
              </DialogTitle>
            </div>
            <span>{t('dropCount', { count: names.length })}</span>
          </header>
          <DialogDescription asChild>
            <p>{t('dropDescription')}</p>
          </DialogDescription>
          <ul aria-label={t('dropList')}>
            {names.map((name, index) => (
              <li key={`${index}:${name}`}>{name}</li>
            ))}
          </ul>
          {!canUpload && <small>{t('dropUploadUnavailable')}</small>}
          <footer>
            <button type="button" ref={cancel} onClick={onCancel}>
              {t('cancel')}
            </button>
            <button type="button" onClick={() => onSelect('path-insert')}>
              {t('insertTemporaryPaths')}
            </button>
            <button
              type="button"
              className="primary"
              disabled={!canUpload}
              onClick={() => onSelect('upload')}
            >
              {t('uploadCurrentDirectory')}
            </button>
          </footer>
        </section>
      </DialogContent>
    </Dialog>
  );
}
