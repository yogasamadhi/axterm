import { useRef, type ReactNode } from 'react';
import { ShieldAlert } from 'lucide-react';
import { Dialog, DialogContent, DialogTitle } from '@axterm/ui/controls';
import { useI18n } from './i18n.tsx';
import { cx } from './styles.ts';
export function PanelFrame({
  className,
  eyebrow,
  title,
  description,
  action,
  children,
}: {
  className?: string | undefined;
  eyebrow: string;
  title: string;
  description: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className={cx('panel-page', className)}>
      <header className={cx('panel-heading')}>
        <div>
          <small>{eyebrow}</small>
          <h1>{title}</h1>
          <p>{description}</p>
        </div>
        {action}
      </header>
      {children}
    </div>
  );
}
/** The renderer owns React and Radix; the feature keeps its retained markup and preferred rejection focus. */
export function Modal({
  title,
  onClose,
  children,
  className,
}: {
  title: string;
  onClose(): void;
  children: ReactNode;
  className?: string;
}) {
  const { x } = useI18n();
  const dialog = useRef<HTMLDivElement>(null);
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent
        ref={dialog}
        className={cx('modal', className)}
        closeLabel={x('common.close')}
        aria-describedby={undefined}
        onOpenAutoFocus={(event) => {
          const preferred = dialog.current?.querySelector<HTMLElement>(
            '[data-autofocus]:not(:disabled)',
          );
          if (preferred) {
            event.preventDefault();
            preferred.focus();
          }
        }}
      >
        <header className={cx('modal-heading')}>
          <DialogTitle asChild>
            <h2>{title}</h2>
          </DialogTitle>
        </header>
        {children}
      </DialogContent>
    </Dialog>
  );
}
export function ErrorBanner({ text }: { text: string }) {
  return (
    <div className={cx('error-banner')} role="alert">
      <ShieldAlert size={14} />
      {text}
    </div>
  );
}
