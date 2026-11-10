/** Browser-only public controls. Importing this module does not install styles. */
import * as React from 'react';
import {
  Dialog as DialogPrimitive,
  DropdownMenu as DropdownMenuPrimitive,
  Label as LabelPrimitive,
  Select as SelectPrimitive,
  Slot,
  Tabs as TabsPrimitive,
  Tooltip as TooltipPrimitive,
} from 'radix-ui';
import { cva, type VariantProps } from 'class-variance-authority';
import styles, { cssText } from './controls.module.css';

/** Installed once by the UI renderer, with the same lifetime as its Client face. */
export const controlsCssText = cssText;
const cx = (...values: (string | undefined | false)[]): string => values.filter(Boolean).join(' ');
const buttonVariants = cva(styles.button, {
  variants: {
    variant: {
      primary: styles.primary,
      secondary: styles.secondary,
      ghost: styles.ghost,
      destructive: styles.destructive,
    },
    size: { default: styles.normal, small: styles.small, icon: styles.icon },
  },
  defaultVariants: { variant: 'secondary', size: 'default' },
});
export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}
export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { className, variant, size, asChild = false, type = 'button', ...props },
  ref,
) {
  const Component = asChild ? Slot.Root : 'button';
  return (
    <Component
      type={type}
      className={cx(buttonVariants({ variant, size }), className)}
      ref={ref}
      {...props}
    />
  );
});
export type InputProps = React.InputHTMLAttributes<HTMLInputElement>;
export const Input = React.forwardRef<HTMLInputElement, InputProps>(function Input(
  { className, ...props },
  ref,
) {
  return <input ref={ref} className={cx(styles.input, className)} {...props} />;
});
export type TextareaProps = React.TextareaHTMLAttributes<HTMLTextAreaElement>;
export const Textarea = React.forwardRef<HTMLTextAreaElement, TextareaProps>(function Textarea(
  { className, ...props },
  ref,
) {
  return <textarea ref={ref} className={cx(styles.input, styles.textarea, className)} {...props} />;
});
export type LabelProps = React.ComponentPropsWithoutRef<typeof LabelPrimitive.Root>;
export const Label = React.forwardRef<React.ElementRef<typeof LabelPrimitive.Root>, LabelProps>(
  function Label({ className, ...props }, ref) {
    return <LabelPrimitive.Root ref={ref} className={cx(styles.label, className)} {...props} />;
  },
);
export const Dialog = DialogPrimitive.Root;
export const DialogTrigger = DialogPrimitive.Trigger;
export const DialogClose = DialogPrimitive.Close;
export type DialogProps = React.ComponentProps<typeof Dialog>;
export interface DialogContentProps extends React.ComponentPropsWithoutRef<
  typeof DialogPrimitive.Content
> {
  /** Localized accessible label; omitted when the feature supplies its own close action. */
  closeLabel?: string;
  /** Feature-owned scrim styling; the public control keeps portal and focus ownership. */
  overlayClassName?: string;
  container?: HTMLElement | null;
}
export const DialogContent = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Content>,
  DialogContentProps
>(function DialogContent(
  {
    className,
    children,
    closeLabel,
    overlayClassName,
    container,
    onOpenAutoFocus,
    onCloseAutoFocus,
    ...props
  },
  ref,
) {
  const contentRef = React.useRef<HTMLDivElement | null>(null);
  const opener = React.useRef<HTMLElement | null>(null);
  // Capture before layout autofocus runs, without reading or writing refs during render.
  React.useInsertionEffect(() => {
    const active = document.activeElement;
    if (!contentRef.current && active instanceof HTMLElement && active !== document.body)
      opener.current = active;
  });
  const contentReference = React.useCallback(
    (node: HTMLDivElement | null) => {
      const active = document.activeElement;
      if (
        node &&
        active instanceof HTMLElement &&
        active !== document.body &&
        !node.contains(active)
      )
        opener.current = active;
      contentRef.current = node;
      if (typeof ref === 'function') ref(node);
      else if (ref) ref.current = node;
    },
    [ref],
  );
  const close = closeLabel ? (
    <DialogPrimitive.Close asChild>
      <Button className={styles.close} variant="ghost" size="icon" aria-label={closeLabel}>
        ×
      </Button>
    </DialogPrimitive.Close>
  ) : undefined;
  let content = children;
  if (props.asChild && close) {
    const child = React.Children.only(children) as React.ReactElement<{
      children?: React.ReactNode;
    }>;
    content = React.cloneElement(child, undefined, child.props.children, close);
  } else if (!props.asChild) {
    content = (
      <>
        {children}
        {close}
      </>
    );
  }
  return (
    <DialogPrimitive.Portal container={container} forceMount={props.forceMount}>
      <DialogPrimitive.Overlay className={cx(styles.overlay, overlayClassName)} />
      <DialogPrimitive.Content
        ref={contentReference}
        className={cx(styles.dialog, className)}
        {...props}
        onOpenAutoFocus={(event) => {
          const active = document.activeElement;
          if (
            active instanceof HTMLElement &&
            active !== document.body &&
            !contentRef.current?.contains(active)
          )
            opener.current = active;
          onOpenAutoFocus?.(event);
        }}
        onCloseAutoFocus={(event) => {
          onCloseAutoFocus?.(event);
          const target = opener.current;
          const active = document.activeElement;
          const focusedElsewhere =
            active instanceof HTMLElement &&
            active !== document.body &&
            active !== target &&
            !contentRef.current?.contains(active);
          if (
            !event.defaultPrevented &&
            !focusedElsewhere &&
            target?.isConnected &&
            target.getClientRects().length
          ) {
            event.preventDefault();
            target.focus({ preventScroll: true });
          }
        }}
      >
        {content}
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  );
});
export type DialogTitleProps = React.ComponentPropsWithoutRef<typeof DialogPrimitive.Title>;
export const DialogTitle = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Title>,
  DialogTitleProps
>(function DialogTitle({ className, ...props }, ref) {
  return <DialogPrimitive.Title ref={ref} className={cx(styles.title, className)} {...props} />;
});
export type DialogDescriptionProps = React.ComponentPropsWithoutRef<
  typeof DialogPrimitive.Description
>;
export const DialogDescription = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Description>,
  DialogDescriptionProps
>(function DialogDescription({ className, ...props }, ref) {
  return (
    <DialogPrimitive.Description
      ref={ref}
      className={cx(styles.description, className)}
      {...props}
    />
  );
});
export type DialogFooterProps = React.HTMLAttributes<HTMLDivElement>;
export function DialogFooter({ className, ...props }: DialogFooterProps): React.ReactNode {
  return <div className={cx(styles.footer, className)} {...props} />;
}

export const Select = SelectPrimitive.Root;
export const SelectValue = SelectPrimitive.Value;
export type SelectProps = React.ComponentProps<typeof Select>;
export type SelectTriggerProps = React.ComponentPropsWithoutRef<typeof SelectPrimitive.Trigger>;
export const SelectTrigger = React.forwardRef<
  React.ElementRef<typeof SelectPrimitive.Trigger>,
  SelectTriggerProps
>(function SelectTrigger({ className, children, ...props }, ref) {
  return (
    <SelectPrimitive.Trigger
      ref={ref}
      className={cx(styles.input, styles.selectTrigger, className)}
      {...props}
    >
      {children}
      <SelectPrimitive.Icon aria-hidden>▾</SelectPrimitive.Icon>
    </SelectPrimitive.Trigger>
  );
});
export interface SelectContentProps extends React.ComponentPropsWithoutRef<
  typeof SelectPrimitive.Content
> {
  container?: HTMLElement | null;
}
export const SelectContent = React.forwardRef<
  React.ElementRef<typeof SelectPrimitive.Content>,
  SelectContentProps
>(function SelectContent({ className, children, container, position = 'popper', ...props }, ref) {
  return (
    <SelectPrimitive.Portal container={container}>
      <SelectPrimitive.Content
        ref={ref}
        className={cx(styles.selectContent, className)}
        position={position}
        {...props}
      >
        <SelectPrimitive.ScrollUpButton className={styles.scrollButton}>
          ▴
        </SelectPrimitive.ScrollUpButton>
        <SelectPrimitive.Viewport className={styles.viewport}>{children}</SelectPrimitive.Viewport>
        <SelectPrimitive.ScrollDownButton className={styles.scrollButton}>
          ▾
        </SelectPrimitive.ScrollDownButton>
      </SelectPrimitive.Content>
    </SelectPrimitive.Portal>
  );
});
export type SelectItemProps = React.ComponentPropsWithoutRef<typeof SelectPrimitive.Item>;
export const SelectItem = React.forwardRef<
  React.ElementRef<typeof SelectPrimitive.Item>,
  SelectItemProps
>(function SelectItem({ className, children, ...props }, ref) {
  return (
    <SelectPrimitive.Item ref={ref} className={cx(styles.selectItem, className)} {...props}>
      <SelectPrimitive.ItemText>{children}</SelectPrimitive.ItemText>
      <SelectPrimitive.ItemIndicator className={styles.indicator}>✓</SelectPrimitive.ItemIndicator>
    </SelectPrimitive.Item>
  );
});
export const Tabs = TabsPrimitive.Root;
export type TabsProps = React.ComponentProps<typeof Tabs>;
export type TabsListProps = React.ComponentPropsWithoutRef<typeof TabsPrimitive.List>;
export const TabsList = React.forwardRef<
  React.ElementRef<typeof TabsPrimitive.List>,
  TabsListProps
>(function TabsList({ className, ...props }, ref) {
  return <TabsPrimitive.List ref={ref} className={cx(styles.tabsList, className)} {...props} />;
});
export type TabsTriggerProps = React.ComponentPropsWithoutRef<typeof TabsPrimitive.Trigger>;
export const TabsTrigger = React.forwardRef<
  React.ElementRef<typeof TabsPrimitive.Trigger>,
  TabsTriggerProps
>(function TabsTrigger({ className, ...props }, ref) {
  return (
    <TabsPrimitive.Trigger ref={ref} className={cx(styles.tabsTrigger, className)} {...props} />
  );
});
export type TabsContentProps = React.ComponentPropsWithoutRef<typeof TabsPrimitive.Content>;
export const TabsContent = React.forwardRef<
  React.ElementRef<typeof TabsPrimitive.Content>,
  TabsContentProps
>(function TabsContent({ className, ...props }, ref) {
  return (
    <TabsPrimitive.Content ref={ref} className={cx(styles.tabsContent, className)} {...props} />
  );
});
export const TooltipProvider = TooltipPrimitive.Provider;
const TooltipAnchorContext = React.createContext<{
  anchor: HTMLElement | null;
  setAnchor: React.Dispatch<React.SetStateAction<HTMLElement | null>>;
} | null>(null);
export function Tooltip(props: React.ComponentProps<typeof TooltipPrimitive.Root>) {
  const [anchor, setAnchor] = React.useState<HTMLElement | null>(null);
  const value = React.useMemo(() => ({ anchor, setAnchor }), [anchor]);
  return (
    <TooltipAnchorContext.Provider value={value}>
      <TooltipPrimitive.Root {...props} />
    </TooltipAnchorContext.Provider>
  );
}
export const TooltipTrigger = React.forwardRef<
  React.ElementRef<typeof TooltipPrimitive.Trigger>,
  React.ComponentPropsWithoutRef<typeof TooltipPrimitive.Trigger>
>(function TooltipTrigger(props, ref) {
  const setAnchor = React.useContext(TooltipAnchorContext)?.setAnchor;
  const bind = React.useCallback(
    (node: HTMLButtonElement | null) => {
      setAnchor?.(node);
      if (typeof ref === 'function') ref(node);
      else if (ref) ref.current = node;
    },
    [setAnchor, ref],
  );
  return <TooltipPrimitive.Trigger {...props} ref={bind} />;
});
export type TooltipProps = React.ComponentProps<typeof Tooltip>;
export type TooltipProviderProps = React.ComponentProps<typeof TooltipProvider>;
export interface TooltipContentProps extends React.ComponentPropsWithoutRef<
  typeof TooltipPrimitive.Content
> {
  container?: HTMLElement | null;
}
export const TooltipContent = React.forwardRef<
  React.ElementRef<typeof TooltipPrimitive.Content>,
  TooltipContentProps
>(function TooltipContent({ className, children, container, sideOffset = 5, ...props }, ref) {
  const anchor = React.useContext(TooltipAnchorContext)?.anchor;
  const landmark = anchor?.closest<HTMLElement>(
    'main,aside,[role="region"],[role="complementary"],[role="dialog"],[role="alertdialog"]',
  );
  return (
    <TooltipPrimitive.Portal container={container === undefined ? landmark : container}>
      <TooltipPrimitive.Content
        ref={ref}
        className={cx(styles.tooltip, className)}
        sideOffset={sideOffset}
        {...props}
      >
        {children}
        <TooltipPrimitive.Arrow className={styles.arrow} aria-hidden="true" />
      </TooltipPrimitive.Content>
    </TooltipPrimitive.Portal>
  );
});

/** Feature-owned menu geometry; Radix owns focus, keyboard navigation and dismissal. */
export const DropdownMenu = DropdownMenuPrimitive.Root;
export const DropdownMenuTrigger = DropdownMenuPrimitive.Trigger;
export const DropdownMenuPortal = DropdownMenuPrimitive.Portal;
export const DropdownMenuContent = DropdownMenuPrimitive.Content;
export const DropdownMenuItem = DropdownMenuPrimitive.Item;
export type DropdownMenuProps = React.ComponentProps<typeof DropdownMenu>;
export type DropdownMenuContentProps = React.ComponentPropsWithoutRef<typeof DropdownMenuContent>;
export type DropdownMenuItemProps = React.ComponentPropsWithoutRef<typeof DropdownMenuItem>;
