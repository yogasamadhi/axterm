import { useEffect, useRef, type ReactNode } from 'react';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuPortal,
  DropdownMenuContent,
  DropdownMenuItem,
} from '@axterm/ui/controls';
import { cx } from './styles.ts';
export interface FileContextMenuItem {
  id: string;
  label: string;
  icon: ReactNode;
  shortcut?: string;
  disabled?: boolean;
  danger?: boolean;
  primary?: boolean;
  separatorBefore?: boolean;
  onSelect(): void | Promise<void>;
}

export function FileContextMenu({
  x,
  y,
  label,
  items,
  onClose,
}: {
  x: number;
  y: number;
  label: string;
  items: FileContextMenuItem[];
  onClose(): void;
}) {
  const previous = useRef(document.activeElement);
  useEffect(() => {
    const blur = () => onClose();
    window.addEventListener('blur', blur);
    return () => window.removeEventListener('blur', blur);
  }, [onClose]);
  const left = Math.max(6, Math.min(x, window.innerWidth - 226));
  const top = Math.max(6, Math.min(y, window.innerHeight - Math.min(items.length * 33 + 8, 456)));
  return (
    <DropdownMenu
      open
      modal={false}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DropdownMenuTrigger asChild>
        <button
          aria-hidden
          tabIndex={-1}
          style={{
            position: 'fixed',
            left,
            top,
            width: 0,
            height: 0,
            border: 0,
            padding: 0,
            pointerEvents: 'none',
          }}
        />
      </DropdownMenuTrigger>
      <DropdownMenuPortal>
        <DropdownMenuContent
          asChild
          align="start"
          side="bottom"
          sideOffset={0}
          collisionPadding={6}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            if (previous.current instanceof HTMLElement && previous.current.isConnected)
              previous.current.focus();
          }}
        >
          <div
            className={cx('file-context-menu')}
            aria-label={label}
            onContextMenu={(event) => event.preventDefault()}
          >
            {items.map((item) => (
              <DropdownMenuItem
                key={item.id}
                asChild
                disabled={item.disabled}
                onPointerUp={(event) => {
                  if (event.button !== 0) event.preventDefault();
                }}
                onSelect={() => {
                  onClose();
                  void item.onSelect();
                }}
              >
                <button
                  type="button"
                  disabled={item.disabled}
                  className={cx(
                    `${item.danger ? 'danger-item' : ''} ${item.primary ? 'primary-item' : ''} ${item.separatorBefore ? 'separator-before' : ''}`,
                  )}
                >
                  {item.icon}
                  <span>{item.label}</span>
                  {item.shortcut && <kbd>{item.shortcut}</kbd>}
                </button>
              </DropdownMenuItem>
            ))}
          </div>
        </DropdownMenuContent>
      </DropdownMenuPortal>
    </DropdownMenu>
  );
}
