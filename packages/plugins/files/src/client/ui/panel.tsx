import type { Connection, FtpConnection } from '@axterm/plugin-api/connections';
import type { Host } from '@axterm/plugin-api/catalog';
import type { Settings } from '@axterm/plugin-api/configuration';
import type { Transfer, CreateTransferInput } from '@axterm/plugin-api/transfers';
import type {
  FileGrant,
  FileComparison,
  RemoteFileEntry,
  RemoteFileTarget,
} from '@axterm/plugin-api/files';
import type { FilesSessionOwner } from './session-owner.ts';
import { FileInfoDialog, FileTable } from './table.tsx';
import { cx } from './styles.ts';
import {
  Check,
  ChevronUp,
  ClipboardPaste,
  Copy,
  Download,
  Eye,
  EyeOff,
  FileCode2,
  FilePlus2,
  Filter,
  Folder,
  FolderInput,
  FolderOpen,
  FolderPlus,
  Info,
  KeyRound,
  ListChecks,
  Pencil,
  RefreshCw,
  Scissors,
  Server,
  Star,
  Terminal as TerminalIcon,
  Trash2,
  Upload,
  X,
} from 'lucide-react';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ExternalEditorDialog } from './external-editor-dialog';
import { FileComparisonDialog } from './file-comparison-dialog';
import { FileContextMenu, type FileContextMenuItem } from './file-context-menu';
import { RemoteEditor } from './remote-editor';
import { droppedFilesError } from './file-drop-model.ts';
import { TextInputDialog } from './text-input-dialog';
import { useI18n } from './i18n.tsx';
import type { FilesMessageKey as AxtermMessageKey } from './locales.ts';
import { useWorkspace } from './hooks.tsx';
import {
  filterFileEntries,
  sortFileEntries,
  type FileManagerSort,
  type FileTableEntry,
} from './file-list-model.ts';
import {
  createFileSelection,
  selectAllFilePaths,
  singleSelectedFilePath,
} from './file-selection-model.ts';
import { messageOf } from './format.ts';
import { EmptyState, ErrorBanner, Modal, PanelFrame } from './scaffold.tsx';
import type {
  FileDragPayload,
  FileManagerColumn,
  FileOperationClipboard,
  FilePaneScope,
} from './file-manager-model.ts';
import {
  DEFAULT_FILE_MANAGER_COLUMNS,
  DEFAULT_FILE_MANAGER_SORT,
  FILE_MANAGER_COLUMNS,
  appendLocalPath,
  appendRemotePath,
  boundedPathHistory,
  fileManagerDropError,
  localAbsoluteAddress,
  localParentPath,
  localRelativeAddress,
  normalizeLocalAddress,
  normalizeRemoteAddress,
} from './file-manager-model.ts';
import { useLocalDirectoryGrant, useDirectory, useRemoteHome } from './hooks.tsx';

export function FilesPanel({
  owner,
  initialLocalDirectoryGrantId,
  session,
  active = true,
  hosts,
  connections,
  ftpConnections,
  transfers,

  settings,
  getActiveSshDirectory,
  requestedSshDirectory,
}: {
  owner: FilesSessionOwner;
  initialLocalDirectoryGrantId?: string;
  session?: { kind: 'local' } | { kind: 'ssh'; connectionId: string } | undefined;
  active?: boolean;
  hosts: Host[];
  connections: Connection[];
  ftpConnections: FtpConnection[];
  transfers: Transfer[];

  settings: Settings | undefined;
  getActiveSshDirectory: (() => { connectionId: string; path: string } | undefined) | undefined;
  requestedSshDirectory?: { connectionId: string; path: string; nonce: string } | undefined;
}) {
  const { x } = useI18n();
  const model = owner.files,
    commands = owner.commands;
  const targetFor = (id = effectiveConnectionId): RemoteFileTarget => ({
    protocol: ftpReady.some((item) => item.id === id) ? 'ftp' : 'sftp',
    connectionId: id,
  });
  const queueTransfer = (
    id: string,
    direction: 'upload' | 'download',
    input: Omit<
      Extract<CreateTransferInput, { direction: 'upload' | 'download' }>,
      'target' | 'direction'
    >,
  ) => {
    const request = { target: targetFor(id), direction, ...structuredClone(input) };
    return commands.command(async (key) => {
      const result = await owner.handoffs.create(key, request);
      await owner.releaseTemporary(input.grantId);
      return result;
    });
  };
  const ready = connections.filter((connection) => connection.state === 'ready');
  const ftpReady = ftpConnections.filter((connection) => connection.state === 'ready');
  const fileManagerView = useWorkspace((state) => state.fileManagerView);
  const fileManagerSplitPercent = useWorkspace((state) => state.fileManagerSplitPercent);
  const setFileManagerView = useWorkspace((state) => state.setFileManagerView);
  const setFileManagerSplitPercent = useWorkspace((state) => state.setFileManagerSplitPercent);

  const activeFtpConnectionId = useWorkspace((state) => state.activeFtpConnectionId);
  const setActiveFtpConnection = useWorkspace((state) => state.setActiveFtpConnection);
  const initialFtpDirectory = ftpReady.find(
    ({ id }) => id === activeFtpConnectionId,
  )?.initialDirectory;
  const [connectionId, setConnectionId] = useState(
    session?.kind === 'ssh'
      ? session.connectionId
      : (requestedSshDirectory?.connectionId ?? activeFtpConnectionId ?? ready[0]?.id ?? ''),
  );
  const [path, setPath] = useState(requestedSshDirectory?.path ?? initialFtpDirectory ?? '/');
  const [pathInput, setPathInput] = useState(
    requestedSshDirectory?.path ?? initialFtpDirectory ?? '/',
  );
  const [remoteSelection, setRemoteSelection] = useState(createFileSelection);
  const {
    grant: localGrant,
    dropFailure,
    select: selectLocalDirectory,
  } = useLocalDirectoryGrant(owner);
  const selectedDirectory = useRef<string>();

  const localFilePanelMountedRef = useRef(true);
  const defaultLocalGrantRequestedRef = useRef(false);
  const followedTerminalDirectoryRef = useRef('');
  const externalDropControllerRef = useRef<AbortController | undefined>(undefined);
  const splitDefaultAppliedRef = useRef(false);
  const [localPath, setLocalPath] = useState('');
  const [localPathInput, setLocalPathInput] = useState('/');
  const [localSelection, setLocalSelection] = useState(createFileSelection);
  const [localHistory, setLocalHistory] = useState<string[]>(
    initialLocalDirectoryGrantId ? [''] : [],
  );
  useEffect(() => {
    if (!localGrant || selectedDirectory.current === localGrant.grantId) return;
    selectedDirectory.current = localGrant.grantId;
    setLocalPath('');
    setLocalPathInput(localAbsoluteAddress(localGrant, ''));
    setLocalSelection(createFileSelection());
    setLocalHistory(['']);
  }, [localGrant]);
  const [remoteHistory, setRemoteHistory] = useState<string[]>([]);
  const [localBookmarks, setLocalBookmarks] = useState<string[]>([]);
  const [localShowHiddenOverride, setLocalShowHiddenOverride] = useState<boolean>();
  const [remoteShowHiddenOverride, setRemoteShowHiddenOverride] = useState<boolean>();
  const [localKeywordDraft, setLocalKeywordDraft] = useState('');
  const [localKeyword, setLocalKeyword] = useState('');
  const [remoteKeywordDraft, setRemoteKeywordDraft] = useState('');
  const [remoteKeyword, setRemoteKeyword] = useState('');
  const [editing, setEditing] = useState<string>();
  const [externalEditor, setExternalEditor] = useState<string>();
  const [externalEditorBusy, setExternalEditorBusy] = useState(false);
  const [fileComparison, setFileComparison] = useState<FileComparison>();
  const [fileComparisonBusy, setFileComparisonBusy] = useState(false);
  const [fileDialog, setFileDialog] = useState<
    | {
        kind: 'create';
        scope: 'local' | 'remote';
        entryType: 'file' | 'directory';
        editAfterCreate?: boolean;
      }
    | { kind: 'rename'; scope: 'local' | 'remote'; path: string; initialValue: string }
  >();
  const [fileMenu, setFileMenu] = useState<{
    scope: 'local' | 'remote';
    entry: FileTableEntry | null;
    x: number;
    y: number;
  }>();
  const [fileInfo, setFileInfo] = useState<{
    scope: 'local' | 'remote';
    entry: FileTableEntry;
  }>();
  const [fileNotice, setFileNotice] = useState('');
  const [fileClipboard, setFileClipboard] = useState<FileOperationClipboard>();
  const [fileDrag, setFileDrag] = useState<FileDragPayload>();
  const [crossPaneDrop, setCrossPaneDrop] = useState<{
    payload: FileDragPayload;
    targetScope: FilePaneScope;
    destination: string;
  }>();
  const [crossPaneTransferBusy, setCrossPaneTransferBusy] = useState(false);
  const [remoteCopyDialog, setRemoteCopyDialog] = useState<{ paths: string[] }>();
  const [remoteCopyTargetConnectionId, setRemoteCopyTargetConnectionId] = useState('');
  const [remoteCopyTargetPath, setRemoteCopyTargetPath] = useState('/');
  const [remoteCopyBusy, setRemoteCopyBusy] = useState(false);
  const [remotePathConnectionId, setRemotePathConnectionId] = useState('');
  const [remotePaths, setRemotePaths] = useState<Record<string, string>>({});
  const [externalDropBusy, setExternalDropBusy] = useState(false);
  const [conflictApplyToAll, setConflictApplyToAll] = useState(false);
  const [conflictDecisionBusy, setConflictDecisionBusy] = useState(false);
  const [error, setError] = useState('');
  const [observedDropFailure, setObservedDropFailure] = useState(dropFailure);
  if (dropFailure !== observedDropFailure) {
    setObservedDropFailure(dropFailure);
    if (dropFailure) setError(x('fileManager.localLoadFailed'));
  }
  const effectiveFileManagerView = session?.kind === 'local' ? 'local' : fileManagerView;
  const effectiveConnectionId =
    session?.kind === 'ssh'
      ? session.connectionId
      : connectionId || activeFtpConnectionId || ready[0]?.id || ftpReady[0]?.id || '';
  const ftpMode = ftpReady.some(({ id }) => id === effectiveConnectionId);
  const sshConnectionReady = ready.some(({ id }) => id === effectiveConnectionId);
  const effectiveHostId = connections.find(({ id }) => id === effectiveConnectionId)?.hostId;
  const pendingConflict = transfers.find(
    (transfer) => transfer.state === 'awaiting-decision' && transfer.conflict,
  );
  const remoteBookmarks =
    settings?.fileManager.remoteAddressBookmarks.filter(
      ({ hostId }) => hostId === null || hostId === effectiveHostId,
    ) ?? [];
  const fileColumns = settings?.fileManager.columns ?? DEFAULT_FILE_MANAGER_COLUMNS;
  const localSort = settings?.fileManager.localSort ?? DEFAULT_FILE_MANAGER_SORT;
  const remoteSort = settings?.fileManager.remoteSort ?? DEFAULT_FILE_MANAGER_SORT;
  const localShowHidden = localShowHiddenOverride ?? settings?.fileManager.showHiddenFiles ?? true;
  const remoteShowHidden =
    remoteShowHiddenOverride ?? settings?.fileManager.showHiddenFiles ?? true;
  const remotePathBookmarked = remoteBookmarks.some((item) => item.path === path);
  const requestedRemotePath =
    requestedSshDirectory?.connectionId === effectiveConnectionId
      ? requestedSshDirectory.path
      : undefined;
  const remoteHome = useRemoteHome(
    owner,
    effectiveConnectionId ? targetFor() : undefined,
    active &&
      effectiveFileManagerView !== 'local' &&
      sshConnectionReady &&
      !ftpMode &&
      !requestedRemotePath,
  );
  const selected = singleSelectedFilePath(remoteSelection);
  const remoteDirectory = useDirectory(owner, 'remote', {
    target: effectiveConnectionId ? targetFor() : undefined,
    path,
    enabled:
      active &&
      effectiveFileManagerView !== 'local' &&
      !!effectiveConnectionId &&
      (ftpMode || sshConnectionReady) &&
      remotePathConnectionId === effectiveConnectionId,
  });
  const files = {
    ...remoteDirectory,
    data: remoteDirectory.data?.entries as RemoteFileEntry[] | undefined,
  };
  const localFiles = useDirectory(owner, 'local', {
    grantId: localGrant?.grantId,
    path: localPath,
    enabled: active && !!localGrant,
  });
  useEffect(() => {
    if (!active || !settings?.fileManager.refreshOnFocus) return;
    const refresh = () => {
      if (localGrant && effectiveFileManagerView !== 'remote')
        void owner.local.refresh().catch(() => undefined);
      if (effectiveConnectionId && effectiveFileManagerView !== 'local')
        void owner.remote.refresh().catch(() => undefined);
    };
    window.addEventListener('focus', refresh);
    return () => window.removeEventListener('focus', refresh);
  }, [
    active,
    settings?.fileManager.refreshOnFocus,
    localGrant,
    effectiveConnectionId,
    effectiveFileManagerView,
    owner,
  ]);
  const selectedLocalPath = singleSelectedFilePath(localSelection);
  const localComparisonEntry = localFiles.data?.entries.find(
    ({ path: entryPath }) => entryPath === selectedLocalPath,
  );
  const remoteComparisonEntry = files.data?.find(({ path: entryPath }) => entryPath === selected);
  const canCompareFiles =
    !!localGrant &&
    !!effectiveConnectionId &&
    localComparisonEntry?.type === 'file' &&
    remoteComparisonEntry?.type === 'file' &&
    !ftpMode;

  useEffect(() => {
    if (
      !active ||
      effectiveFileManagerView === 'local' ||
      !effectiveConnectionId ||
      (!ftpMode && !sshConnectionReady)
    )
      return;
    const remembered = remotePaths[effectiveConnectionId];
    const ftpInitial = ftpReady.find(({ id }) => id === effectiveConnectionId)?.initialDirectory;
    const followed = settings?.fileManager.followTerminalCwd
      ? getActiveSshDirectory?.()
      : undefined;
    const target =
      requestedRemotePath ??
      remembered ??
      ftpInitial ??
      (followed?.connectionId === effectiveConnectionId ? followed.path : undefined) ??
      remoteHome.data?.path ??
      (remoteHome.isError ? '/' : undefined);
    if (!target || remotePathConnectionId === effectiveConnectionId) return;
    let canceled = false;
    queueMicrotask(() => {
      if (canceled) return;
      setRemotePaths((current) =>
        current[effectiveConnectionId] === target
          ? current
          : { ...current, [effectiveConnectionId]: target },
      );
      setPath(target);
      setPathInput(target);
      setRemotePathConnectionId(effectiveConnectionId);
      setRemoteSelection(createFileSelection());
      setRemoteHistory((current) => boundedPathHistory(target, current));
      setRemoteKeyword('');
      setRemoteKeywordDraft('');
      if (remoteHome.isError && !remembered && !requestedRemotePath && !ftpInitial)
        setError(x('fileManager.remoteHomeFallback'));
    });
    return () => {
      canceled = true;
    };
  }, [
    active,
    effectiveConnectionId,
    effectiveFileManagerView,
    ftpReady,
    ftpMode,
    getActiveSshDirectory,
    remoteHome.data?.path,
    remoteHome.isError,
    remotePathConnectionId,
    remotePaths,
    requestedRemotePath,
    settings?.fileManager.followTerminalCwd,
    sshConnectionReady,
    x,
  ]);
  useEffect(() => {
    if (!active || localGrant || defaultLocalGrantRequestedRef.current) return;
    defaultLocalGrantRequestedRef.current = true;
    // The session kind is known from the tab itself, so the default scope never
    // depends on the connection becoming ready after the first render.
    void selectLocalDirectory(session?.kind === 'ssh' ? 'downloads-directory' : 'home-directory')
      .then(async (grant) => {
        if (!grant) return;
        setLocalPath('');
        setLocalPathInput(localAbsoluteAddress(grant, ''));
        setLocalSelection(createFileSelection());
        setLocalHistory(['']);
        setLocalBookmarks([]);
        setError('');
      })
      .catch(() => {
        if (localFilePanelMountedRef.current) setError(x('fileManager.localLoadFailed'));
      });
  }, [active, localGrant, selectLocalDirectory, session?.kind, x]);
  useEffect(() => {
    if (!active) return;
    if (splitDefaultAppliedRef.current || !settings || ftpMode || !effectiveConnectionId) return;
    splitDefaultAppliedRef.current = true;
    if (settings.fileManager.sshSplitView) setFileManagerView('split');
  }, [active, effectiveConnectionId, ftpMode, setFileManagerView, settings]);
  useEffect(() => {
    if (!active || !settings?.fileManager.followTerminalCwd || ftpMode) {
      followedTerminalDirectoryRef.current = '';
      return;
    }
    const follow = () => {
      const target = getActiveSshDirectory?.();
      if (!target?.path.startsWith('/')) return;
      const key = `${target.connectionId}:${target.path}`;
      if (followedTerminalDirectoryRef.current === key) return;
      followedTerminalDirectoryRef.current = key;
      setConnectionId(target.connectionId);
      setPath(target.path);
      setPathInput(target.path);
      setRemoteSelection(createFileSelection());
      setRemoteHistory((current) => boundedPathHistory(target.path, current));
      setRemoteKeyword('');
      setRemoteKeywordDraft('');
      setError('');
      if (fileManagerView === 'local') setFileManagerView('split');
    };
    follow();
    const timer = window.setInterval(follow, 1_000);
    return () => window.clearInterval(timer);
  }, [
    active,
    fileManagerView,
    ftpMode,
    getActiveSshDirectory,
    setFileManagerView,
    settings?.fileManager.followTerminalCwd,
  ]);
  useEffect(() => {
    localFilePanelMountedRef.current = true;
    return () => {
      localFilePanelMountedRef.current = false;
      externalDropControllerRef.current?.abort();
    };
  }, []);

  async function chooseLocalDirectory() {
    try {
      const grant = await selectLocalDirectory('open-directory');
      if (!grant) return;
      setLocalPath('');
      setLocalPathInput(localAbsoluteAddress(grant, ''));
      setLocalSelection(createFileSelection());
      setLocalHistory(['']);
      setLocalBookmarks([]);
      setLocalKeyword('');
      setLocalKeywordDraft('');
      setFileManagerView(fileManagerView === 'remote' ? 'split' : fileManagerView);
    } catch (cause) {
      setError(messageOf(cause, x));
    }
  }

  function navigateLocalPath(nextPath: string) {
    try {
      const normalized = normalizeLocalAddress(nextPath, x);
      setLocalPath(normalized);
      setLocalPathInput(localAbsoluteAddress(localGrant, normalized));
      setLocalSelection(createFileSelection());
      setLocalHistory((current) => boundedPathHistory(normalized, current));
      setLocalKeyword('');
      setLocalKeywordDraft('');
      setError('');
    } catch (cause) {
      setError(messageOf(cause, x));
    }
  }

  async function navigateLocalAddress(nextAddress: string) {
    try {
      const relativePath = localRelativeAddress(nextAddress, localGrant, x);
      if (relativePath !== undefined) {
        navigateLocalPath(relativePath);
        return;
      }
      const grant = await selectLocalDirectory('directory-path', nextAddress.trim());
      if (!grant) return;
      setLocalPath('');
      setLocalPathInput(localAbsoluteAddress(grant, ''));
      setLocalSelection(createFileSelection());
      setLocalHistory(['']);
      setLocalBookmarks([]);
      setLocalKeyword('');
      setLocalKeywordDraft('');
      setError('');
    } catch (cause) {
      setError(messageOf(cause, x));
    }
  }

  function navigateRemote(nextPath: string, targetConnectionId = effectiveConnectionId) {
    try {
      const normalized = normalizeRemoteAddress(nextPath, x);
      if (targetConnectionId)
        setRemotePaths((current) => ({ ...current, [targetConnectionId]: normalized }));
      setPath(normalized);
      setPathInput(normalized);
      setRemotePathConnectionId(targetConnectionId);
      setRemoteSelection(createFileSelection());
      setRemoteHistory((current) => boundedPathHistory(normalized, current));
      setRemoteKeyword('');
      setRemoteKeywordDraft('');
      setError('');
    } catch (cause) {
      setError(messageOf(cause, x));
    }
  }

  function toggleLocalBookmark() {
    if (!localGrant) return;
    setLocalBookmarks((current) =>
      current.includes(localPath)
        ? current.filter((item) => item !== localPath)
        : [localPath, ...current].slice(0, 32),
    );
  }

  async function persistFileManager(patch: Partial<Settings['fileManager']>) {
    if (!settings) return false;
    try {
      await commands.command((key) =>
        owner.ctx.configurationActions.setFileManagerPreferences(
          key,
          structuredClone(patch),
          '"v' + settings.version + '"',
        ),
      );
      return true;
    } catch (cause) {
      setError(messageOf(cause, x));
      return false;
    }
  }

  async function toggleRemoteBookmark() {
    if (!settings || !effectiveConnectionId) return;
    const hostId = connections.find(({ id }) => id === effectiveConnectionId)?.hostId ?? null;
    const current = settings.fileManager.remoteAddressBookmarks;
    const exists = current.find((item) => item.hostId === hostId && item.path === path);
    const remoteAddressBookmarks = exists
      ? current.filter(({ id }) => id !== exists.id)
      : [{ id: crypto.randomUUID(), hostId, path }, ...current].slice(0, 64);
    await persistFileManager({ remoteAddressBookmarks });
  }

  async function changeFileSort(scope: 'local' | 'remote', property: FileManagerColumn) {
    const current = scope === 'local' ? localSort : remoteSort;
    const next: FileManagerSort = {
      property,
      direction: current.property === property && current.direction === 'desc' ? 'asc' : 'desc',
    };
    await persistFileManager(scope === 'local' ? { localSort: next } : { remoteSort: next });
  }

  async function toggleFileColumn(column: FileManagerColumn) {
    if (column === 'name') return;
    const selected = new Set(fileColumns);
    if (selected.has(column)) selected.delete(column);
    else selected.add(column);
    const columns = FILE_MANAGER_COLUMNS.map(({ id }) => id).filter(
      (candidate) => candidate === 'name' || selected.has(candidate),
    );
    await persistFileManager({ columns });
  }

  async function toggleHiddenFiles(scope: 'local' | 'remote') {
    const current = scope === 'local' ? localShowHidden : remoteShowHidden;
    if (scope === 'local') {
      setRemoteShowHiddenOverride(remoteShowHidden);
      setLocalShowHiddenOverride(!current);
      setLocalSelection(createFileSelection());
    } else {
      setLocalShowHiddenOverride(localShowHidden);
      setRemoteShowHiddenOverride(!current);
      setRemoteSelection(createFileSelection());
    }
    await persistFileManager({ showHiddenFiles: !current });
  }

  const followDirectory = useRef<(target: { connectionId: string; path: string }) => void>(
    () => {},
  );
  useLayoutEffect(() => {
    followDirectory.current = (target) => {
      setConnectionId(target.connectionId);
      navigateRemote(target.path, target.connectionId);
      setFileManagerView(fileManagerView === 'local' ? 'split' : fileManagerView);
    };
  });
  useEffect(() => {
    const follow = (target: { connectionId: string; path: string }) =>
      followDirectory.current(target);
    return owner.registerDirectoryFollower(follow);
  }, [owner]);

  function followActiveTerminalDirectory() {
    const target = getActiveSshDirectory?.();
    if (!target) {
      setError(x('fileManager.noActiveSshDirectory'));
      return;
    }
    setConnectionId(target.connectionId);
    navigateRemote(target.path);
    setFileManagerView(fileManagerView === 'local' ? 'split' : fileManagerView);
  }

  function resizeFilePanes(event: React.PointerEvent<HTMLDivElement>) {
    const paneContainer = event.currentTarget.parentElement;
    if (!paneContainer) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    const move = (pointer: PointerEvent) => {
      const bounds = paneContainer.getBoundingClientRect();
      if (!bounds.width) return;
      setFileManagerSplitPercent(((pointer.clientX - bounds.left) / bounds.width) * 100);
    };
    const finish = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', finish);
      owner.cleanups.delete(finish);
    };
    owner.cleanups.add(finish);
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', finish, { once: true });
  }

  async function upload(kind: 'open-file' | 'open-directory') {
    try {
      const grant = await owner.acquireUpload({ kind });
      if (!grant) return;
      const remotePath = `${path.replace(/\/$/, '')}/${grant.name}`;
      await queueTransfer(effectiveConnectionId, 'upload', {
        grantId: grant.grantId,
        remotePath,
        recursive: kind === 'open-directory',
        conflict: 'ask',
      });
    } catch (cause) {
      setError(messageOf(cause, x));
    }
  }

  async function uploadDroppedFiles(
    droppedFiles: readonly File[],
    destination: string,
    includesDirectory: boolean,
  ) {
    if (externalDropBusy || !effectiveConnectionId) return;
    const validationError = droppedFilesError(droppedFiles, includesDirectory);
    if (validationError) {
      setError(fileManagerDropError(validationError, x));
      return;
    }
    externalDropControllerRef.current?.abort();
    const controller = new AbortController();
    externalDropControllerRef.current = controller;
    setExternalDropBusy(true);
    setError('');
    setFileNotice(x('fileManager.dropPreparing', { count: droppedFiles.length }));
    let queued = 0;
    let pendingGrant: FileGrant | undefined;
    try {
      for (const file of droppedFiles) {
        pendingGrant = await owner.importUpload(file, controller.signal);
        controller.signal.throwIfAborted();
        await queueTransfer(effectiveConnectionId, 'upload', {
          grantId: pendingGrant.grantId,
          remotePath: appendRemotePath(destination, pendingGrant.name),
          recursive: false,
          conflict: 'ask',
        });
        pendingGrant = undefined;
        queued += 1;
      }

      setFileNotice(
        x('fileManager.transferQueued', {
          count: queued,
          direction: x('fileManager.uploadDirection'),
        }),
      );
    } catch (cause) {
      if (pendingGrant) await owner.releaseTemporary(pendingGrant.grantId);
      if (queued && localFilePanelMountedRef.current) {
        setFileNotice(x('fileManager.transferPartiallyQueued', { count: queued }));
      }
      if (!controller.signal.aborted && localFilePanelMountedRef.current)
        setError(messageOf(cause, x));
    } finally {
      if (externalDropControllerRef.current === controller)
        externalDropControllerRef.current = undefined;
      if (localFilePanelMountedRef.current) setExternalDropBusy(false);
    }
  }
  async function download() {
    const entry = files.data?.find((item) => item.path === selected);
    if (!entry || !localGrant) return;
    try {
      await queueTransfer(effectiveConnectionId, 'download', {
        // Downloads intentionally share the directory grant and relative path currently
        // displayed in the left pane, rather than invoking a new native save dialog.
        grantId: localGrant.grantId,
        localPath: appendLocalPath(localPath, entry.name),
        remotePath: entry.path,
        recursive: entry.type === 'directory',
        conflict: 'ask',
      });
    } catch (cause) {
      setError(messageOf(cause, x));
    }
  }
  async function chmodEntry(scope: FilePaneScope, entryPath: string, mode: number): Promise<void> {
    try {
      if (scope === 'local') {
        if (!localGrant) throw Error(x('fileManager.localGrantExpired'));
        const id = localGrant.grantId,
          input = { path: entryPath, mode };
        await commands.file((key, signal) => model.chmodEntry(key, id, input, signal));
      } else {
        if (ftpMode) throw Error(x('fileManager.ftpChmodUnavailable'));
        const target = targetFor(),
          input = { path: entryPath, mode };
        await commands.file((key, signal) => model.chmodRemoteEntry(key, target, input, signal));
      }
      setFileNotice(
        x('fileManager.chmodSuccess', { path: entryPath, mode: mode.toString(8).padStart(4, '0') }),
      );
    } catch (cause) {
      setError(messageOf(cause, x));
      throw cause;
    }
  }
  async function createEntry(
    scope: 'local' | 'remote',
    entryType: 'file' | 'directory',
    name: string,
    editAfterCreate = false,
  ): Promise<boolean> {
    try {
      if (scope === 'local') {
        if (!localGrant) return false;
        const id = localGrant.grantId,
          input = { path: localPath, name, type: entryType };
        await commands.file((key, signal) => model.createEntry(key, id, input, signal));
      } else {
        const target = targetFor(),
          input = { path: appendRemotePath(path, name), type: entryType };
        await commands.file((key, signal) => model.createRemoteEntry(key, target, input, signal));
        if (entryType === 'file' && editAfterCreate) setEditing(input.path);
      }
      return true;
    } catch (cause) {
      setError(messageOf(cause, x));
      return false;
    }
  }
  async function renameEntry(
    scope: 'local' | 'remote',
    entryPath: string,
    nextName: string,
  ): Promise<boolean> {
    try {
      if (scope === 'local') {
        if (!localGrant) return false;
        const id = localGrant.grantId,
          input = { path: entryPath, name: nextName };
        await commands.file((key, signal) => model.renameEntry(key, id, input, signal));
        setLocalSelection(createFileSelection());
      } else {
        const target = targetFor(),
          parent = entryPath.replace(/\/[^/]+$/, '') || '/',
          input = { from: entryPath, to: appendRemotePath(parent, nextName) };
        await commands.file((key, signal) => model.renameRemoteEntry(key, target, input, signal));
        setRemoteSelection(createFileSelection());
      }
      return true;
    } catch (cause) {
      setError(messageOf(cause, x));
      return false;
    }
  }
  async function deleteEntries(scope: 'local' | 'remote', paths: readonly string[]) {
    if (!paths.length) return;
    const target =
      paths.length === 1
        ? `“${paths[0]}”`
        : x('fileManager.selectedItems', { count: paths.length });
    if (
      !window.confirm(
        x('fileManager.deleteConfirm', {
          scope: x(scope === 'local' ? 'fileManager.localScope' : 'fileManager.remoteScope'),
          target,
        }),
      )
    )
      return;
    try {
      for (const entryPath of paths) {
        if (scope === 'local') {
          if (!localGrant) return;
          await commands.file((key, signal) =>
            model.deleteEntry(key, localGrant!.grantId, entryPath, signal),
          );
        } else
          await commands.file((key, signal) =>
            model.deleteRemoteEntry(key, targetFor(), entryPath, signal),
          );
      }
      if (scope === 'local') {
        setLocalSelection(createFileSelection());
        await localFiles.refetch();
      } else {
        setRemoteSelection(createFileSelection());
        await files.refetch();
      }
    } catch (cause) {
      setError(messageOf(cause, x));
    }
  }

  async function openFileEntry(scope: 'local' | 'remote', entry: FileTableEntry) {
    try {
      if (entry.type === 'directory') {
        if (scope === 'local') navigateLocalPath(entry.path);
        else navigateRemote(entry.path);
      } else if (scope === 'local') {
        if (!localGrant) return;
        await commands.file((key, signal) =>
          model.performNativeFileOperation(
            key,
            { grantId: localGrant!.grantId, path: entry.path, action: 'open' },
            signal,
          ),
        );
        setFileNotice(x('fileManager.openedDefault', { name: entry.name }));
      } else if (ftpMode) setError(x('fileManager.ftpDownloadToEdit'));
      else setEditing(entry.path);
    } catch (cause) {
      setError(messageOf(cause, x));
    }
  }

  async function revealLocalEntry(entry: FileTableEntry) {
    if (!localGrant) return;
    try {
      await commands.file((key, signal) =>
        model.performNativeFileOperation(
          key,
          { grantId: localGrant!.grantId, path: entry.path, action: 'reveal' },
          signal,
        ),
      );
      setFileNotice(x('fileManager.revealed', { name: entry.name }));
    } catch (cause) {
      setError(messageOf(cause, x));
    }
  }

  async function openTerminalAtDirectory(scope: FilePaneScope, directory: string) {
    if ((scope === 'local' && !localGrant) || (scope === 'remote' && !effectiveConnectionId))
      return;
    try {
      if (scope === 'remote' && ftpMode) {
        setError(x('fileManager.ftpNoTerminal'));
        return;
      }
      const defaultProfileId = settings?.terminal.defaultProfileId ?? undefined;
      await owner.track((signal) =>
        owner.ctx.terminalWorkspaceUi.open(
          {
            kind: scope === 'local' ? 'local' : 'ssh',
            ...(scope === 'remote' ? { connectionId: effectiveConnectionId } : {}),
            ...(defaultProfileId ? { profileId: defaultProfileId } : {}),
            workingDirectory:
              scope === 'local'
                ? { scope: 'local', grantId: localGrant!.grantId, path: directory }
                : { scope: 'remote', path: directory },
            cols: 160,
            rows: 80,
          },
          signal,
        ),
      );
    } catch (cause) {
      setError(messageOf(cause, x));
    }
  }

  async function openExternalEditor(path: string) {
    if (!effectiveConnectionId || externalEditorBusy) return;
    if (ftpMode) {
      setError(x('fileManager.ftpExternalEditUnavailable'));
      return;
    }
    setExternalEditorBusy(true);
    setError('');
    let id: string | undefined;
    const target = targetFor();
    try {
      await commands.file((key, signal) => {
        if (owner.externalSessions.size >= 8) throw Error('FILES_EXTERNAL_EDITOR_CAPACITY');
        id = key;
        owner.externalSessions.add(key);
        return model.createExternalEditor(key, target, path, signal);
      });
      setExternalEditor(id);
    } catch (cause) {
      setError(messageOf(cause, x));
      setExternalEditor(id);
    } finally {
      setExternalEditorBusy(false);
    }
  }

  async function compareSelectedFiles() {
    if (!canCompareFiles || !localGrant || !selectedLocalPath || !selected) return;
    setFileComparisonBusy(true);
    setError('');
    try {
      setFileComparison(
        await model.compareFiles({
          left: { scope: 'local', grantId: localGrant.grantId, path: selectedLocalPath },
          right: { scope: 'remote', target: targetFor(), path: selected },
        }),
      );
    } catch (cause) {
      setError(messageOf(cause, x));
    } finally {
      setFileComparisonBusy(false);
    }
  }

  async function compressAndTransfer(scope: FilePaneScope, entry: FileTableEntry) {
    if (entry.type !== 'directory' || !localGrant || !effectiveConnectionId) return;
    setError('');
    try {
      if (ftpMode) {
        setError(x('fileManager.ftpCompressionUnavailable'));
        return;
      }
      await queueTransfer(effectiveConnectionId, scope === 'local' ? 'upload' : 'download', {
        grantId: localGrant.grantId,
        localPath: scope === 'local' ? entry.path : appendLocalPath(localPath, entry.name),
        remotePath: scope === 'local' ? appendRemotePath(path, entry.name) : entry.path,
        recursive: true,
        archive: true,
        conflict: 'ask',
      });

      setFileNotice(
        x('fileManager.compressedQueued', {
          name: entry.name,
          direction: x(
            scope === 'local' ? 'fileManager.uploadDirection' : 'fileManager.downloadDirection',
          ),
        }),
      );
    } catch (cause) {
      setError(messageOf(cause, x));
    }
  }

  async function copyFilePaths(scope: 'local' | 'remote', paths: string[]) {
    try {
      if (scope === 'local') {
        if (!localGrant) return;
        for (const path of paths) {
          const parent = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
          const listing = await model.listDirectory(
            localGrant.grantId,
            parent,
            owner.lifetime.signal,
          );
          if (!listing.entries.some((entry) => entry.path === path))
            throw Error(x('fileManager.sourceExpired'));
        }
        await navigator.clipboard.writeText(
          paths.map((path) => localAbsoluteAddress(localGrant, path)).join('\n'),
        );
      } else await navigator.clipboard.writeText(paths.join('\n'));
      setFileNotice(x('fileManager.pathsCopied', { count: paths.length }));
    } catch (cause) {
      setError(messageOf(cause, x));
    }
  }

  function fileAuthority(scope: FilePaneScope): string | undefined {
    return scope === 'local' ? localGrant?.grantId : effectiveConnectionId || undefined;
  }

  function stageFileOperation(
    scope: FilePaneScope,
    paths: readonly string[],
    operation: 'copy' | 'move',
  ) {
    const authority = fileAuthority(scope);
    if (!authority || !paths.length) return;
    setFileClipboard({ scope, authority, operation, paths: [...paths] });
    setFileNotice(
      x('fileManager.stagedOperation', {
        operation: x(
          operation === 'copy' ? 'fileManager.copyOperation' : 'fileManager.cutOperation',
        ),
        count: paths.length,
      }),
    );
  }

  function canPasteFiles(scope: FilePaneScope): boolean {
    return (
      !!fileClipboard &&
      fileClipboard.scope === scope &&
      fileClipboard.authority === fileAuthority(scope)
    );
  }

  async function operateFiles(
    scope: FilePaneScope,
    authority: string,
    paths: readonly string[],
    destination: string,
    operation: 'copy' | 'move',
  ) {
    if (!paths.length || authority !== fileAuthority(scope)) {
      setError(x('fileManager.sourceExpired'));
      return;
    }
    try {
      setError('');
      const input = { paths: [...paths], destination, operation, conflict: 'rename' as const };
      if (scope === 'local') {
        await commands.file((key, signal) => model.operateEntries(key, authority, input, signal));
        setLocalSelection(createFileSelection());
      } else {
        if (ftpMode && operation === 'copy') {
          setError(x('fileManager.ftpSiteCopyUnavailable'));
          return;
        }
        const target = targetFor(authority);
        await commands.file((key, signal) =>
          model.operateRemoteEntries(key, target, input, signal),
        );
        setRemoteSelection(createFileSelection());
      }
      if (operation === 'move')
        setFileClipboard((current) =>
          current?.scope === scope && current.authority === authority ? undefined : current,
        );
      setFileNotice(
        x('fileManager.operationComplete', {
          operation: x(
            operation === 'copy' ? 'fileManager.copyOperation' : 'fileManager.movedOperation',
          ),
          count: paths.length,
          destination: destination || '/',
        }),
      );
    } catch (cause) {
      setError(messageOf(cause, x));
    }
  }

  async function pasteFiles(scope: FilePaneScope, destination: string) {
    if (!fileClipboard || !canPasteFiles(scope)) return;
    await operateFiles(
      scope,
      fileClipboard.authority,
      fileClipboard.paths,
      destination,
      fileClipboard.operation,
    );
  }

  function handleFileDrop(
    targetScope: FilePaneScope,
    payload: FileDragPayload,
    destination: string,
  ) {
    if (payload.scope === targetScope) {
      void operateFiles(targetScope, payload.authority, payload.paths, destination, 'move');
      return;
    }
    if (payload.paths.length > 32) {
      setError(x('fileManager.dropLimit'));
      return;
    }
    setCrossPaneDrop({ payload, targetScope, destination });
  }

  function offerContextTransfer(scope: FilePaneScope, paths: string[]) {
    const authority = fileAuthority(scope);
    if (!authority) return;
    handleFileDrop(
      scope === 'local' ? 'remote' : 'local',
      { scope, authority, paths },
      scope === 'local' ? path : localPath,
    );
  }

  async function confirmCrossPaneTransfer() {
    if (!crossPaneDrop || crossPaneTransferBusy || !localGrant || !effectiveConnectionId) return;
    const { payload, targetScope, destination } = crossPaneDrop;
    if (
      (payload.scope === 'local' && payload.authority !== localGrant.grantId) ||
      (payload.scope === 'remote' && payload.authority !== effectiveConnectionId)
    ) {
      setError(x('fileManager.dropSourceExpired'));
      setCrossPaneDrop(undefined);
      return;
    }
    const sourceEntries = payload.scope === 'local' ? localFiles.data?.entries : files.data;
    const entries = payload.paths
      .map((sourcePath) => sourceEntries?.find(({ path: entryPath }) => entryPath === sourcePath))
      .filter((entry): entry is FileTableEntry => !!entry);
    if (entries.length !== payload.paths.length) {
      setError(x('fileManager.dropItemsChanged'));
      setCrossPaneDrop(undefined);
      return;
    }
    setCrossPaneTransferBusy(true);
    setError('');
    let queued = 0;
    try {
      for (const entry of entries) {
        if (payload.scope === 'local' && targetScope === 'remote') {
          await queueTransfer(effectiveConnectionId, 'upload', {
            grantId: localGrant.grantId,
            localPath: entry.path,
            remotePath: appendRemotePath(destination, entry.name),
            recursive: entry.type === 'directory',
            conflict: 'ask',
          });
        } else if (payload.scope === 'remote' && targetScope === 'local') {
          await queueTransfer(effectiveConnectionId, 'download', {
            grantId: localGrant.grantId,
            localPath: appendLocalPath(destination, entry.name),
            remotePath: entry.path,
            recursive: entry.type === 'directory',
            conflict: 'ask',
          });
        }
        queued += 1;
      }

      setFileNotice(
        x('fileManager.transferQueued', {
          count: entries.length,
          direction: x(
            payload.scope === 'local'
              ? 'fileManager.uploadDirection'
              : 'fileManager.downloadDirection',
          ),
        }),
      );
      setCrossPaneDrop(undefined);
    } catch (cause) {
      setError(messageOf(cause, x));
      if (queued > 0) {
        setFileNotice(x('fileManager.transferPartiallyQueued', { count: queued }));

        setCrossPaneDrop(undefined);
      }
    } finally {
      setCrossPaneTransferBusy(false);
    }
  }

  function openRemoteCopyDialog(paths: string[]) {
    if (ftpMode) {
      setError(x('fileManager.ftpRemoteCopyUnavailable'));
      return;
    }
    if (!paths.length || paths.length > 32) {
      setError(x('fileManager.remoteCopyLimit'));
      return;
    }
    setRemoteCopyTargetConnectionId(effectiveConnectionId);
    setRemoteCopyTargetPath(path);
    setRemoteCopyDialog({ paths });
  }

  async function confirmRemoteCopy() {
    if (
      !remoteCopyDialog ||
      remoteCopyBusy ||
      !effectiveConnectionId ||
      !ready.some(({ id }) => id === remoteCopyTargetConnectionId)
    )
      return;
    const entries = remoteCopyDialog.paths
      .map((sourcePath) => files.data?.find(({ path: entryPath }) => entryPath === sourcePath))
      .filter((entry): entry is RemoteFileEntry => !!entry);
    if (entries.length !== remoteCopyDialog.paths.length) {
      setError(x('fileManager.remoteItemsChanged'));
      setRemoteCopyDialog(undefined);
      return;
    }
    let destination: string;
    try {
      destination = normalizeRemoteAddress(remoteCopyTargetPath, x);
    } catch (cause) {
      setError(messageOf(cause, x));
      return;
    }
    setRemoteCopyBusy(true);
    setError('');
    let queued = 0;
    try {
      for (const entry of entries) {
        await commands.command((key) =>
          owner.handoffs.create(key, {
            direction: 'remote-copy',
            source: targetFor(),
            target: targetFor(remoteCopyTargetConnectionId),
            sourcePath: entry.path,
            targetPath: appendRemotePath(destination, entry.name),
            recursive: entry.type === 'directory',
            conflict: 'ask',
          }),
        );
        queued += 1;
      }

      setFileNotice(x('fileManager.remoteCopyQueued', { count: entries.length }));
      setRemoteCopyDialog(undefined);
    } catch (cause) {
      setError(messageOf(cause, x));
      if (queued > 0) {
        setFileNotice(x('fileManager.remoteCopyPartiallyQueued', { count: queued }));

        setRemoteCopyDialog(undefined);
      }
    } finally {
      setRemoteCopyBusy(false);
    }
  }

  async function resolvePendingConflict(strategy: 'skip' | 'overwrite' | 'rename') {
    if (!pendingConflict || conflictDecisionBusy) return;
    setConflictDecisionBusy(true);
    setError('');
    try {
      await commands.command((key) =>
        owner.ctx.transferActions.decideConflict(key, pendingConflict!.id, {
          strategy,
          applyToAll: conflictApplyToAll,
        }),
      );

      setConflictApplyToAll(false);
    } catch (cause) {
      setError(messageOf(cause, x));
    } finally {
      setConflictDecisionBusy(false);
    }
  }

  const menuItems: FileContextMenuItem[] = fileMenu
    ? (() => {
        const { scope, entry } = fileMenu;
        const selection = scope === 'local' ? localSelection : remoteSelection;
        const selectedPaths =
          entry && selection.paths.has(entry.path)
            ? [...selection.paths]
            : entry
              ? [entry.path]
              : [];
        const primaryModifier = isMacPlatform() ? '⌘' : 'Ctrl';
        const items: FileContextMenuItem[] = [];
        if (entry && effectiveConnectionId)
          items.push({
            id: 'transfer',
            label: x(
              scope === 'local' ? 'fileManager.uploadToRemote' : 'fileManager.downloadToLocal',
            ),
            icon: scope === 'local' ? <Upload size={14} /> : <Download size={14} />,
            primary: true,
            disabled: !localGrant,
            onSelect: () => offerContextTransfer(scope, selectedPaths),
          });
        if (!entry && scope === 'remote')
          items.push(
            {
              id: 'upload-file',
              label: x('fileManager.uploadFile'),
              icon: <Upload size={14} />,
              primary: true,
              onSelect: () => void upload('open-file'),
            },
            {
              id: 'upload-directory',
              label: x('fileManager.uploadDirectory'),
              icon: <FolderInput size={14} />,
              onSelect: () => void upload('open-directory'),
            },
          );
        if (entry)
          items.push({
            id: 'open',
            label:
              entry.type === 'directory' ? x('fileManager.enterDirectory') : x('fileManager.open'),
            icon: <FolderOpen size={14} />,
            separatorBefore: !!effectiveConnectionId,
            onSelect: () => openFileEntry(scope, entry),
          });
        if (entry && scope === 'local')
          items.push({
            id: 'reveal',
            label: x('fileManager.reveal'),
            icon: <FolderOpen size={14} />,
            onSelect: () => void revealLocalEntry(entry),
          });
        if (!entry || entry.type === 'directory')
          items.push({
            id: 'open-terminal-here',
            label: x('fileManager.openTerminalHere'),
            icon: <TerminalIcon size={14} />,
            separatorBefore: !entry && scope === 'remote',
            disabled: scope === 'local' ? !localGrant : !effectiveConnectionId,
            ...(scope === 'remote' && ftpMode ? { disabled: true } : {}),
            onSelect: () =>
              void openTerminalAtDirectory(
                scope,
                entry?.path ?? (scope === 'local' ? localPath : path),
              ),
          });
        if (entry?.type === 'file' && scope === 'remote')
          items.push({
            id: 'edit-text',
            label: x('fileManager.editText'),
            icon: <FileCode2 size={14} />,
            disabled: ftpMode,
            onSelect: () => setEditing(entry.path),
          });
        if (entry?.type === 'file' && scope === 'remote')
          items.push({
            id: 'edit-system',
            label: externalEditorBusy
              ? x('fileManager.openingExternalEditor')
              : x('fileManager.useExternalEditor'),
            icon: <FolderOpen size={14} />,
            disabled: externalEditorBusy,
            ...(ftpMode ? { disabled: true } : {}),
            onSelect: () => void openExternalEditor(entry.path),
          });
        if (entry?.type === 'directory')
          items.push({
            id: 'compress-transfer',
            label: x('fileManager.compressAndTransfer'),
            icon: <FolderInput size={14} />,
            disabled: !localGrant || !effectiveConnectionId,
            ...(ftpMode ? { disabled: true } : {}),
            onSelect: () => void compressAndTransfer(scope, entry),
          });
        if (entry)
          items.push({
            id: 'copy',
            label:
              selectedPaths.length > 1
                ? x('fileManager.copySelected', { count: selectedPaths.length })
                : x('fileManager.copy'),
            icon: <Copy size={14} />,
            shortcut: `${primaryModifier}+C`,
            onSelect: () => stageFileOperation(scope, selectedPaths, 'copy'),
          });
        if (entry)
          items.push({
            id: 'cut',
            label:
              selectedPaths.length > 1
                ? x('fileManager.cutSelected', { count: selectedPaths.length })
                : x('fileManager.cut'),
            icon: <Scissors size={14} />,
            shortcut: `${primaryModifier}+X`,
            onSelect: () => stageFileOperation(scope, selectedPaths, 'move'),
          });
        if (entry && scope === 'remote')
          items.push({
            id: 'remote-copy',
            label:
              selectedPaths.length > 1
                ? x('fileManager.copyRemoteSelected', { count: selectedPaths.length })
                : x('fileManager.copyRemote'),
            icon: <Server size={14} />,
            disabled: ftpMode,
            onSelect: () => openRemoteCopyDialog(selectedPaths),
          });
        items.push({
          id: 'paste',
          label: x('fileManager.paste'),
          icon: <ClipboardPaste size={14} />,
          shortcut: `${primaryModifier}+V`,
          disabled: !canPasteFiles(scope),
          onSelect: () => void pasteFiles(scope, scope === 'local' ? localPath : path),
        });
        if (entry)
          items.push({
            id: 'rename',
            label: x('fileManager.rename'),
            icon: <Pencil size={14} />,
            onSelect: () =>
              setFileDialog({
                kind: 'rename',
                scope,
                path: entry.path,
                initialValue: entry.name,
              }),
          });
        if (entry)
          items.push({
            id: 'copy-path',
            label:
              selectedPaths.length > 1
                ? x('fileManager.copySelectedPaths', { count: selectedPaths.length })
                : x('fileManager.copyPath'),
            icon: <Copy size={14} />,
            shortcut: `${primaryModifier}+Shift+C`,
            onSelect: () => copyFilePaths(scope, selectedPaths),
          });
        if (entry)
          items.push({
            id: 'delete',
            label:
              selectedPaths.length > 1
                ? x('fileManager.deleteSelected', { count: selectedPaths.length })
                : x('fileManager.delete'),
            icon: <Trash2 size={14} />,
            danger: true,
            onSelect: () => deleteEntries(scope, selectedPaths),
          });
        if (entry && entry.type !== 'symlink' && !(scope === 'remote' && ftpMode))
          items.push({
            id: 'chmod',
            label: x('fileManager.changePermissions'),
            icon: <KeyRound size={14} />,
            onSelect: () => setFileInfo({ scope, entry }),
          });
        if (entry)
          items.push({
            id: 'info',
            label: x('fileManager.information'),
            icon: <Info size={14} />,
            onSelect: () => setFileInfo({ scope, entry }),
          });
        items.push(
          {
            id: 'new-file',
            label: x('fileManager.newFile'),
            icon: <FilePlus2 size={14} />,
            separatorBefore: !!entry,
            onSelect: () => setFileDialog({ kind: 'create', scope, entryType: 'file' }),
          },
          {
            id: 'new-folder',
            label: x('fileManager.newDirectory'),
            icon: <FolderPlus size={14} />,
            onSelect: () => setFileDialog({ kind: 'create', scope, entryType: 'directory' }),
          },
          ...(scope === 'remote' && !ftpMode
            ? [
                {
                  id: 'new-file-edit',
                  label: x('fileManager.newAndEditText'),
                  icon: <FileCode2 size={14} />,
                  onSelect: () =>
                    setFileDialog({
                      kind: 'create',
                      scope,
                      entryType: 'file',
                      editAfterCreate: true,
                    }),
                } satisfies FileContextMenuItem,
              ]
            : []),
          {
            id: 'select-all',
            label: x('fileManager.selectAll'),
            icon: <ListChecks size={14} />,
            shortcut: `${primaryModifier}+A`,
            onSelect: () => {
              const entries =
                scope === 'local'
                  ? sortFileEntries(
                      filterFileEntries(
                        localFiles.data?.entries ?? [],
                        localShowHidden,
                        localKeyword,
                      ),
                      localSort,
                    )
                  : sortFileEntries(
                      filterFileEntries(files.data ?? [], remoteShowHidden, remoteKeyword),
                      remoteSort,
                    );
              const next = selectAllFilePaths(entries.map(({ path: entryPath }) => entryPath));
              if (scope === 'local') {
                setLocalSelection(next);
                setRemoteSelection(createFileSelection());
              } else {
                setRemoteSelection(next);
                setLocalSelection(createFileSelection());
              }
            },
          },
          {
            id: 'refresh',
            label: x('fileManager.refresh'),
            icon: <RefreshCw size={14} />,
            onSelect: () => (scope === 'local' ? void localFiles.refetch() : void files.refetch()),
          },
        );
        return items;
      })()
    : [];

  return (
    <PanelFrame
      className={cx(
        session ? `embedded-file-panel embedded-file-panel-${session.kind}` : undefined,
      )}
      eyebrow="SFTP"
      title={x('fileManager.title')}
      description={x('fileManager.description')}
      action={
        session?.kind === 'local' ? undefined : (
          <div className={cx('toolbar')}>
            <div
              className={cx('file-view-switcher')}
              role="group"
              aria-label={x('fileManager.layout')}
            >
              {(['local', 'remote', 'split'] as const).map((view) => (
                <button
                  key={view}
                  type="button"
                  aria-pressed={effectiveFileManagerView === view}
                  onClick={() => setFileManagerView(view)}
                >
                  {x(
                    {
                      local: 'fileManager.local',
                      remote: 'fileManager.remote',
                      split: 'fileManager.split',
                    }[view] as AxtermMessageKey,
                  )}
                </button>
              ))}
            </div>
            <button onClick={() => void upload('open-file')} disabled={!effectiveConnectionId}>
              <Upload size={13} /> {x('fileManager.uploadFile')}
            </button>
            <button onClick={() => void upload('open-directory')} disabled={!effectiveConnectionId}>
              <FolderInput size={13} /> {x('fileManager.uploadDirectory')}
            </button>
            <button onClick={() => void download()} disabled={!selected || !localGrant}>
              <Download size={13} /> {x('fileManager.download')}
            </button>
            <button
              onClick={() => void compareSelectedFiles()}
              disabled={!canCompareFiles || fileComparisonBusy}
              title={x('fileManager.compareHint')}
            >
              <FileCode2 size={13} />{' '}
              {fileComparisonBusy ? x('fileManager.comparing') : x('fileManager.compare')}
            </button>
          </div>
        )
      }
    >
      {error && <ErrorBanner text={error} />}
      {fileNotice && (
        <p className={cx('file-operation-notice')} role="status">
          {fileNotice}
        </p>
      )}
      <div
        className={cx(`file-workspace file-workspace-${effectiveFileManagerView}`)}
        data-view={effectiveFileManagerView}
        style={
          effectiveFileManagerView === 'split'
            ? {
                gridTemplateColumns: `minmax(0, ${fileManagerSplitPercent}fr) 6px minmax(0, ${100 - fileManagerSplitPercent}fr)`,
              }
            : undefined
        }
      >
        {effectiveFileManagerView !== 'remote' && (
          <section
            data-axterm-directory-drop=""
            className={cx('file-pane file-pane-local')}
            aria-label={x('fileManager.localFiles')}
            onDragOverCapture={(event) => {
              if (active && event.dataTransfer.types.includes('Files')) {
                event.preventDefault();
                event.dataTransfer.dropEffect = 'copy';
              }
            }}
            onDropCapture={(event) => {
              if (!active || !event.dataTransfer.types.includes('Files')) return;
              event.preventDefault();
              event.stopPropagation();
              setError(x('fileManager.dropLocalDirectoryOnly'));
            }}
          >
            <header className={cx('file-pane-title')}>
              <strong>{x('fileManager.local')}</strong>
              <button type="button" onClick={() => void chooseLocalDirectory()}>
                <FolderInput size={12} />{' '}
                {localGrant ? x('fileManager.changeDirectory') : x('fileManager.selectDirectory')}
              </button>
            </header>
            <div className={cx('file-address-bar')}>
              <button
                type="button"
                title={x('fileManager.returnToGrantRoot')}
                disabled={!localGrant || !localPath}
                onClick={() => navigateLocalPath('')}
              >
                <Folder size={13} />
              </button>
              <button
                type="button"
                title={x('fileManager.parentDirectory')}
                disabled={!localGrant || !localPath}
                onClick={() => navigateLocalPath(localParentPath(localPath))}
              >
                <ChevronUp size={13} />
              </button>
              <button
                type="button"
                title={
                  localBookmarks.includes(localPath)
                    ? x('fileManager.unfavoriteLocalPath')
                    : x('fileManager.favoriteLocalPath')
                }
                aria-label={x('fileManager.favoriteLocalPath')}
                aria-pressed={localBookmarks.includes(localPath)}
                disabled={!localGrant}
                onClick={toggleLocalBookmark}
              >
                <Star size={13} />
              </button>
              <input
                aria-label={x('fileManager.localRelativePath')}
                value={localGrant ? localPathInput : ''}
                placeholder={localGrant ? '/' : x('fileManager.selectLocalDirectoryPlaceholder')}
                disabled={!localGrant}
                onChange={(event) => setLocalPathInput(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') void navigateLocalAddress(localPathInput);
                }}
              />
              <button
                type="button"
                title={x('fileManager.refreshLocal')}
                disabled={!localGrant}
                onClick={() => void localFiles.refetch()}
              >
                <RefreshCw size={13} />
              </button>
            </div>
            <div className={cx('file-path-tools')}>
              <select
                aria-label={x('fileManager.localHistory')}
                value=""
                disabled={!localHistory.length}
                onChange={(event) => navigateLocalPath(event.target.value.slice(5))}
              >
                <option value="">{x('fileManager.history')}</option>
                {localHistory.map((item) => (
                  <option key={item} value={`path:${item}`}>
                    {localAbsoluteAddress(localGrant, item)}
                  </option>
                ))}
              </select>
              <select
                aria-label={x('fileManager.localFavorites')}
                value=""
                disabled={!localBookmarks.length}
                onChange={(event) => navigateLocalPath(event.target.value.slice(5))}
              >
                <option value="">{x('fileManager.favorites')}</option>
                {localBookmarks.map((item) => (
                  <option key={item} value={`path:${item}`}>
                    {localAbsoluteAddress(localGrant, item)}
                  </option>
                ))}
              </select>
              <button
                type="button"
                aria-label={
                  localShowHidden
                    ? x('fileManager.hideLocalHidden')
                    : x('fileManager.showLocalHidden')
                }
                aria-pressed={localShowHidden}
                title={
                  localShowHidden ? x('fileManager.hideDotfiles') : x('fileManager.showDotfiles')
                }
                onClick={() => void toggleHiddenFiles('local')}
              >
                {localShowHidden ? <Eye size={12} /> : <EyeOff size={12} />}
              </button>
              <label className={cx(`file-keyword-filter ${localKeyword ? 'active' : ''}`)}>
                <Filter size={12} aria-hidden="true" />
                <input
                  aria-label={x('fileManager.localKeyword')}
                  value={localKeywordDraft}
                  placeholder={x('fileManager.keyword')}
                  onChange={(event) => setLocalKeywordDraft(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      setLocalKeyword(localKeywordDraft.trim());
                      setLocalSelection(createFileSelection());
                    }
                  }}
                />
                <button
                  type="button"
                  aria-label={x('fileManager.applyLocalKeyword')}
                  onClick={() => {
                    setLocalKeyword(localKeywordDraft.trim());
                    setLocalSelection(createFileSelection());
                  }}
                >
                  <Check size={11} />
                </button>
                {!!localKeyword && (
                  <button
                    type="button"
                    aria-label={x('fileManager.clearLocalKeyword')}
                    onClick={() => {
                      setLocalKeyword('');
                      setLocalKeywordDraft('');
                      setLocalSelection(createFileSelection());
                    }}
                  >
                    <X size={11} />
                  </button>
                )}
              </label>
            </div>
            {localFiles.isError && (
              <div className={cx('file-pane-recovery')}>
                <ErrorBanner text={x('fileManager.localLoadFailed')} />
                <button type="button" onClick={() => void localFiles.refetch()}>
                  {x('fileManager.refreshLocal')}
                </button>
              </div>
            )}
            {localGrant && !localFiles.isError ? (
              <FileTable
                key={`local:${fileColumns.join(',')}`}
                scope="local"
                label={x('fileManager.localTable')}
                entries={sortFileEntries(
                  filterFileEntries(localFiles.data?.entries ?? [], localShowHidden, localKeyword),
                  localSort,
                )}
                columns={fileColumns}
                sort={localSort}
                selection={localSelection}
                currentPath={localPath}
                parentPath={localPath ? localParentPath(localPath) : undefined}
                fileDrag={fileDrag}
                pasteEnabled={canPasteFiles('local')}
                parentVisible={!!localPath}
                onParent={() => navigateLocalPath(localParentPath(localPath))}
                onSelectionChange={(next) => {
                  setLocalSelection(next);
                }}
                onContextMenu={(entry, x, y) => setFileMenu({ scope: 'local', entry, x, y })}
                onOpen={(entry) => {
                  void openFileEntry('local', entry);
                }}
                onStageFileOperation={(paths, operation) =>
                  stageFileOperation('local', paths, operation)
                }
                onPaste={(destination) => void pasteFiles('local', destination)}
                onStartDrag={(paths) => {
                  const authority = fileAuthority('local');
                  if (!authority) return undefined;
                  const payload = { scope: 'local' as const, authority, paths: [...paths] };
                  setFileDrag(payload);
                  return payload;
                }}
                onEndDrag={() => setFileDrag(undefined)}
                onDropFiles={(payload, destination) =>
                  handleFileDrop('local', payload, destination)
                }
                onSort={(column) => void changeFileSort('local', column)}
                onToggleColumn={(column) => void toggleFileColumn(column)}
              />
            ) : !localGrant ? (
              <div className={cx('file-list')}>
                <EmptyState
                  icon={Folder}
                  title={x('fileManager.selectLocalTitle')}
                  text={x('fileManager.grantHint')}
                />
              </div>
            ) : null}
            {localFiles.data && 'truncated' in localFiles.data && localFiles.data.truncated && (
              <p className={cx('file-pane-note')}>{x('fileManager.listTruncated')}</p>
            )}
          </section>
        )}
        {effectiveFileManagerView === 'split' && (
          <div
            className={cx('file-pane-divider')}
            role="separator"
            aria-label={x('fileManager.resizePanes')}
            aria-orientation="vertical"
            aria-valuemin={25}
            aria-valuemax={75}
            aria-valuenow={Math.round(fileManagerSplitPercent)}
            tabIndex={0}
            onPointerDown={resizeFilePanes}
            onKeyDown={(event) => {
              if (event.key === 'ArrowLeft')
                setFileManagerSplitPercent(fileManagerSplitPercent - 5);
              if (event.key === 'ArrowRight')
                setFileManagerSplitPercent(fileManagerSplitPercent + 5);
            }}
          />
        )}
        {effectiveFileManagerView !== 'local' && (
          <section
            className={cx('file-pane file-pane-remote')}
            aria-label={x('fileManager.remoteFiles')}
          >
            <header className={cx('file-pane-title')}>
              <strong>{x('fileManager.remote')}</strong>
              {session?.kind === 'ssh' ? (
                <span className={cx('file-session-connection')}>
                  {hosts.find(
                    (host) =>
                      host.id === connections.find(({ id }) => id === session.connectionId)?.hostId,
                  )?.name ?? session.connectionId.slice(0, 8)}
                </span>
              ) : (
                <select
                  aria-label={x('fileManager.remoteConnection')}
                  value={effectiveConnectionId}
                  onChange={(event) => {
                    const nextConnectionId = event.target.value;
                    setConnectionId(nextConnectionId);
                    setActiveFtpConnection(
                      ftpReady.some(({ id }) => id === nextConnectionId)
                        ? nextConnectionId
                        : undefined,
                    );
                    const ftpConnection = ftpReady.find(({ id }) => id === nextConnectionId);
                    if (ftpConnection)
                      navigateRemote(ftpConnection.initialDirectory, nextConnectionId);
                    else setRemotePathConnectionId('');
                    setRemoteSelection(createFileSelection());
                  }}
                >
                  <option value="">{x('fileManager.selectConnectedHost')}</option>
                  {ready.map((connection) => (
                    <option key={connection.id} value={connection.id}>
                      {hosts.find((host) => host.id === connection.hostId)?.name ??
                        connection.id.slice(0, 8)}
                    </option>
                  ))}
                  {ftpReady.map((connection) => (
                    <option key={connection.id} value={connection.id}>
                      {connection.name} · {connection.security === 'plain' ? 'FTP' : 'FTPS'}
                    </option>
                  ))}
                </select>
              )}
              {ftpMode && (
                <button
                  type="button"
                  title={x('fileManager.closeFtp')}
                  onClick={() => {
                    void owner.ctx.connectionActions
                      .closeFtpConnection(effectiveConnectionId)
                      .then(async () => {
                        setActiveFtpConnection(undefined);
                        setConnectionId(ready[0]?.id ?? '');
                      })
                      .catch((cause: unknown) => setError(messageOf(cause, x)));
                  }}
                >
                  <X size={12} /> {x('fileManager.disconnect')}
                </button>
              )}
            </header>
            <div className={cx('file-address-bar')}>
              <button
                type="button"
                title={x('fileManager.remoteRoot')}
                onClick={() => navigateRemote('/')}
              >
                <Folder size={13} />
              </button>
              <button
                type="button"
                title={x('fileManager.parentDirectory')}
                disabled={path === '/'}
                onClick={() => navigateRemote(path.replace(/\/[^/]+\/?$/, '') || '/')}
              >
                <ChevronUp size={13} />
              </button>
              <button
                type="button"
                title={
                  remotePathBookmarked
                    ? x('fileManager.unfavoriteRemotePath')
                    : x('fileManager.favoriteRemotePath')
                }
                aria-label={x('fileManager.favoriteRemotePath')}
                aria-pressed={remotePathBookmarked}
                disabled={!effectiveConnectionId || !settings}
                onClick={() => void toggleRemoteBookmark()}
              >
                <Star size={13} />
              </button>
              <input
                aria-label={x('fileManager.remotePath')}
                value={pathInput}
                onChange={(event) => setPathInput(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') navigateRemote(pathInput);
                }}
              />
              <button
                type="button"
                title={x('fileManager.refreshRemote')}
                onClick={() => void files.refetch()}
              >
                <RefreshCw size={13} />
              </button>
            </div>
            <div className={cx('file-path-tools')}>
              <select
                aria-label={x('fileManager.remoteHistory')}
                value=""
                disabled={!remoteHistory.length}
                onChange={(event) => navigateRemote(event.target.value)}
              >
                <option value="">{x('fileManager.history')}</option>
                {remoteHistory.map((item) => (
                  <option key={item} value={item}>
                    {item}
                  </option>
                ))}
              </select>
              <select
                aria-label={x('fileManager.remoteFavorites')}
                value=""
                disabled={!remoteBookmarks.length}
                onChange={(event) => navigateRemote(event.target.value)}
              >
                <option value="">{x('fileManager.favorites')}</option>
                {remoteBookmarks.map((item) => (
                  <option key={item.id} value={item.path}>
                    {item.path}
                  </option>
                ))}
              </select>
              <button type="button" onClick={followActiveTerminalDirectory}>
                <TerminalIcon size={12} /> {x('fileManager.currentTerminalDirectory')}
              </button>
              <button
                type="button"
                aria-label={
                  remoteShowHidden
                    ? x('fileManager.hideRemoteHidden')
                    : x('fileManager.showRemoteHidden')
                }
                aria-pressed={remoteShowHidden}
                title={
                  remoteShowHidden ? x('fileManager.hideDotfiles') : x('fileManager.showDotfiles')
                }
                onClick={() => void toggleHiddenFiles('remote')}
              >
                {remoteShowHidden ? <Eye size={12} /> : <EyeOff size={12} />}
              </button>
              <label className={cx(`file-keyword-filter ${remoteKeyword ? 'active' : ''}`)}>
                <Filter size={12} aria-hidden="true" />
                <input
                  aria-label={x('fileManager.remoteKeyword')}
                  value={remoteKeywordDraft}
                  placeholder={x('fileManager.keyword')}
                  onChange={(event) => setRemoteKeywordDraft(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      setRemoteKeyword(remoteKeywordDraft.trim());
                      setRemoteSelection(createFileSelection());
                    }
                  }}
                />
                <button
                  type="button"
                  aria-label={x('fileManager.applyRemoteKeyword')}
                  onClick={() => {
                    setRemoteKeyword(remoteKeywordDraft.trim());
                    setRemoteSelection(createFileSelection());
                  }}
                >
                  <Check size={11} />
                </button>
                {!!remoteKeyword && (
                  <button
                    type="button"
                    aria-label={x('fileManager.clearRemoteKeyword')}
                    onClick={() => {
                      setRemoteKeyword('');
                      setRemoteKeywordDraft('');
                      setRemoteSelection(createFileSelection());
                    }}
                  >
                    <X size={11} />
                  </button>
                )}
              </label>
            </div>
            <div className={cx('file-pane-actions')}>
              <button
                onClick={() =>
                  setFileDialog({ kind: 'create', scope: 'remote', entryType: 'directory' })
                }
                disabled={!effectiveConnectionId}
              >
                {x('fileManager.newDirectory')}
              </button>
              <button
                onClick={() => {
                  if (selected)
                    setFileDialog({
                      kind: 'rename',
                      scope: 'remote',
                      path: selected,
                      initialValue: selected.split('/').at(-1) ?? '',
                    });
                }}
                disabled={!selected}
              >
                {x('fileManager.rename')}
              </button>
              <button
                onClick={() => {
                  if (remoteComparisonEntry)
                    setFileInfo({ scope: 'remote', entry: remoteComparisonEntry });
                }}
                disabled={!remoteComparisonEntry || remoteComparisonEntry.type === 'symlink'}
              >
                chmod
              </button>
              <button
                onClick={() => void deleteEntries('remote', [...remoteSelection.paths])}
                disabled={!remoteSelection.paths.size}
              >
                {x('fileManager.delete')}
              </button>
            </div>
            {files.isError && (
              <div className={cx('file-pane-recovery')}>
                <ErrorBanner text={x('fileManager.remoteLoadFailed')} />
                <button type="button" onClick={() => void files.refetch()}>
                  {x('fileManager.refreshRemote')}
                </button>
              </div>
            )}
            {effectiveConnectionId && !files.isError ? (
              <FileTable
                key={`remote:${fileColumns.join(',')}`}
                scope="remote"
                label={x('fileManager.remoteTable')}
                entries={sortFileEntries(
                  filterFileEntries(files.data ?? [], remoteShowHidden, remoteKeyword),
                  remoteSort,
                )}
                columns={fileColumns}
                sort={remoteSort}
                selection={remoteSelection}
                currentPath={path}
                parentPath={path !== '/' ? path.replace(/\/[^/]+\/?$/, '') || '/' : undefined}
                fileDrag={fileDrag}
                pasteEnabled={canPasteFiles('remote')}
                parentVisible={path !== '/'}
                onParent={() => navigateRemote(path.replace(/\/[^/]+\/?$/, '') || '/')}
                onSelectionChange={(next) => {
                  setRemoteSelection(next);
                }}
                onContextMenu={(entry, x, y) => setFileMenu({ scope: 'remote', entry, x, y })}
                onOpen={(entry) => void openFileEntry('remote', entry)}
                onStageFileOperation={(paths, operation) =>
                  stageFileOperation('remote', paths, operation)
                }
                onPaste={(destination) => void pasteFiles('remote', destination)}
                onStartDrag={(paths) => {
                  const authority = fileAuthority('remote');
                  if (!authority) return undefined;
                  const payload = { scope: 'remote' as const, authority, paths: [...paths] };
                  setFileDrag(payload);
                  return payload;
                }}
                onEndDrag={() => setFileDrag(undefined)}
                onDropFiles={(payload, destination) =>
                  handleFileDrop('remote', payload, destination)
                }
                onDropExternalFiles={(droppedFiles, destination, includesDirectory) =>
                  void uploadDroppedFiles(droppedFiles, destination, includesDirectory)
                }
                externalDropBusy={externalDropBusy}
                onSort={(column) => void changeFileSort('remote', column)}
                onToggleColumn={(column) => void toggleFileColumn(column)}
              />
            ) : !effectiveConnectionId ? (
              <div className={cx('file-list')}>
                <EmptyState
                  icon={Folder}
                  title={x('fileManager.selectConnection')}
                  text={x('fileManager.selectConnectionHint')}
                />
              </div>
            ) : null}
          </section>
        )}
      </div>
      {editing && (
        <RemoteEditor
          owner={owner}
          target={targetFor()}
          path={editing}
          onClose={() => setEditing(undefined)}
          onSavedAs={(savedPath) => {
            setEditing(savedPath);
            void files.refetch();
          }}
        />
      )}
      {externalEditor && (
        <ExternalEditorDialog
          owner={owner}
          id={externalEditor}
          onUploaded={() => void files.refetch()}
          onClose={() => setExternalEditor(undefined)}
        />
      )}
      {fileComparison && (
        <FileComparisonDialog
          comparison={fileComparison}
          onClose={() => setFileComparison(undefined)}
        />
      )}
      {fileMenu && (
        <FileContextMenu
          x={fileMenu.x}
          y={fileMenu.y}
          label={x('fileManager.menuAria', {
            scope: x(
              fileMenu.scope === 'local' ? 'fileManager.localScope' : 'fileManager.remoteScope',
            ),
          })}
          items={menuItems}
          onClose={() => setFileMenu(undefined)}
        />
      )}
      {fileInfo && (
        <FileInfoDialog
          scope={fileInfo.scope}
          entry={fileInfo.entry}
          onChangeMode={(mode) => chmodEntry(fileInfo.scope, fileInfo.entry.path, mode)}
          onClose={() => setFileInfo(undefined)}
        />
      )}
      {active && crossPaneDrop && (
        <Modal
          portal
          title={
            crossPaneDrop.payload.scope === 'local'
              ? x('fileManager.confirmUpload')
              : x('fileManager.confirmDownload')
          }
          onClose={() => {
            if (!crossPaneTransferBusy) setCrossPaneDrop(undefined);
          }}
        >
          <div className={cx('stack file-transfer-drop-dialog')}>
            <p>
              {x('fileManager.confirmTransfer', {
                count: crossPaneDrop.payload.paths.length,
                direction: x(
                  crossPaneDrop.payload.scope === 'local'
                    ? 'fileManager.uploadToRemote'
                    : 'fileManager.downloadToLocal',
                ),
              })}
            </p>
            <code>
              {crossPaneDrop.targetScope === 'local'
                ? localAbsoluteAddress(localGrant, crossPaneDrop.destination)
                : crossPaneDrop.destination || '/'}
            </code>
            <p className={cx('hint')}>{x('fileManager.conflictHint')}</p>
            <div className={cx('modal-actions')}>
              <button
                type="button"
                disabled={crossPaneTransferBusy}
                onClick={() => setCrossPaneDrop(undefined)}
              >
                {x('common.cancel')}
              </button>
              <button
                type="button"
                className={cx('primary')}
                disabled={crossPaneTransferBusy}
                onClick={() => void confirmCrossPaneTransfer()}
              >
                {crossPaneTransferBusy
                  ? x('fileManager.queueing')
                  : crossPaneDrop.payload.scope === 'local'
                    ? x('fileManager.uploadDirection')
                    : x('fileManager.downloadDirection')}
              </button>
            </div>
          </div>
        </Modal>
      )}
      {remoteCopyDialog && (
        <Modal
          title={x('fileManager.copyToRemote')}
          onClose={() => {
            if (!remoteCopyBusy) setRemoteCopyDialog(undefined);
          }}
        >
          <form
            className={cx('stack file-transfer-drop-dialog')}
            onSubmit={(event) => {
              event.preventDefault();
              void confirmRemoteCopy();
            }}
          >
            <p>
              {x('fileManager.remoteCopyDescription', { count: remoteCopyDialog.paths.length })}
            </p>
            <label>
              {x('fileManager.targetConnection')}
              <select
                value={remoteCopyTargetConnectionId}
                disabled={remoteCopyBusy}
                onChange={(event) => setRemoteCopyTargetConnectionId(event.target.value)}
              >
                {ready.map((connection) => (
                  <option key={connection.id} value={connection.id}>
                    {hosts.find(({ id }) => id === connection.hostId)?.name ?? connection.hostId}
                    {connection.id === effectiveConnectionId ? x('fileManager.currentSuffix') : ''}
                  </option>
                ))}
              </select>
            </label>
            <label>
              {x('fileManager.targetDirectory')}
              <input
                value={remoteCopyTargetPath}
                disabled={remoteCopyBusy}
                maxLength={4_096}
                spellCheck={false}
                onChange={(event) => setRemoteCopyTargetPath(event.target.value)}
              />
            </label>
            <p className={cx('hint')}>{x('fileManager.remoteCopyHint')}</p>
            <div className={cx('modal-actions')}>
              <button
                type="button"
                disabled={remoteCopyBusy}
                onClick={() => setRemoteCopyDialog(undefined)}
              >
                {x('common.cancel')}
              </button>
              <button
                type="submit"
                className={cx('primary')}
                disabled={remoteCopyBusy || !remoteCopyTargetConnectionId}
              >
                {remoteCopyBusy ? x('fileManager.queueing') : x('fileManager.startCopy')}
              </button>
            </div>
          </form>
        </Modal>
      )}
      {active && pendingConflict?.conflict && (
        <Modal
          portal
          title={x('fileManager.resolveConflict')}
          onClose={() => {
            if (conflictDecisionBusy) return;
            void commands.command((key) =>
              owner.ctx.transferActions.cancel(key, pendingConflict.id),
            );
          }}
        >
          <div className={cx('stack transfer-conflict-dialog')}>
            <p className={cx('danger-text')}>
              {x('fileManager.conflictDescription', {
                type: x(
                  pendingConflict.conflict.type === 'directory'
                    ? 'fileManager.directory'
                    : 'fileManager.file',
                ),
              })}
            </p>
            <code>{pendingConflict.conflict.path}</code>
            <label className={cx('checkbox-row')}>
              <input
                type="checkbox"
                checked={conflictApplyToAll}
                disabled={conflictDecisionBusy}
                onChange={(event) => setConflictApplyToAll(event.target.checked)}
              />
              {x('fileManager.applyToAll')}
            </label>
            <div className={cx('modal-actions transfer-conflict-actions')}>
              <button
                type="button"
                disabled={conflictDecisionBusy}
                onClick={() => void resolvePendingConflict('skip')}
              >
                {x('fileManager.skip')}
              </button>
              <button
                type="button"
                className={cx('danger')}
                disabled={conflictDecisionBusy}
                onClick={() => void resolvePendingConflict('overwrite')}
              >
                {pendingConflict.conflict.type === 'directory'
                  ? x('fileManager.merge')
                  : x('fileManager.overwrite')}
              </button>
              <button
                type="button"
                className={cx('primary')}
                disabled={conflictDecisionBusy}
                onClick={() => void resolvePendingConflict('rename')}
              >
                {x('fileManager.renameStrategy')}
              </button>
            </div>
          </div>
        </Modal>
      )}
      {fileDialog && (
        <TextInputDialog
          key={`${fileDialog.kind}:${'path' in fileDialog ? fileDialog.path : path}`}
          title={
            fileDialog.kind === 'rename'
              ? x('fileManager.renameTitle', {
                  scope: x(
                    fileDialog.scope === 'local'
                      ? 'fileManager.localScope'
                      : 'fileManager.remoteScope',
                  ),
                })
              : x('fileManager.createTitle', {
                  scope: x(
                    fileDialog.scope === 'local'
                      ? 'fileManager.localScope'
                      : 'fileManager.remoteScope',
                  ),
                  type: x(
                    fileDialog.entryType === 'directory'
                      ? 'fileManager.directory'
                      : 'fileManager.file',
                  ),
                })
          }
          label={x('fileManager.name')}
          initialValue={fileDialog.kind === 'rename' ? fileDialog.initialValue : ''}
          submitLabel={
            fileDialog.kind === 'create' ? x('fileManager.create') : x('fileManager.save')
          }
          validate={(value) => {
            if (!value) return x('fileManager.nameRequired');
            return value.includes('/') ? x('fileManager.nameNoSlash') : undefined;
          }}
          onClose={() => setFileDialog(undefined)}
          onSubmit={(value) =>
            fileDialog.kind === 'rename'
              ? renameEntry(fileDialog.scope, fileDialog.path, value)
              : createEntry(
                  fileDialog.scope,
                  fileDialog.entryType,
                  value,
                  fileDialog.editAfterCreate,
                )
          }
        />
      )}
    </PanelFrame>
  );
}

function isMacPlatform() {
  return (globalThis.navigator?.platform.toLocaleLowerCase() ?? '').includes('mac');
}
