import { Dialog, DialogContent, DialogTitle } from '@axterm/ui/controls';
import { useLayoutEffect, useRef, useState, type DragEvent as ReactDragEvent } from 'react';
import { File, FileCode2, Folder, KeyRound, X } from 'lucide-react';
import { useI18n } from './i18n.tsx';
import type { FilesTranslator as Translator } from './locales.ts';
import { formatBytes, messageOf } from './format.ts';
import { calculateVirtualWindow } from './virtual-window.ts';
import {
  createFileSelection,
  moveFileSelection,
  selectAllFilePaths,
  selectFilePath,
  type FileSelectionState,
} from './file-selection-model.ts';
import { type FileTableEntry, type FileManagerSort } from './file-list-model.ts';
import {
  FILE_DRAG_MIME,
  FILE_MANAGER_COLUMNS,
  type FilePaneScope,
  type FileManagerColumn,
  type FileDragPayload,
} from './file-manager-model.ts';
import { cx } from './styles.ts';
export function FileInfoDialog({
  scope,
  entry,
  onChangeMode,
  onClose,
}: {
  scope: 'local' | 'remote';
  entry: FileTableEntry;
  onChangeMode(mode: number): Promise<void>;
  onClose(): void;
}) {
  const { language, x } = useI18n();
  const initialMode = entry.mode === undefined ? 0 : entry.mode & 0o7777;
  const [editingPermissions, setEditingPermissions] = useState(false);
  const [mode, setMode] = useState(initialMode);
  const [modeInput, setModeInput] = useState(initialMode.toString(8).padStart(4, '0'));
  const [saving, setSaving] = useState(false);
  const [permissionError, setPermissionError] = useState('');
  const values = [
    [x('fileInfo.location'), entry.path],
    [
      x('fileInfo.type'),
      entry.type === 'directory'
        ? x('fileInfo.directory')
        : entry.type === 'file'
          ? x('fileInfo.file')
          : entry.type === 'symlink'
            ? x('fileInfo.symlink')
            : x('fileInfo.other'),
    ],
    [
      x('fileInfo.size'),
      entry.type === 'directory' ? x('fileInfo.directory') : formatBytes(entry.size),
    ],
    [x('fileInfo.symbolicMode'), entry.mode === undefined ? '—' : symbolicMode(initialMode)],
    [
      x('fileInfo.octalMode'),
      entry.mode === undefined ? '—' : initialMode.toString(8).padStart(4, '0'),
    ],
    [x('fileInfo.owner'), entry.owner ?? '—'],
    [x('fileInfo.group'), entry.group ?? '—'],
    [
      x('fileInfo.modified'),
      entry.modifiedAt ? new Date(entry.modifiedAt).toLocaleString(language) : '—',
    ],
    [
      x('fileInfo.accessed'),
      entry.accessedAt ? new Date(entry.accessedAt).toLocaleString(language) : '—',
    ],
  ];
  const permissionGroups = [
    { label: x('fileInfo.ownerClass'), bits: [0o400, 0o200, 0o100] },
    { label: x('fileInfo.groupClass'), bits: [0o040, 0o020, 0o010] },
    { label: x('fileInfo.otherClass'), bits: [0o004, 0o002, 0o001] },
  ];
  const setPermissionMode = (nextMode: number) => {
    setMode(nextMode);
    setModeInput(nextMode.toString(8).padStart(4, '0'));
    setPermissionError('');
  };
  async function savePermissions() {
    if (!/^[0-7]{3,4}$/u.test(modeInput)) {
      setPermissionError(x('fileInfo.invalidMode'));
      return;
    }
    const nextMode = Number.parseInt(modeInput, 8);
    setSaving(true);
    setPermissionError('');
    try {
      await onChangeMode(nextMode);
      onClose();
    } catch (cause) {
      setPermissionError(messageOf(cause, x));
    } finally {
      setSaving(false);
    }
  }
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !saving) onClose();
      }}
    >
      <DialogContent asChild aria-describedby={undefined} overlayClassName={cx('modal-backdrop')}>
        <section
          className={cx('modal file-info-dialog')}
          role="dialog"
          aria-modal="true"
          aria-label={x('fileInfo.title')}
        >
          <header>
            <div>
              <small>
                {scope === 'local' ? x('fileInfo.localItem') : x('fileInfo.remoteItem')}
              </small>
              <DialogTitle asChild>
                <h2>{entry.name}</h2>
              </DialogTitle>
            </div>
            <button type="button" aria-label={x('fileInfo.closeAria')} onClick={onClose}>
              <X size={15} />
            </button>
          </header>
          <dl className={cx('file-info-properties')}>
            {values.map(([label, value]) => (
              <div key={label}>
                <dt>{label}</dt>
                <dd>{value}</dd>
              </div>
            ))}
          </dl>
          {editingPermissions && (
            <div className={cx('file-permission-editor')}>
              <div className={cx('file-permission-summary')}>
                <strong>{symbolicMode(mode)}</strong>
                <label>
                  {x('fileInfo.octalMode')}
                  <input
                    aria-label={x('fileInfo.octalAria')}
                    inputMode="numeric"
                    maxLength={4}
                    value={modeInput}
                    onChange={(event) => {
                      const value = event.target.value;
                      setModeInput(value);
                      if (/^[0-7]{3,4}$/u.test(value)) setMode(Number.parseInt(value, 8));
                    }}
                  />
                </label>
              </div>
              <div className={cx('file-permission-grid')}>
                <span />
                <strong>{x('fileInfo.read')}</strong>
                <strong>{x('fileInfo.write')}</strong>
                <strong>{x('fileInfo.execute')}</strong>
                {permissionGroups.map((group) => (
                  <div className={cx('file-permission-row')} key={group.label}>
                    <strong>{group.label}</strong>
                    {group.bits.map((bit, index) => (
                      <button
                        key={bit}
                        type="button"
                        aria-label={x('fileInfo.permissionAria', {
                          operation: [
                            x('fileInfo.read'),
                            x('fileInfo.write'),
                            x('fileInfo.execute'),
                          ][index]!,
                          subject: group.label,
                        })}
                        aria-pressed={(mode & bit) !== 0}
                        onClick={() => setPermissionMode(mode ^ bit)}
                      >
                        {['r', 'w', 'x'][index]}
                      </button>
                    ))}
                  </div>
                ))}
              </div>
              <p className={cx('hint')}>{x('fileInfo.nonRecursiveHint')}</p>
              {permissionError && <p className={cx('danger-text')}>{permissionError}</p>}
            </div>
          )}
          <footer>
            {editingPermissions ? (
              <>
                <button
                  type="button"
                  disabled={saving}
                  onClick={() => setEditingPermissions(false)}
                >
                  {x('common.cancel')}
                </button>
                <button
                  type="button"
                  className={cx('primary')}
                  disabled={saving}
                  onClick={() => void savePermissions()}
                >
                  {saving ? x('fileInfo.applying') : x('fileInfo.apply')}
                </button>
              </>
            ) : (
              <>
                {entry.mode !== undefined && entry.type !== 'symlink' && (
                  <button type="button" onClick={() => setEditingPermissions(true)}>
                    <KeyRound size={13} /> {x('fileInfo.changePermissions')}
                  </button>
                )}
                <button type="button" autoFocus onClick={onClose}>
                  {x('fileInfo.close')}
                </button>
              </>
            )}
          </footer>
        </section>
      </DialogContent>
    </Dialog>
  );
}

function symbolicMode(mode: number): string {
  const masks = [0o400, 0o200, 0o100, 0o040, 0o020, 0o010, 0o004, 0o002, 0o001];
  return masks.map((mask, index) => ((mode & mask) !== 0 ? 'rwx'[index % 3] : '-')).join('');
}

export function FileTable({
  scope,
  label,
  entries,
  columns,
  sort,
  selection,
  currentPath,
  parentPath,
  fileDrag,
  pasteEnabled,
  parentVisible,
  onParent,
  onSelectionChange,
  onContextMenu,
  onOpen,
  onStageFileOperation,
  onPaste,
  onStartDrag,
  onEndDrag,
  onDropFiles,
  onDropExternalFiles,
  externalDropBusy = false,
  onSort,
  onToggleColumn,
}: {
  scope: FilePaneScope;
  label: string;
  entries: FileTableEntry[];
  columns: FileManagerColumn[];
  sort: FileManagerSort;
  selection: FileSelectionState;
  currentPath: string;
  parentPath: string | undefined;
  fileDrag: FileDragPayload | undefined;
  pasteEnabled: boolean;
  parentVisible: boolean;
  onParent(): void;
  onSelectionChange(selection: FileSelectionState): void;
  onContextMenu(entry: FileTableEntry | null, x: number, y: number): void;
  onOpen(entry: FileTableEntry): void;
  onStageFileOperation(paths: readonly string[], operation: 'copy' | 'move'): void;
  onPaste(destination: string): void;
  onStartDrag(paths: readonly string[]): FileDragPayload | undefined;
  onEndDrag(): void;
  onDropFiles(payload: FileDragPayload, destination: string): void;
  onDropExternalFiles?(
    files: readonly File[],
    destination: string,
    includesDirectory: boolean,
  ): void;
  externalDropBusy?: boolean;
  onSort(column: FileManagerColumn): void;
  onToggleColumn(column: FileManagerColumn): void;
}) {
  const { language, x } = useI18n();
  const [widths, setWidths] = useState(() => columns.map(() => 100 / columns.length));
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(340);
  const [dropTarget, setDropTarget] = useState<string>();
  const activeDragRef = useRef<FileDragPayload | undefined>(undefined);
  const scrollRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const scroll = scrollRef.current;
    if (!scroll) return;
    const measure = () => setViewportHeight(scroll.clientHeight);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(scroll);
    return () => observer.disconnect();
  }, []);
  const drag = useRef<
    | {
        index: number;
        startX: number;
        widths: number[];
        containerWidth: number;
      }
    | undefined
  >(undefined);
  const rowHeight = 32;
  const overscan = 6;
  const { start, end } = calculateVirtualWindow({
    itemCount: entries.length,
    rowHeight,
    scrollTop,
    viewportHeight,
    overscan,
  });
  const visible = entries.slice(start, end);
  const orderedPaths = entries.map(({ path }) => path);
  const clipboardPaths = selection.paths.size
    ? [...selection.paths]
    : selection.focusedPath
      ? [selection.focusedPath]
      : [];
  const activeDrag = () => activeDragRef.current ?? fileDrag;
  const isExternalFileTransfer = (transfer: DataTransfer) =>
    Array.from(transfer.types).includes('Files');
  const acceptsTransfer = (transfer: DataTransfer) =>
    Array.from(transfer.types).includes(FILE_DRAG_MIME) ||
    activeDrag()?.scope === scope ||
    (!!onDropExternalFiles && !externalDropBusy && isExternalFileTransfer(transfer));
  const dropPayload = (transfer: DataTransfer) => parseFileDragPayload(transfer) ?? activeDrag();
  const dropEffect = (transfer: DataTransfer) =>
    isExternalFileTransfer(transfer) && !dropPayload(transfer) ? 'copy' : 'move';
  const commitDrop = (event: ReactDragEvent<HTMLElement>, destination: string) => {
    const payload = dropPayload(event.dataTransfer);
    if (payload) {
      onDropFiles(payload, destination);
      return true;
    }
    if (!onDropExternalFiles || externalDropBusy || !isExternalFileTransfer(event.dataTransfer))
      return false;
    const includesDirectory = [...event.dataTransfer.items].some(
      (item) => item.kind === 'file' && item.webkitGetAsEntry?.()?.isDirectory,
    );
    onDropExternalFiles([...event.dataTransfer.files], destination, includesDirectory);
    return true;
  };
  const gridTemplateColumns = widths.map((width) => `minmax(0, ${width}fr)`).join(' ');

  function focusFile(path: string | null) {
    if (!path) return;
    const index = orderedPaths.indexOf(path);
    const scroll = scrollRef.current;
    if (index < 0 || !scroll) return;
    const parentOffset = parentVisible ? rowHeight : 0;
    const rowTop = parentOffset + index * rowHeight;
    const rowBottom = rowTop + rowHeight;
    if (rowTop < scroll.scrollTop) scroll.scrollTop = rowTop;
    else if (rowBottom > scroll.scrollTop + scroll.clientHeight)
      scroll.scrollTop = rowBottom - scroll.clientHeight;
    setScrollTop(scroll.scrollTop);
    requestAnimationFrame(() => {
      scroll.querySelector<HTMLButtonElement>(`[data-file-index="${index}"]`)?.focus();
    });
  }

  function moveSelection(direction: -1 | 1, extend = false) {
    const next = moveFileSelection({ orderedPaths, selection, direction, extend });
    onSelectionChange(next);
    focusFile(next.focusedPath);
  }

  function adjustColumns(index: number, delta: number) {
    setWidths((current) => {
      const left = Math.max(
        8,
        Math.min(current[index]! + delta, current[index]! + current[index + 1]! - 8),
      );
      const right = current[index]! + current[index + 1]! - left;
      return current.map((width, columnIndex) =>
        columnIndex === index ? left : columnIndex === index + 1 ? right : width,
      );
    });
  }

  return (
    <div className={cx('file-list file-table')} aria-label={label}>
      <div className={cx('file-table-header-wrap')}>
        <div className={cx('file-table-header')} role="row" style={{ gridTemplateColumns }}>
          {columns.map((column, index) => {
            const labelText = fileColumnLabel(column, x);
            return (
              <div
                className={cx('file-table-column')}
                role="columnheader"
                aria-sort={
                  sort.property === column
                    ? sort.direction === 'asc'
                      ? 'ascending'
                      : 'descending'
                    : 'none'
                }
                key={column}
              >
                <button
                  type="button"
                  title={x('fileTable.sortBy', { column: labelText })}
                  onClick={() => onSort(column)}
                >
                  <span>{labelText}</span>
                  {sort.property === column && (
                    <span aria-hidden="true">{sort.direction === 'asc' ? '↑' : '↓'}</span>
                  )}
                </button>
                {index < columns.length - 1 && (
                  <span
                    className={cx('file-column-resizer')}
                    role="separator"
                    aria-label={x('fileTable.resizeColumns', {
                      left: labelText,
                      right: fileColumnLabel(columns[index + 1]!, x),
                    })}
                    aria-orientation="vertical"
                    aria-valuemin={8}
                    aria-valuemax={92}
                    aria-valuenow={Math.round(widths[index]!)}
                    tabIndex={0}
                    onKeyDown={(event) => {
                      if (event.key === 'ArrowLeft') adjustColumns(index, -2);
                      if (event.key === 'ArrowRight') adjustColumns(index, 2);
                    }}
                    onPointerDown={(event) => {
                      const containerWidth =
                        event.currentTarget.parentElement?.parentElement?.clientWidth;
                      if (!containerWidth) return;
                      event.currentTarget.setPointerCapture(event.pointerId);
                      drag.current = {
                        index,
                        startX: event.clientX,
                        widths: [...widths],
                        containerWidth,
                      };
                    }}
                    onPointerMove={(event) => {
                      const state = drag.current;
                      if (!state || state.index !== index) return;
                      const delta = ((event.clientX - state.startX) / state.containerWidth) * 100;
                      const pairTotal = state.widths[index]! + state.widths[index + 1]!;
                      const left = Math.max(
                        8,
                        Math.min(state.widths[index]! + delta, pairTotal - 8),
                      );
                      setWidths(
                        state.widths.map((width, columnIndex) =>
                          columnIndex === index
                            ? left
                            : columnIndex === index + 1
                              ? pairTotal - left
                              : width,
                        ),
                      );
                    }}
                    onPointerUp={(event) => {
                      drag.current = undefined;
                      if (event.currentTarget.hasPointerCapture(event.pointerId))
                        event.currentTarget.releasePointerCapture(event.pointerId);
                    }}
                    onPointerCancel={() => {
                      drag.current = undefined;
                    }}
                  />
                )}
              </div>
            );
          })}
        </div>
        <details className={cx('file-column-picker')}>
          <summary
            aria-label={x('fileTable.configureColumns')}
            title={x('fileTable.configureColumns')}
          >
            {x('fileTable.columns')}
          </summary>
          <div role="menu" aria-label={x('fileTable.columnMenu')}>
            {FILE_MANAGER_COLUMNS.map((column) => (
              <label key={column.id}>
                <input
                  type="checkbox"
                  checked={columns.includes(column.id)}
                  disabled={column.id === 'name'}
                  onChange={() => onToggleColumn(column.id)}
                />
                {x(column.labelKey)}
              </label>
            ))}
          </div>
        </details>
      </div>
      <div
        ref={scrollRef}
        className={cx(`file-table-scroll ${dropTarget === 'current' ? 'drop-target' : ''}`)}
        role="rowgroup"
        aria-busy={externalDropBusy}
        tabIndex={entries.length ? -1 : 0}
        onPointerDown={(event) => {
          if (!(event.target as Element).closest('.file-row'))
            onSelectionChange(createFileSelection());
        }}
        onContextMenu={(event) => {
          if ((event.target as Element).closest('.file-row')) return;
          event.preventDefault();
          onSelectionChange(createFileSelection());
          onContextMenu(null, event.clientX, event.clientY);
        }}
        onKeyDown={(event) => {
          const key = event.key.toLocaleLowerCase();
          if (isPlatformSelectionModifier(event) && key === 'c' && clipboardPaths.length) {
            event.preventDefault();
            event.stopPropagation();
            onStageFileOperation(clipboardPaths, 'copy');
          } else if (isPlatformSelectionModifier(event) && key === 'x' && clipboardPaths.length) {
            event.preventDefault();
            event.stopPropagation();
            onStageFileOperation(clipboardPaths, 'move');
          } else if (isPlatformSelectionModifier(event) && key === 'v' && pasteEnabled) {
            event.preventDefault();
            event.stopPropagation();
            onPaste(currentPath);
          } else if (isPlatformSelectionModifier(event) && key === 'a') {
            event.preventDefault();
            event.stopPropagation();
            onSelectionChange(selectAllFilePaths(orderedPaths, selection.focusedPath));
          } else if (event.key === 'Escape') {
            event.preventDefault();
            onSelectionChange(createFileSelection());
          }
        }}
        onDragOver={(event) => {
          if (
            !acceptsTransfer(event.dataTransfer) ||
            (event.target as Element).closest('.file-data-row')
          )
            return;
          event.preventDefault();
          event.dataTransfer.dropEffect = dropEffect(event.dataTransfer);
          setDropTarget('current');
        }}
        onDragLeave={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null))
            setDropTarget(undefined);
        }}
        onDrop={(event) => {
          if ((event.target as Element).closest('.file-data-row')) return;
          event.preventDefault();
          setDropTarget(undefined);
          commitDrop(event, currentPath);
        }}
        onScroll={(event) => {
          setScrollTop(event.currentTarget.scrollTop);
        }}
      >
        {parentVisible && (
          <button
            className={cx(
              `file-row file-parent-row ${dropTarget === 'parent' ? 'drop-target' : ''}`,
            )}
            style={{ gridTemplateColumns }}
            onClick={() => onSelectionChange(createFileSelection())}
            onDoubleClick={onParent}
            onContextMenu={(event) => {
              event.preventDefault();
              event.stopPropagation();
              onSelectionChange(createFileSelection());
              onContextMenu(null, event.clientX, event.clientY);
            }}
            onDragOver={(event) => {
              if (!acceptsTransfer(event.dataTransfer) || parentPath === undefined) return;
              event.preventDefault();
              event.stopPropagation();
              event.dataTransfer.dropEffect = dropEffect(event.dataTransfer);
              setDropTarget('parent');
            }}
            onDragLeave={() => setDropTarget(undefined)}
            onDrop={(event) => {
              if (parentPath === undefined) return;
              event.preventDefault();
              event.stopPropagation();
              setDropTarget(undefined);
              commitDrop(event, parentPath);
            }}
          >
            {columns.map((column) => (
              <span key={column}>
                {column === 'name' ? (
                  <>
                    <Folder size={15} /> ..
                  </>
                ) : (
                  ''
                )}
              </span>
            ))}
          </button>
        )}
        <div className={cx('file-row-spacer')} style={{ height: start * rowHeight }} />
        {visible.map((entry, visibleIndex) => {
          const index = start + visibleIndex;
          const isSelected = selection.paths.has(entry.path);
          return (
            <button
              className={cx(
                `file-row file-data-row ${isSelected ? 'selected' : ''} ${dropTarget === entry.path ? 'drop-target' : ''}`,
              )}
              style={{ gridTemplateColumns }}
              key={entry.path}
              data-file-index={index}
              aria-label={entry.name}
              aria-pressed={isSelected}
              draggable
              tabIndex={
                selection.focusedPath === entry.path || (!selection.focusedPath && index === 0)
                  ? 0
                  : -1
              }
              onFocus={() => {
                if (selection.focusedPath !== entry.path)
                  onSelectionChange({ ...selection, focusedPath: entry.path });
              }}
              onClick={(event) =>
                onSelectionChange(
                  selectFilePath({
                    orderedPaths,
                    selection,
                    targetPath: entry.path,
                    additive: isPlatformSelectionModifier(event),
                    range: event.shiftKey,
                  }),
                )
              }
              onDoubleClick={() => onOpen(entry)}
              onContextMenu={(event) => {
                event.preventDefault();
                event.stopPropagation();
                if (!isSelected)
                  onSelectionChange(
                    selectFilePath({ orderedPaths, selection, targetPath: entry.path }),
                  );
                onContextMenu(entry, event.clientX, event.clientY);
              }}
              onDragStart={(event) => {
                const paths = isSelected ? [...selection.paths] : [entry.path];
                if (!isSelected)
                  onSelectionChange(
                    selectFilePath({ orderedPaths, selection, targetPath: entry.path }),
                  );
                event.dataTransfer.effectAllowed = 'move';
                const payload = onStartDrag(paths);
                activeDragRef.current = payload;
                if (payload) event.dataTransfer.setData(FILE_DRAG_MIME, JSON.stringify(payload));
              }}
              onDragEnd={() => {
                activeDragRef.current = undefined;
                setDropTarget(undefined);
                onEndDrag();
              }}
              onDragOver={(event) => {
                const external =
                  isExternalFileTransfer(event.dataTransfer) && !dropPayload(event.dataTransfer);
                if (
                  !acceptsTransfer(event.dataTransfer) ||
                  (entry.type !== 'directory' && !external)
                )
                  return;
                event.preventDefault();
                event.stopPropagation();
                event.dataTransfer.dropEffect = dropEffect(event.dataTransfer);
                setDropTarget(entry.type === 'directory' ? entry.path : 'current');
              }}
              onDragLeave={() => setDropTarget(undefined)}
              onDrop={(event) => {
                const external =
                  isExternalFileTransfer(event.dataTransfer) && !dropPayload(event.dataTransfer);
                if (entry.type !== 'directory' && !external) return;
                event.preventDefault();
                event.stopPropagation();
                setDropTarget(undefined);
                commitDrop(event, entry.type === 'directory' ? entry.path : currentPath);
              }}
              onKeyDown={(event) => {
                if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                  event.preventDefault();
                  event.stopPropagation();
                  moveSelection(event.key === 'ArrowDown' ? 1 : -1, event.shiftKey);
                } else if (event.key === 'Home' || event.key === 'End') {
                  event.preventDefault();
                  event.stopPropagation();
                  const targetPath =
                    orderedPaths[event.key === 'Home' ? 0 : orderedPaths.length - 1];
                  if (!targetPath) return;
                  const next = selectFilePath({
                    orderedPaths,
                    selection,
                    targetPath,
                    range: event.shiftKey,
                  });
                  onSelectionChange(next);
                  focusFile(targetPath);
                } else if (event.key === 'Enter') {
                  event.preventDefault();
                  event.stopPropagation();
                  onOpen(entry);
                } else if (event.key === ' ') {
                  event.preventDefault();
                  event.stopPropagation();
                  onSelectionChange(
                    selectFilePath({
                      orderedPaths,
                      selection,
                      targetPath: entry.path,
                      additive: isPlatformSelectionModifier(event),
                    }),
                  );
                }
              }}
            >
              {columns.map((column) => (
                <span key={column} title={fileColumnValue(entry, column, x, language)}>
                  {column === 'name' && <FileEntryIcon entry={entry} />}
                  {fileColumnValue(entry, column, x, language)}
                </span>
              ))}
            </button>
          );
        })}
        <div
          className={cx('file-row-spacer')}
          style={{ height: (entries.length - end) * rowHeight }}
        />
      </div>
      <div className={cx('file-table-page')} aria-live="polite">
        {selection.paths.size
          ? `${x('fileTable.selectedCount', { count: selection.paths.size })} · `
          : ''}
        {entries.length ? `${start + 1}–${end} / ${entries.length}` : '0 / 0'}
      </div>
    </div>
  );
}

function isPlatformSelectionModifier(event: { ctrlKey: boolean; metaKey: boolean }): boolean {
  return isMacPlatform() ? event.metaKey : event.ctrlKey;
}

function parseFileDragPayload(transfer: DataTransfer): FileDragPayload | undefined {
  try {
    const value = JSON.parse(transfer.getData(FILE_DRAG_MIME)) as Partial<FileDragPayload>;
    if (
      (value.scope !== 'local' && value.scope !== 'remote') ||
      typeof value.authority !== 'string' ||
      !value.authority ||
      !Array.isArray(value.paths) ||
      !value.paths.length ||
      value.paths.length > 1_000 ||
      value.paths.some((path) => typeof path !== 'string' || !path || path.length > 4_096)
    )
      return undefined;
    return { scope: value.scope, authority: value.authority, paths: value.paths as string[] };
  } catch {
    return undefined;
  }
}

function isMacPlatform(): boolean {
  return (globalThis.navigator?.platform.toLocaleLowerCase() ?? '').includes('mac');
}

function FileEntryIcon({ entry }: { entry: FileTableEntry }) {
  return entry.type === 'directory' ? (
    <Folder size={15} />
  ) : entry.type === 'file' ? (
    <FileCode2 size={15} />
  ) : (
    <File size={15} />
  );
}

function fileColumnLabel(column: FileManagerColumn, x: Translator): string {
  const key = FILE_MANAGER_COLUMNS.find(({ id }) => id === column)?.labelKey;
  return key ? x(key) : column;
}

function fileColumnValue(
  entry: FileTableEntry,
  column: FileManagerColumn,
  x: Translator,
  language: string,
): string {
  if (column === 'name') return entry.name;
  if (column === 'size')
    return entry.type === 'directory' ? x('fileManager.directory') : formatBytes(entry.size);
  if (column === 'modifiedAt' || column === 'accessedAt') {
    const value = entry[column];
    return value ? new Date(value).toLocaleString(language, { hour12: false }) : '—';
  }
  if (column === 'mode') return entry.mode === undefined ? '—' : (entry.mode & 0o7777).toString(8);
  if (column === 'extension') {
    const separator = entry.name.lastIndexOf('.');
    return separator > 0 && separator < entry.name.length - 1
      ? entry.name.slice(separator + 1)
      : '—';
  }
  return entry[column] ?? '—';
}
