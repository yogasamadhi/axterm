import { useQuery, type QueryClient } from '@tanstack/react-query';
import type { createRuntimeClient } from '@workspace/client';
import type {
  Connection,
  ExternalEditorSession,
  FileComparison,
  FtpConnection,
  Host,
  RemoteFileEntry,
  Settings,
  Transfer,
} from '@workspace/contracts';
import type { FileGrant } from '@workspace/contracts/desktop';
import {
  Check,
  ChevronUp,
  ClipboardPaste,
  Copy,
  Download,
  Eye,
  EyeOff,
  File,
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
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type DragEvent as ReactDragEvent,
} from 'react';
import { ExternalEditorDialog } from '../../components/external-editor-dialog';
import { FileComparisonDialog } from '../../components/file-comparison-dialog';
import { FileContextMenu, type FileContextMenuItem } from '../../components/file-context-menu';
import { RemoteEditor } from '../../components/remote-editor';
import { terminalDroppedFilesError } from '../../components/terminal-file-drop-model';
import { TextInputDialog } from '../../components/text-input-dialog';
import { useI18n } from '../../i18n/context';
import type { AxtermMessageKey } from '../../i18n/core';
import { useWorkspace } from '../../stores/workspace';
import {
  filterFileEntries,
  sortFileEntries,
  type FileManagerSort,
  type FileTableEntry,
} from '../file-list-model';
import {
  createFileSelection,
  moveFileSelection,
  selectAllFilePaths,
  selectFilePath,
  singleSelectedFilePath,
  type FileSelectionState,
} from '../file-selection-model';
import { formatBytes, messageOf } from '../ui/format';
import { EmptyState, ErrorBanner, Modal, PanelFrame } from '../ui/panel-scaffold';
import { calculateVirtualWindow } from '../virtual-window';
import type {
  FileDragPayload,
  FileManagerColumn,
  FileOperationClipboard,
  FilePaneScope,
} from './file-manager-model';
import {
  DEFAULT_FILE_MANAGER_COLUMNS,
  DEFAULT_FILE_MANAGER_SORT,
  FILE_DRAG_MIME,
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
} from './file-manager-model';
import { useLocalDirectoryGrant } from './use-local-directory-grant';

type Client = ReturnType<typeof createRuntimeClient>;
type Translator = ReturnType<typeof useI18n>['x'];
export function FilesPanel({
  client,
  initialLocalDirectoryGrantId,
  session,
  active = true,
  hosts,
  connections,
  ftpConnections,
  transfers,
  queryClient,
  settings,
  getActiveSshDirectory,
  requestedSshDirectory,
}: {
  client: Client;
  initialLocalDirectoryGrantId?: string;
  session?: { kind: 'local' } | { kind: 'ssh'; connectionId: string } | undefined;
  active?: boolean;
  hosts: Host[];
  connections: Connection[];
  ftpConnections: FtpConnection[];
  transfers: Transfer[];
  queryClient: QueryClient;
  settings: Settings | undefined;
  getActiveSshDirectory: (() => { connectionId: string; path: string } | undefined) | undefined;
  requestedSshDirectory?: { connectionId: string; path: string; nonce: string } | undefined;
}) {
  const { x } = useI18n();
  const ready = connections.filter((connection) => connection.state === 'ready');
  const ftpReady = ftpConnections.filter((connection) => connection.state === 'ready');
  const fileManagerView = useWorkspace((state) => state.fileManagerView);
  const fileManagerSplitPercent = useWorkspace((state) => state.fileManagerSplitPercent);
  const setFileManagerView = useWorkspace((state) => state.setFileManagerView);
  const setFileManagerSplitPercent = useWorkspace((state) => state.setFileManagerSplitPercent);
  const addTerminal = useWorkspace((state) => state.addTerminal);
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
  const [initialLocalGrant] = useState<FileGrant | undefined>(() =>
    initialLocalDirectoryGrantId
      ? {
          grantId: initialLocalDirectoryGrantId,
          kind: 'directory',
          name: x('fileManager.cliDirectory'),
          permissions: ['read', 'write'],
          createdAt: new Date().toISOString(),
        }
      : undefined,
  );
  const { grant: localGrant, select: selectLocalDirectory } = useLocalDirectoryGrant(
    client,
    initialLocalGrant,
  );
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
  const [remoteHistory, setRemoteHistory] = useState<string[]>([]);
  const [localBookmarks, setLocalBookmarks] = useState<string[]>([]);
  const [localShowHiddenOverride, setLocalShowHiddenOverride] = useState<boolean>();
  const [remoteShowHiddenOverride, setRemoteShowHiddenOverride] = useState<boolean>();
  const [localKeywordDraft, setLocalKeywordDraft] = useState('');
  const [localKeyword, setLocalKeyword] = useState('');
  const [remoteKeywordDraft, setRemoteKeywordDraft] = useState('');
  const [remoteKeyword, setRemoteKeyword] = useState('');
  const [editing, setEditing] = useState<string>();
  const [externalEditor, setExternalEditor] = useState<ExternalEditorSession>();
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
  const completedTransferRevisionRef = useRef('');
  const [error, setError] = useState('');
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
  const remoteHome = useQuery({
    queryKey: ['sftp-home', effectiveConnectionId],
    queryFn: () => client.remoteHome(effectiveConnectionId),
    enabled:
      active &&
      effectiveFileManagerView !== 'local' &&
      !!effectiveConnectionId &&
      sshConnectionReady &&
      !ftpMode &&
      !requestedRemotePath,
    retry: false,
    staleTime: Number.POSITIVE_INFINITY,
  });
  const selected = singleSelectedFilePath(remoteSelection);
  const files = useQuery({
    queryKey: ['files', effectiveConnectionId, path],
    queryFn: () =>
      ftpMode
        ? client.ftpFiles(effectiveConnectionId, path)
        : client.remoteFiles(effectiveConnectionId, path),
    enabled:
      active &&
      effectiveFileManagerView !== 'local' &&
      !!effectiveConnectionId &&
      (ftpMode || sshConnectionReady) &&
      remotePathConnectionId === effectiveConnectionId,
    retry: false,
    refetchOnMount: settings?.fileManager.refreshOnFocus ? 'always' : false,
  });
  const localFiles = useQuery({
    queryKey: ['local-files', localGrant?.grantId, localPath],
    queryFn: () => client.listGrantedDirectory(localGrant!.grantId, localPath),
    enabled: active && !!localGrant,
    retry: false,
    refetchOnMount: settings?.fileManager.refreshOnFocus ? 'always' : false,
  });
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
    void selectLocalDirectory('home-directory')
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
  }, [active, localGrant, selectLocalDirectory, x]);
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
  useEffect(() => {
    if (!active) return;
    const revision = transfers
      .filter(({ state }) => state === 'succeeded')
      .map(({ id, updatedAt }) => `${id}:${updatedAt}`)
      .sort()
      .join('|');
    if (!revision || revision === completedTransferRevisionRef.current) return;
    completedTransferRevisionRef.current = revision;
    void Promise.all([
      queryClient.invalidateQueries({ queryKey: ['local-files'] }),
      queryClient.invalidateQueries({ queryKey: ['files'] }),
    ]);
  }, [active, queryClient, transfers]);

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
      const next = await client.updateSettings(settings, { fileManager: patch });
      queryClient.setQueryData(['settings'], next);
      return true;
    } catch (cause) {
      setError(messageOf(cause, x));
      await queryClient.invalidateQueries({ queryKey: ['settings'] });
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
    const owner = event.currentTarget.parentElement;
    if (!owner) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    const move = (pointer: PointerEvent) => {
      const bounds = owner.getBoundingClientRect();
      if (!bounds.width) return;
      setFileManagerSplitPercent(((pointer.clientX - bounds.left) / bounds.width) * 100);
    };
    const finish = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', finish);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', finish, { once: true });
  }

  async function upload(kind: 'open-file' | 'open-directory') {
    try {
      const grant = await client.createFileGrant(kind);
      if (!grant) return;
      const remotePath = `${path.replace(/\/$/, '')}/${grant.name}`;
      await (ftpMode ? client.createFtpTransfer : client.createTransfer)(
        effectiveConnectionId,
        'upload',
        {
          grantId: grant.grantId,
          remotePath,
          recursive: kind === 'open-directory',
          conflict: 'ask',
        },
      );
      await queryClient.invalidateQueries({ queryKey: ['transfers'] });
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
    const validationError = terminalDroppedFilesError(droppedFiles, includesDirectory);
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
        pendingGrant = await client.importDroppedFile(file, controller.signal);
        controller.signal.throwIfAborted();
        await (ftpMode ? client.createFtpTransfer : client.createTransfer)(
          effectiveConnectionId,
          'upload',
          {
            grantId: pendingGrant.grantId,
            remotePath: appendRemotePath(destination, pendingGrant.name),
            recursive: false,
            conflict: 'ask',
          },
        );
        pendingGrant = undefined;
        queued += 1;
      }
      await queryClient.invalidateQueries({ queryKey: ['transfers'] });
      setFileNotice(
        x('fileManager.transferQueued', {
          count: queued,
          direction: x('fileManager.uploadDirection'),
        }),
      );
    } catch (cause) {
      if (pendingGrant) await client.revokeFileGrant(pendingGrant.grantId).catch(() => undefined);
      if (queued && localFilePanelMountedRef.current) {
        await queryClient.invalidateQueries({ queryKey: ['transfers'] });
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
      await (ftpMode ? client.createFtpTransfer : client.createTransfer)(
        effectiveConnectionId,
        'download',
        {
          // Downloads intentionally share the directory grant and relative path currently
          // displayed in the left pane, rather than invoking a new native save dialog.
          grantId: localGrant.grantId,
          localPath: appendLocalPath(localPath, entry.name),
          remotePath: entry.path,
          recursive: entry.type === 'directory',
          conflict: 'ask',
        },
      );
      await queryClient.invalidateQueries({ queryKey: ['transfers'] });
    } catch (cause) {
      setError(messageOf(cause, x));
    }
  }
  async function chmodEntry(scope: FilePaneScope, entryPath: string, mode: number): Promise<void> {
    try {
      if (scope === 'local') {
        if (!localGrant) throw new Error(x('fileManager.localGrantExpired'));
        await client.chmodGrantedEntry(localGrant.grantId, entryPath, mode);
        await localFiles.refetch();
      } else {
        if (ftpMode) throw new Error(x('fileManager.ftpChmodUnavailable'));
        await client.chmod(effectiveConnectionId, entryPath, mode);
        await files.refetch();
      }
      setFileNotice(
        x('fileManager.chmodSuccess', {
          path: entryPath,
          mode: mode.toString(8).padStart(4, '0'),
        }),
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
        await client.createGrantedEntry(localGrant.grantId, {
          path: localPath,
          name,
          type: entryType,
        });
        await localFiles.refetch();
      } else {
        const remotePath = `${path.replace(/\/$/, '')}/${name}`;
        if (entryType === 'directory')
          await (ftpMode ? client.createFtpDirectory : client.createRemoteDirectory)(
            effectiveConnectionId,
            remotePath,
          );
        else
          await (ftpMode ? client.createFtpFile : client.createRemoteFile)(
            effectiveConnectionId,
            remotePath,
          );
        await files.refetch();
        if (entryType === 'file' && editAfterCreate) setEditing(remotePath);
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
        await client.renameGrantedEntry(localGrant.grantId, entryPath, nextName);
        setLocalSelection(createFileSelection());
        await localFiles.refetch();
      } else {
        const parent = entryPath.replace(/\/[^/]+$/, '') || '/';
        await (ftpMode ? client.renameFtpPath : client.renameRemotePath)(
          effectiveConnectionId,
          entryPath,
          `${parent.replace(/\/$/, '')}/${nextName}`,
        );
        setRemoteSelection(createFileSelection());
        await files.refetch();
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
          await client.deleteGrantedEntry(localGrant.grantId, entryPath);
        } else
          await (ftpMode ? client.deleteFtpPath : client.deleteRemotePath)(
            effectiveConnectionId,
            entryPath,
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
        await client.openGrantedEntry(localGrant.grantId, entry.path);
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
      await client.revealGrantedEntry(localGrant.grantId, entry.path);
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
      setError('');
      const defaultProfileId = settings?.terminal.defaultProfileId ?? undefined;
      const terminal = await client.createTerminal({
        kind: scope === 'local' ? 'local' : 'ssh',
        ...(scope === 'remote' ? { connectionId: effectiveConnectionId } : {}),
        ...(defaultProfileId ? { profileId: defaultProfileId } : {}),
        workingDirectory:
          scope === 'local'
            ? { scope: 'local', grantId: localGrant!.grantId, path: directory }
            : { scope: 'remote', path: directory },
        cols: 160,
        rows: 80,
      });
      const connection = connections.find(({ id }) => id === effectiveConnectionId);
      const host = hosts.find(({ id }) => id === connection?.hostId);
      const directoryName = directory.split('/').filter(Boolean).at(-1);
      addTerminal({
        id: terminal.id,
        title:
          scope === 'local'
            ? x('fileManager.localTerminalTitle', { name: directoryName ?? localGrant!.name })
            : `${host?.name ?? terminal.title} · ${directoryName ?? '/'}`,
        kind: scope === 'local' ? 'local' : 'ssh',
        ...(scope === 'remote'
          ? {
              ...(connection?.hostId ? { hostId: connection.hostId } : {}),
              connectionId: effectiveConnectionId,
              ...(connection?.connectionProfileId
                ? { connectionProfileId: connection.connectionProfileId }
                : {}),
            }
          : {}),
        ...(terminal.profileId ? { profileId: terminal.profileId } : {}),
        appearance: terminal.appearance,
        behavior: terminal.behavior,
        disconnected: false,
      });
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
    try {
      setExternalEditor(await client.createExternalEditor(effectiveConnectionId, path));
    } catch (cause) {
      setError(messageOf(cause, x));
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
        await client.compareFiles({
          left: { scope: 'local', grantId: localGrant.grantId, path: selectedLocalPath },
          right: { scope: 'remote', connectionId: effectiveConnectionId, path: selected },
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
      await client.createTransfer(
        effectiveConnectionId,
        scope === 'local' ? 'upload' : 'download',
        {
          grantId: localGrant.grantId,
          localPath: scope === 'local' ? entry.path : appendLocalPath(localPath, entry.name),
          remotePath: scope === 'local' ? appendRemotePath(path, entry.name) : entry.path,
          recursive: true,
          archive: true,
          conflict: 'ask',
        },
      );
      await queryClient.invalidateQueries({ queryKey: ['transfers'] });
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
        await client.copyGrantedEntryPaths(localGrant.grantId, paths);
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
      if (scope === 'local') {
        await client.operateGrantedEntries(authority, {
          paths: [...paths],
          destination,
          operation,
          conflict: 'rename',
        });
        const directories = [...new Set([localPath, destination])];
        const refreshed = await Promise.all(
          directories.map(async (directory) => ({
            directory,
            listing: await client.listGrantedDirectory(authority, directory),
          })),
        );
        setLocalSelection(createFileSelection());
        await queryClient.invalidateQueries({
          queryKey: ['local-files', authority],
          refetchType: 'none',
        });
        for (const item of refreshed)
          queryClient.setQueryData(['local-files', authority, item.directory], item.listing);
      } else {
        if (ftpMode && operation === 'copy') {
          setError(x('fileManager.ftpSiteCopyUnavailable'));
          return;
        }
        if (ftpMode) {
          for (const source of paths)
            await client.renameFtpPath(
              authority,
              source,
              appendRemotePath(destination, source.split('/').filter(Boolean).at(-1) ?? 'item'),
            );
        } else
          await client.operateRemoteEntries(authority, {
            paths: [...paths],
            destination,
            operation,
            conflict: 'rename',
          });
        const directories = [...new Set([path, destination])];
        const refreshed = await Promise.all(
          directories.map(async (directory) => ({
            directory,
            listing: await client.remoteFiles(authority, directory),
          })),
        );
        setRemoteSelection(createFileSelection());
        await queryClient.invalidateQueries({
          queryKey: ['files', authority],
          refetchType: 'none',
        });
        for (const item of refreshed)
          queryClient.setQueryData(['files', authority, item.directory], item.listing);
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
          await (ftpMode ? client.createFtpTransfer : client.createTransfer)(
            effectiveConnectionId,
            'upload',
            {
              grantId: localGrant.grantId,
              localPath: entry.path,
              remotePath: appendRemotePath(destination, entry.name),
              recursive: entry.type === 'directory',
              conflict: 'ask',
            },
          );
        } else if (payload.scope === 'remote' && targetScope === 'local') {
          await (ftpMode ? client.createFtpTransfer : client.createTransfer)(
            effectiveConnectionId,
            'download',
            {
              grantId: localGrant.grantId,
              localPath: appendLocalPath(destination, entry.name),
              remotePath: entry.path,
              recursive: entry.type === 'directory',
              conflict: 'ask',
            },
          );
        }
        queued += 1;
      }
      await queryClient.invalidateQueries({ queryKey: ['transfers'] });
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
        await queryClient.invalidateQueries({ queryKey: ['transfers'] });
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
        await client.createRemoteTransfer({
          sourceConnectionId: effectiveConnectionId,
          targetConnectionId: remoteCopyTargetConnectionId,
          sourcePath: entry.path,
          targetPath: appendRemotePath(destination, entry.name),
          recursive: entry.type === 'directory',
          conflict: 'ask',
        });
        queued += 1;
      }
      await queryClient.invalidateQueries({ queryKey: ['transfers'] });
      setFileNotice(x('fileManager.remoteCopyQueued', { count: entries.length }));
      setRemoteCopyDialog(undefined);
    } catch (cause) {
      setError(messageOf(cause, x));
      if (queued > 0) {
        setFileNotice(x('fileManager.remoteCopyPartiallyQueued', { count: queued }));
        await queryClient.invalidateQueries({ queryKey: ['transfers'] });
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
      await client.resolveTransferConflict(pendingConflict.id, {
        strategy,
        applyToAll: conflictApplyToAll,
      });
      await queryClient.invalidateQueries({ queryKey: ['transfers'] });
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
      className={session ? `embedded-file-panel embedded-file-panel-${session.kind}` : undefined}
      eyebrow="SFTP"
      title={x('fileManager.title')}
      description={x('fileManager.description')}
      action={
        session?.kind === 'local' ? undefined : (
          <div className="toolbar">
            <div className="file-view-switcher" role="group" aria-label={x('fileManager.layout')}>
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
        <p className="file-operation-notice" role="status">
          {fileNotice}
        </p>
      )}
      <div
        className={`file-workspace file-workspace-${effectiveFileManagerView}`}
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
            className="file-pane file-pane-local"
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
              const paths = window.desktopDirectoryDrop?.takePaths() ?? [];
              if (paths.length !== 1) {
                setError(x('fileManager.dropLocalDirectoryOnly'));
                return;
              }
              void navigateLocalAddress(paths[0]!);
            }}
          >
            <header className="file-pane-title">
              <strong>{x('fileManager.local')}</strong>
              <button type="button" onClick={() => void chooseLocalDirectory()}>
                <FolderInput size={12} />{' '}
                {localGrant ? x('fileManager.changeDirectory') : x('fileManager.selectDirectory')}
              </button>
            </header>
            <div className="file-address-bar">
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
            <div className="file-path-tools">
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
              <label className={`file-keyword-filter ${localKeyword ? 'active' : ''}`}>
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
              <div className="file-pane-recovery">
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
              <div className="file-list">
                <EmptyState
                  icon={Folder}
                  title={x('fileManager.selectLocalTitle')}
                  text={x('fileManager.grantHint')}
                />
              </div>
            ) : null}
            {localFiles.data?.truncated && (
              <p className="file-pane-note">{x('fileManager.listTruncated')}</p>
            )}
          </section>
        )}
        {effectiveFileManagerView === 'split' && (
          <div
            className="file-pane-divider"
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
          <section className="file-pane file-pane-remote" aria-label={x('fileManager.remoteFiles')}>
            <header className="file-pane-title">
              <strong>{x('fileManager.remote')}</strong>
              {session?.kind === 'ssh' ? (
                <span className="file-session-connection">
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
                    void client
                      .closeFtpConnection(effectiveConnectionId)
                      .then(async () => {
                        setActiveFtpConnection(undefined);
                        setConnectionId(ready[0]?.id ?? '');
                        await queryClient.invalidateQueries({ queryKey: ['ftp-connections'] });
                      })
                      .catch((cause: unknown) => setError(messageOf(cause, x)));
                  }}
                >
                  <X size={12} /> {x('fileManager.disconnect')}
                </button>
              )}
            </header>
            <div className="file-address-bar">
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
            <div className="file-path-tools">
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
              <label className={`file-keyword-filter ${remoteKeyword ? 'active' : ''}`}>
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
            <div className="file-pane-actions">
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
              <div className="file-pane-recovery">
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
              <div className="file-list">
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
          client={client}
          connectionId={effectiveConnectionId}
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
          client={client}
          initial={externalEditor}
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
      {crossPaneDrop && (
        <Modal
          title={
            crossPaneDrop.payload.scope === 'local'
              ? x('fileManager.confirmUpload')
              : x('fileManager.confirmDownload')
          }
          onClose={() => {
            if (!crossPaneTransferBusy) setCrossPaneDrop(undefined);
          }}
        >
          <div className="stack file-transfer-drop-dialog">
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
            <code>{crossPaneDrop.destination || '/'}</code>
            <p className="hint">{x('fileManager.conflictHint')}</p>
            <div className="modal-actions">
              <button
                type="button"
                disabled={crossPaneTransferBusy}
                onClick={() => setCrossPaneDrop(undefined)}
              >
                {x('common.cancel')}
              </button>
              <button
                type="button"
                className="primary"
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
            className="stack file-transfer-drop-dialog"
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
            <p className="hint">{x('fileManager.remoteCopyHint')}</p>
            <div className="modal-actions">
              <button
                type="button"
                disabled={remoteCopyBusy}
                onClick={() => setRemoteCopyDialog(undefined)}
              >
                {x('common.cancel')}
              </button>
              <button
                type="submit"
                className="primary"
                disabled={remoteCopyBusy || !remoteCopyTargetConnectionId}
              >
                {remoteCopyBusy ? x('fileManager.queueing') : x('fileManager.startCopy')}
              </button>
            </div>
          </form>
        </Modal>
      )}
      {pendingConflict?.conflict && (
        <Modal
          title={x('fileManager.resolveConflict')}
          onClose={() => {
            if (conflictDecisionBusy) return;
            void client
              .cancelTransfer(pendingConflict.id)
              .then(() => queryClient.invalidateQueries({ queryKey: ['transfers'] }));
          }}
        >
          <div className="stack transfer-conflict-dialog">
            <p className="danger-text">
              {x('fileManager.conflictDescription', {
                type: x(
                  pendingConflict.conflict.type === 'directory'
                    ? 'fileManager.directory'
                    : 'fileManager.file',
                ),
              })}
            </p>
            <code>{pendingConflict.conflict.path}</code>
            <label className="checkbox-row">
              <input
                type="checkbox"
                checked={conflictApplyToAll}
                disabled={conflictDecisionBusy}
                onChange={(event) => setConflictApplyToAll(event.target.checked)}
              />
              {x('fileManager.applyToAll')}
            </label>
            <div className="modal-actions transfer-conflict-actions">
              <button
                type="button"
                disabled={conflictDecisionBusy}
                onClick={() => void resolvePendingConflict('skip')}
              >
                {x('fileManager.skip')}
              </button>
              <button
                type="button"
                className="danger"
                disabled={conflictDecisionBusy}
                onClick={() => void resolvePendingConflict('overwrite')}
              >
                {pendingConflict.conflict.type === 'directory'
                  ? x('fileManager.merge')
                  : x('fileManager.overwrite')}
              </button>
              <button
                type="button"
                className="primary"
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

function FileInfoDialog({
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
    <div
      className="modal-backdrop"
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
      onKeyDown={(event) => {
        if (event.key === 'Escape') onClose();
      }}
    >
      <section
        className="modal file-info-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={x('fileInfo.title')}
      >
        <header>
          <div>
            <small>{scope === 'local' ? x('fileInfo.localItem') : x('fileInfo.remoteItem')}</small>
            <h2>{entry.name}</h2>
          </div>
          <button type="button" aria-label={x('fileInfo.closeAria')} onClick={onClose}>
            <X size={15} />
          </button>
        </header>
        <dl className="file-info-properties">
          {values.map(([label, value]) => (
            <div key={label}>
              <dt>{label}</dt>
              <dd>{value}</dd>
            </div>
          ))}
        </dl>
        {editingPermissions && (
          <div className="file-permission-editor">
            <div className="file-permission-summary">
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
            <div className="file-permission-grid">
              <span />
              <strong>{x('fileInfo.read')}</strong>
              <strong>{x('fileInfo.write')}</strong>
              <strong>{x('fileInfo.execute')}</strong>
              {permissionGroups.map((group) => (
                <div className="file-permission-row" key={group.label}>
                  <strong>{group.label}</strong>
                  {group.bits.map((bit, index) => (
                    <button
                      key={bit}
                      type="button"
                      aria-label={x('fileInfo.permissionAria', {
                        operation: [x('fileInfo.read'), x('fileInfo.write'), x('fileInfo.execute')][
                          index
                        ]!,
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
            <p className="hint">{x('fileInfo.nonRecursiveHint')}</p>
            {permissionError && <p className="danger-text">{permissionError}</p>}
          </div>
        )}
        <footer>
          {editingPermissions ? (
            <>
              <button type="button" disabled={saving} onClick={() => setEditingPermissions(false)}>
                {x('common.cancel')}
              </button>
              <button
                type="button"
                className="primary"
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
    </div>
  );
}

function symbolicMode(mode: number): string {
  const masks = [0o400, 0o200, 0o100, 0o040, 0o020, 0o010, 0o004, 0o002, 0o001];
  return masks.map((mask, index) => ((mode & mask) !== 0 ? 'rwx'[index % 3] : '-')).join('');
}

function FileTable({
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
    <div className="file-list file-table" aria-label={label}>
      <div className="file-table-header-wrap">
        <div className="file-table-header" role="row" style={{ gridTemplateColumns }}>
          {columns.map((column, index) => {
            const labelText = fileColumnLabel(column, x);
            return (
              <div
                className="file-table-column"
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
                    className="file-column-resizer"
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
        <details className="file-column-picker">
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
        className={`file-table-scroll ${dropTarget === 'current' ? 'drop-target' : ''}`}
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
            className={`file-row file-parent-row ${dropTarget === 'parent' ? 'drop-target' : ''}`}
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
        <div className="file-row-spacer" style={{ height: start * rowHeight }} />
        {visible.map((entry, visibleIndex) => {
          const index = start + visibleIndex;
          const isSelected = selection.paths.has(entry.path);
          return (
            <button
              className={`file-row file-data-row ${isSelected ? 'selected' : ''} ${dropTarget === entry.path ? 'drop-target' : ''}`}
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
        <div className="file-row-spacer" style={{ height: (entries.length - end) * rowHeight }} />
      </div>
      <div className="file-table-page" aria-live="polite">
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
