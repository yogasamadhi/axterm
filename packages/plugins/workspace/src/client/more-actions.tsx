import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Ellipsis } from 'lucide-react';
import { Dialog, DialogTrigger, DialogContent, DialogTitle } from '@axterm/ui/controls';
import styles from './workspace.module.css';
/** Contributions keep one portal target; a closed menu has no active Radix dismiss/focus layer. */
export function MoreActions({ label, children }: { label: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const [container] = useState(() => document.createElement('div'));
  const attach = useCallback(
    (element: HTMLElement | null) => {
      if (element) element.append(container);
      else container.remove();
    },
    [container],
  );
  useEffect(() => () => container.remove(), [container]);
  return (
    <Dialog open={open} onOpenChange={setOpen} modal={false}>
      <DialogTrigger asChild>
        <button
          data-workspace-more-toggle
          className={styles['more-toggle']}
          aria-label={label}
          title={label}
        >
          <Ellipsis size={15} />
        </button>
      </DialogTrigger>
      <DialogContent
        asChild
        aria-describedby={undefined}
        onCloseAutoFocus={(event) => {
          if (document.querySelector('[role="dialog"][data-state="open"]')) event.preventDefault();
        }}
      >
        <section className={styles['workspace-more-actions']} data-workspace-more-actions>
          <DialogTitle className={styles['sr-only']}>{label}</DialogTitle>
          <div ref={attach} />
        </section>
      </DialogContent>
      {createPortal(
        <div
          style={{ display: 'contents' }}
          onClickCapture={(event) => {
            if (event.target instanceof Element && event.target.closest('button')) setOpen(false);
          }}
        >
          {children}
        </div>,
        container,
      )}
    </Dialog>
  );
}
