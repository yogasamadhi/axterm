import {
  ClipboardPaste,
  Bot,
  Copy,
  Eraser,
  ListChecks,
  PlayCircle,
  Save,
  Search,
  StopCircle,
  Upload,
  Download,
} from 'lucide-react';
import { useEffect, useRef, type KeyboardEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import {
  terminalContextMenuAvailability,
  type TerminalContextMenuPosition,
} from './terminal-interaction';
import { useI18n } from '../i18n/context';

interface TerminalContextMenuProps extends TerminalContextMenuPosition {
  hasSelection: boolean;
  recording: boolean;
  recordingBusy: boolean;
  transferBusy: boolean;
  onCopy(): void;
  onPaste(): void;
  onPasteSelected(): void;
  onExplainWithAi(): void;
  onSelectAll(): void;
  onClear(): void;
  onSearch(): void;
  onSaveLog(): void;
  onToggleRecording(): void;
  onXmodemUpload(): void;
  onXmodemDownload(): void;
}

interface TerminalContextMenuItemProps {
  icon: ReactNode;
  label: string;
  shortcut?: string | undefined;
  disabled?: boolean | undefined;
  onSelect(): void;
}

function TerminalContextMenuItem({
  icon,
  label,
  shortcut,
  disabled,
  onSelect,
}: TerminalContextMenuItemProps) {
  return (
    <button type="button" role="menuitem" disabled={disabled} onClick={onSelect}>
      {icon}
      <span>{label}</span>
      {shortcut && <kbd>{shortcut}</kbd>}
    </button>
  );
}

export function TerminalContextMenu({
  x,
  y,
  hasSelection,
  recording,
  recordingBusy,
  transferBusy,
  onCopy,
  onPaste,
  onPasteSelected,
  onExplainWithAi,
  onSelectAll,
  onClear,
  onSearch,
  onSaveLog,
  onToggleRecording,
  onXmodemUpload,
  onXmodemDownload,
}: TerminalContextMenuProps) {
  const { t, x: text } = useI18n();
  const menu = useRef<HTMLDivElement>(null);
  useEffect(() => {
    menu.current?.focus();
  }, []);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    const buttons = [
      ...(menu.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? []),
    ];
    if (!buttons.length) return;
    event.preventDefault();
    const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const next =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? buttons.length - 1
          : event.key === 'ArrowDown'
            ? (current + 1) % buttons.length
            : (current <= 0 ? buttons.length : current) - 1;
    buttons[next]?.focus();
  };

  const isMac =
    typeof navigator !== 'undefined' && navigator.platform.toLowerCase().includes('mac');
  const primaryModifier = isMac ? '⌘' : 'Ctrl';
  const available = terminalContextMenuAvailability(hasSelection);
  return createPortal(
    <div
      ref={menu}
      className="terminal-context-menu"
      role="menu"
      aria-label={text('terminal.menu')}
      tabIndex={-1}
      style={{ left: x, top: y }}
      onKeyDown={onKeyDown}
      onPointerDown={(event) => event.stopPropagation()}
    >
      <TerminalContextMenuItem
        icon={<Copy size={14} />}
        label={t('copy', 'Copy')}
        disabled={!available.copy}
        onSelect={onCopy}
      />
      <TerminalContextMenuItem
        icon={<ClipboardPaste size={14} />}
        label={t('paste', 'Paste')}
        onSelect={onPaste}
      />
      <TerminalContextMenuItem
        icon={<ClipboardPaste size={14} />}
        label={t('pasteSelected', 'Paste selected')}
        disabled={!available.pasteSelected}
        onSelect={onPasteSelected}
      />
      <TerminalContextMenuItem
        icon={<ListChecks size={14} />}
        label={t('selectAll', 'Select all')}
        onSelect={onSelectAll}
      />
      <TerminalContextMenuItem
        icon={<Bot size={14} />}
        label={text('terminal.explainWithAi')}
        disabled={!available.explainWithAi}
        onSelect={onExplainWithAi}
      />
      <TerminalContextMenuItem
        icon={<Eraser size={14} />}
        label={t('clear', 'Clear')}
        onSelect={onClear}
      />
      <TerminalContextMenuItem
        icon={<Search size={14} />}
        label={t('search', 'Search')}
        shortcut={`${primaryModifier}+F`}
        onSelect={onSearch}
      />
      <TerminalContextMenuItem
        icon={<Save size={14} />}
        label={text('terminal.saveLog')}
        disabled={recordingBusy}
        onSelect={onSaveLog}
      />
      <TerminalContextMenuItem
        icon={recording ? <StopCircle size={14} /> : <PlayCircle size={14} />}
        label={recording ? text('terminal.stopRecording') : text('terminal.startRecording')}
        disabled={recordingBusy}
        onSelect={onToggleRecording}
      />
      <TerminalContextMenuItem
        icon={<Upload size={14} />}
        label={text('terminal.xmodemSend')}
        disabled={transferBusy}
        onSelect={onXmodemUpload}
      />
      <TerminalContextMenuItem
        icon={<Download size={14} />}
        label={text('terminal.xmodemReceive')}
        disabled={transferBusy}
        onSelect={onXmodemDownload}
      />
    </div>,
    document.body,
  );
}
