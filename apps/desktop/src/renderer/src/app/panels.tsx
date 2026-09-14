import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { useQuery, type QueryClient } from '@tanstack/react-query';
import type { createRuntimeClient } from '@workspace/client';
import type {
  AiApproval,
  AiAttachmentPreview,
  AiBookmarkDraft,
  AiProviderProtocol,
  AiToolCall,
  Bookmark,
  BookmarkTree,
  Connection,
  ExternalEditorSession,
  FileComparison,
  FtpConnection,
  Host,
  HostProxyConfig,
  KnownHostKey,
  RemoteFileEntry,
  Settings,
  SerialPortInfo,
  SshAgentStatus,
  TerminalProfile,
  TerminalProfileInput,
  Transfer,
  Tunnel,
  TunnelProfile,
} from '@workspace/contracts';
import {
  DEFAULT_AI_ROLE,
  DEFAULT_SSH_CONNECTION_OPTIONS,
  DEFAULT_SSH_STARTUP,
  DEFAULT_TERMINAL_APPEARANCE,
  DEFAULT_TERMINAL_BEHAVIOR,
  DEFAULT_TERMINAL_TYPE,
  TERMINAL_ENCODINGS,
} from '@workspace/contracts';
import {
  Bot,
  Check,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  ClipboardPaste,
  Copy,
  Download,
  File,
  FileCode2,
  FilePlus2,
  Filter,
  Folder,
  FolderInput,
  FolderOpen,
  FolderPlus,
  Globe2,
  History,
  Eye,
  EyeOff,
  Info,
  KeyRound,
  ListChecks,
  LoaderCircle,
  Monitor,
  Network,
  Pause,
  Paperclip,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  Save,
  Send,
  Scissors,
  Search,
  Server,
  ShieldAlert,
  Square,
  Star,
  Terminal as TerminalIcon,
  Trash2,
  Upload,
  WandSparkles,
  X,
} from 'lucide-react';
import { RemoteEditor } from '../components/remote-editor';
import { ExternalEditorDialog } from '../components/external-editor-dialog';
import { FileComparisonDialog } from '../components/file-comparison-dialog';
import { TextInputDialog } from '../components/text-input-dialog';
import { useWorkspace } from '../stores/workspace';
import type { FileGrant, UpdaterStatus } from '@workspace/contracts/desktop';
import type { QuickConnectTarget } from '@workspace/shared';
import { SshConfigImportDialog } from './ssh-config-import/ssh-config-import-dialog';
import { parseAiBookmarkDraft } from './ai-bookmark-draft';
import { aiGeneratedCode, aiTerminalInsertion } from './ai-generated-command';
import { WindowPreferencesPanel } from './window-preferences-panel';
import { HostProxyFields, ProxySettingsPanel } from './proxy-settings-panel';
import {
  normalizeProxyUsername,
  proxyCredentialRefs,
  retainedProxyCredentialRef,
} from './proxy-settings-model';
import { ConnectionProfilesPanel } from './connection-profiles/connection-profiles-panel';
import { ElectermDataPanel } from './electerm-data/electerm-data-panel';
import { TabPreferencesPanel } from './tab-preferences-panel';
import { CommandHistorySettingsPanel } from './command-history/command-history-settings-panel';
import { ShortcutSettingsPanel } from './shortcuts/shortcut-settings-panel';
import { QuickCommandWorkspace } from './quick-commands/quick-command-workspace';
import { BatchOperationWorkspace } from './batch-operations/batch-operation-workspace';
import { TriggerWorkspace } from './triggers/trigger-workspace';
import { BookmarkQuickCommandsEditor } from './bookmarks/bookmark-quick-commands-editor';
import { BookmarkTriggersEditor } from './bookmarks/bookmark-triggers-editor';
import { TerminalRecoverySettingsPanel } from './terminal-recovery-settings-panel';
import {
  filterSettingsCategories,
  moveSettingsCategory,
  type SettingsCategoryId,
} from './settings-navigation';
import { maskHostAddress } from './privacy';
import { WidgetWorkspace } from './widgets/widget-workspace';
import { TerminalThemeWorkspace } from './terminal-themes/terminal-theme-workspace';
import { DataSyncPanel } from './data-sync/data-sync-panel';
import { LanguageSettingsPanel } from './language-settings-panel';
import { ActivityRailSettingsPanel } from './activity-rail-settings-panel';
import { ElectermBehaviorSettingsPanel } from './electerm-behavior-settings-panel';
import { useI18n } from '../i18n/context';
import type { AxtermMessageKey } from '../i18n/core';
import { FileContextMenu, type FileContextMenuItem } from '../components/file-context-menu';
import {
  createFileSelection,
  moveFileSelection,
  selectAllFilePaths,
  selectFilePath,
  singleSelectedFilePath,
  type FileSelectionState,
} from './file-selection-model';
import './bookmarks/ssh-bookmark-form.css';
import {
  filterFileEntries,
  sortFileEntries,
  type FileManagerSort,
  type FileTableEntry,
} from './file-list-model';
import { calculateVirtualWindow } from './virtual-window';

type Client = ReturnType<typeof createRuntimeClient>;
type Translator = ReturnType<typeof useI18n>['x'];
type HostFormTab = 'auth' | 'settings' | 'quickCommands' | 'triggers' | 'tunnels' | 'hops';
type HostAuthType = Host['authType'];
type FileManagerColumn = Settings['fileManager']['columns'][number];
type FilePaneScope = 'local' | 'remote';
interface FileOperationClipboard {
  scope: FilePaneScope;
  authority: string;
  operation: 'copy' | 'move';
  paths: string[];
}
interface FileDragPayload {
  scope: FilePaneScope;
  authority: string;
  paths: string[];
}
const FILE_DRAG_MIME = 'application/x-axterm-file-selection';

const FILE_MANAGER_COLUMNS: Array<{ id: FileManagerColumn; labelKey: AxtermMessageKey }> = [
  { id: 'name', labelKey: 'fileManager.columnName' },
  { id: 'size', labelKey: 'fileManager.columnSize' },
  { id: 'modifiedAt', labelKey: 'fileManager.columnModified' },
  { id: 'accessedAt', labelKey: 'fileManager.columnAccessed' },
  { id: 'owner', labelKey: 'fileManager.columnOwner' },
  { id: 'group', labelKey: 'fileManager.columnGroup' },
  { id: 'mode', labelKey: 'fileManager.columnMode' },
  { id: 'path', labelKey: 'fileManager.columnPath' },
  { id: 'extension', labelKey: 'fileManager.columnExtension' },
];
const DEFAULT_FILE_MANAGER_COLUMNS: FileManagerColumn[] = ['name', 'size', 'modifiedAt'];
const DEFAULT_FILE_MANAGER_SORT: FileManagerSort = {
  property: 'modifiedAt',
  direction: 'desc',
};

export function HostsPanel({
  client,
  queryClient,
  hosts,
  bookmarkTree,
  connections,
  onCreateBookmarkGroup,
  onConnectBookmark,
  onDuplicateBookmark,
  onDeleteBookmark,
  requestedBookmarkId,
  requestedCreate = false,
  requestedQuickConnect,
  hideAddresses = false,
  onRequestedBookmarkHandled,
}: {
  client: Client;
  queryClient: QueryClient;
  hosts: Host[];
  bookmarkTree: BookmarkTree | undefined;
  connections: Connection[];
  onCreateBookmarkGroup(): void;
  onConnectBookmark(bookmark: Bookmark): void;
  onDuplicateBookmark(bookmark: Bookmark): void;
  onDeleteBookmark(bookmark: Bookmark): void;
  requestedBookmarkId?: string;
  requestedCreate?: boolean;
  requestedQuickConnect?: QuickConnectTarget;
  hideAddresses?: boolean;
  onRequestedBookmarkHandled?(): void;
}) {
  const { x } = useI18n();
  const requestedBookmark = bookmarkTree?.bookmarks.find(({ id }) => id === requestedBookmarkId);
  const requestedFtpBookmark =
    requestedBookmark?.protocol === 'ftp' ? requestedBookmark : undefined;
  const requestedTelnetBookmark =
    requestedBookmark?.protocol === 'telnet' ? requestedBookmark : undefined;
  const requestedSerialBookmark =
    requestedBookmark?.protocol === 'serial' ? requestedBookmark : undefined;
  const requestedRdpBookmark =
    requestedBookmark?.protocol === 'rdp' ? requestedBookmark : undefined;
  const requestedVncBookmark =
    requestedBookmark?.protocol === 'vnc' ? requestedBookmark : undefined;
  const requestedSpiceBookmark =
    requestedBookmark?.protocol === 'spice' ? requestedBookmark : undefined;
  const requestedWebBookmark =
    requestedBookmark?.protocol === 'web' ? requestedBookmark : undefined;
  const requestedHost = requestedBookmark?.hostId
    ? hosts.find(({ id }) => id === requestedBookmark.hostId)
    : undefined;
  const [editing, setEditing] = useState(false);
  const [editingHost, setEditingHost] = useState<Host>();
  const [editingBookmark, setEditingBookmark] = useState<Bookmark>();
  const [ftpEditing, setFtpEditing] = useState<Bookmark | null>();
  const [telnetEditing, setTelnetEditing] = useState<Bookmark | null>();
  const [serialEditing, setSerialEditing] = useState<Bookmark | null>();
  const [rdpEditing, setRdpEditing] = useState<Bookmark | null>();
  const [vncEditing, setVncEditing] = useState<Bookmark | null>();
  const [spiceEditing, setSpiceEditing] = useState<Bookmark | null>();
  const [webEditing, setWebEditing] = useState<Bookmark | null>();
  const [aiBookmarkOpen, setAiBookmarkOpen] = useState(false);
  const [savingBookmark, setSavingBookmark] = useState(false);
  const [connecting, setConnecting] = useState<Host>();
  const [error, setError] = useState('');
  const [importGrant, setImportGrant] = useState<FileGrant>();
  const [hostQuery, setHostQuery] = useState('');
  const [activeGroupId, setActiveGroupId] = useState<string>();
  const [hostFormTab, setHostFormTab] = useState<HostFormTab>('auth');
  const [bookmarkQuickCommandDrafts, setBookmarkQuickCommandDrafts] = useState<
    Record<string, Bookmark['quickCommands']>
  >({});
  const [bookmarkTriggerDrafts, setBookmarkTriggerDrafts] = useState<
    Record<string, Bookmark['triggers']>
  >({});
  const [hostAuthTypeOverride, setHostAuthType] = useState<HostAuthType>();
  const [preferSshAgentOverride, setPreferSshAgent] = useState<boolean>();
  const [sshAgentPathOverride, setSshAgentPath] = useState<string>();
  const [sshAgentStatus, setSshAgentStatus] = useState<SshAgentStatus>();
  const [probingSshAgent, setProbingSshAgent] = useState(false);
  const [useConnectionProfileOverride, setUseConnectionProfile] = useState<boolean>();
  const terminalProfiles = useQuery({
    queryKey: ['terminal-profiles'],
    queryFn: client.terminalProfiles,
  });
  const connectionProfiles = useQuery({
    queryKey: ['connection-profiles'],
    queryFn: client.connectionProfiles,
  });
  const tunnelProfiles = useQuery({
    queryKey: ['tunnel-profiles'],
    queryFn: client.tunnelProfiles,
  });
  const serialPorts = useQuery({
    queryKey: ['serial-ports'],
    queryFn: client.serialPorts,
    retry: false,
  });
  const tunnels = useQuery({
    queryKey: ['tunnels'],
    queryFn: client.tunnels,
    refetchInterval: 1_500,
  });
  const addTerminal = useWorkspace((state) => state.addTerminal);
  const showSection = useWorkspace((state) => state.showSection);
  const [bookmarkFormQuery, setBookmarkFormQuery] = useState('');
  const activeEditingBookmark =
    editingBookmark ?? (requestedBookmark?.protocol === 'ssh' ? requestedBookmark : undefined);
  const bookmarkQuickCommandDraftKey = activeEditingBookmark?.id ?? 'new';
  const bookmarkQuickCommands =
    bookmarkQuickCommandDrafts[bookmarkQuickCommandDraftKey] ??
    activeEditingBookmark?.quickCommands ??
    [];
  const setBookmarkQuickCommands = (value: Bookmark['quickCommands']) =>
    setBookmarkQuickCommandDrafts((current) => ({
      ...current,
      [bookmarkQuickCommandDraftKey]: value,
    }));
  const bookmarkTriggers =
    bookmarkTriggerDrafts[bookmarkQuickCommandDraftKey] ?? activeEditingBookmark?.triggers ?? [];
  const setBookmarkTriggers = (value: Bookmark['triggers']) =>
    setBookmarkTriggerDrafts((current) => ({
      ...current,
      [bookmarkQuickCommandDraftKey]: value,
    }));
  const activeEditingHost = editingHost ?? requestedHost;
  const hostAuthType =
    hostAuthTypeOverride ??
    (activeEditingHost?.authType === 'agent' ? 'password' : activeEditingHost?.authType) ??
    'password';
  const preferSshAgent = preferSshAgentOverride ?? activeEditingHost?.sshAgent.enabled ?? true;
  const sshAgentPath = sshAgentPathOverride ?? activeEditingHost?.sshAgent.path ?? '';
  const useConnectionProfile =
    useConnectionProfileOverride ?? !!activeEditingBookmark?.connectionProfileId;
  const editorOpen = editing || requestedCreate || (!!requestedBookmark && !!requestedHost);
  const groupIds = activeGroupId ? descendantGroupIds(bookmarkTree, activeGroupId) : undefined;
  const visibleHostIds = groupIds
    ? new Set(
        bookmarkTree?.bookmarks
          .filter((bookmark) => bookmark.groupId && groupIds.has(bookmark.groupId))
          .flatMap((bookmark) => (bookmark.hostId ? [bookmark.hostId] : [])) ?? [],
      )
    : undefined;
  const visibleHosts = hosts
    .filter((host) => !visibleHostIds || visibleHostIds.has(host.id))
    .filter((host) =>
      `${host.name} ${host.hostname} ${host.username}`
        .toLowerCase()
        .includes(hostQuery.trim().toLowerCase()),
    )
    .sort(
      (left, right) =>
        Number(right.favorite) - Number(left.favorite) || left.name.localeCompare(right.name),
    );
  const visibleFtpBookmarks = (bookmarkTree?.bookmarks ?? [])
    .filter((bookmark) => bookmark.protocol === 'ftp' && bookmark.ftp)
    .filter((bookmark) => !groupIds || (!!bookmark.groupId && groupIds.has(bookmark.groupId)))
    .filter((bookmark) =>
      `${bookmark.title} ${bookmark.ftp?.hostname ?? ''} ${bookmark.ftp?.username ?? ''}`
        .toLocaleLowerCase()
        .includes(hostQuery.trim().toLocaleLowerCase()),
    );
  const visibleTelnetBookmarks = (bookmarkTree?.bookmarks ?? [])
    .filter((bookmark) => bookmark.protocol === 'telnet' && bookmark.telnet)
    .filter((bookmark) => !groupIds || (!!bookmark.groupId && groupIds.has(bookmark.groupId)))
    .filter((bookmark) =>
      `${bookmark.title} ${bookmark.telnet?.hostname ?? ''} ${bookmark.telnet?.username ?? ''}`
        .toLocaleLowerCase()
        .includes(hostQuery.trim().toLocaleLowerCase()),
    );
  const visibleSerialBookmarks = (bookmarkTree?.bookmarks ?? [])
    .filter((bookmark) => bookmark.protocol === 'serial' && bookmark.serial)
    .filter((bookmark) => !groupIds || (!!bookmark.groupId && groupIds.has(bookmark.groupId)))
    .filter((bookmark) =>
      `${bookmark.title} ${bookmark.serial?.path ?? ''} ${bookmark.serial?.baudRate ?? ''}`
        .toLocaleLowerCase()
        .includes(hostQuery.trim().toLocaleLowerCase()),
    );
  const visibleRdpBookmarks = (bookmarkTree?.bookmarks ?? [])
    .filter((bookmark) => bookmark.protocol === 'rdp' && bookmark.rdp)
    .filter((bookmark) => !groupIds || (!!bookmark.groupId && groupIds.has(bookmark.groupId)))
    .filter((bookmark) =>
      `${bookmark.title} ${bookmark.rdp?.hostname ?? ''} ${bookmark.rdp?.username ?? ''}`
        .toLocaleLowerCase()
        .includes(hostQuery.trim().toLocaleLowerCase()),
    );
  const visibleVncBookmarks = (bookmarkTree?.bookmarks ?? [])
    .filter((bookmark) => bookmark.protocol === 'vnc' && bookmark.vnc)
    .filter((bookmark) => !groupIds || (!!bookmark.groupId && groupIds.has(bookmark.groupId)))
    .filter((bookmark) =>
      `${bookmark.title} ${bookmark.vnc?.hostname ?? ''} ${bookmark.vnc?.username ?? ''}`
        .toLocaleLowerCase()
        .includes(hostQuery.trim().toLocaleLowerCase()),
    );
  const visibleSpiceBookmarks = (bookmarkTree?.bookmarks ?? [])
    .filter((bookmark) => bookmark.protocol === 'spice' && bookmark.spice)
    .filter((bookmark) => !groupIds || (!!bookmark.groupId && groupIds.has(bookmark.groupId)))
    .filter((bookmark) =>
      `${bookmark.title} ${bookmark.spice?.hostname ?? ''}`
        .toLocaleLowerCase()
        .includes(hostQuery.trim().toLocaleLowerCase()),
    );
  const visibleWebBookmarks = (bookmarkTree?.bookmarks ?? [])
    .filter((bookmark) => bookmark.protocol === 'web' && bookmark.web)
    .filter((bookmark) => !groupIds || (!!bookmark.groupId && groupIds.has(bookmark.groupId)))
    .filter((bookmark) =>
      `${bookmark.title} ${bookmark.web?.url ?? ''}`
        .toLocaleLowerCase()
        .includes(hostQuery.trim().toLocaleLowerCase()),
    );

  async function createHost(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (savingBookmark) return;
    const formElement = event.currentTarget;
    if (!formElement.checkValidity()) {
      const invalid = [...formElement.elements].find(
        (element) =>
          (element instanceof HTMLInputElement ||
            element instanceof HTMLSelectElement ||
            element instanceof HTMLTextAreaElement) &&
          !element.validity.valid,
      );
      const tab = invalid?.closest<HTMLElement>('[data-tab]')?.dataset.tab;
      if (
        tab === 'auth' ||
        tab === 'settings' ||
        tab === 'quickCommands' ||
        tab === 'triggers' ||
        tab === 'tunnels' ||
        tab === 'hops'
      )
        setHostFormTab(tab);
      requestAnimationFrame(() => formElement.reportValidity());
      return;
    }
    const form = new FormData(formElement);
    const submitAction =
      ((event.nativeEvent as SubmitEvent).submitter as HTMLButtonElement | null)?.value ?? 'save';
    setError('');
    setSavingBookmark(true);
    const createdCredentialRefs: string[] = [];
    let referencesCommitted = false;
    let savedHost: Host | undefined;
    let savedBookmark: Bookmark | undefined;
    try {
      const password = String(form.get('password') ?? '');
      const save = form.get('save') === 'on';
      const selectedAuthType = String(form.get('authType')) as
        'password' | 'privateKey' | 'keyboardInteractive' | 'agent';
      const authType =
        selectedAuthType === 'password' && preferSshAgent && !password
          ? ('agent' as const)
          : selectedAuthType;
      const credential =
        password && save
          ? await client
              .createCredential({
                kind: authType === 'privateKey' ? 'privateKey' : 'sshPassword',
                label: `${String(form.get('name'))} SSH`,
                secret: password,
              })
              .then((value) => {
                createdCredentialRefs.push(value.ref);
                return value;
              })
          : undefined;
      const passphrase = String(form.get('passphrase') ?? '');
      const passphraseCredential =
        passphrase && save
          ? await client
              .createCredential({
                kind: 'privateKeyPassphrase',
                label: `${String(form.get('name'))} key passphrase`,
                secret: passphrase,
              })
              .then((value) => {
                createdCredentialRefs.push(value.ref);
                return value;
              })
          : undefined;
      const certificate = String(form.get('certificate') ?? '');
      const certificateCredential =
        certificate && save
          ? await client
              .createCredential({
                kind: 'sshCertificate',
                label: `${String(form.get('name'))} SSH certificate`,
                secret: certificate,
              })
              .then((value) => {
                createdCredentialRefs.push(value.ref);
                return value;
              })
          : undefined;
      const proxyMode = String(form.get('proxyMode') ?? 'inherit') as HostProxyConfig['mode'];
      let proxy: HostProxyConfig =
        proxyMode === 'direct' ? { mode: 'direct' } : { mode: 'inherit' };
      if (proxyMode === 'custom') {
        const proxyUrl = String(form.get('proxyUrl') ?? '').trim();
        const proxyUsername = normalizeProxyUsername(String(form.get('proxyUsername') ?? ''));
        const proxyPassword = String(form.get('proxyPassword') ?? '');
        if (!proxyUsername && proxyPassword) throw new Error(x('hosts.proxyUsernameRequired'));
        let proxyCredentialRef = proxyUsername
          ? retainedProxyCredentialRef(activeEditingHost?.proxy, proxyUsername)
          : null;
        if (proxyUsername && proxyPassword) {
          proxyCredentialRef = (
            await client.createCredential({
              kind: 'proxyPassword',
              label: x('hosts.proxyCredentialLabel', { name: String(form.get('name')) }),
              secret: proxyPassword,
            })
          ).ref;
          createdCredentialRefs.push(proxyCredentialRef);
        }
        if (proxyUsername && !proxyCredentialRef) throw new Error(x('hosts.proxyPasswordRequired'));
        proxy = {
          mode: 'custom',
          endpoint: { url: proxyUrl, username: proxyUsername, credentialRef: proxyCredentialRef },
        };
      } else if (proxyMode === 'command') {
        proxy = {
          mode: 'command',
          command: {
            executable: String(form.get('proxyCommandExecutable') ?? '').trim(),
            arguments: String(form.get('proxyCommandArguments') ?? '')
              .split(/\r?\n/u)
              .map((argument) => argument.trim())
              .filter(Boolean),
          },
        };
      }
      const keepExistingCredential = activeEditingHost?.authType === authType;
      const input = {
        name: String(form.get('name')),
        hostname: String(form.get('hostname')),
        username: String(form.get('username')),
        port: Number(form.get('port')),
        authType,
        credentialRef:
          credential?.ref ??
          (keepExistingCredential ? activeEditingHost?.credentialRef : null) ??
          null,
        passphraseCredentialRef:
          authType === 'privateKey'
            ? (passphraseCredential?.ref ??
              (keepExistingCredential ? activeEditingHost?.passphraseCredentialRef : null) ??
              null)
            : null,
        certificateCredentialRef:
          authType === 'privateKey'
            ? (certificateCredential?.ref ??
              (keepExistingCredential ? activeEditingHost?.certificateCredentialRef : null) ??
              null)
            : null,
        jumpHostId: null,
        jumpHostIds: form.getAll('jumpHostIds').map(String),
        favorite: form.get('favorite') === 'on',
        proxy,
        connectionOptions: {
          connectionTimeoutMs: Number(form.get('connectionTimeoutMs')),
          keepaliveIntervalMs: Number(form.get('keepaliveIntervalMs')),
          keepaliveCountMax: Number(form.get('keepaliveCountMax')),
          compression: form.get('compression') === 'on',
          algorithms: {
            kex: form.getAll('sshKex').map(String),
            cipher: form.getAll('sshCipher').map(String),
            serverHostKey: form.getAll('sshServerHostKey').map(String),
            hmac: form.getAll('sshHmac').map(String),
          },
          reconnectPolicy: {
            mode: String(form.get('reconnectMode')) as 'manual' | 'automatic',
            delayMs: Number(form.get('reconnectDelayMs')),
            maxAttempts: Number(form.get('reconnectMaxAttempts')),
          },
        },
        startup: {
          directory: String(form.get('sshStartupDirectory') ?? '').trim() || null,
          environment: parseSshStartupEnvironment(
            String(form.get('sshStartupEnvironment') ?? ''),
            x,
          ),
          loginScripts: readSshStartupScripts(form, 'sshLoginScript'),
          runScripts: readSshStartupScripts(form, 'sshRunScript'),
        },
        x11: {
          enabled: form.get('sshX11Enabled') === 'on',
          display: String(form.get('sshX11Display') ?? '').trim() || null,
        },
        sshAgent: {
          enabled: preferSshAgent,
          path: String(form.get('sshAgentPath') ?? '').trim() || null,
        },
      };
      if (activeEditingHost) {
        const tree = queryClient.getQueryData<BookmarkTree>(['bookmark-tree']) ?? bookmarkTree;
        const bookmark =
          activeEditingBookmark ??
          tree?.bookmarks.find(({ hostId }) => hostId === activeEditingHost.id);
        if (!tree || !bookmark) throw new Error(x('hosts.sshBookmarkMissing'));
        const result = await client.updateSshBookmark(tree, activeEditingHost, bookmark.id, {
          host: input,
          bookmark: {
            groupId: String(form.get('groupId') || '') || null,
            title: String(form.get('bookmarkTitle') || '').trim() || input.name,
            color: String(form.get('color') || '').trim() || null,
            description: String(form.get('description') || ''),
            profileId: String(form.get('profileId') || '') || null,
            connectionProfileId: String(form.get('connectionProfileId') || '') || null,
            quickCommands: bookmarkQuickCommands,
            triggers: bookmarkTriggers,
          },
        });
        referencesCommitted = true;
        queryClient.setQueryData(['bookmark-tree'], result.tree);
        await cleanupReplacedCredentials(client, hosts, activeEditingHost, result.host);
        savedHost = result.host;
        savedBookmark = result.bookmark;
      } else {
        const tree = queryClient.getQueryData<BookmarkTree>(['bookmark-tree']) ?? bookmarkTree;
        if (!tree) throw new Error(x('hosts.treeUnavailable'));
        const result = await client.createSshBookmark(tree, {
          host: input,
          bookmark: {
            groupId: String(form.get('groupId') || '') || null,
            title: String(form.get('bookmarkTitle') || '').trim() || input.name,
            color: String(form.get('color') || '').trim() || null,
            description: String(form.get('description') || ''),
            profileId: String(form.get('profileId') || '') || null,
            connectionProfileId: String(form.get('connectionProfileId') || '') || null,
            quickCommands: bookmarkQuickCommands,
            triggers: bookmarkTriggers,
          },
        });
        referencesCommitted = true;
        queryClient.setQueryData(['bookmark-tree'], result.tree);
        savedHost = result.host;
        savedBookmark = result.bookmark;
      }
      formElement.reset();
      setBookmarkQuickCommandDrafts({});
      setBookmarkTriggerDrafts({});
      await queryClient.invalidateQueries({ queryKey: ['hosts'] });
      setEditingHost(undefined);
      setEditingBookmark(undefined);
      onRequestedBookmarkHandled?.();
      if (submitAction === 'save-and-new') {
        setHostFormTab('auth');
        setHostAuthType('password');
        setPreferSshAgent(undefined);
        setSshAgentPath(undefined);
        setSshAgentStatus(undefined);
        setUseConnectionProfile(false);
        setEditing(true);
      } else {
        setHostFormTab('auth');
        setHostAuthType(undefined);
        setPreferSshAgent(undefined);
        setSshAgentPath(undefined);
        setSshAgentStatus(undefined);
        setUseConnectionProfile(undefined);
        setEditing(false);
      }
      if (submitAction === 'save-and-connect' && savedHost && savedBookmark) {
        const connection = await client.createConnection(
          savedHost.id,
          save ? undefined : password || undefined,
          save ? undefined : passphrase || undefined,
          savedBookmark.connectionProfileId ?? undefined,
          save ? undefined : certificate || undefined,
        );
        const ready = await waitForReadyConnection(client, connection.id, x);
        await queryClient.invalidateQueries({ queryKey: ['connections'] });
        await openShell(
          ready,
          savedBookmark.profileId ?? undefined,
          savedBookmark.title,
          savedBookmark.id,
        );
      }
    } catch (cause) {
      if (!referencesCommitted && createdCredentialRefs.length)
        await Promise.allSettled(
          createdCredentialRefs.map((credentialRef) => client.deleteCredential(credentialRef)),
        );
      setError(messageOf(cause, x));
    } finally {
      setSavingBookmark(false);
    }
  }

  async function importConfig() {
    setError('');
    try {
      const grant = await client.createFileGrant('open-file');
      if (!grant) return;
      const tree = queryClient.getQueryData<BookmarkTree>(['bookmark-tree']) ?? bookmarkTree;
      if (!tree) {
        await client.revokeFileGrant(grant.grantId);
        throw new Error(x('hosts.treeUnavailable'));
      }
      setImportGrant(grant);
    } catch (cause) {
      setError(messageOf(cause, x));
    }
  }

  async function deleteHost(host: Host) {
    if (!window.confirm(x('hosts.deleteConfirm', { name: host.name }))) return;
    try {
      const tree = queryClient.getQueryData<BookmarkTree>(['bookmark-tree']) ?? bookmarkTree;
      if (!tree) throw new Error(x('hosts.treeUnavailable'));
      const result = await client.deleteSshBookmarkHost(tree, host);
      queryClient.setQueryData(['bookmark-tree'], result.tree);
      const credentialRefs = [
        host.credentialRef,
        host.passphraseCredentialRef,
        host.certificateCredentialRef,
        ...proxyCredentialRefs(host.proxy),
      ].filter(
        (value): value is string =>
          !!value &&
          !hosts.some(
            (candidate) =>
              candidate.id !== host.id &&
              (candidate.credentialRef === value ||
                candidate.passphraseCredentialRef === value ||
                candidate.certificateCredentialRef === value ||
                proxyCredentialRefs(candidate.proxy).includes(value)),
          ),
      );
      await Promise.allSettled(
        [...new Set(credentialRefs)].map((credentialRef) => client.deleteCredential(credentialRef)),
      );
      await queryClient.invalidateQueries({ queryKey: ['hosts'] });
      await queryClient.invalidateQueries({ queryKey: ['connections'] });
    } catch (cause) {
      setError(messageOf(cause, x));
    }
  }

  async function connect(host: Host, secret?: string, passphrase?: string, certificate?: string) {
    setError('');
    try {
      const connectionProfileId = bookmarkTree?.bookmarks.find(
        (bookmark) => bookmark.hostId === host.id,
      )?.connectionProfileId;
      await client.createConnection(
        host.id,
        secret,
        passphrase,
        connectionProfileId ?? undefined,
        certificate,
      );
      setConnecting(undefined);
      await queryClient.invalidateQueries({ queryKey: ['connections'] });
    } catch (cause) {
      setError(messageOf(cause, x));
    }
  }

  async function openShell(
    connection: Connection,
    requestedProfileId?: string,
    title?: string,
    requestedBookmarkId?: string,
  ) {
    try {
      const bookmark = requestedBookmarkId
        ? bookmarkTree?.bookmarks.find(({ id }) => id === requestedBookmarkId)
        : bookmarkTree?.bookmarks.find((candidate) => candidate.hostId === connection.hostId);
      const profileId = requestedProfileId ?? bookmark?.profileId;
      const terminal = await client.createTerminal({
        kind: 'ssh',
        connectionId: connection.id,
        ...(bookmark ? { bookmarkId: bookmark.id } : {}),
        ...(profileId ? { profileId } : {}),
        cols: 160,
        rows: 80,
      });
      addTerminal({
        id: terminal.id,
        title: title ?? hosts.find((host) => host.id === connection.hostId)?.name ?? terminal.title,
        kind: 'ssh',
        hostId: connection.hostId,
        ...(bookmark ? { bookmarkId: bookmark.id } : {}),
        connectionId: connection.id,
        ...(connection.connectionProfileId
          ? { connectionProfileId: connection.connectionProfileId }
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

  async function openLocalShell() {
    try {
      const terminal = await client.createTerminal({ kind: 'local', cols: 160, rows: 80 });
      addTerminal({
        id: terminal.id,
        title: terminal.title,
        kind: 'local',
        ...(terminal.profileId ? { profileId: terminal.profileId } : {}),
        appearance: terminal.appearance,
        behavior: terminal.behavior,
        disconnected: false,
      });
      closeEditor();
    } catch (cause) {
      setError(messageOf(cause, x));
    }
  }

  function closeEditor() {
    setEditing(false);
    setEditingHost(undefined);
    setEditingBookmark(undefined);
    setHostFormTab('auth');
    setBookmarkQuickCommandDrafts({});
    setBookmarkTriggerDrafts({});
    setHostAuthType(undefined);
    setPreferSshAgent(undefined);
    setSshAgentPath(undefined);
    setSshAgentStatus(undefined);
    setUseConnectionProfile(undefined);
    setBookmarkFormQuery('');
    onRequestedBookmarkHandled?.();
  }

  function openProtocolBookmarkEditor(
    protocol: 'ftp' | 'telnet' | 'serial' | 'rdp' | 'vnc' | 'spice' | 'web' | 'local',
  ) {
    if (protocol === 'local') {
      closeEditor();
      void openLocalShell();
      return;
    }
    if (protocol === 'ftp') setFtpEditing(null);
    else if (protocol === 'telnet') setTelnetEditing(null);
    else if (protocol === 'serial') setSerialEditing(null);
    else if (protocol === 'rdp') setRdpEditing(null);
    else if (protocol === 'vnc') setVncEditing(null);
    else if (protocol === 'spice') setSpiceEditing(null);
    else setWebEditing(null);
  }

  function connectProtocolBookmark(bookmark: Bookmark) {
    closeEditor();
    onConnectBookmark(bookmark);
  }

  async function probeAgent() {
    setError('');
    setProbingSshAgent(true);
    try {
      setSshAgentStatus(await client.probeSshAgent(sshAgentPath.trim() || undefined));
    } catch (cause) {
      setError(messageOf(cause, x));
    } finally {
      setProbingSshAgent(false);
    }
  }

  function leaveEditor(section: 'hosts' | 'commands' | 'ai' | 'settings') {
    closeEditor();
    showSection(section);
  }

  const bookmarkFormGroups = (() => {
    const groups = bookmarkTree?.groups ?? [];
    const ordered = groups
      .filter(({ parentId }) => parentId === null)
      .flatMap((root) => [root, ...groups.filter(({ parentId }) => parentId === root.id)]);
    const keyword = bookmarkFormQuery.trim().toLocaleLowerCase();
    return keyword
      ? ordered.filter(({ name }) => name.toLocaleLowerCase().includes(keyword))
      : ordered;
  })();

  return (
    <PanelFrame
      eyebrow="HOST MANAGER"
      title={x('hosts.title')}
      description={x('hosts.description')}
      action={
        <div className="toolbar">
          <button onClick={() => void importConfig()}>{x('hosts.importSshConfig')}</button>
          <button onClick={onCreateBookmarkGroup}>{x('hosts.newGroup')}</button>
          <button onClick={() => setFtpEditing(null)}>
            <FolderInput size={14} /> {x('hosts.addFtp')}
          </button>
          <button onClick={() => setTelnetEditing(null)}>
            <Network size={14} /> {x('hosts.addTelnet')}
          </button>
          <button onClick={() => setSerialEditing(null)}>
            <TerminalIcon size={14} /> {x('hosts.addSerial')}
          </button>
          <button onClick={() => setRdpEditing(null)}>
            <Monitor size={14} /> {x('hosts.addRdp')}
          </button>
          <button onClick={() => setVncEditing(null)}>
            <Monitor size={14} /> {x('hosts.addVnc')}
          </button>
          <button onClick={() => setSpiceEditing(null)}>
            <Monitor size={14} /> {x('hosts.addSpice')}
          </button>
          <button onClick={() => setWebEditing(null)}>
            <Globe2 size={14} /> {x('hosts.addWeb')}
          </button>
          <button
            className="primary"
            onClick={() => {
              setEditingHost(undefined);
              setEditingBookmark(undefined);
              setHostFormTab('auth');
              setHostAuthType('password');
              setPreferSshAgent(undefined);
              setSshAgentPath(undefined);
              setSshAgentStatus(undefined);
              setUseConnectionProfile(false);
              onRequestedBookmarkHandled?.();
              setEditing(true);
            }}
          >
            <Plus size={14} /> {x('hosts.addHost')}
          </button>
        </div>
      }
    >
      {error && <ErrorBanner text={error} />}
      <div className="host-filter-bar">
        <div className="group-strip" role="tablist" aria-label={x('hosts.groups')}>
          <button
            className={!activeGroupId ? 'active' : ''}
            onClick={() => setActiveGroupId(undefined)}
          >
            {x('hosts.all')} <small>{hosts.length}</small>
          </button>
          {bookmarkTree?.groups.map((group) => (
            <button
              className={activeGroupId === group.id ? 'active' : ''}
              key={group.id}
              onClick={() => setActiveGroupId(group.id)}
            >
              {group.name}
              <small>{hostsInGroup(bookmarkTree, group.id).size}</small>
            </button>
          ))}
        </div>
        <label className="host-search">
          <Search size={14} />
          <input
            aria-label={x('hosts.searchList')}
            placeholder={x('hosts.searchPlaceholder')}
            value={hostQuery}
            onChange={(event) => setHostQuery(event.target.value)}
          />
        </label>
      </div>
      <div className="card-grid">
        {visibleHosts.map((host) => {
          const bookmark = bookmarkTree?.bookmarks.find((item) => item.hostId === host.id);
          const connectionProfile = connectionProfiles.data?.find(
            (profile) => profile.id === bookmark?.connectionProfileId,
          );
          const connection = connections.find(
            (item) =>
              item.hostId === host.id &&
              (item.connectionProfileId ?? null) === (bookmark?.connectionProfileId ?? null) &&
              item.state !== 'closed',
          );
          return (
            <article
              className="host-card"
              data-bookmark-id={bookmark?.id}
              data-bookmark-protocol="ssh"
              data-bookmark-description={bookmark?.description}
              key={host.id}
              title={bookmark?.description || undefined}
            >
              <div className="card-icon">
                <Server size={18} />
              </div>
              <div className="card-copy">
                <strong>
                  {bookmark?.color && (
                    <span
                      className="bookmark-title-color"
                      data-bookmark-color={bookmark.color}
                      style={{ color: bookmark.color }}
                      aria-hidden="true"
                    >
                      ●
                    </span>
                  )}
                  {bookmark?.title ?? host.name}
                  {host.favorite && <Star size={12} fill="currentColor" />}
                </strong>
                <span>
                  {host.username}@{hideAddresses ? maskHostAddress(host.hostname) : host.hostname}:
                  {host.port}
                </span>
                <small className={`connection-state ${connection?.state ?? 'idle'}`}>
                  <i />{' '}
                  {connection
                    ? connectionStateLabel(connection.state, x)
                    : authTypeLabel(host.authType, x)}
                </small>
              </div>
              <div className="card-actions">
                <button
                  onClick={() => {
                    setEditingHost(host);
                    setEditingBookmark(
                      bookmarkTree?.bookmarks.find(({ hostId }) => hostId === host.id),
                    );
                    setHostFormTab('auth');
                    setHostAuthType(host.authType === 'agent' ? 'password' : host.authType);
                    setPreferSshAgent(undefined);
                    setSshAgentPath(undefined);
                    setSshAgentStatus(undefined);
                    setUseConnectionProfile(undefined);
                    setEditing(true);
                  }}
                >
                  {x('hosts.edit')}
                </button>
                {bookmark && (
                  <button
                    aria-label={x('bookmarkTree.duplicate')}
                    title={x('bookmarkTree.duplicate')}
                    onClick={() => onDuplicateBookmark(bookmark)}
                  >
                    <Copy size={13} />
                  </button>
                )}
                <button onClick={() => void deleteHost(host)}>{x('common.delete')}</button>
                {connection?.state === 'ready' ? (
                  <button
                    className="primary connect-action"
                    onClick={() => void openShell(connection)}
                  >
                    <TerminalIcon size={13} /> {x('hosts.openTerminal')}
                  </button>
                ) : connection ? (
                  <button disabled>
                    <LoaderCircle className="spin" size={13} /> {connection.state}
                  </button>
                ) : (
                  <button
                    className="connect-action"
                    onClick={() =>
                      host.credentialRef ||
                      connectionProfile?.ssh.passwordCredentialRef ||
                      connectionProfile?.ssh.privateKeyCredentialRef ||
                      host.authType === 'agent' ||
                      host.authType === 'keyboardInteractive'
                        ? void connect(host)
                        : setConnecting(host)
                    }
                  >
                    <Play size={13} /> {x('hosts.connect')}
                  </button>
                )}
              </div>
            </article>
          );
        })}
        {visibleFtpBookmarks.map((bookmark) => (
          <article
            className="host-card"
            data-bookmark-id={bookmark.id}
            data-bookmark-protocol={bookmark.protocol}
            data-bookmark-description={bookmark.description}
            key={bookmark.id}
            title={bookmark.description || undefined}
          >
            <div className="card-icon">
              <FolderInput size={18} />
            </div>
            <div className="card-copy">
              <BookmarkCardHeading bookmark={bookmark} />
              <span>
                {bookmark.ftp!.username}@
                {hideAddresses ? maskHostAddress(bookmark.ftp!.hostname) : bookmark.ftp!.hostname}:
                {bookmark.ftp!.port}
              </span>
              <small className="connection-state idle">
                <i /> {bookmark.ftp!.security === 'plain' ? 'FTP' : 'FTPS'}
              </small>
            </div>
            <div className="card-actions">
              <button onClick={() => setFtpEditing(bookmark)}>{x('hosts.edit')}</button>
              <button
                aria-label={x('bookmarkTree.duplicate')}
                title={x('bookmarkTree.duplicate')}
                onClick={() => onDuplicateBookmark(bookmark)}
              >
                <Copy size={13} />
              </button>
              <button
                aria-label={x('common.delete')}
                title={x('common.delete')}
                onClick={() => onDeleteBookmark(bookmark)}
              >
                <Trash2 size={13} />
              </button>
              <button className="connect-action" onClick={() => onConnectBookmark(bookmark)}>
                <Play size={13} /> {x('hosts.connect')}
              </button>
            </div>
          </article>
        ))}
        {visibleTelnetBookmarks.map((bookmark) => (
          <article
            className="host-card"
            data-bookmark-id={bookmark.id}
            data-bookmark-protocol={bookmark.protocol}
            data-bookmark-description={bookmark.description}
            key={bookmark.id}
            title={bookmark.description || undefined}
          >
            <div className="card-icon">
              <TerminalIcon size={18} />
            </div>
            <div className="card-copy">
              <BookmarkCardHeading bookmark={bookmark} />
              <span>
                {bookmark.telnet!.username ? `${bookmark.telnet!.username}@` : ''}
                {hideAddresses
                  ? maskHostAddress(bookmark.telnet!.hostname)
                  : bookmark.telnet!.hostname}
                :{bookmark.telnet!.port}
              </span>
              <small className="connection-state idle">
                <i /> Telnet · {bookmark.telnet!.encoding.toUpperCase()}
              </small>
            </div>
            <div className="card-actions">
              <button onClick={() => setTelnetEditing(bookmark)}>{x('hosts.edit')}</button>
              <button
                aria-label={x('bookmarkTree.duplicate')}
                title={x('bookmarkTree.duplicate')}
                onClick={() => onDuplicateBookmark(bookmark)}
              >
                <Copy size={13} />
              </button>
              <button
                aria-label={x('common.delete')}
                title={x('common.delete')}
                onClick={() => onDeleteBookmark(bookmark)}
              >
                <Trash2 size={13} />
              </button>
              <button className="connect-action" onClick={() => onConnectBookmark(bookmark)}>
                <Play size={13} /> {x('hosts.connect')}
              </button>
            </div>
          </article>
        ))}
        {visibleSerialBookmarks.map((bookmark) => (
          <article
            className="host-card"
            data-bookmark-id={bookmark.id}
            data-bookmark-protocol={bookmark.protocol}
            data-bookmark-description={bookmark.description}
            key={bookmark.id}
            title={bookmark.description || undefined}
          >
            <div className="card-icon">
              <TerminalIcon size={18} />
            </div>
            <div className="card-copy">
              <BookmarkCardHeading bookmark={bookmark} />
              <span>{bookmark.serial!.path}</span>
              <small className="connection-state idle">
                <i /> Serial · {bookmark.serial!.baudRate} · {bookmark.serial!.dataBits}
                {bookmark.serial!.parity[0]!.toUpperCase()}
                {bookmark.serial!.stopBits}
              </small>
            </div>
            <div className="card-actions">
              <button onClick={() => setSerialEditing(bookmark)}>{x('hosts.edit')}</button>
              <button
                aria-label={x('bookmarkTree.duplicate')}
                title={x('bookmarkTree.duplicate')}
                onClick={() => onDuplicateBookmark(bookmark)}
              >
                <Copy size={13} />
              </button>
              <button
                aria-label={x('common.delete')}
                title={x('common.delete')}
                onClick={() => onDeleteBookmark(bookmark)}
              >
                <Trash2 size={13} />
              </button>
              <button className="connect-action" onClick={() => onConnectBookmark(bookmark)}>
                <Play size={13} /> {x('hosts.open')}
              </button>
            </div>
          </article>
        ))}
        {visibleRdpBookmarks.map((bookmark) => (
          <article
            className="host-card"
            data-bookmark-id={bookmark.id}
            data-bookmark-protocol={bookmark.protocol}
            data-bookmark-description={bookmark.description}
            key={bookmark.id}
            title={bookmark.description || undefined}
          >
            <div className="card-icon">
              <Monitor size={18} />
            </div>
            <div className="card-copy">
              <BookmarkCardHeading bookmark={bookmark} />
              <span>
                {bookmark.rdp!.username}@
                {hideAddresses ? maskHostAddress(bookmark.rdp!.hostname) : bookmark.rdp!.hostname}:
                {bookmark.rdp!.port}
              </span>
              <small className="connection-state idle">
                <i /> RDP · {bookmark.rdp!.desktopWidth}×{bookmark.rdp!.desktopHeight}
                {bookmark.rdp!.domain ? ` · ${bookmark.rdp!.domain}` : ''}
              </small>
            </div>
            <div className="card-actions">
              <button onClick={() => setRdpEditing(bookmark)}>{x('hosts.edit')}</button>
              <button
                aria-label={x('bookmarkTree.duplicate')}
                title={x('bookmarkTree.duplicate')}
                onClick={() => onDuplicateBookmark(bookmark)}
              >
                <Copy size={13} />
              </button>
              <button
                aria-label={x('common.delete')}
                title={x('common.delete')}
                onClick={() => onDeleteBookmark(bookmark)}
              >
                <Trash2 size={13} />
              </button>
              <button className="connect-action" onClick={() => onConnectBookmark(bookmark)}>
                <Play size={13} /> {x('hosts.connect')}
              </button>
            </div>
          </article>
        ))}
        {visibleVncBookmarks.map((bookmark) => (
          <article
            className="host-card"
            data-bookmark-id={bookmark.id}
            data-bookmark-protocol={bookmark.protocol}
            data-bookmark-description={bookmark.description}
            key={bookmark.id}
            title={bookmark.description || undefined}
          >
            <div className="card-icon">
              <Monitor size={18} />
            </div>
            <div className="card-copy">
              <BookmarkCardHeading bookmark={bookmark} />
              <span>
                {bookmark.vnc!.username ? `${bookmark.vnc!.username}@` : ''}
                {hideAddresses ? maskHostAddress(bookmark.vnc!.hostname) : bookmark.vnc!.hostname}:
                {bookmark.vnc!.port}
              </span>
              <small className="connection-state idle">
                <i />{' '}
                {x('hosts.vncSummary', {
                  quality: bookmark.vnc!.qualityLevel,
                  compression: bookmark.vnc!.compressionLevel,
                })}
              </small>
            </div>
            <div className="card-actions">
              <button onClick={() => setVncEditing(bookmark)}>{x('hosts.edit')}</button>
              <button
                aria-label={x('bookmarkTree.duplicate')}
                title={x('bookmarkTree.duplicate')}
                onClick={() => onDuplicateBookmark(bookmark)}
              >
                <Copy size={13} />
              </button>
              <button
                aria-label={x('common.delete')}
                title={x('common.delete')}
                onClick={() => onDeleteBookmark(bookmark)}
              >
                <Trash2 size={13} />
              </button>
              <button className="connect-action" onClick={() => onConnectBookmark(bookmark)}>
                <Play size={13} /> {x('hosts.connect')}
              </button>
            </div>
          </article>
        ))}
        {visibleSpiceBookmarks.map((bookmark) => (
          <article
            className="host-card"
            data-bookmark-id={bookmark.id}
            data-bookmark-protocol={bookmark.protocol}
            data-bookmark-description={bookmark.description}
            key={bookmark.id}
            title={bookmark.description || undefined}
          >
            <div className="card-icon">
              <Monitor size={18} />
            </div>
            <div className="card-copy">
              <BookmarkCardHeading bookmark={bookmark} />
              <span>
                {hideAddresses
                  ? maskHostAddress(bookmark.spice!.hostname)
                  : bookmark.spice!.hostname}
                :{bookmark.spice!.port}
              </span>
              <small className="connection-state idle">
                <i /> SPICE ·{' '}
                {bookmark.spice!.viewOnly ? x('hosts.readOnly') : x('hosts.interactive')} ·{' '}
                {bookmark.spice!.scaleViewport ? x('hosts.scaled') : x('hosts.originalSize')}
              </small>
            </div>
            <div className="card-actions">
              <button onClick={() => setSpiceEditing(bookmark)}>{x('hosts.edit')}</button>
              <button
                aria-label={x('bookmarkTree.duplicate')}
                title={x('bookmarkTree.duplicate')}
                onClick={() => onDuplicateBookmark(bookmark)}
              >
                <Copy size={13} />
              </button>
              <button
                aria-label={x('common.delete')}
                title={x('common.delete')}
                onClick={() => onDeleteBookmark(bookmark)}
              >
                <Trash2 size={13} />
              </button>
              <button className="connect-action" onClick={() => onConnectBookmark(bookmark)}>
                <Play size={13} /> {x('hosts.connect')}
              </button>
            </div>
          </article>
        ))}
        {visibleWebBookmarks.map((bookmark) => (
          <article
            className="host-card"
            data-bookmark-id={bookmark.id}
            data-bookmark-protocol={bookmark.protocol}
            data-bookmark-description={bookmark.description}
            key={bookmark.id}
            title={bookmark.description || undefined}
          >
            <div className="card-icon">
              <Globe2 size={18} />
            </div>
            <div className="card-copy">
              <BookmarkCardHeading bookmark={bookmark} />
              <span>{bookmark.web!.url}</span>
              <small className="connection-state idle">
                <i /> Web ·{' '}
                {bookmark.web!.hideAddressBar
                  ? x('hosts.hiddenAddressBar')
                  : x('hosts.visibleAddressBar')}
                {bookmark.web!.userAgent ? x('hosts.customUserAgent') : ''}
              </small>
            </div>
            <div className="card-actions">
              <button onClick={() => setWebEditing(bookmark)}>{x('hosts.edit')}</button>
              <button
                aria-label={x('bookmarkTree.duplicate')}
                title={x('bookmarkTree.duplicate')}
                onClick={() => onDuplicateBookmark(bookmark)}
              >
                <Copy size={13} />
              </button>
              <button
                aria-label={x('common.delete')}
                title={x('common.delete')}
                onClick={() => onDeleteBookmark(bookmark)}
              >
                <Trash2 size={13} />
              </button>
              <button className="connect-action" onClick={() => onConnectBookmark(bookmark)}>
                <Play size={13} /> {x('hosts.open')}
              </button>
            </div>
          </article>
        ))}
        {!visibleHosts.length &&
          !visibleFtpBookmarks.length &&
          !visibleTelnetBookmarks.length &&
          !visibleSerialBookmarks.length &&
          !visibleRdpBookmarks.length &&
          !visibleVncBookmarks.length &&
          !visibleSpiceBookmarks.length &&
          !visibleWebBookmarks.length && (
            <EmptyState
              icon={Server}
              title={hosts.length ? x('hosts.noMatches') : x('hosts.empty')}
              text={hosts.length ? x('hosts.noMatchesHint') : x('hosts.emptyHint')}
            />
          )}
      </div>
      {editorOpen && (
        <Modal
          className="host-bookmark-modal"
          title={activeEditingHost ? x('hosts.editSshHost') : x('hosts.addSshHost')}
          onClose={closeEditor}
          chrome={
            <>
              <nav
                className="settings-workspace-tabs host-bookmark-shell-tabs"
                aria-label={x('hosts.editorCategories')}
              >
                <button className="active" aria-current="page" type="button">
                  Bookmarks
                </button>
                <button type="button" onClick={() => leaveEditor('settings')}>
                  Setting
                </button>
                <button type="button" onClick={() => leaveEditor('settings')}>
                  UI Themes
                </button>
                <button type="button" onClick={() => leaveEditor('commands')}>
                  Quick commands
                </button>
                <button type="button" onClick={() => leaveEditor('commands')}>
                  Triggers <sup>Beta</sup>
                </button>
                <button type="button" onClick={() => leaveEditor('settings')}>
                  Profiles
                </button>
                <button type="button" onClick={() => leaveEditor('settings')}>
                  Widgets <sup>Beta</sup>
                </button>
              </nav>
              <button
                className="settings-workspace-close left host-bookmark-shell-close-left"
                type="button"
                aria-label={x('hosts.closeEditor')}
                onClick={closeEditor}
              >
                ×
              </button>
              <aside
                className="host-bookmark-shell-sidebar"
                aria-label={x('hosts.editorDirectory')}
              >
                <div className="host-bookmark-shell-toolbar">
                  <button
                    type="button"
                    title={x('hosts.newBookmark')}
                    onClick={() =>
                      document.querySelector<HTMLInputElement>('input[name="name"]')?.focus()
                    }
                  >
                    <Plus size={14} />
                  </button>
                  <button type="button" title={x('hosts.newGroup')} onClick={onCreateBookmarkGroup}>
                    <Folder size={14} />
                  </button>
                  <button disabled type="button" title={x('hosts.editGroup')}>
                    <Pencil size={14} />
                  </button>
                  <button
                    type="button"
                    title={x('hosts.importSshConfig')}
                    onClick={() => void importConfig()}
                  >
                    <Upload size={14} />
                  </button>
                  <button
                    type="button"
                    title={x('hosts.importExport')}
                    onClick={() => leaveEditor('settings')}
                  >
                    <Download size={14} />
                  </button>
                  <button
                    type="button"
                    title={x('hosts.newLocalTerminal')}
                    onClick={() => void openLocalShell()}
                  >
                    <TerminalIcon size={14} />
                  </button>
                </div>
                <label className="host-bookmark-shell-search">
                  <Search size={13} aria-hidden="true" />
                  <input
                    aria-label={x('hosts.searchDirectory')}
                    value={bookmarkFormQuery}
                    onChange={(event) => setBookmarkFormQuery(event.target.value)}
                  />
                </label>
                <div
                  className="host-bookmark-shell-tree"
                  role="tree"
                  aria-label={x('hosts.bookmarkDirectory')}
                >
                  {bookmarkFormGroups.map((group) => (
                    <button
                      aria-selected={activeGroupId === group.id}
                      className={group.parentId ? 'child' : ''}
                      key={group.id}
                      role="treeitem"
                      type="button"
                      onClick={() => setActiveGroupId(group.id)}
                    >
                      <span style={{ backgroundColor: group.color ?? '#0088cc' }} />
                      {group.name}
                    </button>
                  ))}
                </div>
              </aside>
              <div className="host-bookmark-protocol-heading">
                <div>
                  <strong>{activeEditingHost ? 'Edit Bookmarks' : 'New Bookmarks'}</strong>
                  <button type="button" onClick={() => setAiBookmarkOpen(true)}>
                    <Bot size={13} /> {x('aiBookmark.create')}
                  </button>
                </div>
                <div className="host-bookmark-protocols" aria-label={x('hosts.connectionProtocol')}>
                  <button className="active" data-bookmark-protocol="ssh" type="button">
                    Ssh/Sftp
                  </button>
                  {(
                    [
                      ['telnet', 'Telnet'],
                      ['serial', 'Serial'],
                      ['local', 'Local'],
                      ['vnc', 'Vnc'],
                      ['rdp', 'Rdp'],
                      ['ftp', 'Ftp'],
                      ['web', 'Web'],
                      ['spice', 'Spice'],
                    ] as const
                  ).map(([protocol, label]) => (
                    <button
                      disabled={!!activeEditingHost}
                      data-bookmark-protocol={protocol}
                      key={protocol}
                      onClick={() => openProtocolBookmarkEditor(protocol)}
                      type="button"
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </div>
            </>
          }
        >
          <form
            className="form-grid host-protocol-form"
            data-active-tab={hostFormTab}
            key={activeEditingBookmark?.id ?? 'new'}
            noValidate
            onSubmit={(event) => void createHost(event)}
          >
            <div
              className="host-form-tabs full-field"
              role="tablist"
              aria-label={x('hosts.bookmarkSettings')}
            >
              {(
                [
                  ['auth', 'Auth', x('hosts.auth')],
                  ['settings', 'Settings', x('hosts.settings')],
                ] as const
              ).map(([tab, label, accessibleLabel]) => (
                <button
                  aria-label={accessibleLabel}
                  aria-controls={`ssh-bookmark-${tab}`}
                  aria-selected={hostFormTab === tab}
                  className={hostFormTab === tab ? 'active' : ''}
                  id={`ssh-bookmark-tab-${tab}`}
                  key={tab}
                  onClick={() => setHostFormTab(tab)}
                  onKeyDown={(event) => {
                    const tabs = Array.from(
                      event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>(
                        '[role="tab"]',
                      ) ?? [],
                    );
                    const currentIndex = tabs.indexOf(event.currentTarget);
                    const nextIndex =
                      event.key === 'ArrowRight'
                        ? (currentIndex + 1) % tabs.length
                        : event.key === 'ArrowLeft'
                          ? (currentIndex - 1 + tabs.length) % tabs.length
                          : event.key === 'Home'
                            ? 0
                            : event.key === 'End'
                              ? tabs.length - 1
                              : -1;
                    if (nextIndex < 0) return;
                    event.preventDefault();
                    tabs[nextIndex]?.focus();
                    tabs[nextIndex]?.click();
                  }}
                  role="tab"
                  tabIndex={hostFormTab === tab ? 0 : -1}
                  type="button"
                >
                  {label}
                </button>
              ))}
              <button
                aria-label={x('hosts.bookmarkQuickCommands')}
                aria-controls="ssh-bookmark-quickCommands"
                aria-selected={hostFormTab === 'quickCommands'}
                className={hostFormTab === 'quickCommands' ? 'active' : ''}
                id="ssh-bookmark-tab-quickCommands"
                onClick={() => setHostFormTab('quickCommands')}
                role="tab"
                tabIndex={hostFormTab === 'quickCommands' ? 0 : -1}
                type="button"
              >
                Quick commands
              </button>
              <button
                aria-label={x('hosts.bookmarkTriggers')}
                aria-controls="ssh-bookmark-triggers"
                aria-selected={hostFormTab === 'triggers'}
                className={hostFormTab === 'triggers' ? 'active' : ''}
                id="ssh-bookmark-tab-triggers"
                onClick={() => setHostFormTab('triggers')}
                role="tab"
                tabIndex={hostFormTab === 'triggers' ? 0 : -1}
                type="button"
              >
                Triggers
              </button>
              <button
                aria-label={x('hosts.sshTunnels')}
                aria-controls="ssh-bookmark-tunnels"
                aria-selected={hostFormTab === 'tunnels'}
                className={hostFormTab === 'tunnels' ? 'active' : ''}
                id="ssh-bookmark-tab-tunnels"
                onClick={() => setHostFormTab('tunnels')}
                role="tab"
                tabIndex={hostFormTab === 'tunnels' ? 0 : -1}
                type="button"
              >
                Ssh tunnel
              </button>
              <button
                aria-label={x('hosts.jumpHosts')}
                aria-controls="ssh-bookmark-hops"
                aria-selected={hostFormTab === 'hops'}
                className={hostFormTab === 'hops' ? 'active' : ''}
                id="ssh-bookmark-tab-hops"
                onClick={() => setHostFormTab('hops')}
                role="tab"
                tabIndex={hostFormTab === 'hops' ? 0 : -1}
                type="button"
              >
                Connection hopping
              </button>
            </div>
            <p
              aria-labelledby="ssh-bookmark-tab-auth"
              className="host-form-tab-intro host-form-field full-field"
              data-tab="auth"
              id="ssh-bookmark-auth"
              role="tabpanel"
            >
              {x('hosts.authIntro')}
            </p>
            <BookmarkQuickCommandsEditor
              value={bookmarkQuickCommands}
              onChange={setBookmarkQuickCommands}
            />
            <BookmarkTriggersEditor value={bookmarkTriggers} onChange={setBookmarkTriggers} />
            <label className="host-form-field host-field-category" data-tab="auth settings">
              Category:
              <select
                aria-label={x('hosts.group')}
                name="groupId"
                defaultValue={
                  activeEditingHost
                    ? (activeEditingBookmark?.groupId ?? '')
                    : (activeGroupId ??
                      bookmarkTree?.groups.find(({ parentId }) => parentId === null)?.id ??
                      '')
                }
              >
                <option value="">{x('hosts.uncategorized')}</option>
                {bookmarkTree?.groups.map((group) => (
                  <option key={group.id} value={group.id}>
                    {group.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="host-form-field host-field-title" data-tab="auth">
              Title:
              <input
                aria-label={x('hosts.displayName')}
                name="name"
                required
                autoFocus
                defaultValue={activeEditingHost?.name}
              />
            </label>
            <label className="host-form-field" data-tab="settings">
              {x('hosts.bookmarkTitle')}
              <input
                name="bookmarkTitle"
                maxLength={100}
                placeholder={x('hosts.bookmarkTitlePlaceholder')}
                defaultValue={activeEditingBookmark?.title ?? ''}
              />
            </label>
            <label className="host-form-field host-field-host" data-tab="auth">
              Host:
              <span className="host-field-with-help">
                <small>hostname or ip</small>
                <input
                  aria-label={x('hosts.address')}
                  name="hostname"
                  required
                  defaultValue={activeEditingHost?.hostname}
                />
              </span>
            </label>
            <label className="host-form-field host-field-username" data-tab="auth">
              Username:
              <input
                aria-label={x('hosts.username')}
                name="username"
                required
                defaultValue={activeEditingHost?.username}
              />
            </label>
            <div className="host-form-field host-auth-selector" data-tab="auth">
              <span />
              <div role="group" aria-label={x('hosts.authType')}>
                <button
                  aria-pressed={!useConnectionProfile && hostAuthType === 'password'}
                  className={!useConnectionProfile && hostAuthType === 'password' ? 'active' : ''}
                  onClick={() => {
                    setUseConnectionProfile(false);
                    setHostAuthType('password');
                  }}
                  type="button"
                >
                  Password
                </button>
                <button
                  aria-pressed={!useConnectionProfile && hostAuthType === 'privateKey'}
                  className={!useConnectionProfile && hostAuthType === 'privateKey' ? 'active' : ''}
                  onClick={() => {
                    setUseConnectionProfile(false);
                    setHostAuthType('privateKey');
                  }}
                  type="button"
                >
                  PrivateKey/Certificate
                </button>
                <button
                  aria-pressed={useConnectionProfile}
                  className={useConnectionProfile ? 'active' : ''}
                  onClick={() => setUseConnectionProfile(true)}
                  type="button"
                >
                  Profiles
                </button>
              </div>
              <select
                aria-label={x('hosts.authMethod')}
                className="host-auth-native-select"
                name="authType"
                onChange={(event) => {
                  setUseConnectionProfile(false);
                  setHostAuthType(event.target.value as HostAuthType);
                }}
                value={hostAuthType}
              >
                <option value="password">{x('hosts.password')}</option>
                <option value="privateKey">{x('hosts.privateKey')}</option>
                <option value="keyboardInteractive">Keyboard Interactive</option>
                <option value="agent">SSH Agent</option>
              </select>
            </div>
            {useConnectionProfile ? (
              <label className="host-form-field host-field-profile" data-tab="auth">
                Profiles:
                <select
                  aria-label={x('hosts.connectionProfile')}
                  name="connectionProfileId"
                  required
                  defaultValue={
                    activeEditingBookmark?.connectionProfileId ??
                    connectionProfiles.data?.find((profile) => profile.isDefault)?.id ??
                    ''
                  }
                >
                  <option value="" disabled>
                    {x('hosts.selectConnectionProfile')}
                  </option>
                  {connectionProfiles.data?.map((profile) => (
                    <option key={profile.id} value={profile.id}>
                      {profile.name}
                      {profile.isDefault ? x('hosts.defaultSuffix') : ''}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}
            <label className="host-form-field host-field-port" data-tab="auth">
              <span className="host-required-label">
                <i>*</i> Port:
              </span>
              <input
                aria-label={x('hosts.port')}
                name="port"
                type="number"
                defaultValue={activeEditingHost?.port ?? 22}
                min="1"
                max="65535"
                required
              />
            </label>
            <p
              aria-labelledby="ssh-bookmark-tab-settings"
              className="host-form-tab-intro host-form-field full-field"
              data-tab="settings"
              id="ssh-bookmark-settings"
              role="tabpanel"
            >
              {x('hosts.settingsIntro')}
            </p>
            <label className="host-form-field" data-tab="settings">
              {x('hosts.terminalProfile')}
              <select name="profileId" defaultValue={activeEditingBookmark?.profileId ?? ''}>
                <option value="">{x('hosts.platformDefault')}</option>
                {terminalProfiles.data?.map((profile) => (
                  <option key={profile.id} value={profile.id}>
                    {profile.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="host-form-field" data-tab="settings">
              {x('hosts.titleColor')}
              <input
                name="color"
                maxLength={7}
                pattern="^#[0-9a-fA-F]{6}$"
                placeholder={x('hosts.optionalColorPlaceholder')}
                defaultValue={activeEditingBookmark?.color ?? ''}
              />
            </label>
            <label className="full-field host-form-field" data-tab="settings">
              {x('hosts.descriptionField')}
              <textarea
                name="description"
                rows={3}
                maxLength={2_000}
                defaultValue={activeEditingBookmark?.description ?? ''}
              />
            </label>
            <HostJumpChainFields
              key={`host-jump-chain:${activeEditingHost?.id ?? 'new'}`}
              host={activeEditingHost}
              hosts={hosts}
            />
            <HostTunnelFields
              active={tunnels.data ?? []}
              client={client}
              connections={connections}
              host={activeEditingHost}
              key={`host-tunnels:${activeEditingHost?.id ?? 'new'}`}
              onChanged={() => {
                void Promise.all([tunnelProfiles.refetch(), tunnels.refetch()]);
              }}
              onError={setError}
              profiles={(tunnelProfiles.data ?? []).filter(
                ({ hostId }) => hostId === activeEditingHost?.id,
              )}
            />
            <fieldset className="connection-options full-field host-form-field" data-tab="settings">
              <legend>{x('hosts.connectionSettings')}</legend>
              <label>
                {x('hosts.connectionTimeout')}
                <input
                  name="connectionTimeoutMs"
                  type="number"
                  min="1000"
                  max="300000"
                  step="1000"
                  required
                  defaultValue={
                    activeEditingHost?.connectionOptions.connectionTimeoutMs ??
                    DEFAULT_SSH_CONNECTION_OPTIONS.connectionTimeoutMs
                  }
                />
              </label>
              <label>
                {x('hosts.keepaliveInterval')}
                <input
                  name="keepaliveIntervalMs"
                  type="number"
                  min="0"
                  max="300000"
                  step="1000"
                  required
                  defaultValue={
                    activeEditingHost?.connectionOptions.keepaliveIntervalMs ??
                    DEFAULT_SSH_CONNECTION_OPTIONS.keepaliveIntervalMs
                  }
                />
              </label>
              <label>
                {x('hosts.keepaliveLimit')}
                <input
                  name="keepaliveCountMax"
                  type="number"
                  min="1"
                  max="100"
                  required
                  defaultValue={
                    activeEditingHost?.connectionOptions.keepaliveCountMax ??
                    DEFAULT_SSH_CONNECTION_OPTIONS.keepaliveCountMax
                  }
                />
              </label>
              <label>
                {x('hosts.reconnectPolicy')}
                <select
                  name="reconnectMode"
                  defaultValue={
                    activeEditingHost?.connectionOptions.reconnectPolicy.mode ??
                    DEFAULT_SSH_CONNECTION_OPTIONS.reconnectPolicy.mode
                  }
                >
                  <option value="manual">{x('hosts.manualReconnect')}</option>
                  <option value="automatic">{x('hosts.automaticReconnect')}</option>
                </select>
              </label>
              <label>
                {x('hosts.reconnectDelay')}
                <input
                  name="reconnectDelayMs"
                  type="number"
                  min="250"
                  max="60000"
                  step="250"
                  required
                  defaultValue={
                    activeEditingHost?.connectionOptions.reconnectPolicy.delayMs ??
                    DEFAULT_SSH_CONNECTION_OPTIONS.reconnectPolicy.delayMs
                  }
                />
              </label>
              <label>
                {x('hosts.maxReconnectAttempts')}
                <input
                  name="reconnectMaxAttempts"
                  type="number"
                  min="1"
                  max="20"
                  required
                  defaultValue={
                    activeEditingHost?.connectionOptions.reconnectPolicy.maxAttempts ??
                    DEFAULT_SSH_CONNECTION_OPTIONS.reconnectPolicy.maxAttempts
                  }
                />
              </label>
              <label className="check">
                <input
                  name="compression"
                  type="checkbox"
                  defaultChecked={
                    activeEditingHost?.connectionOptions.compression ??
                    DEFAULT_SSH_CONNECTION_OPTIONS.compression
                  }
                />{' '}
                {x('hosts.enableCompression')}
              </label>
              <details className="ssh-algorithm-settings full-field">
                <summary>{x('hosts.advancedAlgorithms')}</summary>
                <p className="hint">{x('hosts.algorithmHint')}</p>
                <div className="ssh-algorithm-grid">
                  <SshAlgorithmField
                    label={x('hosts.kexAlgorithms')}
                    name="sshKex"
                    options={SSH_KEX_OPTIONS}
                    selected={activeEditingHost?.connectionOptions.algorithms.kex ?? []}
                  />
                  <SshAlgorithmField
                    label={x('hosts.cipherAlgorithms')}
                    name="sshCipher"
                    options={SSH_CIPHER_OPTIONS}
                    selected={activeEditingHost?.connectionOptions.algorithms.cipher ?? []}
                  />
                  <SshAlgorithmField
                    label={x('hosts.hostKeyAlgorithms')}
                    name="sshServerHostKey"
                    options={SSH_HOST_KEY_OPTIONS}
                    selected={activeEditingHost?.connectionOptions.algorithms.serverHostKey ?? []}
                  />
                  <SshAlgorithmField
                    label={x('hosts.macAlgorithms')}
                    name="sshHmac"
                    options={SSH_HMAC_OPTIONS}
                    selected={activeEditingHost?.connectionOptions.algorithms.hmac ?? []}
                  />
                </div>
              </details>
            </fieldset>
            <SshStartupFields
              key={activeEditingHost?.id ?? 'new-host-startup'}
              host={activeEditingHost}
            />
            <details className="ssh-x11-settings full-field host-form-field" data-tab="settings">
              <summary>{x('hosts.x11Forwarding')}</summary>
              <p className="hint">{x('hosts.x11Hint')}</p>
              <label className="check">
                <input
                  defaultChecked={activeEditingHost?.x11.enabled ?? false}
                  name="sshX11Enabled"
                  type="checkbox"
                />{' '}
                {x('hosts.enableX11')}
              </label>
              <label>
                {x('hosts.localDisplay')}
                <input
                  defaultValue={activeEditingHost?.x11.display ?? ''}
                  maxLength={1_024}
                  name="sshX11Display"
                  placeholder={x('hosts.localDisplayPlaceholder')}
                />
              </label>
            </details>
            <HostProxyFields
              className="host-form-field"
              client={client}
              dataTab="settings"
              host={activeEditingHost}
            />
            {!useConnectionProfile && hostAuthType === 'privateKey' ? (
              <label className="host-form-field full-field host-field-password" data-tab="auth">
                Private key:
                <textarea
                  aria-label={x('hosts.privateKey')}
                  name="password"
                  rows={4}
                  autoComplete="off"
                  placeholder={
                    activeEditingHost?.credentialRef ? x('hosts.savedSecretPlaceholder') : ''
                  }
                />
              </label>
            ) : !useConnectionProfile &&
              (hostAuthType === 'password' || hostAuthType === 'keyboardInteractive') ? (
              <label className="host-form-field host-field-password" data-tab="auth">
                Password:
                <input
                  aria-label={x('hosts.password')}
                  name="password"
                  type="password"
                  autoComplete="new-password"
                  placeholder={
                    activeEditingHost?.credentialRef
                      ? x('hosts.savedSecretPlaceholder')
                      : 'Password'
                  }
                />
              </label>
            ) : !useConnectionProfile ? (
              <p className="host-auth-note host-form-field full-field" data-tab="auth">
                {hostAuthType === 'agent'
                  ? x('hosts.agentAuthHint')
                  : x('hosts.keyboardInteractiveHint')}
              </p>
            ) : null}
            <div className="host-form-field host-field-agent" data-tab="auth">
              <span>Use ssh agent:</span>
              <div>
                <button
                  aria-checked={preferSshAgent}
                  aria-label={x('hosts.useAgent')}
                  className="host-switch"
                  onClick={() => setPreferSshAgent(!preferSshAgent)}
                  role="switch"
                  type="button"
                >
                  <i />
                </button>
                <input
                  aria-label="SSH Agent Path"
                  disabled={!preferSshAgent}
                  maxLength={4_096}
                  name="sshAgentPath"
                  onChange={(event) => {
                    setSshAgentPath(event.target.value);
                    setSshAgentStatus(undefined);
                  }}
                  placeholder="SSH_AUTH_SOCK / Pageant"
                  value={sshAgentPath}
                />
                <button
                  disabled={!preferSshAgent || probingSshAgent}
                  onClick={() => void probeAgent()}
                  type="button"
                >
                  {probingSshAgent ? x('hosts.probing') : x('hosts.probe')}
                </button>
              </div>
              {sshAgentStatus ? (
                <small
                  className={
                    sshAgentStatus.state === 'available' ? 'connection-state ready' : 'error-text'
                  }
                  role="status"
                >
                  {sshAgentStatus.message}
                </small>
              ) : null}
            </div>
            <div className="host-form-field host-field-mfa" data-tab="auth">
              <span>MFA/OTP:</span>
              <button
                aria-checked={hostAuthType === 'keyboardInteractive'}
                aria-label="MFA/OTP"
                className="host-switch"
                onClick={() => {
                  setUseConnectionProfile(false);
                  setHostAuthType(
                    hostAuthType === 'keyboardInteractive' ? 'password' : 'keyboardInteractive',
                  );
                }}
                role="switch"
                type="button"
              >
                <i />
              </button>
            </div>
            <div className="host-form-field host-field-run-script" data-tab="auth">
              <span>Run script:</span>
              <div>
                <input
                  aria-label={x('hosts.scriptDelay')}
                  disabled
                  value="Run script delay 500 ms"
                  readOnly
                />
                <input aria-label={x('hosts.runScript')} disabled value="Run script" readOnly />
                <button disabled type="button">
                  −
                </button>
                <button disabled type="button">
                  ＋ Run script
                </button>
              </div>
            </div>
            {!useConnectionProfile && hostAuthType === 'privateKey' ? (
              <>
                <label className="host-form-field host-field-passphrase" data-tab="auth">
                  {x('hosts.passphrase')}
                  <input
                    name="passphrase"
                    type="password"
                    autoComplete="off"
                    placeholder={
                      activeEditingHost?.passphraseCredentialRef
                        ? x('hosts.savedSecretPlaceholder')
                        : ''
                    }
                  />
                </label>
                <label className="host-form-field full-field" data-tab="auth">
                  {x('hosts.opensshCertificate')}
                  <textarea
                    aria-label={x('hosts.sshCertificate')}
                    autoComplete="off"
                    name="certificate"
                    placeholder={
                      activeEditingHost?.certificateCredentialRef
                        ? x('hosts.savedSecretPlaceholder')
                        : 'ssh-ed25519-cert-v01@openssh.com …'
                    }
                    rows={3}
                  />
                </label>
              </>
            ) : null}
            {!useConnectionProfile &&
            (hostAuthType === 'password' ||
              hostAuthType === 'privateKey' ||
              hostAuthType === 'keyboardInteractive') ? (
              <label className="check host-form-field host-field-save" data-tab="auth">
                <input name="save" type="checkbox" defaultChecked /> {x('hosts.saveInVault')}
              </label>
            ) : null}
            <label className="check host-form-field" data-tab="settings">
              <input name="favorite" type="checkbox" defaultChecked={activeEditingHost?.favorite} />{' '}
              {x('hosts.favorite')}
            </label>
            <div className="modal-actions">
              <button type="button" onClick={closeEditor}>
                {x('common.cancel')}
              </button>
              <button disabled={savingBookmark} name="submitAction" type="submit" value="save">
                <Save size={13} /> {x('common.save')}
              </button>
              <button
                disabled={savingBookmark}
                name="submitAction"
                type="submit"
                value="save-and-new"
              >
                <Plus size={13} /> {x('hosts.saveAndNew')}
              </button>
              <button
                className="primary"
                disabled={savingBookmark}
                name="submitAction"
                type="submit"
                value="save-and-connect"
              >
                {savingBookmark ? <LoaderCircle className="spin" size={13} /> : <Play size={13} />}
                {x('hosts.saveAndConnect')}
              </button>
            </div>
          </form>
        </Modal>
      )}
      {aiBookmarkOpen && bookmarkTree && (
        <AiBookmarkDialog
          bookmarkTree={bookmarkTree}
          client={client}
          defaultGroupId={activeGroupId ?? null}
          onClose={() => setAiBookmarkOpen(false)}
          onSaved={async (tree) => {
            queryClient.setQueryData(['bookmark-tree'], tree);
            await queryClient.invalidateQueries({ queryKey: ['hosts'] });
            setAiBookmarkOpen(false);
            setEditingHost(undefined);
            setEditingBookmark(undefined);
            setEditing(false);
            onRequestedBookmarkHandled?.();
          }}
        />
      )}
      {connecting && (
        <Modal
          title={x('hosts.connectTitle', { name: connecting.name })}
          onClose={() => setConnecting(undefined)}
        >
          <form
            className="stack"
            onSubmit={(event) => {
              event.preventDefault();
              const form = new FormData(event.currentTarget);
              void connect(
                connecting,
                String(form.get('secret') ?? ''),
                String(form.get('passphrase') ?? ''),
                String(form.get('certificate') ?? ''),
              );
            }}
          >
            <label>
              {x('hosts.sessionSecret')}
              <textarea name="secret" rows={5} autoFocus required autoComplete="off" />
            </label>
            {connecting.authType === 'privateKey' && (
              <>
                <label>
                  {x('hosts.optionalPassphrase')}
                  <input name="passphrase" type="password" autoComplete="off" />
                </label>
                <label>
                  {x('hosts.optionalCertificate')}
                  <textarea name="certificate" rows={3} autoComplete="off" />
                </label>
              </>
            )}
            <p className="hint">{x('hosts.ephemeralSecretHint')}</p>
            <div className="modal-actions">
              <button type="button" onClick={() => setConnecting(undefined)}>
                {x('common.cancel')}
              </button>
              <button className="primary">
                <KeyRound size={13} /> {x('hosts.connect')}
              </button>
            </div>
          </form>
        </Modal>
      )}
      {(ftpEditing !== undefined ||
        requestedFtpBookmark ||
        requestedQuickConnect?.protocol === 'ftp') &&
        bookmarkTree && (
          <FtpBookmarkDialog
            bookmark={ftpEditing !== undefined ? ftpEditing : requestedFtpBookmark!}
            {...(requestedQuickConnect?.protocol === 'ftp'
              ? { initialTarget: requestedQuickConnect }
              : {})}
            bookmarkTree={bookmarkTree}
            client={client}
            defaultGroupId={activeGroupId ?? null}
            onClose={() => {
              setFtpEditing(undefined);
              closeEditor();
              onRequestedBookmarkHandled?.();
            }}
            onConnect={connectProtocolBookmark}
            queryClient={queryClient}
          />
        )}
      {(telnetEditing !== undefined ||
        requestedTelnetBookmark ||
        requestedQuickConnect?.protocol === 'telnet') &&
        bookmarkTree && (
          <TelnetBookmarkDialog
            bookmark={telnetEditing !== undefined ? telnetEditing : requestedTelnetBookmark!}
            {...(requestedQuickConnect?.protocol === 'telnet'
              ? { initialTarget: requestedQuickConnect }
              : {})}
            bookmarkTree={bookmarkTree}
            client={client}
            defaultGroupId={activeGroupId ?? null}
            onClose={() => {
              setTelnetEditing(undefined);
              closeEditor();
              onRequestedBookmarkHandled?.();
            }}
            onConnect={connectProtocolBookmark}
            queryClient={queryClient}
          />
        )}
      {(serialEditing !== undefined ||
        requestedSerialBookmark ||
        requestedQuickConnect?.protocol === 'serial') &&
        bookmarkTree && (
          <SerialBookmarkDialog
            bookmark={serialEditing !== undefined ? serialEditing : requestedSerialBookmark!}
            {...(requestedQuickConnect?.protocol === 'serial'
              ? { initialTarget: requestedQuickConnect }
              : {})}
            bookmarkTree={bookmarkTree}
            client={client}
            defaultGroupId={activeGroupId ?? null}
            ports={serialPorts.data ?? []}
            {...(serialPorts.error ? { portsError: messageOf(serialPorts.error) } : {})}
            onRefreshPorts={() => void serialPorts.refetch()}
            onClose={() => {
              setSerialEditing(undefined);
              closeEditor();
              onRequestedBookmarkHandled?.();
            }}
            onConnect={connectProtocolBookmark}
            queryClient={queryClient}
          />
        )}
      {(rdpEditing !== undefined ||
        requestedRdpBookmark ||
        requestedQuickConnect?.protocol === 'rdp') &&
        bookmarkTree && (
          <RdpBookmarkDialog
            bookmark={rdpEditing !== undefined ? rdpEditing : requestedRdpBookmark!}
            {...(requestedQuickConnect?.protocol === 'rdp'
              ? { initialTarget: requestedQuickConnect }
              : {})}
            bookmarkTree={bookmarkTree}
            client={client}
            defaultGroupId={activeGroupId ?? null}
            hosts={hosts}
            onClose={() => {
              setRdpEditing(undefined);
              closeEditor();
              onRequestedBookmarkHandled?.();
            }}
            onConnect={connectProtocolBookmark}
            queryClient={queryClient}
          />
        )}
      {(vncEditing !== undefined ||
        requestedVncBookmark ||
        requestedQuickConnect?.protocol === 'vnc') &&
        bookmarkTree && (
          <VncBookmarkDialog
            bookmark={vncEditing !== undefined ? vncEditing : requestedVncBookmark!}
            {...(requestedQuickConnect?.protocol === 'vnc'
              ? { initialTarget: requestedQuickConnect }
              : {})}
            bookmarkTree={bookmarkTree}
            client={client}
            defaultGroupId={activeGroupId ?? null}
            hosts={hosts}
            onClose={() => {
              setVncEditing(undefined);
              closeEditor();
              onRequestedBookmarkHandled?.();
            }}
            onConnect={connectProtocolBookmark}
            queryClient={queryClient}
          />
        )}
      {(spiceEditing !== undefined ||
        requestedSpiceBookmark ||
        requestedQuickConnect?.protocol === 'spice') &&
        bookmarkTree && (
          <SpiceBookmarkDialog
            bookmark={spiceEditing !== undefined ? spiceEditing : requestedSpiceBookmark!}
            {...(requestedQuickConnect?.protocol === 'spice'
              ? { initialTarget: requestedQuickConnect }
              : {})}
            bookmarkTree={bookmarkTree}
            client={client}
            defaultGroupId={activeGroupId ?? null}
            hosts={hosts}
            onClose={() => {
              setSpiceEditing(undefined);
              closeEditor();
              onRequestedBookmarkHandled?.();
            }}
            onConnect={connectProtocolBookmark}
            queryClient={queryClient}
          />
        )}
      {(webEditing !== undefined ||
        requestedWebBookmark ||
        requestedQuickConnect?.protocol === 'http' ||
        requestedQuickConnect?.protocol === 'https') &&
        bookmarkTree && (
          <WebBookmarkDialog
            bookmark={webEditing !== undefined ? webEditing : requestedWebBookmark!}
            {...(requestedQuickConnect?.protocol === 'http' ||
            requestedQuickConnect?.protocol === 'https'
              ? { initialTarget: requestedQuickConnect }
              : {})}
            bookmarkTree={bookmarkTree}
            client={client}
            defaultGroupId={activeGroupId ?? null}
            onClose={() => {
              setWebEditing(undefined);
              closeEditor();
              onRequestedBookmarkHandled?.();
            }}
            onConnect={connectProtocolBookmark}
            queryClient={queryClient}
          />
        )}
      {importGrant && bookmarkTree && (
        <SshConfigImportDialog
          key={importGrant.grantId}
          client={client}
          rootGrant={importGrant}
          groupId={activeGroupId ?? null}
          bookmarkTree={queryClient.getQueryData<BookmarkTree>(['bookmark-tree']) ?? bookmarkTree}
          onClose={() => setImportGrant(undefined)}
          onCommitted={async (result) => {
            queryClient.setQueryData(['bookmark-tree'], result.tree);
            await Promise.all([
              queryClient.invalidateQueries({ queryKey: ['hosts'] }),
              queryClient.invalidateQueries({ queryKey: ['connections'] }),
            ]);
          }}
          onTreeStale={() =>
            queryClient.invalidateQueries({ queryKey: ['bookmark-tree'] }).then(() => undefined)
          }
        />
      )}
    </PanelFrame>
  );
}

function protocolBookmarkMetadata(
  form: FormData,
  bookmark: Bookmark | null | undefined,
  defaultGroupId: string | null,
) {
  return {
    groupId: String(form.get('groupId') || '') || (bookmark ? null : defaultGroupId),
    title: String(form.get('name') ?? ''),
    color: String(form.get('color') ?? '').trim() || null,
    description: String(form.get('description') ?? ''),
  };
}

function ProtocolBookmarkColorField({ bookmark }: { bookmark: Bookmark | null | undefined }) {
  const { x } = useI18n();
  return (
    <label>
      {x('hosts.titleColor')}
      <input
        name="color"
        maxLength={7}
        pattern="^#[0-9a-fA-F]{6}$"
        placeholder={x('hosts.optionalColorPlaceholder')}
        defaultValue={bookmark?.color ?? ''}
      />
    </label>
  );
}

function FtpBookmarkDialog({
  client,
  queryClient,
  bookmarkTree,
  bookmark,
  initialTarget,
  defaultGroupId,
  onClose,
  onConnect,
}: {
  client: Client;
  queryClient: QueryClient;
  bookmarkTree: BookmarkTree;
  bookmark?: Bookmark | null;
  initialTarget?: Extract<QuickConnectTarget, { protocol: 'ftp' }>;
  defaultGroupId: string | null;
  onClose(): void;
  onConnect(bookmark: Bookmark): void;
}) {
  const { x } = useI18n();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const settings = bookmark?.ftp;

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const form = new FormData(event.currentTarget);
    const password = String(form.get('password') ?? '');
    const removePassword = form.get('removePassword') === 'on';
    const previousCredentialRef = settings?.credentialRef ?? null;
    let createdCredentialRef: string | undefined;
    setBusy(true);
    setError('');
    try {
      if (password) {
        createdCredentialRef = (
          await client.createCredential({
            kind: 'protocolPassword',
            label: `FTP · ${String(form.get('name') ?? '')}`,
            secret: password,
          })
        ).ref;
      }
      const input = {
        ...protocolBookmarkMetadata(form, bookmark, defaultGroupId),
        ftp: {
          hostname: String(form.get('hostname') ?? ''),
          port: Number(form.get('port') ?? 21),
          username: String(form.get('username') ?? 'anonymous'),
          credentialRef: createdCredentialRef ?? (removePassword ? null : previousCredentialRef),
          security: String(form.get('security') ?? 'plain') as
            'plain' | 'explicit-tls' | 'implicit-tls',
          tlsVerify: form.get('tlsVerify') === 'on',
          encoding: String(form.get('encoding') ?? 'utf-8') as NonNullable<
            Bookmark['ftp']
          >['encoding'],
          initialDirectory: String(form.get('initialDirectory') ?? '/'),
        },
      };
      const nextTree = bookmark
        ? await client.updateBookmark(bookmarkTree, bookmark.id, input)
        : await client.createBookmark(bookmarkTree, {
            ...input,
            groupId: String(form.get('groupId') || '') || defaultGroupId,
            protocol: 'ftp',
            hostId: null,
            color: input.color,
            profileId: null,
            connectionProfileId: null,
          });
      queryClient.setQueryData(['bookmark-tree'], nextTree);
      const saved = nextTree.bookmarks.find(
        (candidate) =>
          candidate.id === bookmark?.id ||
          (!bookmark &&
            candidate.ftp?.credentialRef === input.ftp.credentialRef &&
            candidate.title === input.title),
      );
      if (previousCredentialRef && previousCredentialRef !== input.ftp.credentialRef)
        await client.deleteCredential(previousCredentialRef).catch(() => {});
      const action = (event.nativeEvent as SubmitEvent).submitter as HTMLButtonElement | null;
      onClose();
      if (action?.value === 'connect' && saved) onConnect(saved);
    } catch (cause) {
      if (createdCredentialRef) await client.deleteCredential(createdCredentialRef).catch(() => {});
      setError(messageOf(cause, x));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      className="protocol-bookmark-modal"
      title={bookmark ? x('protocolBookmark.editFtp') : x('protocolBookmark.addFtp')}
      onClose={onClose}
    >
      <form className="form-grid" onSubmit={(event) => void save(event)}>
        {error && <ErrorBanner text={error} />}
        <label>
          {x('protocolBookmark.name')}
          <input
            name="name"
            required
            maxLength={100}
            defaultValue={bookmark?.title ?? initialTarget?.title ?? initialTarget?.hostname ?? ''}
          />
        </label>
        <label>
          {x('protocolBookmark.group')}
          <select name="groupId" defaultValue={bookmark?.groupId ?? defaultGroupId ?? ''}>
            <option value="">{x('protocolBookmark.rootDirectory')}</option>
            {bookmarkTree.groups.map((group) => (
              <option key={group.id} value={group.id}>
                {group.name}
              </option>
            ))}
          </select>
        </label>
        <ProtocolBookmarkColorField bookmark={bookmark} />
        <label>
          {x('protocolBookmark.host')}
          <input
            name="hostname"
            required
            maxLength={253}
            defaultValue={settings?.hostname ?? initialTarget?.hostname ?? ''}
          />
        </label>
        <label>
          {x('protocolBookmark.port')}
          <input
            name="port"
            type="number"
            min={1}
            max={65_535}
            required
            defaultValue={settings?.port ?? initialTarget?.port ?? 21}
          />
        </label>
        <label>
          {x('protocolBookmark.username')}
          <input
            name="username"
            required
            maxLength={128}
            defaultValue={settings?.username ?? initialTarget?.username ?? 'anonymous'}
          />
        </label>
        <label>
          {x('protocolBookmark.password')}
          <input
            name="password"
            type="password"
            autoComplete="new-password"
            defaultValue={initialTarget?.temporarySecret ?? ''}
            placeholder={
              settings?.credentialRef
                ? x('protocolBookmark.savedPasswordPlaceholder')
                : x('protocolBookmark.optional')
            }
          />
        </label>
        {settings?.credentialRef && (
          <label className="check">
            <input name="removePassword" type="checkbox" />{' '}
            {x('protocolBookmark.removeSavedPassword')}
          </label>
        )}
        <label>
          {x('protocolBookmark.ftpSecurity')}
          <select
            name="security"
            defaultValue={settings?.security ?? (initialTarget?.secure ? 'explicit-tls' : 'plain')}
          >
            <option value="plain">FTP</option>
            <option value="explicit-tls">{x('protocolBookmark.ftpExplicit')}</option>
            <option value="implicit-tls">{x('protocolBookmark.ftpImplicit')}</option>
          </select>
        </label>
        <label className="check">
          <input name="tlsVerify" type="checkbox" defaultChecked={settings?.tlsVerify ?? true} />{' '}
          {x('protocolBookmark.verifyTls')}
        </label>
        <label>
          {x('protocolBookmark.encoding')}
          <select
            name="encoding"
            defaultValue={settings?.encoding ?? initialTarget?.encode ?? 'utf-8'}
          >
            {['utf-8', 'gbk', 'gb18030', 'big5', 'shift-jis', 'euc-jp', 'euc-kr'].map(
              (encoding) => (
                <option key={encoding} value={encoding}>
                  {encoding.toUpperCase()}
                </option>
              ),
            )}
          </select>
        </label>
        <label>
          {x('protocolBookmark.initialDirectory')}
          <input
            name="initialDirectory"
            required
            defaultValue={settings?.initialDirectory ?? '/'}
            pattern="/.*"
          />
        </label>
        <label className="full-field">
          {x('protocolBookmark.description')}
          <textarea
            name="description"
            rows={3}
            maxLength={2_000}
            defaultValue={bookmark?.description ?? ''}
          />
        </label>
        <p className="hint full-field">{x('protocolBookmark.ftpVaultHint')}</p>
        <div className="modal-actions full-field">
          <button type="button" onClick={onClose}>
            {x('common.cancel')}
          </button>
          <button disabled={busy} value="save">
            {busy ? x('protocolBookmark.saving') : x('common.save')}
          </button>
          <button className="primary" disabled={busy} value="connect">
            {x('protocolBookmark.saveAndConnect')}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function TelnetBookmarkDialog({
  client,
  queryClient,
  bookmarkTree,
  bookmark,
  initialTarget,
  defaultGroupId,
  onClose,
  onConnect,
}: {
  client: Client;
  queryClient: QueryClient;
  bookmarkTree: BookmarkTree;
  bookmark?: Bookmark | null;
  initialTarget?: Extract<QuickConnectTarget, { protocol: 'telnet' }>;
  defaultGroupId: string | null;
  onClose(): void;
  onConnect(bookmark: Bookmark): void;
}) {
  const { x } = useI18n();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const settings = bookmark?.telnet;

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const form = new FormData(event.currentTarget);
    const password = String(form.get('password') ?? '');
    const removePassword = form.get('removePassword') === 'on';
    const previousCredentialRef = settings?.credentialRef ?? null;
    let createdCredentialRef: string | undefined;
    setBusy(true);
    setError('');
    try {
      if (password) {
        createdCredentialRef = (
          await client.createCredential({
            kind: 'protocolPassword',
            label: `Telnet · ${String(form.get('name') ?? '')}`,
            secret: password,
          })
        ).ref;
      }
      const input = {
        ...protocolBookmarkMetadata(form, bookmark, defaultGroupId),
        profileId: String(form.get('profileId') || '') || null,
        connectionProfileId: String(form.get('connectionProfileId') || '') || null,
        telnet: {
          hostname: String(form.get('hostname') ?? ''),
          port: Number(form.get('port') ?? 23),
          username: String(form.get('username') ?? ''),
          credentialRef: createdCredentialRef ?? (removePassword ? null : previousCredentialRef),
          loginPrompt: String(form.get('loginPrompt') ?? ''),
          passwordPrompt: String(form.get('passwordPrompt') ?? ''),
          encoding: String(form.get('encoding') ?? 'utf-8') as NonNullable<
            Bookmark['telnet']
          >['encoding'],
          connectionTimeoutMs: Number(form.get('connectionTimeoutMs') ?? 10_000),
        },
      };
      const previousIds = new Set(bookmarkTree.bookmarks.map(({ id }) => id));
      const nextTree = bookmark
        ? await client.updateBookmark(bookmarkTree, bookmark.id, input)
        : await client.createBookmark(bookmarkTree, {
            ...input,
            groupId: String(form.get('groupId') || '') || defaultGroupId,
            protocol: 'telnet',
            hostId: null,
            color: input.color,
            ftp: null,
          });
      queryClient.setQueryData(['bookmark-tree'], nextTree);
      const saved = bookmark
        ? nextTree.bookmarks.find(({ id }) => id === bookmark.id)
        : nextTree.bookmarks.find(({ id }) => !previousIds.has(id));
      if (previousCredentialRef && previousCredentialRef !== input.telnet.credentialRef)
        await client.deleteCredential(previousCredentialRef).catch(() => {});
      const action = (event.nativeEvent as SubmitEvent).submitter as HTMLButtonElement | null;
      onClose();
      if (action?.value === 'connect' && saved) onConnect(saved);
    } catch (cause) {
      if (createdCredentialRef) await client.deleteCredential(createdCredentialRef).catch(() => {});
      setError(messageOf(cause, x));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      className="protocol-bookmark-modal"
      title={bookmark ? x('protocolBookmark.editTelnet') : x('protocolBookmark.addTelnet')}
      onClose={onClose}
    >
      <form className="form-grid" onSubmit={(event) => void save(event)}>
        {error && <ErrorBanner text={error} />}
        <label>
          {x('protocolBookmark.name')}
          <input
            name="name"
            required
            maxLength={100}
            defaultValue={bookmark?.title ?? initialTarget?.title ?? initialTarget?.hostname ?? ''}
          />
        </label>
        <label>
          {x('protocolBookmark.group')}
          <select name="groupId" defaultValue={bookmark?.groupId ?? defaultGroupId ?? ''}>
            <option value="">{x('protocolBookmark.rootDirectory')}</option>
            {bookmarkTree.groups.map((group) => (
              <option key={group.id} value={group.id}>
                {group.name}
              </option>
            ))}
          </select>
        </label>
        <ProtocolBookmarkColorField bookmark={bookmark} />
        <label>
          {x('protocolBookmark.host')}
          <input
            name="hostname"
            required
            maxLength={253}
            defaultValue={settings?.hostname ?? initialTarget?.hostname ?? ''}
          />
        </label>
        <label>
          {x('protocolBookmark.port')}
          <input
            name="port"
            type="number"
            min={1}
            max={65_535}
            required
            defaultValue={settings?.port ?? initialTarget?.port ?? 23}
          />
        </label>
        <label>
          {x('protocolBookmark.username')}
          <input
            name="username"
            maxLength={128}
            defaultValue={settings?.username ?? initialTarget?.username ?? 'root'}
          />
        </label>
        <label>
          {x('protocolBookmark.password')}
          <input
            name="password"
            type="password"
            autoComplete="new-password"
            defaultValue={initialTarget?.temporarySecret ?? ''}
            placeholder={
              settings?.credentialRef
                ? x('protocolBookmark.savedPasswordPlaceholder')
                : x('protocolBookmark.optional')
            }
          />
        </label>
        {settings?.credentialRef && (
          <label className="check">
            <input name="removePassword" type="checkbox" />{' '}
            {x('protocolBookmark.removeSavedPassword')}
          </label>
        )}
        <label>
          {x('protocolBookmark.loginPromptRegex')}
          <input
            name="loginPrompt"
            required
            maxLength={256}
            spellCheck={false}
            defaultValue={
              settings?.loginPrompt ??
              initialTarget?.loginPrompt ??
              '/login[: ]*$|user(?:name)?[: ]*$/i'
            }
          />
        </label>
        <label>
          {x('protocolBookmark.passwordPromptRegex')}
          <input
            name="passwordPrompt"
            required
            maxLength={256}
            spellCheck={false}
            defaultValue={
              settings?.passwordPrompt ?? initialTarget?.passwordPrompt ?? '/password[: ]*$/i'
            }
          />
        </label>
        <label>
          {x('protocolBookmark.encoding')}
          <select name="encoding" defaultValue={settings?.encoding ?? 'utf-8'}>
            {TERMINAL_ENCODINGS.map((encoding) => (
              <option key={encoding} value={encoding}>
                {encoding.toUpperCase()}
              </option>
            ))}
          </select>
        </label>
        <label>
          {x('protocolBookmark.connectionTimeout')}
          <input
            name="connectionTimeoutMs"
            type="number"
            min={250}
            max={120_000}
            required
            defaultValue={settings?.connectionTimeoutMs ?? 10_000}
          />
        </label>
        <label>
          {x('protocolBookmark.terminalProfile')}
          <select name="profileId" defaultValue={bookmark?.profileId ?? ''}>
            <option value="">{x('protocolBookmark.defaultProfile')}</option>
            {(queryClient.getQueryData<TerminalProfile[]>(['terminal-profiles']) ?? []).map(
              (profile) => (
                <option key={profile.id} value={profile.id}>
                  {profile.name}
                </option>
              ),
            )}
          </select>
        </label>
        <label>
          {x('protocolBookmark.connectionProfile')}
          <select name="connectionProfileId" defaultValue={bookmark?.connectionProfileId ?? ''}>
            <option value="">{x('protocolBookmark.noConnectionProfile')}</option>
            {(
              queryClient.getQueryData<Array<{ id: string; name: string }>>([
                'connection-profiles',
              ]) ?? []
            ).map((profile) => (
              <option key={profile.id} value={profile.id}>
                {profile.name}
              </option>
            ))}
          </select>
        </label>
        <label className="full-field">
          {x('protocolBookmark.description')}
          <textarea
            name="description"
            rows={3}
            maxLength={2_000}
            defaultValue={bookmark?.description ?? ''}
          />
        </label>
        <p className="hint full-field">{x('protocolBookmark.telnetVaultHint')}</p>
        <div className="modal-actions full-field">
          <button type="button" onClick={onClose}>
            {x('common.cancel')}
          </button>
          <button disabled={busy} value="save">
            {busy ? x('protocolBookmark.saving') : x('common.save')}
          </button>
          <button className="primary" disabled={busy} value="connect">
            {x('protocolBookmark.saveAndConnect')}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function SerialBookmarkDialog({
  client,
  queryClient,
  bookmarkTree,
  bookmark,
  initialTarget,
  defaultGroupId,
  ports,
  portsError,
  onRefreshPorts,
  onClose,
  onConnect,
}: {
  client: Client;
  queryClient: QueryClient;
  bookmarkTree: BookmarkTree;
  bookmark?: Bookmark | null;
  initialTarget?: Extract<QuickConnectTarget, { protocol: 'serial' }>;
  defaultGroupId: string | null;
  ports: SerialPortInfo[];
  portsError?: string;
  onRefreshPorts(): void;
  onClose(): void;
  onConnect(bookmark: Bookmark): void;
}) {
  const { x } = useI18n();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const settings = bookmark?.serial;

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const form = new FormData(event.currentTarget);
    const input = {
      ...protocolBookmarkMetadata(form, bookmark, defaultGroupId),
      profileId: String(form.get('profileId') || '') || null,
      serial: {
        path: String(form.get('path') ?? ''),
        baudRate: Number(form.get('baudRate') ?? 9_600),
        dataBits: Number(form.get('dataBits') ?? 8) as 5 | 6 | 7 | 8,
        stopBits: Number(form.get('stopBits') ?? 1) as 1 | 1.5 | 2,
        parity: String(form.get('parity') ?? 'none') as NonNullable<Bookmark['serial']>['parity'],
        lock: form.get('lock') === 'on',
        rtscts: form.get('rtscts') === 'on',
        xon: form.get('xon') === 'on',
        xoff: form.get('xoff') === 'on',
        xany: form.get('xany') === 'on',
        txLineEnding: String(form.get('txLineEnding') ?? '\r') as NonNullable<
          Bookmark['serial']
        >['txLineEnding'],
        rxLineEnding: String(form.get('rxLineEnding') ?? 'none') as NonNullable<
          Bookmark['serial']
        >['rxLineEnding'],
        closeSequence: String(form.get('closeSequence') ?? ''),
        closeSequenceDelayMs: Number(form.get('closeSequenceDelayMs') ?? 500),
        encoding: String(form.get('encoding') ?? 'utf-8') as NonNullable<
          Bookmark['serial']
        >['encoding'],
      },
    };
    setBusy(true);
    setError('');
    try {
      const previousIds = new Set(bookmarkTree.bookmarks.map(({ id }) => id));
      const nextTree = bookmark
        ? await client.updateBookmark(bookmarkTree, bookmark.id, input)
        : await client.createBookmark(bookmarkTree, {
            ...input,
            groupId: String(form.get('groupId') || '') || defaultGroupId,
            protocol: 'serial',
            hostId: null,
            color: input.color,
            connectionProfileId: null,
            ftp: null,
            telnet: null,
          });
      queryClient.setQueryData(['bookmark-tree'], nextTree);
      const saved = bookmark
        ? nextTree.bookmarks.find(({ id }) => id === bookmark.id)
        : nextTree.bookmarks.find(({ id }) => !previousIds.has(id));
      const action = (event.nativeEvent as SubmitEvent).submitter as HTMLButtonElement | null;
      onClose();
      if (action?.value === 'connect' && saved) onConnect(saved);
    } catch (cause) {
      setError(messageOf(cause, x));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      className="protocol-bookmark-modal"
      title={bookmark ? x('protocolBookmark.editSerial') : x('protocolBookmark.addSerial')}
      onClose={onClose}
    >
      <form className="form-grid" onSubmit={(event) => void save(event)}>
        {error && <ErrorBanner text={error} />}
        <label>
          {x('protocolBookmark.name')}
          <input
            name="name"
            required
            maxLength={100}
            defaultValue={bookmark?.title ?? initialTarget?.title ?? initialTarget?.path ?? ''}
          />
        </label>
        <label>
          {x('protocolBookmark.group')}
          <select name="groupId" defaultValue={bookmark?.groupId ?? defaultGroupId ?? ''}>
            <option value="">{x('protocolBookmark.rootDirectory')}</option>
            {bookmarkTree.groups.map((group) => (
              <option key={group.id} value={group.id}>
                {group.name}
              </option>
            ))}
          </select>
        </label>
        <ProtocolBookmarkColorField bookmark={bookmark} />
        <label className="full-field">
          {x('protocolBookmark.serialPath')}
          <div className="inline-field-actions">
            <input
              name="path"
              list="serial-port-paths"
              required
              maxLength={1_024}
              defaultValue={settings?.path ?? initialTarget?.path ?? ports[0]?.path ?? ''}
              placeholder={x('protocolBookmark.serialPathPlaceholder')}
            />
            <button type="button" onClick={onRefreshPorts}>
              <RefreshCw size={13} /> {x('protocolBookmark.refresh')}
            </button>
          </div>
          <datalist id="serial-port-paths">
            {ports.map((port) => (
              <option key={port.path} value={port.path}>
                {port.manufacturer ?? port.serialNumber ?? port.path}
              </option>
            ))}
          </datalist>
        </label>
        {portsError ? (
          <p className="hint full-field">
            {x('protocolBookmark.serialEnumerationFailed', { message: portsError })}
          </p>
        ) : (
          <p className="hint full-field" data-testid="serial-enumeration-ready">
            {x('protocolBookmark.serialEnumerationCount', { count: ports.length })}
          </p>
        )}
        <label>
          {x('protocolBookmark.baudRate')}
          <input
            name="baudRate"
            type="number"
            list="serial-baud-rates"
            min={50}
            max={4_000_000}
            required
            defaultValue={settings?.baudRate ?? initialTarget?.baudRate ?? 9_600}
          />
          <datalist id="serial-baud-rates">
            {[110, 300, 1_200, 2_400, 4_800, 9_600, 14_400, 19_200, 38_400, 57_600, 115_200].map(
              (rate) => (
                <option key={rate} value={rate} />
              ),
            )}
          </datalist>
        </label>
        <label>
          {x('protocolBookmark.dataBits')}
          <select name="dataBits" defaultValue={settings?.dataBits ?? initialTarget?.dataBits ?? 8}>
            {[8, 7, 6, 5].map((bits) => (
              <option key={bits} value={bits}>
                {bits}
              </option>
            ))}
          </select>
        </label>
        <label>
          {x('protocolBookmark.stopBits')}
          <select name="stopBits" defaultValue={settings?.stopBits ?? initialTarget?.stopBits ?? 1}>
            {[1, 1.5, 2].map((bits) => (
              <option key={bits} value={bits}>
                {bits}
              </option>
            ))}
          </select>
        </label>
        <label>
          {x('protocolBookmark.parity')}
          <select name="parity" defaultValue={settings?.parity ?? initialTarget?.parity ?? 'none'}>
            {['none', 'even', 'mark', 'odd', 'space'].map((parity) => (
              <option key={parity} value={parity}>
                {parity}
              </option>
            ))}
          </select>
        </label>
        <label>
          {x('protocolBookmark.sendNewline')}
          <select name="txLineEnding" defaultValue={settings?.txLineEnding ?? '\r'}>
            <option value={'\r'}>CR</option>
            <option value={'\n'}>LF</option>
            <option value={'\r\n'}>CR+LF</option>
          </select>
        </label>
        <label>
          {x('protocolBookmark.receiveNewline')}
          <select name="rxLineEnding" defaultValue={settings?.rxLineEnding ?? 'none'}>
            <option value="none">{x('protocolBookmark.noConversion')}</option>
            <option value="lf_to_crlf">LF → CRLF</option>
            <option value="cr_to_crlf">CR → CRLF</option>
          </select>
        </label>
        <fieldset className="full-field checkbox-grid">
          <legend>{x('protocolBookmark.portFlowControl')}</legend>
          <label className="check">
            <input
              name="lock"
              type="checkbox"
              defaultChecked={settings?.lock ?? initialTarget?.lock ?? true}
            />{' '}
            {x('protocolBookmark.exclusiveLock')}
          </label>
          {(['rtscts', 'xon', 'xoff', 'xany'] as const).map((name) => (
            <label className="check" key={name}>
              <input
                name={name}
                type="checkbox"
                defaultChecked={settings?.[name] ?? initialTarget?.[name] ?? false}
              />{' '}
              {name.toUpperCase()}
            </label>
          ))}
        </fieldset>
        <label>
          {x('protocolBookmark.closeSequence')}
          <input
            name="closeSequence"
            maxLength={64}
            spellCheck={false}
            defaultValue={settings?.closeSequence ?? '\\x01ky'}
          />
        </label>
        <label>
          {x('protocolBookmark.closeWait')}
          <input
            name="closeSequenceDelayMs"
            type="number"
            min={0}
            max={10_000}
            step={100}
            defaultValue={settings?.closeSequenceDelayMs ?? 500}
          />
        </label>
        <label>
          {x('protocolBookmark.encoding')}
          <select name="encoding" defaultValue={settings?.encoding ?? 'utf-8'}>
            {TERMINAL_ENCODINGS.map((encoding) => (
              <option key={encoding} value={encoding}>
                {encoding.toUpperCase()}
              </option>
            ))}
          </select>
        </label>
        <label>
          {x('protocolBookmark.terminalProfile')}
          <select name="profileId" defaultValue={bookmark?.profileId ?? ''}>
            <option value="">{x('protocolBookmark.defaultProfile')}</option>
            {(queryClient.getQueryData<TerminalProfile[]>(['terminal-profiles']) ?? []).map(
              (profile) => (
                <option key={profile.id} value={profile.id}>
                  {profile.name}
                </option>
              ),
            )}
          </select>
        </label>
        <label className="full-field">
          {x('protocolBookmark.description')}
          <textarea
            name="description"
            rows={3}
            maxLength={2_000}
            defaultValue={bookmark?.description ?? ''}
          />
        </label>
        <p className="hint full-field">{x('protocolBookmark.serialHint')}</p>
        <div className="modal-actions full-field">
          <button type="button" onClick={onClose}>
            {x('common.cancel')}
          </button>
          <button disabled={busy} value="save">
            {busy ? x('protocolBookmark.saving') : x('common.save')}
          </button>
          <button className="primary" disabled={busy} value="connect">
            {x('protocolBookmark.saveAndOpen')}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function RdpBookmarkDialog({
  client,
  queryClient,
  bookmarkTree,
  bookmark,
  initialTarget,
  defaultGroupId,
  hosts,
  onClose,
  onConnect,
}: {
  client: Client;
  queryClient: QueryClient;
  bookmarkTree: BookmarkTree;
  bookmark?: Bookmark | null;
  initialTarget?: Extract<QuickConnectTarget, { protocol: 'rdp' }>;
  defaultGroupId: string | null;
  hosts: Host[];
  onClose(): void;
  onConnect(bookmark: Bookmark): void;
}) {
  const { x } = useI18n();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const settings = bookmark?.rdp;
  const [proxyMode, setProxyMode] = useState<'inherit' | 'direct' | 'custom'>(
    settings?.proxy.mode === 'custom'
      ? 'custom'
      : settings?.proxy.mode === 'direct'
        ? 'direct'
        : 'inherit',
  );

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const form = new FormData(event.currentTarget);
    const password = String(form.get('password') ?? '');
    const proxyPassword = String(form.get('proxyPassword') ?? '');
    const removePassword = form.get('removePassword') === 'on';
    const previousCredentialRef = settings?.credentialRef ?? null;
    const previousProxyCredentialRef =
      settings?.proxy.mode === 'custom' ? settings.proxy.endpoint.credentialRef : null;
    const createdCredentialRefs: string[] = [];
    setBusy(true);
    setError('');
    try {
      let credentialRef = removePassword ? null : previousCredentialRef;
      if (password) {
        credentialRef = (
          await client.createCredential({
            kind: 'protocolPassword',
            label: `RDP · ${String(form.get('name') ?? '')}`,
            secret: password,
          })
        ).ref;
        createdCredentialRefs.push(credentialRef);
      }
      let proxy: NonNullable<Bookmark['rdp']>['proxy'];
      if (proxyMode === 'custom') {
        const proxyUsername = String(form.get('proxyUsername') ?? '').trim() || null;
        let proxyCredentialRef =
          settings?.proxy.mode === 'custom' && settings.proxy.endpoint.username === proxyUsername
            ? settings.proxy.endpoint.credentialRef
            : null;
        if (proxyPassword) {
          proxyCredentialRef = (
            await client.createCredential({
              kind: 'proxyPassword',
              label: `RDP Proxy · ${String(form.get('name') ?? '')}`,
              secret: proxyPassword,
            })
          ).ref;
          createdCredentialRefs.push(proxyCredentialRef);
        }
        if (!!proxyUsername !== !!proxyCredentialRef)
          throw new Error(x('protocolBookmark.proxyPairRequired'));
        proxy = {
          mode: 'custom',
          endpoint: {
            url: String(form.get('proxyUrl') ?? ''),
            username: proxyUsername,
            credentialRef: proxyCredentialRef,
          },
        };
      } else proxy = { mode: proxyMode };
      const input = {
        ...protocolBookmarkMetadata(form, bookmark, defaultGroupId),
        connectionProfileId: String(form.get('connectionProfileId') || '') || null,
        rdp: {
          hostname: String(form.get('hostname') ?? ''),
          port: Number(form.get('port') ?? 3_389),
          username: String(form.get('username') ?? ''),
          credentialRef,
          domain: String(form.get('domain') ?? ''),
          proxy,
          jumpHostId: String(form.get('jumpHostId') || '') || null,
          connectionTimeoutMs: Number(form.get('connectionTimeoutMs') ?? 15_000),
          desktopWidth: Number(form.get('desktopWidth') ?? 1_280),
          desktopHeight: Number(form.get('desktopHeight') ?? 720),
          scaleViewport: form.get('scaleViewport') === 'on',
          clipboard: form.get('clipboard') === 'on',
        },
      };
      const previousIds = new Set(bookmarkTree.bookmarks.map(({ id }) => id));
      const nextTree = bookmark
        ? await client.updateBookmark(bookmarkTree, bookmark.id, input)
        : await client.createBookmark(bookmarkTree, {
            ...input,
            groupId: String(form.get('groupId') || '') || defaultGroupId,
            protocol: 'rdp',
            hostId: null,
            color: input.color,
            profileId: null,
          });
      queryClient.setQueryData(['bookmark-tree'], nextTree);
      const saved = bookmark
        ? nextTree.bookmarks.find(({ id }) => id === bookmark.id)
        : nextTree.bookmarks.find(({ id }) => !previousIds.has(id));
      const retained = new Set([
        input.rdp.credentialRef,
        input.rdp.proxy.mode === 'custom' ? input.rdp.proxy.endpoint.credentialRef : null,
      ]);
      await Promise.allSettled(
        [previousCredentialRef, previousProxyCredentialRef]
          .filter((reference): reference is string => !!reference && !retained.has(reference))
          .map((reference) => client.deleteCredential(reference)),
      );
      const action = (event.nativeEvent as SubmitEvent).submitter as HTMLButtonElement | null;
      onClose();
      if (action?.value === 'connect' && saved) onConnect(saved);
    } catch (cause) {
      await Promise.allSettled(createdCredentialRefs.map((ref) => client.deleteCredential(ref)));
      setError(messageOf(cause, x));
    } finally {
      setBusy(false);
    }
  }

  const customProxy = settings?.proxy.mode === 'custom' ? settings.proxy.endpoint : undefined;
  const profiles = queryClient.getQueryData<Array<{ id: string; name: string; rdp: unknown }>>([
    'connection-profiles',
  ]);
  return (
    <Modal
      className="protocol-bookmark-modal"
      title={bookmark ? x('protocolBookmark.editRdp') : x('protocolBookmark.addRdp')}
      onClose={onClose}
    >
      <form className="form-grid" onSubmit={(event) => void save(event)}>
        {error && <ErrorBanner text={error} />}
        <label>
          {x('protocolBookmark.name')}
          <input
            name="name"
            required
            maxLength={100}
            defaultValue={bookmark?.title ?? initialTarget?.title ?? initialTarget?.hostname ?? ''}
          />
        </label>
        <label>
          {x('protocolBookmark.group')}
          <select name="groupId" defaultValue={bookmark?.groupId ?? defaultGroupId ?? ''}>
            <option value="">{x('protocolBookmark.rootDirectory')}</option>
            {bookmarkTree.groups.map((group) => (
              <option key={group.id} value={group.id}>
                {group.name}
              </option>
            ))}
          </select>
        </label>
        <ProtocolBookmarkColorField bookmark={bookmark} />
        <label>
          {x('protocolBookmark.host')}
          <input
            name="hostname"
            required
            maxLength={253}
            defaultValue={settings?.hostname ?? initialTarget?.hostname ?? ''}
          />
        </label>
        <label>
          {x('protocolBookmark.port')}
          <input
            name="port"
            type="number"
            min={1}
            max={65_535}
            required
            defaultValue={settings?.port ?? initialTarget?.port ?? 3_389}
          />
        </label>
        <label>
          {x('protocolBookmark.username')}
          <input
            name="username"
            required
            maxLength={128}
            defaultValue={settings?.username ?? initialTarget?.username ?? ''}
          />
        </label>
        <label>
          {x('protocolBookmark.password')}
          <input
            name="password"
            type="password"
            autoComplete="new-password"
            defaultValue={initialTarget?.temporarySecret ?? ''}
            placeholder={
              settings?.credentialRef
                ? x('protocolBookmark.savedPasswordPlaceholder')
                : x('protocolBookmark.optional')
            }
          />
        </label>
        {settings?.credentialRef && (
          <label className="check full-field">
            <input name="removePassword" type="checkbox" />{' '}
            {x('protocolBookmark.removeSavedPassword')}
          </label>
        )}
        <label>
          {x('protocolBookmark.domain')}
          <input
            name="domain"
            maxLength={128}
            defaultValue={settings?.domain ?? initialTarget?.domain ?? ''}
          />
        </label>
        <label>
          {x('protocolBookmark.connectionProfile')}
          <select name="connectionProfileId" defaultValue={bookmark?.connectionProfileId ?? ''}>
            <option value="">{x('protocolBookmark.none')}</option>
            {(profiles ?? [])
              .filter((profile) => !!profile.rdp)
              .map((profile) => (
                <option key={profile.id} value={profile.id}>
                  {profile.name}
                </option>
              ))}
          </select>
        </label>
        <label>
          {x('protocolBookmark.jumpHost')}
          <select name="jumpHostId" defaultValue={settings?.jumpHostId ?? ''}>
            <option value="">{x('protocolBookmark.none')}</option>
            {hosts.map((host) => (
              <option key={host.id} value={host.id}>
                {host.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          {x('protocolBookmark.timeout')}
          <input
            name="connectionTimeoutMs"
            type="number"
            min={1_000}
            max={120_000}
            step={1_000}
            defaultValue={settings?.connectionTimeoutMs ?? 15_000}
          />
        </label>
        <label>
          {x('protocolBookmark.proxy')}
          <select
            name="proxyMode"
            value={proxyMode}
            onChange={(event) => setProxyMode(event.target.value as typeof proxyMode)}
          >
            <option value="inherit">{x('protocolBookmark.proxyInherit')}</option>
            <option value="direct">{x('protocolBookmark.proxyDirect')}</option>
            <option value="custom">{x('protocolBookmark.proxyCustom')}</option>
          </select>
        </label>
        {proxyMode === 'custom' && (
          <>
            <label>
              {x('protocolBookmark.proxyUrl')}
              <input
                name="proxyUrl"
                required
                placeholder="socks5://127.0.0.1:1080"
                defaultValue={customProxy?.url ?? ''}
              />
            </label>
            <label>
              {x('protocolBookmark.proxyUsername')}
              <input name="proxyUsername" defaultValue={customProxy?.username ?? ''} />
            </label>
            <label>
              {x('protocolBookmark.proxyPassword')}
              <input
                name="proxyPassword"
                type="password"
                autoComplete="new-password"
                placeholder={
                  customProxy?.credentialRef ? x('protocolBookmark.savedPasswordPlaceholder') : ''
                }
              />
            </label>
          </>
        )}
        <label>
          {x('protocolBookmark.desktopWidth')}
          <input
            name="desktopWidth"
            type="number"
            min={320}
            max={8_192}
            defaultValue={settings?.desktopWidth ?? 1_280}
          />
        </label>
        <label>
          {x('protocolBookmark.desktopHeight')}
          <input
            name="desktopHeight"
            type="number"
            min={240}
            max={4_320}
            defaultValue={settings?.desktopHeight ?? 720}
          />
        </label>
        <fieldset className="full-field checkbox-grid">
          <legend>{x('protocolBookmark.sessionExperience')}</legend>
          <label className="check">
            <input
              name="scaleViewport"
              type="checkbox"
              defaultChecked={settings?.scaleViewport ?? false}
            />{' '}
            {x('protocolBookmark.fitToWindow')}
          </label>
          <label className="check">
            <input name="clipboard" type="checkbox" defaultChecked={settings?.clipboard ?? true} />{' '}
            {x('protocolBookmark.clipboardSync')}
          </label>
        </fieldset>
        <label className="full-field">
          {x('protocolBookmark.description')}
          <textarea
            name="description"
            rows={3}
            maxLength={2_000}
            defaultValue={bookmark?.description ?? ''}
          />
        </label>
        <p className="hint full-field">{x('protocolBookmark.rdpVaultHint')}</p>
        <div className="modal-actions full-field">
          <button type="button" onClick={onClose}>
            {x('common.cancel')}
          </button>
          <button disabled={busy} value="save">
            {busy ? x('protocolBookmark.saving') : x('common.save')}
          </button>
          <button className="primary" disabled={busy} value="connect">
            {x('protocolBookmark.saveAndConnect')}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function VncBookmarkDialog({
  client,
  queryClient,
  bookmarkTree,
  bookmark,
  initialTarget,
  defaultGroupId,
  hosts,
  onClose,
  onConnect,
}: {
  client: Client;
  queryClient: QueryClient;
  bookmarkTree: BookmarkTree;
  bookmark?: Bookmark | null;
  initialTarget?: Extract<QuickConnectTarget, { protocol: 'vnc' }>;
  defaultGroupId: string | null;
  hosts: Host[];
  onClose(): void;
  onConnect(bookmark: Bookmark): void;
}) {
  const { x } = useI18n();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const settings = bookmark?.vnc;
  const [proxyMode, setProxyMode] = useState<'inherit' | 'direct' | 'custom'>(
    settings?.proxy.mode === 'custom'
      ? 'custom'
      : settings?.proxy.mode === 'direct'
        ? 'direct'
        : 'inherit',
  );

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const form = new FormData(event.currentTarget);
    const password = String(form.get('password') ?? '');
    const proxyPassword = String(form.get('proxyPassword') ?? '');
    const removePassword = form.get('removePassword') === 'on';
    const previousCredentialRef = settings?.credentialRef ?? null;
    const previousProxyCredentialRef =
      settings?.proxy.mode === 'custom' ? settings.proxy.endpoint.credentialRef : null;
    const createdCredentialRefs: string[] = [];
    setBusy(true);
    setError('');
    try {
      let credentialRef = removePassword ? null : previousCredentialRef;
      if (password) {
        credentialRef = (
          await client.createCredential({
            kind: 'protocolPassword',
            label: `VNC · ${String(form.get('name') ?? '')}`,
            secret: password,
          })
        ).ref;
        createdCredentialRefs.push(credentialRef);
      }
      let proxy: NonNullable<Bookmark['vnc']>['proxy'];
      if (proxyMode === 'custom') {
        const proxyUsername = String(form.get('proxyUsername') ?? '').trim() || null;
        let proxyCredentialRef =
          settings?.proxy.mode === 'custom' && settings.proxy.endpoint.username === proxyUsername
            ? settings.proxy.endpoint.credentialRef
            : null;
        if (proxyPassword) {
          proxyCredentialRef = (
            await client.createCredential({
              kind: 'proxyPassword',
              label: `VNC Proxy · ${String(form.get('name') ?? '')}`,
              secret: proxyPassword,
            })
          ).ref;
          createdCredentialRefs.push(proxyCredentialRef);
        }
        if (!!proxyUsername !== !!proxyCredentialRef)
          throw new Error(x('protocolBookmark.proxyPairRequired'));
        proxy = {
          mode: 'custom',
          endpoint: {
            url: String(form.get('proxyUrl') ?? ''),
            username: proxyUsername,
            credentialRef: proxyCredentialRef,
          },
        };
      } else proxy = { mode: proxyMode };
      const input = {
        ...protocolBookmarkMetadata(form, bookmark, defaultGroupId),
        connectionProfileId: String(form.get('connectionProfileId') || '') || null,
        vnc: {
          hostname: String(form.get('hostname') ?? ''),
          port: Number(form.get('port') ?? 5_900),
          username: String(form.get('username') ?? ''),
          credentialRef,
          proxy,
          jumpHostId: String(form.get('jumpHostId') || '') || null,
          connectionTimeoutMs: Number(form.get('connectionTimeoutMs') ?? 15_000),
          viewOnly: form.get('viewOnly') === 'on',
          clipViewport: form.get('clipViewport') === 'on',
          scaleViewport: form.get('scaleViewport') === 'on',
          qualityLevel: Number(form.get('qualityLevel') ?? 3),
          compressionLevel: Number(form.get('compressionLevel') ?? 1),
          shared: form.get('shared') === 'on',
          showDotCursor: form.get('showDotCursor') === 'on',
          clipboard: form.get('clipboard') === 'on',
        },
      };
      const previousIds = new Set(bookmarkTree.bookmarks.map(({ id }) => id));
      const nextTree = bookmark
        ? await client.updateBookmark(bookmarkTree, bookmark.id, input)
        : await client.createBookmark(bookmarkTree, {
            ...input,
            groupId: String(form.get('groupId') || '') || defaultGroupId,
            protocol: 'vnc',
            hostId: null,
            color: input.color,
            profileId: null,
          });
      queryClient.setQueryData(['bookmark-tree'], nextTree);
      const saved = bookmark
        ? nextTree.bookmarks.find(({ id }) => id === bookmark.id)
        : nextTree.bookmarks.find(({ id }) => !previousIds.has(id));
      const retained = new Set([
        input.vnc.credentialRef,
        input.vnc.proxy.mode === 'custom' ? input.vnc.proxy.endpoint.credentialRef : null,
      ]);
      await Promise.allSettled(
        [previousCredentialRef, previousProxyCredentialRef]
          .filter((reference): reference is string => !!reference && !retained.has(reference))
          .map((reference) => client.deleteCredential(reference)),
      );
      const action = (event.nativeEvent as SubmitEvent).submitter as HTMLButtonElement | null;
      onClose();
      if (action?.value === 'connect' && saved) onConnect(saved);
    } catch (cause) {
      await Promise.allSettled(createdCredentialRefs.map((ref) => client.deleteCredential(ref)));
      setError(messageOf(cause, x));
    } finally {
      setBusy(false);
    }
  }

  const customProxy = settings?.proxy.mode === 'custom' ? settings.proxy.endpoint : undefined;
  const profiles = queryClient.getQueryData<Array<{ id: string; name: string; vnc: unknown }>>([
    'connection-profiles',
  ]);
  return (
    <Modal
      className="protocol-bookmark-modal"
      title={bookmark ? x('protocolBookmark.editVnc') : x('protocolBookmark.addVnc')}
      onClose={onClose}
    >
      <form className="form-grid" onSubmit={(event) => void save(event)}>
        {error && <ErrorBanner text={error} />}
        <label>
          {x('protocolBookmark.name')}
          <input
            name="name"
            required
            maxLength={100}
            defaultValue={bookmark?.title ?? initialTarget?.title ?? initialTarget?.hostname ?? ''}
          />
        </label>
        <label>
          {x('protocolBookmark.group')}
          <select name="groupId" defaultValue={bookmark?.groupId ?? defaultGroupId ?? ''}>
            <option value="">{x('protocolBookmark.rootDirectory')}</option>
            {bookmarkTree.groups.map((group) => (
              <option key={group.id} value={group.id}>
                {group.name}
              </option>
            ))}
          </select>
        </label>
        <ProtocolBookmarkColorField bookmark={bookmark} />
        <label>
          {x('protocolBookmark.host')}
          <input
            name="hostname"
            required
            maxLength={253}
            defaultValue={settings?.hostname ?? initialTarget?.hostname ?? ''}
          />
        </label>
        <label>
          {x('protocolBookmark.port')}
          <input
            name="port"
            type="number"
            min={1}
            max={65_535}
            required
            defaultValue={settings?.port ?? initialTarget?.port ?? 5_900}
          />
        </label>
        <label>
          {x('protocolBookmark.username')}
          <input
            name="username"
            maxLength={128}
            defaultValue={settings?.username ?? initialTarget?.username ?? ''}
          />
        </label>
        <label>
          {x('protocolBookmark.password')}
          <input
            name="password"
            type="password"
            autoComplete="new-password"
            defaultValue={initialTarget?.temporarySecret ?? ''}
            placeholder={
              settings?.credentialRef
                ? x('protocolBookmark.savedPasswordPlaceholder')
                : x('protocolBookmark.optional')
            }
          />
        </label>
        {settings?.credentialRef && (
          <label className="check full-field">
            <input name="removePassword" type="checkbox" />{' '}
            {x('protocolBookmark.removeSavedPassword')}
          </label>
        )}
        <label>
          {x('protocolBookmark.connectionProfile')}
          <select name="connectionProfileId" defaultValue={bookmark?.connectionProfileId ?? ''}>
            <option value="">{x('protocolBookmark.none')}</option>
            {(profiles ?? [])
              .filter((profile) => !!profile.vnc)
              .map((profile) => (
                <option key={profile.id} value={profile.id}>
                  {profile.name}
                </option>
              ))}
          </select>
        </label>
        <label>
          {x('protocolBookmark.jumpHost')}
          <select name="jumpHostId" defaultValue={settings?.jumpHostId ?? ''}>
            <option value="">{x('protocolBookmark.none')}</option>
            {hosts.map((host) => (
              <option key={host.id} value={host.id}>
                {host.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          {x('protocolBookmark.timeout')}
          <input
            name="connectionTimeoutMs"
            type="number"
            min={1_000}
            max={120_000}
            step={1_000}
            defaultValue={settings?.connectionTimeoutMs ?? 15_000}
          />
        </label>
        <label>
          {x('protocolBookmark.proxy')}
          <select
            name="proxyMode"
            value={proxyMode}
            onChange={(event) => setProxyMode(event.target.value as typeof proxyMode)}
          >
            <option value="inherit">{x('protocolBookmark.proxyInherit')}</option>
            <option value="direct">{x('protocolBookmark.proxyDirect')}</option>
            <option value="custom">{x('protocolBookmark.proxyCustom')}</option>
          </select>
        </label>
        {proxyMode === 'custom' && (
          <>
            <label>
              {x('protocolBookmark.proxyUrl')}
              <input
                name="proxyUrl"
                required
                placeholder="socks5://127.0.0.1:1080"
                defaultValue={customProxy?.url ?? ''}
              />
            </label>
            <label>
              {x('protocolBookmark.proxyUsername')}
              <input name="proxyUsername" defaultValue={customProxy?.username ?? ''} />
            </label>
            <label>
              {x('protocolBookmark.proxyPassword')}
              <input
                name="proxyPassword"
                type="password"
                autoComplete="new-password"
                placeholder={
                  customProxy?.credentialRef ? x('protocolBookmark.savedPasswordPlaceholder') : ''
                }
              />
            </label>
          </>
        )}
        <label>
          {x('protocolBookmark.quality')}
          <input
            name="qualityLevel"
            type="number"
            min={0}
            max={9}
            defaultValue={settings?.qualityLevel ?? initialTarget?.qualityLevel ?? 3}
          />
        </label>
        <label>
          {x('protocolBookmark.compression')}
          <input
            name="compressionLevel"
            type="number"
            min={0}
            max={9}
            defaultValue={settings?.compressionLevel ?? initialTarget?.compressionLevel ?? 1}
          />
        </label>
        <fieldset className="full-field checkbox-grid">
          <legend>{x('protocolBookmark.sessionExperience')}</legend>
          <label className="check">
            <input
              name="viewOnly"
              type="checkbox"
              defaultChecked={settings?.viewOnly ?? initialTarget?.viewOnly ?? false}
            />{' '}
            {x('protocolBookmark.viewOnly')}
          </label>
          <label className="check">
            <input
              name="clipViewport"
              type="checkbox"
              defaultChecked={settings?.clipViewport ?? initialTarget?.clipViewport ?? false}
            />{' '}
            {x('protocolBookmark.clipOverflow')}
          </label>
          <label className="check">
            <input
              name="scaleViewport"
              type="checkbox"
              defaultChecked={settings?.scaleViewport ?? initialTarget?.scaleViewport ?? true}
            />{' '}
            {x('protocolBookmark.fitToWindow')}
          </label>
          <label className="check">
            <input
              name="shared"
              type="checkbox"
              defaultChecked={settings?.shared ?? initialTarget?.shared ?? true}
            />{' '}
            {x('protocolBookmark.sharedSession')}
          </label>
          <label className="check">
            <input
              name="showDotCursor"
              type="checkbox"
              defaultChecked={settings?.showDotCursor ?? true}
            />{' '}
            {x('protocolBookmark.dotCursor')}
          </label>
          <label className="check">
            <input name="clipboard" type="checkbox" defaultChecked={settings?.clipboard ?? true} />{' '}
            {x('protocolBookmark.clipboardSync')}
          </label>
        </fieldset>
        <label className="full-field">
          {x('protocolBookmark.description')}
          <textarea
            name="description"
            rows={3}
            maxLength={2_000}
            defaultValue={bookmark?.description ?? ''}
          />
        </label>
        <p className="hint full-field">{x('protocolBookmark.vncVaultHint')}</p>
        <div className="modal-actions full-field">
          <button type="button" onClick={onClose}>
            {x('common.cancel')}
          </button>
          <button disabled={busy} value="save">
            {busy ? x('protocolBookmark.saving') : x('common.save')}
          </button>
          <button className="primary" disabled={busy} value="connect">
            {x('protocolBookmark.saveAndConnect')}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function SpiceBookmarkDialog({
  client,
  queryClient,
  bookmarkTree,
  bookmark,
  initialTarget,
  defaultGroupId,
  hosts,
  onClose,
  onConnect,
}: {
  client: Client;
  queryClient: QueryClient;
  bookmarkTree: BookmarkTree;
  bookmark?: Bookmark | null;
  initialTarget?: Extract<QuickConnectTarget, { protocol: 'spice' }>;
  defaultGroupId: string | null;
  hosts: Host[];
  onClose(): void;
  onConnect(bookmark: Bookmark): void;
}) {
  const { x } = useI18n();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const settings = bookmark?.spice;
  const [proxyMode, setProxyMode] = useState<'inherit' | 'direct' | 'custom'>(
    settings?.proxy.mode === 'custom'
      ? 'custom'
      : settings?.proxy.mode === 'direct'
        ? 'direct'
        : 'inherit',
  );

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const form = new FormData(event.currentTarget);
    const password = String(form.get('password') ?? '');
    const proxyPassword = String(form.get('proxyPassword') ?? '');
    const previousCredentialRef = settings?.credentialRef ?? null;
    const previousProxyCredentialRef =
      settings?.proxy.mode === 'custom' ? settings.proxy.endpoint.credentialRef : null;
    const createdCredentialRefs: string[] = [];
    setBusy(true);
    setError('');
    try {
      let credentialRef = form.get('removePassword') === 'on' ? null : previousCredentialRef;
      if (password) {
        credentialRef = (
          await client.createCredential({
            kind: 'protocolPassword',
            label: `SPICE · ${String(form.get('name') ?? '')}`,
            secret: password,
          })
        ).ref;
        createdCredentialRefs.push(credentialRef);
      }
      let proxy: NonNullable<Bookmark['spice']>['proxy'];
      if (proxyMode === 'custom') {
        const proxyUsername = String(form.get('proxyUsername') ?? '').trim() || null;
        let proxyCredentialRef =
          settings?.proxy.mode === 'custom' && settings.proxy.endpoint.username === proxyUsername
            ? settings.proxy.endpoint.credentialRef
            : null;
        if (proxyPassword) {
          proxyCredentialRef = (
            await client.createCredential({
              kind: 'proxyPassword',
              label: `SPICE Proxy · ${String(form.get('name') ?? '')}`,
              secret: proxyPassword,
            })
          ).ref;
          createdCredentialRefs.push(proxyCredentialRef);
        }
        if (!!proxyUsername !== !!proxyCredentialRef)
          throw new Error(x('protocolBookmark.proxyPairRequired'));
        proxy = {
          mode: 'custom',
          endpoint: {
            url: String(form.get('proxyUrl') ?? ''),
            username: proxyUsername,
            credentialRef: proxyCredentialRef,
          },
        };
      } else proxy = { mode: proxyMode };
      const input = {
        ...protocolBookmarkMetadata(form, bookmark, defaultGroupId),
        connectionProfileId: String(form.get('connectionProfileId') || '') || null,
        spice: {
          hostname: String(form.get('hostname') ?? ''),
          port: Number(form.get('port') ?? 5_900),
          credentialRef,
          proxy,
          jumpHostId: String(form.get('jumpHostId') || '') || null,
          connectionTimeoutMs: Number(form.get('connectionTimeoutMs') ?? 15_000),
          viewOnly: form.get('viewOnly') === 'on',
          scaleViewport: form.get('scaleViewport') === 'on',
        },
      };
      const previousIds = new Set(bookmarkTree.bookmarks.map(({ id }) => id));
      const nextTree = bookmark
        ? await client.updateBookmark(bookmarkTree, bookmark.id, input)
        : await client.createBookmark(bookmarkTree, {
            ...input,
            groupId: String(form.get('groupId') || '') || defaultGroupId,
            protocol: 'spice',
            hostId: null,
            color: input.color,
            profileId: null,
          });
      queryClient.setQueryData(['bookmark-tree'], nextTree);
      const saved = bookmark
        ? nextTree.bookmarks.find(({ id }) => id === bookmark.id)
        : nextTree.bookmarks.find(({ id }) => !previousIds.has(id));
      const retained = new Set([
        input.spice.credentialRef,
        input.spice.proxy.mode === 'custom' ? input.spice.proxy.endpoint.credentialRef : null,
      ]);
      await Promise.allSettled(
        [previousCredentialRef, previousProxyCredentialRef]
          .filter((reference): reference is string => !!reference && !retained.has(reference))
          .map((reference) => client.deleteCredential(reference)),
      );
      const action = (event.nativeEvent as SubmitEvent).submitter as HTMLButtonElement | null;
      onClose();
      if (action?.value === 'connect' && saved) onConnect(saved);
    } catch (cause) {
      await Promise.allSettled(createdCredentialRefs.map((ref) => client.deleteCredential(ref)));
      setError(messageOf(cause, x));
    } finally {
      setBusy(false);
    }
  }

  const customProxy = settings?.proxy.mode === 'custom' ? settings.proxy.endpoint : undefined;
  const profiles = queryClient.getQueryData<Array<{ id: string; name: string; spice: unknown }>>([
    'connection-profiles',
  ]);
  return (
    <Modal
      className="protocol-bookmark-modal"
      title={bookmark ? x('protocolBookmark.editSpice') : x('protocolBookmark.addSpice')}
      onClose={onClose}
    >
      <form className="form-grid" onSubmit={(event) => void save(event)}>
        {error && <ErrorBanner text={error} />}
        <label>
          {x('protocolBookmark.name')}
          <input
            name="name"
            required
            maxLength={100}
            defaultValue={bookmark?.title ?? initialTarget?.title ?? initialTarget?.hostname ?? ''}
          />
        </label>
        <label>
          {x('protocolBookmark.group')}
          <select name="groupId" defaultValue={bookmark?.groupId ?? defaultGroupId ?? ''}>
            <option value="">{x('protocolBookmark.rootDirectory')}</option>
            {bookmarkTree.groups.map((group) => (
              <option key={group.id} value={group.id}>
                {group.name}
              </option>
            ))}
          </select>
        </label>
        <ProtocolBookmarkColorField bookmark={bookmark} />
        <label>
          {x('protocolBookmark.host')}
          <input
            name="hostname"
            required
            maxLength={253}
            defaultValue={settings?.hostname ?? initialTarget?.hostname ?? ''}
          />
        </label>
        <label>
          {x('protocolBookmark.port')}
          <input
            name="port"
            type="number"
            min={1}
            max={65_535}
            required
            defaultValue={settings?.port ?? initialTarget?.port ?? 5_900}
          />
        </label>
        <label>
          {x('protocolBookmark.password')}
          <input
            name="password"
            type="password"
            autoComplete="new-password"
            defaultValue={initialTarget?.temporarySecret ?? ''}
            placeholder={
              settings?.credentialRef
                ? x('protocolBookmark.savedPasswordPlaceholder')
                : x('protocolBookmark.optional')
            }
          />
        </label>
        {settings?.credentialRef && (
          <label className="check full-field">
            <input name="removePassword" type="checkbox" />{' '}
            {x('protocolBookmark.removeSavedPassword')}
          </label>
        )}
        <label>
          {x('protocolBookmark.connectionProfile')}
          <select name="connectionProfileId" defaultValue={bookmark?.connectionProfileId ?? ''}>
            <option value="">{x('protocolBookmark.none')}</option>
            {(profiles ?? [])
              .filter((profile) => !!profile.spice)
              .map((profile) => (
                <option key={profile.id} value={profile.id}>
                  {profile.name}
                </option>
              ))}
          </select>
        </label>
        <label>
          {x('protocolBookmark.jumpHost')}
          <select name="jumpHostId" defaultValue={settings?.jumpHostId ?? ''}>
            <option value="">{x('protocolBookmark.none')}</option>
            {hosts.map((host) => (
              <option key={host.id} value={host.id}>
                {host.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          {x('protocolBookmark.timeout')}
          <input
            name="connectionTimeoutMs"
            type="number"
            min={1_000}
            max={120_000}
            step={1_000}
            defaultValue={settings?.connectionTimeoutMs ?? 15_000}
          />
        </label>
        <label>
          {x('protocolBookmark.proxy')}
          <select
            name="proxyMode"
            value={proxyMode}
            onChange={(event) => setProxyMode(event.target.value as typeof proxyMode)}
          >
            <option value="inherit">{x('protocolBookmark.proxyInherit')}</option>
            <option value="direct">{x('protocolBookmark.proxyDirect')}</option>
            <option value="custom">{x('protocolBookmark.proxyCustom')}</option>
          </select>
        </label>
        {proxyMode === 'custom' && (
          <>
            <label>
              {x('protocolBookmark.proxyUrl')}
              <input
                name="proxyUrl"
                required
                placeholder="socks5://127.0.0.1:1080"
                defaultValue={customProxy?.url ?? ''}
              />
            </label>
            <label>
              {x('protocolBookmark.proxyUsername')}
              <input name="proxyUsername" defaultValue={customProxy?.username ?? ''} />
            </label>
            <label>
              {x('protocolBookmark.proxyPassword')}
              <input
                name="proxyPassword"
                type="password"
                autoComplete="new-password"
                placeholder={
                  customProxy?.credentialRef ? x('protocolBookmark.savedPasswordPlaceholder') : ''
                }
              />
            </label>
          </>
        )}
        <fieldset className="full-field checkbox-grid">
          <legend>{x('protocolBookmark.sessionExperience')}</legend>
          <label className="check">
            <input
              name="viewOnly"
              type="checkbox"
              defaultChecked={settings?.viewOnly ?? initialTarget?.viewOnly ?? false}
            />{' '}
            {x('protocolBookmark.viewOnly')}
          </label>
          <label className="check">
            <input
              name="scaleViewport"
              type="checkbox"
              defaultChecked={settings?.scaleViewport ?? initialTarget?.scaleViewport ?? true}
            />{' '}
            {x('protocolBookmark.fitToWindow')}
          </label>
        </fieldset>
        <label className="full-field">
          {x('protocolBookmark.description')}
          <textarea
            name="description"
            rows={3}
            maxLength={2_000}
            defaultValue={bookmark?.description ?? ''}
          />
        </label>
        <p className="hint full-field">{x('protocolBookmark.spiceVaultHint')}</p>
        <div className="modal-actions full-field">
          <button type="button" onClick={onClose}>
            {x('common.cancel')}
          </button>
          <button disabled={busy} value="save">
            {busy ? x('protocolBookmark.saving') : x('common.save')}
          </button>
          <button className="primary" disabled={busy} value="connect">
            {x('protocolBookmark.saveAndConnect')}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function WebBookmarkDialog({
  client,
  queryClient,
  bookmarkTree,
  bookmark,
  initialTarget,
  defaultGroupId,
  onClose,
  onConnect,
}: {
  client: Client;
  queryClient: QueryClient;
  bookmarkTree: BookmarkTree;
  bookmark?: Bookmark | null;
  initialTarget?: Extract<QuickConnectTarget, { protocol: 'http' | 'https' }>;
  defaultGroupId: string | null;
  onClose(): void;
  onConnect(bookmark: Bookmark): void;
}) {
  const { x } = useI18n();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const settings = bookmark?.web;

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const form = new FormData(event.currentTarget);
    const input = {
      ...protocolBookmarkMetadata(form, bookmark, defaultGroupId),
      connectionProfileId: null,
      web: {
        url: String(form.get('url') ?? ''),
        userAgent: String(form.get('userAgent') ?? '').trim() || null,
        hideAddressBar: form.get('hideAddressBar') === 'on',
      },
    };
    setBusy(true);
    setError('');
    try {
      const previousIds = new Set(bookmarkTree.bookmarks.map(({ id }) => id));
      const nextTree = bookmark
        ? await client.updateBookmark(bookmarkTree, bookmark.id, input)
        : await client.createBookmark(bookmarkTree, {
            ...input,
            groupId: String(form.get('groupId') || '') || defaultGroupId,
            protocol: 'web',
            hostId: null,
            color: input.color,
            profileId: null,
          });
      queryClient.setQueryData(['bookmark-tree'], nextTree);
      const saved = bookmark
        ? nextTree.bookmarks.find(({ id }) => id === bookmark.id)
        : nextTree.bookmarks.find(({ id }) => !previousIds.has(id));
      const action = (event.nativeEvent as SubmitEvent).submitter as HTMLButtonElement | null;
      onClose();
      if (action?.value === 'connect' && saved) onConnect(saved);
    } catch (cause) {
      setError(messageOf(cause, x));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      className="protocol-bookmark-modal"
      title={bookmark ? x('protocolBookmark.editWeb') : x('protocolBookmark.addWeb')}
      onClose={onClose}
    >
      <form className="form-grid" onSubmit={(event) => void save(event)}>
        {error && <ErrorBanner text={error} />}
        <label>
          {x('protocolBookmark.name')}
          <input
            name="name"
            required
            maxLength={100}
            defaultValue={bookmark?.title ?? initialTarget?.title ?? initialTarget?.url ?? ''}
          />
        </label>
        <label>
          {x('protocolBookmark.group')}
          <select name="groupId" defaultValue={bookmark?.groupId ?? defaultGroupId ?? ''}>
            <option value="">{x('protocolBookmark.rootDirectory')}</option>
            {bookmarkTree.groups.map((group) => (
              <option key={group.id} value={group.id}>
                {group.name}
              </option>
            ))}
          </select>
        </label>
        <ProtocolBookmarkColorField bookmark={bookmark} />
        <label className="full-field">
          URL
          <input
            name="url"
            type="url"
            required
            maxLength={4_096}
            placeholder="https://example.com"
            defaultValue={settings?.url ?? initialTarget?.url ?? 'https://'}
          />
        </label>
        <label className="full-field">
          User-Agent
          <input
            name="userAgent"
            maxLength={512}
            placeholder={x('protocolBookmark.electronDefaultPlaceholder')}
            defaultValue={settings?.userAgent ?? initialTarget?.userAgent ?? ''}
          />
        </label>
        <fieldset className="full-field checkbox-grid">
          <legend>{x('protocolBookmark.pageExperience')}</legend>
          <label className="check">
            <input
              name="hideAddressBar"
              type="checkbox"
              defaultChecked={settings?.hideAddressBar ?? false}
            />{' '}
            {x('protocolBookmark.hideAddressBar')}
          </label>
        </fieldset>
        <label className="full-field">
          {x('protocolBookmark.description')}
          <textarea
            name="description"
            rows={3}
            maxLength={2_000}
            defaultValue={bookmark?.description ?? ''}
          />
        </label>
        <p className="hint full-field">{x('protocolBookmark.webSecurityHint')}</p>
        <div className="modal-actions full-field">
          <button type="button" onClick={onClose}>
            {x('common.cancel')}
          </button>
          <button disabled={busy} value="save">
            {busy ? x('protocolBookmark.saving') : x('common.save')}
          </button>
          <button className="primary" disabled={busy} value="connect">
            {x('protocolBookmark.saveAndOpen')}
          </button>
        </div>
      </form>
    </Modal>
  );
}

const SSH_KEX_OPTIONS = [
  'curve25519-sha256',
  'curve25519-sha256@libssh.org',
  'diffie-hellman-group14-sha256',
  'diffie-hellman-group16-sha512',
  'ecdh-sha2-nistp256',
] as const;
const SSH_CIPHER_OPTIONS = [
  'chacha20-poly1305@openssh.com',
  'aes128-gcm@openssh.com',
  'aes256-gcm@openssh.com',
  'aes128-ctr',
  'aes192-ctr',
  'aes256-ctr',
] as const;
const SSH_HOST_KEY_OPTIONS = [
  'ssh-ed25519',
  'ecdsa-sha2-nistp256',
  'ecdsa-sha2-nistp384',
  'ecdsa-sha2-nistp521',
  'rsa-sha2-512',
  'rsa-sha2-256',
] as const;
const SSH_HMAC_OPTIONS = [
  'hmac-sha2-256-etm@openssh.com',
  'hmac-sha2-512-etm@openssh.com',
  'hmac-sha2-256',
  'hmac-sha2-512',
] as const;

function SshAlgorithmField({
  label,
  name,
  options,
  selected,
}: {
  label: string;
  name: string;
  options: readonly string[];
  selected: string[];
}) {
  return (
    <label>
      {label}
      <select aria-label={label} defaultValue={selected} multiple name={name} size={4}>
        {options.map((option) => (
          <option key={option} value={option}>
            {option}
          </option>
        ))}
      </select>
    </label>
  );
}

type StartupScriptRow = Host['startup']['runScripts'][number] & { id: number };

interface TunnelDraft {
  editing?: TunnelProfile;
  name: string;
  type: TunnelProfile['type'];
  bindHost: string;
  bindPort: number;
  targetHost: string;
  targetPort: number;
  allowNonLoopback: boolean;
}

const emptyTunnelDraft = (): TunnelDraft => ({
  name: '',
  type: 'local',
  bindHost: '127.0.0.1',
  bindPort: 0,
  targetHost: '127.0.0.1',
  targetPort: 80,
  allowNonLoopback: false,
});

function HostTunnelFields({
  client,
  host,
  profiles,
  active,
  connections,
  onChanged,
  onError,
}: {
  client: Client;
  host: Host | undefined;
  profiles: TunnelProfile[];
  active: Tunnel[];
  connections: Connection[];
  onChanged(): void;
  onError(message: string): void;
}) {
  const { x } = useI18n();
  const [draft, setDraft] = useState<TunnelDraft>(emptyTunnelDraft);
  const connection = connections.find(
    (candidate) => candidate.hostId === host?.id && candidate.state === 'ready',
  );

  async function save() {
    if (!host) return;
    if (!draft.name.trim()) return onError(x('hostTunnel.nameRequired'));
    if (draft.type !== 'dynamic' && (!draft.targetHost.trim() || !draft.targetPort))
      return onError(x('hostTunnel.targetRequired'));
    const input = {
      name: draft.name.trim(),
      hostId: host.id,
      type: draft.type,
      bindHost: draft.bindHost.trim(),
      bindPort: draft.bindPort,
      targetHost: draft.type === 'dynamic' ? null : draft.targetHost.trim(),
      targetPort: draft.type === 'dynamic' ? null : draft.targetPort,
      allowNonLoopback: draft.type === 'remote' ? false : draft.allowNonLoopback,
    };
    try {
      if (draft.editing) await client.updateTunnelProfile(draft.editing, input);
      else await client.createTunnelProfile(input);
      setDraft(emptyTunnelDraft());
      onError('');
      onChanged();
    } catch (cause) {
      onError(messageOf(cause, x));
    }
  }

  async function remove(profile: TunnelProfile) {
    if (!window.confirm(x('hostTunnel.deleteConfirm', { name: profile.name }))) return;
    try {
      await Promise.all(
        active
          .filter(({ profileId }) => profileId === profile.id)
          .map(({ id }) => client.stopTunnel(id)),
      );
      await client.deleteTunnelProfile(profile);
      if (draft.editing?.id === profile.id) setDraft(emptyTunnelDraft());
      onError('');
      onChanged();
    } catch (cause) {
      onError(messageOf(cause, x));
    }
  }

  async function toggle(profile: TunnelProfile, tunnel?: Tunnel) {
    try {
      if (tunnel) await client.stopTunnel(tunnel.id);
      else if (connection)
        await client.startTunnel({ connectionId: connection.id, profileId: profile.id });
      else throw new Error(x('hostTunnel.connectFirst'));
      onError('');
      onChanged();
    } catch (cause) {
      onError(messageOf(cause, x));
      onChanged();
    }
  }

  return (
    <fieldset
      aria-labelledby="ssh-bookmark-tab-tunnels"
      className="host-tunnel-editor host-form-field full-field"
      data-tab="tunnels"
      id="ssh-bookmark-tunnels"
      role="tabpanel"
    >
      <legend>{x('hostTunnel.title')}</legend>
      {!host ? (
        <p className="hint">{x('hostTunnel.saveHostFirst')}</p>
      ) : (
        <>
          <div className="host-tunnel-draft">
            <label>
              {x('hostTunnel.name')}
              <input
                aria-label={x('hostTunnel.nameAria')}
                value={draft.name}
                onChange={(event) => setDraft({ ...draft, name: event.target.value })}
              />
            </label>
            <label>
              {x('hostTunnel.type')}
              <select
                aria-label={x('hostTunnel.typeAria')}
                value={draft.type}
                onChange={(event) =>
                  setDraft({ ...draft, type: event.target.value as TunnelProfile['type'] })
                }
              >
                <option value="local">{x('hostTunnel.local')}</option>
                <option value="remote">{x('hostTunnel.remote')}</option>
                <option value="dynamic">{x('hostTunnel.dynamic')}</option>
              </select>
            </label>
            <label>
              {x('hostTunnel.bindAddress')}
              <input
                aria-label={x('hostTunnel.bindAddressAria')}
                value={draft.bindHost}
                onChange={(event) => setDraft({ ...draft, bindHost: event.target.value })}
              />
            </label>
            <label>
              {x('hostTunnel.bindPort')}
              <input
                aria-label={x('hostTunnel.bindPortAria')}
                max="65535"
                min="0"
                type="number"
                value={draft.bindPort}
                onChange={(event) => setDraft({ ...draft, bindPort: Number(event.target.value) })}
              />
            </label>
            {draft.type !== 'dynamic' && (
              <>
                <label>
                  {x('hostTunnel.targetAddress')}
                  <input
                    aria-label={x('hostTunnel.targetAddressAria')}
                    value={draft.targetHost}
                    onChange={(event) => setDraft({ ...draft, targetHost: event.target.value })}
                  />
                </label>
                <label>
                  {x('hostTunnel.targetPort')}
                  <input
                    aria-label={x('hostTunnel.targetPortAria')}
                    max="65535"
                    min="1"
                    type="number"
                    value={draft.targetPort}
                    onChange={(event) =>
                      setDraft({ ...draft, targetPort: Number(event.target.value) })
                    }
                  />
                </label>
              </>
            )}
            {draft.type !== 'remote' && (
              <label className="check host-tunnel-non-loopback">
                <input
                  checked={draft.allowNonLoopback}
                  type="checkbox"
                  onChange={(event) =>
                    setDraft({ ...draft, allowNonLoopback: event.target.checked })
                  }
                />
                {x('hostTunnel.allowNonLoopback')}
              </label>
            )}
            <div className="host-tunnel-draft-actions">
              {draft.editing && (
                <button type="button" onClick={() => setDraft(emptyTunnelDraft())}>
                  {x('common.cancel')}
                </button>
              )}
              <button className="primary" type="button" onClick={() => void save()}>
                <Save size={13} />{' '}
                {draft.editing ? x('hostTunnel.saveChanges') : x('hostTunnel.add')}
              </button>
            </div>
          </div>
          <div className="host-tunnel-list">
            {!profiles.length && <p className="hint">{x('hostTunnel.empty')}</p>}
            {profiles.map((profile) => {
              const tunnel = active.find(({ profileId }) => profileId === profile.id);
              return (
                <div className={`host-tunnel-row ${tunnel?.state ?? ''}`} key={profile.id}>
                  <span>
                    <strong>{profile.name}</strong>
                    <small>
                      {tunnelTypeLabel(profile.type, x)} · {profile.bindHost}:
                      {tunnel?.bindPort ?? profile.bindPort}
                    </small>
                    <small>
                      {tunnel
                        ? tunnelStateLabel(tunnel.state, x, tunnel.errorCode)
                        : x('tunnels.stopped')}
                    </small>
                  </span>
                  <button
                    aria-label={x(tunnel ? 'hostTunnel.stopNamed' : 'hostTunnel.startNamed', {
                      name: profile.name,
                    })}
                    disabled={!tunnel && !connection}
                    type="button"
                    onClick={() => void toggle(profile, tunnel)}
                  >
                    {tunnel ? <Square size={13} /> : <Play size={13} />}
                  </button>
                  <button
                    aria-label={x('hostTunnel.editNamed', { name: profile.name })}
                    type="button"
                    onClick={() =>
                      setDraft({
                        editing: profile,
                        name: profile.name,
                        type: profile.type,
                        bindHost: profile.bindHost,
                        bindPort: profile.bindPort,
                        targetHost: profile.targetHost ?? '127.0.0.1',
                        targetPort: profile.targetPort ?? 80,
                        allowNonLoopback: profile.allowNonLoopback,
                      })
                    }
                  >
                    <Pencil size={13} />
                  </button>
                  <button
                    aria-label={x('hostTunnel.deleteNamed', { name: profile.name })}
                    type="button"
                    onClick={() => void remove(profile)}
                  >
                    <Trash2 size={13} />
                  </button>
                </div>
              );
            })}
          </div>
        </>
      )}
    </fieldset>
  );
}

function SshStartupFields({ host }: { host: Host | undefined }) {
  const { x } = useI18n();
  const startup = host?.startup ?? DEFAULT_SSH_STARTUP;
  const initialRows = (rows: Host['startup']['loginScripts']): StartupScriptRow[] =>
    rows.map((row, id) => ({ ...row, id }));
  const [loginScripts, setLoginScripts] = useState(() => initialRows(startup.loginScripts));
  const [runScripts, setRunScripts] = useState(() => initialRows(startup.runScripts));

  const renderScripts = (
    kind: 'sshLoginScript' | 'sshRunScript',
    rows: StartupScriptRow[],
    update: (rows: StartupScriptRow[]) => void,
  ) => (
    <div className="ssh-startup-script-group">
      <div className="ssh-startup-script-heading">
        <strong>
          {kind === 'sshLoginScript' ? x('sshStartup.loginScripts') : x('sshStartup.runScripts')}
        </strong>
        <button
          type="button"
          disabled={rows.length >= 16}
          onClick={() =>
            update([
              ...rows,
              {
                id: rows.reduce((maximum, row) => Math.max(maximum, row.id), -1) + 1,
                command: '',
                delayMs: 500,
                sendEnter: true,
                waitForOutput: true,
                settleIdleMs: 400,
                settleTimeoutMs: 3_000,
              },
            ])
          }
        >
          <Plus size={13} aria-hidden="true" /> {x('sshStartup.addScript')}
        </button>
      </div>
      {rows.map((row, index) => (
        <div className="ssh-startup-script-row" key={row.id}>
          <label>
            {x('sshStartup.delay')}
            <input
              aria-label={x(
                kind === 'sshLoginScript'
                  ? 'sshStartup.loginScriptDelayAria'
                  : 'sshStartup.runScriptDelayAria',
                { number: index + 1 },
              )}
              defaultValue={row.delayMs}
              max="60000"
              min="0"
              name={`${kind}Delay`}
              required
              type="number"
            />
          </label>
          <label>
            {x('sshStartup.command')}
            <textarea
              aria-label={x(
                kind === 'sshLoginScript'
                  ? 'sshStartup.loginScriptCommandAria'
                  : 'sshStartup.runScriptCommandAria',
                { number: index + 1 },
              )}
              defaultValue={row.command}
              maxLength={4_096}
              name={`${kind}Command`}
              required
              rows={2}
            />
          </label>
          <div className="ssh-startup-script-options">
            <label>
              {x('sshStartup.sendMode')}
              <select defaultValue={row.sendEnter ? 'enter' : 'raw'} name={`${kind}SendMode`}>
                <option value="enter">{x('sshStartup.sendWithEnter')}</option>
                <option value="raw">{x('sshStartup.sendTextOnly')}</option>
              </select>
            </label>
            <label>
              {x('sshStartup.nextWait')}
              <select defaultValue={row.waitForOutput ? 'idle' : 'delay'} name={`${kind}WaitMode`}>
                <option value="idle">{x('sshStartup.waitForIdle')}</option>
                <option value="delay">{x('sshStartup.fixedDelayOnly')}</option>
              </select>
            </label>
            <label>
              {x('sshStartup.idleTime')}
              <input
                defaultValue={row.settleIdleMs}
                max="2000"
                min="50"
                name={`${kind}SettleIdle`}
                required
                type="number"
              />
            </label>
            <label>
              {x('sshStartup.maxWait')}
              <input
                defaultValue={row.settleTimeoutMs}
                max="10000"
                min="250"
                name={`${kind}SettleTimeout`}
                required
                type="number"
              />
            </label>
          </div>
          <button
            aria-label={x(
              kind === 'sshLoginScript'
                ? 'sshStartup.deleteLoginScriptAria'
                : 'sshStartup.deleteRunScriptAria',
              { number: index + 1 },
            )}
            type="button"
            onClick={() => update(rows.filter(({ id }) => id !== row.id))}
          >
            <Trash2 size={14} aria-hidden="true" />
          </button>
        </div>
      ))}
      {!rows.length && <p className="hint">{x('sshStartup.empty')}</p>}
    </div>
  );

  return (
    <details className="ssh-startup-settings full-field host-form-field" data-tab="settings">
      <summary>{x('sshStartup.title')}</summary>
      <p className="hint">{x('sshStartup.hint')}</p>
      <label>
        {x('sshStartup.directory')}
        <input
          defaultValue={startup.directory ?? ''}
          maxLength={4_096}
          name="sshStartupDirectory"
          placeholder="/home/operator/project"
        />
      </label>
      <label>
        {x('sshStartup.environment')}
        <textarea
          defaultValue={Object.entries(startup.environment)
            .map(([name, value]) => `${name}=${value}`)
            .join('\n')}
          name="sshStartupEnvironment"
          placeholder={'LANG=zh_CN.UTF-8\nAPP_ENV=staging'}
          rows={3}
        />
        <small>{x('sshStartup.environmentHint')}</small>
      </label>
      {renderScripts('sshLoginScript', loginScripts, setLoginScripts)}
      {renderScripts('sshRunScript', runScripts, setRunScripts)}
    </details>
  );
}

function parseSshStartupEnvironment(input: string, x: Translator): Record<string, string> {
  const environment: Record<string, string> = {};
  for (const [index, source] of input.split(/\r?\n/gu).entries()) {
    if (!source.trim()) continue;
    const separator = source.indexOf('=');
    if (separator <= 0) throw new Error(x('hosts.environmentLineInvalid', { line: index + 1 }));
    const name = source.slice(0, separator).trim();
    if (name in environment) throw new Error(x('hosts.environmentDuplicate', { name }));
    environment[name] = source.slice(separator + 1);
  }
  return environment;
}

function readSshStartupScripts(
  form: FormData,
  kind: 'sshLoginScript' | 'sshRunScript',
): Host['startup']['runScripts'] {
  const commands = form.getAll(`${kind}Command`).map((value) => String(value).trim());
  const delays = form.getAll(`${kind}Delay`).map(Number);
  const sendModes = form.getAll(`${kind}SendMode`).map(String);
  const waitModes = form.getAll(`${kind}WaitMode`).map(String);
  const settleIdle = form.getAll(`${kind}SettleIdle`).map(Number);
  const settleTimeout = form.getAll(`${kind}SettleTimeout`).map(Number);
  return commands.map((command, index) => ({
    command,
    delayMs: delays[index] ?? 0,
    sendEnter: sendModes[index] !== 'raw',
    waitForOutput: waitModes[index] !== 'delay',
    settleIdleMs: settleIdle[index] ?? 400,
    settleTimeoutMs: settleTimeout[index] ?? 3_000,
  }));
}

function HostJumpChainFields({ host, hosts }: { host: Host | undefined; hosts: Host[] }) {
  const { x } = useI18n();
  const initial = host?.jumpHostIds.length
    ? host.jumpHostIds
    : legacyJumpPath(host?.jumpHostId ?? null, hosts);
  const [ids, setIds] = useState(initial);
  const [candidate, setCandidate] = useState('');
  const [targetName, setTargetName] = useState(host?.name || x('jumpChain.targetHost'));
  const root = useRef<HTMLFieldSetElement>(null);
  const available = hosts.filter((item) => item.id !== host?.id && !ids.includes(item.id));

  useEffect(() => {
    const input = root.current?.closest('form')?.elements.namedItem('name');
    if (!(input instanceof HTMLInputElement)) return;
    const update = () => setTargetName(input.value.trim() || x('jumpChain.targetHost'));
    update();
    input.addEventListener('input', update);
    return () => input.removeEventListener('input', update);
  }, [x]);

  function move(index: number, offset: -1 | 1) {
    const destination = index + offset;
    if (destination < 0 || destination >= ids.length) return;
    setIds((current) => {
      const next = [...current];
      [next[index], next[destination]] = [next[destination]!, next[index]!];
      return next;
    });
  }

  return (
    <fieldset ref={root} className="host-jump-chain host-form-field full-field" data-tab="hops">
      <legend>{x('jumpChain.title')}</legend>
      <p id="ssh-bookmark-hops" className="hint">
        {x('jumpChain.hint')}
      </p>
      <div className="host-jump-chain-add">
        <label>
          {x('jumpChain.addSavedHost')}
          <select
            aria-label={x('jumpChain.addAria')}
            value={candidate}
            onChange={(event) => setCandidate(event.target.value)}
          >
            <option value="">{x('jumpChain.selectHost')}</option>
            {available.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name} — {item.username}@{item.hostname}:{item.port}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          disabled={!candidate || ids.length >= 8}
          onClick={() => {
            if (!candidate || ids.includes(candidate) || ids.length >= 8) return;
            setIds((current) => [...current, candidate]);
            setCandidate('');
          }}
        >
          <Plus size={13} aria-hidden="true" /> {x('jumpChain.add')}
        </button>
      </div>
      <ol className="host-jump-chain-list" aria-label={x('jumpChain.order')}>
        {ids.map((id, index) => {
          const item = hosts.find((candidateHost) => candidateHost.id === id);
          if (!item) return null;
          return (
            <li key={id}>
              <input name="jumpHostIds" type="hidden" value={id} />
              <span className="host-jump-chain-index">{index + 1}</span>
              <span>
                <strong>{item.name}</strong>
                <small>
                  {item.username}@{item.hostname}:{item.port}
                </small>
              </span>
              <button
                aria-label={x('jumpChain.moveUp', { name: item.name })}
                type="button"
                disabled={index === 0}
                onClick={() => move(index, -1)}
              >
                <ChevronUp size={14} aria-hidden="true" />
              </button>
              <button
                aria-label={x('jumpChain.moveDown', { name: item.name })}
                type="button"
                disabled={index === ids.length - 1}
                onClick={() => move(index, 1)}
              >
                <ChevronDown size={14} aria-hidden="true" />
              </button>
              <button
                aria-label={x('jumpChain.remove', { name: item.name })}
                type="button"
                onClick={() => setIds((current) => current.filter((value) => value !== id))}
              >
                <Trash2 size={13} aria-hidden="true" />
              </button>
            </li>
          );
        })}
      </ol>
      {!ids.length && <p className="hint host-jump-chain-empty">{x('jumpChain.direct')}</p>}
      <p className="host-jump-chain-path" aria-label={x('jumpChain.path')}>
        <span>{x('jumpChain.localMachine')}</span>
        {ids.map((id) => (
          <span key={id}>
            {hosts.find((item) => item.id === id)?.name ?? x('jumpChain.unknownHost')}
          </span>
        ))}
        <span>{targetName}</span>
      </p>
    </fieldset>
  );
}

function legacyJumpPath(jumpHostId: string | null, hosts: Host[]): string[] {
  const path: string[] = [];
  const seen = new Set<string>();
  let cursor = jumpHostId;
  while (cursor && !seen.has(cursor) && path.length < 8) {
    seen.add(cursor);
    path.unshift(cursor);
    cursor = hosts.find(({ id }) => id === cursor)?.jumpHostId ?? null;
  }
  return path;
}

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
  const [localGrant, setLocalGrant] = useState<FileGrant | undefined>(() =>
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
  const localGrantRef = useRef<FileGrant | undefined>(undefined);
  const localFilePanelMountedRef = useRef(true);
  const defaultLocalGrantRequestedRef = useRef(false);
  const followedTerminalDirectoryRef = useRef('');
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
  const selected = singleSelectedFilePath(remoteSelection);
  const files = useQuery({
    queryKey: ['files', effectiveConnectionId, path],
    queryFn: () =>
      ftpMode
        ? client.ftpFiles(effectiveConnectionId, path)
        : client.remoteFiles(effectiveConnectionId, path),
    enabled: active && !!effectiveConnectionId,
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
    localGrantRef.current = localGrant;
  }, [localGrant]);
  useEffect(() => {
    if (!active || localGrant || defaultLocalGrantRequestedRef.current) return;
    defaultLocalGrantRequestedRef.current = true;
    void client
      .createFileGrant('home-directory')
      .then(async (grant) => {
        if (!grant) return;
        if (!localFilePanelMountedRef.current) {
          await client.revokeFileGrant(grant.grantId).catch(() => undefined);
          return;
        }
        const previous = localGrantRef.current;
        localGrantRef.current = grant;
        setLocalGrant(grant);
        setLocalPath('');
        setLocalPathInput(localAbsoluteAddress(grant, ''));
        setLocalSelection(createFileSelection());
        setLocalHistory(['']);
        setLocalBookmarks([]);
        setError('');
        if (previous) await client.revokeFileGrant(previous.grantId).catch(() => undefined);
      })
      .catch((cause: unknown) => {
        if (localFilePanelMountedRef.current) setError(messageOf(cause, x));
      });
  }, [active, client, localGrant, x]);
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
  useEffect(
    () => () => {
      localFilePanelMountedRef.current = false;
      const grant = localGrantRef.current;
      if (grant) void client.revokeFileGrant(grant.grantId).catch(() => {});
    },
    [client],
  );
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
      const grant = await client.createFileGrant('open-directory');
      if (!grant) return;
      const previous = localGrantRef.current;
      localGrantRef.current = grant;
      setLocalGrant(grant);
      setLocalPath('');
      setLocalPathInput(localAbsoluteAddress(grant, ''));
      setLocalSelection(createFileSelection());
      setLocalHistory(['']);
      setLocalBookmarks([]);
      setLocalKeyword('');
      setLocalKeywordDraft('');
      setFileManagerView(fileManagerView === 'remote' ? 'split' : fileManagerView);
      if (previous) await client.revokeFileGrant(previous.grantId).catch(() => {});
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
      const grant = await client.createFileGrant('directory-path', nextAddress.trim());
      if (!grant) return;
      const previous = localGrantRef.current;
      localGrantRef.current = grant;
      setLocalGrant(grant);
      setLocalPath('');
      setLocalPathInput(localAbsoluteAddress(grant, ''));
      setLocalSelection(createFileSelection());
      setLocalHistory(['']);
      setLocalBookmarks([]);
      setLocalKeyword('');
      setLocalKeywordDraft('');
      setError('');
      if (previous) await client.revokeFileGrant(previous.grantId).catch(() => undefined);
    } catch (cause) {
      setError(messageOf(cause, x));
    }
  }

  function navigateRemote(nextPath: string) {
    try {
      const normalized = normalizeRemoteAddress(nextPath, x);
      setPath(normalized);
      setPathInput(normalized);
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
  async function download() {
    const entry = files.data?.find((item) => item.path === selected);
    if (!entry) return;
    try {
      const grant = await client.createFileGrant(
        entry.type === 'directory' ? 'open-directory' : 'save-file',
      );
      if (!grant) return;
      await (ftpMode ? client.createFtpTransfer : client.createTransfer)(
        effectiveConnectionId,
        'download',
        {
          grantId: grant.grantId,
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
        if (entry)
          items.push({
            id: 'open',
            label:
              entry.type === 'directory' ? x('fileManager.enterDirectory') : x('fileManager.open'),
            icon: <FolderOpen size={14} />,
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
            <button onClick={() => void download()} disabled={!selected}>
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
          <section className="file-pane file-pane-local" aria-label={x('fileManager.localFiles')}>
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
            {localGrant ? (
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
            ) : (
              <div className="file-list">
                <EmptyState
                  icon={Folder}
                  title={x('fileManager.selectLocalTitle')}
                  text={x('fileManager.grantHint')}
                />
              </div>
            )}
            {localFiles.isError && <ErrorBanner text={messageOf(localFiles.error, x)} />}
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
                    if (ftpConnection) navigateRemote(ftpConnection.initialDirectory);
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
            {effectiveConnectionId ? (
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
                onSort={(column) => void changeFileSort('remote', column)}
                onToggleColumn={(column) => void toggleFileColumn(column)}
              />
            ) : (
              <div className="file-list">
                <EmptyState
                  icon={Folder}
                  title={x('fileManager.selectConnection')}
                  text={x('fileManager.selectConnectionHint')}
                />
              </div>
            )}
            {files.isError && <ErrorBanner text={messageOf(files.error, x)} />}
          </section>
        )}
      </div>
      {!!transfers.length && (
        <section className="transfer-list">
          <h3>{x('fileManager.transferQueue')}</h3>
          {transfers.slice(0, 8).map((transfer) => (
            <div key={transfer.id}>
              <span>
                {transfer.direction === 'upload' ? (
                  <Upload size={12} />
                ) : transfer.direction === 'download' ? (
                  <Download size={12} />
                ) : (
                  <Server size={12} />
                )}{' '}
                {transfer.id.slice(0, 8)}
              </span>
              <progress value={transfer.bytesTransferred} max={transfer.totalBytes || 1} />
              <small>{transfer.state}</small>
              {transfer.state === 'running' ? (
                <>
                  <button
                    onClick={() => void client.pauseTransfer(transfer.id)}
                    title={x('fileManager.pause')}
                  >
                    <Pause size={11} />
                  </button>
                  <button
                    onClick={() => void client.cancelTransfer(transfer.id)}
                    title={x('fileManager.cancel')}
                  >
                    <Square size={11} />
                  </button>
                </>
              ) : transfer.state === 'paused' ? (
                <>
                  <button
                    onClick={() => void client.resumeTransfer(transfer.id)}
                    title={x('fileManager.resume')}
                  >
                    <Play size={11} />
                  </button>
                  <button
                    onClick={() => void client.cancelTransfer(transfer.id)}
                    title={x('fileManager.cancel')}
                  >
                    <Square size={11} />
                  </button>
                </>
              ) : ['queued', 'preparing', 'awaiting-decision'].includes(transfer.state) ? (
                <button onClick={() => void client.cancelTransfer(transfer.id)}>
                  <Square size={11} />
                </button>
              ) : null}
              {['failed', 'canceled'].includes(transfer.state) && (
                <button onClick={() => void client.retryTransfer(transfer.id)}>
                  {x('fileManager.retry')}
                </button>
              )}
            </div>
          ))}
        </section>
      )}
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
  const acceptsTransfer = (transfer: DataTransfer) =>
    Array.from(transfer.types).includes(FILE_DRAG_MIME) || activeDrag()?.scope === scope;
  const dropPayload = (transfer: DataTransfer) => parseFileDragPayload(transfer) ?? activeDrag();
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
          event.dataTransfer.dropEffect = 'move';
          setDropTarget('current');
        }}
        onDragLeave={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null))
            setDropTarget(undefined);
        }}
        onDrop={(event) => {
          const payload = dropPayload(event.dataTransfer);
          if (!payload || (event.target as Element).closest('.file-data-row')) return;
          event.preventDefault();
          setDropTarget(undefined);
          onDropFiles(payload, currentPath);
        }}
        onScroll={(event) => {
          setScrollTop(event.currentTarget.scrollTop);
          setViewportHeight(event.currentTarget.clientHeight);
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
              event.dataTransfer.dropEffect = 'move';
              setDropTarget('parent');
            }}
            onDragLeave={() => setDropTarget(undefined)}
            onDrop={(event) => {
              const payload = dropPayload(event.dataTransfer);
              if (!payload || parentPath === undefined) return;
              event.preventDefault();
              event.stopPropagation();
              setDropTarget(undefined);
              onDropFiles(payload, parentPath);
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
                if (!acceptsTransfer(event.dataTransfer) || entry.type !== 'directory') return;
                event.preventDefault();
                event.stopPropagation();
                event.dataTransfer.dropEffect = 'move';
                setDropTarget(entry.path);
              }}
              onDragLeave={() => setDropTarget(undefined)}
              onDrop={(event) => {
                const payload = dropPayload(event.dataTransfer);
                if (!payload || entry.type !== 'directory') return;
                event.preventDefault();
                event.stopPropagation();
                setDropTarget(undefined);
                onDropFiles(payload, entry.path);
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

export function TunnelsPanel({
  client,
  connections,
  hosts,
}: {
  client: Client;
  connections: Connection[];
  hosts: Host[];
}) {
  const { x } = useI18n();
  const profiles = useQuery({ queryKey: ['tunnel-profiles'], queryFn: client.tunnelProfiles });
  const active = useQuery({
    queryKey: ['tunnels'],
    queryFn: client.tunnels,
    refetchInterval: 1500,
  });
  const ready = connections.filter((connection) => connection.state === 'ready');
  const [error, setError] = useState('');
  const [editingProfile, setEditingProfile] = useState<TunnelProfile>();
  const [profileType, setProfileType] = useState<TunnelProfile['type']>('local');
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    const type = String(form.get('type')) as 'local' | 'remote' | 'dynamic';
    try {
      const input = {
        name: String(form.get('name')),
        hostId: String(form.get('hostId')),
        type,
        bindHost: String(form.get('bindHost')),
        bindPort: Number(form.get('bindPort')),
        targetHost: type === 'dynamic' ? null : String(form.get('targetHost')),
        targetPort: type === 'dynamic' ? null : Number(form.get('targetPort')),
        allowNonLoopback: form.get('allowNonLoopback') === 'on',
      };
      if (editingProfile) await client.updateTunnelProfile(editingProfile, input);
      else await client.createTunnelProfile(input);
      formElement.reset();
      setEditingProfile(undefined);
      setProfileType('local');
      setError('');
      await profiles.refetch();
    } catch (cause) {
      setError(messageOf(cause));
    }
  }
  async function start(profileId: string, hostId: string) {
    const connection = ready.find((item) => item.hostId === hostId);
    if (!connection) return setError(x('tunnels.connectHostFirst'));
    try {
      await client.startTunnel({ connectionId: connection.id, profileId });
      await active.refetch();
    } catch (cause) {
      setError(messageOf(cause));
      await active.refetch();
    }
  }
  async function stop(tunnelId: string) {
    try {
      await client.stopTunnel(tunnelId);
      setError('');
      await active.refetch();
    } catch (cause) {
      setError(messageOf(cause));
    }
  }
  async function remove(profile: TunnelProfile) {
    if (!window.confirm(x('tunnels.deleteConfirm', { name: profile.name }))) return;
    try {
      await Promise.all(
        (active.data ?? [])
          .filter(({ profileId }) => profileId === profile.id)
          .map(({ id }) => client.stopTunnel(id)),
      );
      await client.deleteTunnelProfile(profile);
      if (editingProfile?.id === profile.id) setEditingProfile(undefined);
      setError('');
      await Promise.all([profiles.refetch(), active.refetch()]);
    } catch (cause) {
      setError(messageOf(cause));
    }
  }
  return (
    <PanelFrame
      eyebrow={x('tunnels.eyebrow')}
      title={x('tunnels.title')}
      description={x('tunnels.description')}
    >
      {error && <ErrorBanner text={error} />}
      <div className="two-column tunnel-manager">
        <form
          className="stack surface"
          key={editingProfile?.id ?? 'new-tunnel'}
          onSubmit={(event) => void save(event)}
        >
          <div className="panel-heading-inline">
            <h3>{editingProfile ? x('tunnels.editProfile') : x('tunnels.newProfile')}</h3>
            {editingProfile && (
              <button
                type="button"
                onClick={() => {
                  setEditingProfile(undefined);
                  setProfileType('local');
                }}
              >
                {x('tunnels.cancelEdit')}
              </button>
            )}
          </div>
          <label>
            {x('tunnels.name')}
            <input defaultValue={editingProfile?.name ?? ''} name="name" required />
          </label>
          <label>
            {x('tunnels.host')}
            <select
              defaultValue={editingProfile?.hostId ?? hosts[0]?.id ?? ''}
              name="hostId"
              required
            >
              {!hosts.length && <option value="">{x('tunnels.saveSshHostFirst')}</option>}
              {hosts.map((host) => (
                <option key={host.id} value={host.id}>
                  {host.name} — {host.username}@{host.hostname}:{host.port}
                </option>
              ))}
            </select>
          </label>
          <label>
            {x('tunnels.type')}
            <select
              name="type"
              value={profileType}
              onChange={(event) => setProfileType(event.target.value as TunnelProfile['type'])}
            >
              <option value="local">{x('tunnels.local')}</option>
              <option value="remote">{x('tunnels.remote')}</option>
              <option value="dynamic">{x('tunnels.dynamic')}</option>
            </select>
          </label>
          <div className="inline">
            <label>
              {x('tunnels.bindAddress')}
              <input name="bindHost" defaultValue={editingProfile?.bindHost ?? '127.0.0.1'} />
            </label>
            <label>
              {x('tunnels.port')}
              <input
                name="bindPort"
                type="number"
                min="0"
                max="65535"
                defaultValue={editingProfile?.bindPort ?? 0}
              />
            </label>
          </div>
          {profileType !== 'dynamic' && (
            <div className="inline">
              <label>
                {x('tunnels.targetAddress')}
                <input
                  name="targetHost"
                  defaultValue={editingProfile?.targetHost ?? '127.0.0.1'}
                  required
                />
              </label>
              <label>
                {x('tunnels.targetPort')}
                <input
                  name="targetPort"
                  type="number"
                  min="1"
                  max="65535"
                  defaultValue={editingProfile?.targetPort ?? 80}
                  required
                />
              </label>
            </div>
          )}
          {profileType !== 'remote' && (
            <label className="check">
              <input
                defaultChecked={editingProfile?.allowNonLoopback ?? false}
                name="allowNonLoopback"
                type="checkbox"
              />
              {x('tunnels.allowNonLoopback')}
            </label>
          )}
          <button className="primary" disabled={!hosts.length}>
            <Save size={13} />{' '}
            {editingProfile ? x('tunnels.saveChanges') : x('tunnels.saveProfile')}
          </button>
        </form>
        <div className="surface list">
          <h3>{x('tunnels.profilesAndInstances')}</h3>
          {!profiles.data?.length && <p className="hint">{x('tunnels.empty')}</p>}
          {profiles.data?.map((profile) => {
            const tunnel = active.data?.find(({ profileId }) => profileId === profile.id);
            const host = hosts.find(({ id }) => id === profile.hostId);
            const canStart = ready.some(({ hostId }) => hostId === profile.hostId);
            return (
              <div
                className={`list-row tunnel-profile-row ${tunnel?.state ?? ''}`}
                key={profile.id}
              >
                {tunnel?.state === 'active' ? <Check size={15} /> : <Network size={15} />}
                <div>
                  <strong>{profile.name}</strong>
                  <small>
                    {host?.name ?? x('tunnels.unknownHost')} · {tunnelTypeLabel(profile.type, x)} ·{' '}
                    {profile.bindHost}:{tunnel?.bindPort ?? profile.bindPort}
                    {profile.type !== 'dynamic'
                      ? ` → ${profile.targetHost}:${profile.targetPort}`
                      : ''}
                  </small>
                  <small className="tunnel-status">
                    {tunnel
                      ? tunnelStateLabel(tunnel.state, x, tunnel.errorCode)
                      : canStart
                        ? x('tunnels.connectedReady')
                        : x('tunnels.waitingForHost')}
                  </small>
                </div>
                <div className="row-actions">
                  {tunnel && tunnel.state !== 'closed' ? (
                    <button
                      aria-label={x('tunnels.stopNamed', { name: profile.name })}
                      onClick={() => void stop(tunnel.id)}
                    >
                      <Square size={12} />
                    </button>
                  ) : (
                    <button
                      aria-label={x('tunnels.startNamed', { name: profile.name })}
                      disabled={!canStart}
                      onClick={() => void start(profile.id, profile.hostId)}
                    >
                      <Play size={12} />
                    </button>
                  )}
                  <button
                    aria-label={x('tunnels.editNamed', { name: profile.name })}
                    onClick={() => {
                      setEditingProfile(profile);
                      setProfileType(profile.type);
                    }}
                  >
                    <Pencil size={12} />
                  </button>
                  <button
                    aria-label={x('tunnels.deleteNamed', { name: profile.name })}
                    onClick={() => void remove(profile)}
                  >
                    <Trash2 size={12} />
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </PanelFrame>
  );
}

function tunnelTypeLabel(type: TunnelProfile['type'], x: ReturnType<typeof useI18n>['x']): string {
  return type === 'local'
    ? x('tunnels.local')
    : type === 'remote'
      ? x('tunnels.remote')
      : x('tunnels.dynamic');
}

function tunnelStateLabel(
  state: string,
  x: ReturnType<typeof useI18n>['x'],
  errorCode?: string,
): string {
  if (state === 'active') return x('tunnels.active');
  if (state === 'starting') return x('tunnels.starting');
  if (state === 'stopping') return x('tunnels.stopping');
  if (state === 'failed')
    return errorCode === 'TUNNEL_PORT_IN_USE'
      ? x('tunnels.portInUse')
      : errorCode === 'SSH_CONNECTION_CLOSED'
        ? x('tunnels.sshClosed')
        : x('tunnels.startFailed');
  return x('tunnels.stopped');
}

export function CommandsPanel({
  client,
  requestedSection = 'quick-commands',
}: {
  client: Client;
  requestedSection?: 'quick-commands' | 'batch-operations' | 'triggers';
}) {
  const { x } = useI18n();
  const [selection, setSelection] = useState<{
    request: 'quick-commands' | 'batch-operations' | 'triggers';
    value: 'quick-commands' | 'batch-operations' | 'triggers';
  }>({ request: requestedSection, value: requestedSection });
  const section = selection.request === requestedSection ? selection.value : requestedSection;
  const setSection = (value: 'quick-commands' | 'batch-operations' | 'triggers') =>
    setSelection({ request: requestedSection, value });
  return (
    <PanelFrame
      eyebrow={x('panels.productivity')}
      title={
        section === 'quick-commands'
          ? x('panels.quickCommands')
          : section === 'batch-operations'
            ? x('panels.batchOperations')
            : x('panels.triggers')
      }
      description={
        section === 'quick-commands'
          ? x('panels.quickCommandsDescription')
          : section === 'batch-operations'
            ? x('panels.batchOperationsDescription')
            : x('panels.triggersDescription')
      }
    >
      <nav className="commands-workspace-tabs" aria-label={x('panels.commandTools')}>
        <button
          type="button"
          aria-selected={section === 'quick-commands'}
          onClick={() => setSection('quick-commands')}
        >
          {x('panels.quickCommands')}
        </button>
        <button
          type="button"
          aria-selected={section === 'batch-operations'}
          onClick={() => setSection('batch-operations')}
        >
          {x('panels.batchOperations')}
        </button>
        <button
          type="button"
          aria-selected={section === 'triggers'}
          onClick={() => setSection('triggers')}
        >
          {x('panels.triggers')} <sup>{x('panels.beta')}</sup>
        </button>
      </nav>
      {section === 'quick-commands' && <QuickCommandWorkspace client={client} />}
      {section === 'batch-operations' && <BatchOperationWorkspace client={client} />}
      {section === 'triggers' && <TriggerWorkspace client={client} />}
    </PanelFrame>
  );
}

export function AiPanel({
  client,
  activeTerminalId,
}: {
  client: Client;
  activeTerminalId: string | undefined;
}) {
  const { x, language } = useI18n();
  const providers = useQuery({ queryKey: ['ai-providers'], queryFn: client.aiProviders });
  const models = useQuery({ queryKey: ['ai-models'], queryFn: client.aiModels });
  const runs = useQuery({ queryKey: ['ai-runs'], queryFn: client.aiRuns, refetchInterval: 1200 });
  const conversations = useQuery({
    queryKey: ['ai-conversations'],
    queryFn: client.aiConversations,
    refetchInterval: 2_500,
  });
  const approvals = useQuery({
    queryKey: ['ai-approvals'],
    queryFn: client.aiApprovals,
    refetchInterval: 1200,
  });
  const toolCalls = useQuery({
    queryKey: [
      'ai-tool-calls',
      [
        ...new Set([
          ...(runs.data ?? []).map(({ id }) => id),
          ...(approvals.data ?? []).map(({ runId }) => runId),
        ]),
      ]
        .sort()
        .join(',') ?? '',
    ],
    enabled: !!runs.data?.length || !!approvals.data?.length,
    refetchInterval: 1_200,
    queryFn: async () =>
      (
        await Promise.all(
          [
            ...new Set([
              ...(runs.data ?? []).map(({ id }) => id),
              ...(approvals.data ?? []).map(({ runId }) => runId),
            ]),
          ]
            .slice(-100)
            .map((runId) => client.aiToolCalls(runId)),
        )
      ).flat(),
  });
  const insertTerminal = useWorkspace((state) => state.insertTerminal);
  const [setup, setSetup] = useState(false);
  const offeredSetupRef = useRef(false);
  const [error, setError] = useState('');
  const [providerProtocol, setProviderProtocol] = useState<AiProviderProtocol>('openai-chat');
  const [providerStatus, setProviderStatus] = useState<Record<string, string>>({});
  const [currentConversationId, setCurrentConversationId] = useState<string | null | undefined>(
    undefined,
  );
  const [showConversationHistory, setShowConversationHistory] = useState(true);
  const [deleteConversationId, setDeleteConversationId] = useState<string | null>(null);
  const [chatActionStatus, setChatActionStatus] = useState<Record<string, string>>({});
  const [promptDraft, setPromptDraft] = useState('');
  const [attachments, setAttachments] = useState<AiAttachmentPreview[]>([]);
  const attachmentsRef = useRef<AiAttachmentPreview[]>([]);
  const attachmentControllerRef = useRef<AbortController | undefined>(undefined);
  const [attachmentBusy, setAttachmentBusy] = useState(false);
  const [attachmentDragOver, setAttachmentDragOver] = useState(false);
  const [previewAttachmentId, setPreviewAttachmentId] = useState<string>();
  const conversation = useQuery({
    queryKey: ['ai-conversation', currentConversationId],
    enabled: typeof currentConversationId === 'string',
    queryFn: () => client.aiConversation(currentConversationId!),
    refetchInterval: 1_200,
  });
  useEffect(() => {
    if (!conversations.isSuccess) return;
    if (currentConversationId === undefined)
      setCurrentConversationId(conversations.data[0]?.id ?? null);
  }, [conversations.data, conversations.isSuccess, currentConversationId]);
  useEffect(() => {
    if (!providers.isSuccess || !approvals.isSuccess || offeredSetupRef.current) return;
    offeredSetupRef.current = true;
    const hasPendingApproval = approvals.data.some(({ state }) => state === 'pending');
    if (!providers.data.length && !hasPendingApproval) setSetup(true);
  }, [approvals.data, approvals.isSuccess, providers.data, providers.isSuccess]);
  useEffect(
    () => () => {
      attachmentControllerRef.current?.abort();
      void Promise.allSettled(
        attachmentsRef.current.map(({ id }) => client.discardAiAttachment(id)),
      );
    },
    [client],
  );
  const currentConversation = conversations.data?.find(({ id }) => id === currentConversationId);
  const activeConversationRun = runs.data?.find(
    (item) =>
      item.conversationId === currentConversationId &&
      ['queued', 'running', 'waiting_approval'].includes(item.state),
  );
  async function configure(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const createdCredentialRefs: string[] = [];
    let providerId = '';
    try {
      const credential = await client.createCredential({
        kind: 'aiApiKey',
        label: `${String(form.get('name'))} API Key`,
        secret: String(form.get('apiKey')),
      });
      createdCredentialRefs.push(credential.ref);
      const proxyUrl = String(form.get('proxyUrl') ?? '').trim();
      const proxyUsername = String(form.get('proxyUsername') ?? '').trim();
      const proxyPassword = String(form.get('proxyPassword') ?? '');
      let proxyCredentialRef: string | null = null;
      if (proxyUrl && (proxyUsername || proxyPassword)) {
        if (!proxyUsername || !proxyPassword) throw new Error(x('ai.providerProxyPairRequired'));
        const proxyCredential = await client.createCredential({
          kind: 'proxyPassword',
          label: `${String(form.get('name'))} AI Proxy`,
          secret: proxyPassword,
        });
        proxyCredentialRef = proxyCredential.ref;
        createdCredentialRefs.push(proxyCredential.ref);
      }
      const provider = await client.createAiProvider({
        name: String(form.get('name')),
        baseUrl: String(form.get('baseUrl')),
        protocol: providerProtocol,
        apiPath: String(form.get('apiPath')),
        auth: String(form.get('auth')) as 'bearer' | 'x-api-key',
        role: String(form.get('role')),
        timeoutMs: Number(form.get('timeoutMs')),
        proxy: proxyUrl
          ? {
              url: proxyUrl,
              username: proxyUsername || null,
              credentialRef: proxyCredentialRef,
            }
          : null,
        credentialRef: credential.ref,
        enabled: true,
      });
      providerId = provider.id;
      await client.createAiModel({
        providerId: provider.id,
        name: String(form.get('model')),
        model: String(form.get('model')),
        capabilities: ['chat', 'tools'],
      });
      setSetup(false);
      setProviderStatus((current) => ({
        ...current,
        [provider.id]: x('ai.providerSaved'),
      }));
      await Promise.all([providers.refetch(), models.refetch()]);
    } catch (cause) {
      let releaseCredentials = !providerId;
      if (providerId) {
        const createdProvider = (await providers.refetch()).data?.find(
          ({ id }) => id === providerId,
        );
        if (createdProvider) {
          try {
            await client.deleteAiProvider(createdProvider);
            releaseCredentials = true;
          } catch {
            releaseCredentials = false;
          }
        } else releaseCredentials = true;
      }
      if (releaseCredentials)
        await Promise.allSettled(createdCredentialRefs.map((ref) => client.deleteCredential(ref)));
      setError(messageOf(cause));
    }
  }
  async function testProvider(providerId: string) {
    setProviderStatus((current) => ({ ...current, [providerId]: x('ai.providerTesting') }));
    try {
      const result = await client.testAiProvider(providerId);
      setProviderStatus((current) => ({
        ...current,
        [providerId]: x('ai.providerTestPassed', {
          latency: result.latencyMs,
          models: result.models.length,
        }),
      }));
    } catch (cause) {
      setProviderStatus((current) => ({
        ...current,
        [providerId]: x('ai.providerTestFailed', { message: messageOf(cause) }),
      }));
    }
  }
  async function toggleProvider(providerId: string) {
    const provider = providers.data?.find(({ id }) => id === providerId);
    if (!provider) return;
    try {
      await client.updateAiProvider(provider, { enabled: !provider.enabled });
      await providers.refetch();
    } catch (cause) {
      setError(messageOf(cause));
    }
  }
  async function run(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    try {
      const prompt = String(form.get('prompt')).trim();
      if (!prompt && !attachmentsRef.current.length) return;
      const modelId = String(form.get('modelId'));
      const useCase = String(form.get('useCase')) as
        'explainCommand' | 'explainOutput' | 'generateCommand' | 'diagnose';
      let conversationId = currentConversationId ?? null;
      if (!conversationId) {
        const created = await client.createAiConversation({
          name:
            prompt.replace(/\s+/gu, ' ').slice(0, 120) ||
            x('ai.attachmentConversation', { name: attachmentsRef.current[0]!.name }),
          modelId,
          useCase,
        });
        conversationId = created.id;
        setCurrentConversationId(created.id);
      }
      await client.startAi({
        modelId,
        conversationId,
        useCase,
        prompt,
        context: '',
        attachmentIds: attachmentsRef.current.map(({ id }) => id),
        ...(activeTerminalId ? { terminalId: activeTerminalId } : {}),
      });
      await Promise.all([runs.refetch(), conversations.refetch()]);
      if (currentConversationId) await conversation.refetch();
      attachmentsRef.current = [];
      setAttachments([]);
      setPreviewAttachmentId(undefined);
      setPromptDraft('');
      formElement.reset();
    } catch (cause) {
      setError(messageOf(cause));
    }
  }
  async function acceptPreparedAttachment(preview: AiAttachmentPreview) {
    const current = attachmentsRef.current;
    if (current.some(({ name, size }) => name === preview.name && size === preview.size)) {
      await client.discardAiAttachment(preview.id).catch(() => undefined);
      setError(x('ai.attachmentDuplicate', { name: preview.name }));
      return;
    }
    if (
      current.length >= 8 ||
      current.reduce((sum, item) => sum + item.size, 0) + preview.size > 100 * 1024
    ) {
      await client.discardAiAttachment(preview.id).catch(() => undefined);
      setError(x('ai.attachmentTotalTooLarge'));
      return;
    }
    const next = [...current, preview];
    attachmentsRef.current = next;
    setAttachments(next);
    setPreviewAttachmentId(preview.id);
  }
  async function prepareGrant(grantId: string, signal?: AbortSignal) {
    try {
      await acceptPreparedAttachment(await client.prepareAiAttachment(grantId, signal));
    } finally {
      await client.revokeFileGrant(grantId).catch(() => undefined);
    }
  }
  async function chooseAttachment() {
    if (attachmentBusy) return;
    setAttachmentBusy(true);
    setError('');
    try {
      const grant = await client.createFileGrant('open-file');
      if (grant) await prepareGrant(grant.grantId);
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setAttachmentBusy(false);
    }
  }
  async function importDroppedAttachments(files: FileList) {
    if (attachmentBusy || !files.length) return;
    const controller = new AbortController();
    attachmentControllerRef.current = controller;
    setAttachmentBusy(true);
    setError('');
    try {
      for (const file of Array.from(files).slice(0, 8)) {
        if (controller.signal.aborted) break;
        let grant: FileGrant | undefined;
        try {
          grant = await client.importDroppedFile(file, controller.signal);
          await prepareGrant(grant.grantId, controller.signal);
          grant = undefined;
        } catch (cause) {
          if (!controller.signal.aborted) setError(messageOf(cause));
        } finally {
          if (grant) await client.revokeFileGrant(grant.grantId).catch(() => undefined);
        }
      }
    } finally {
      if (attachmentControllerRef.current === controller)
        attachmentControllerRef.current = undefined;
      setAttachmentBusy(false);
      setAttachmentDragOver(false);
    }
  }
  async function removeAttachment(id: string) {
    const next = attachmentsRef.current.filter((item) => item.id !== id);
    attachmentsRef.current = next;
    setAttachments(next);
    if (previewAttachmentId === id) setPreviewAttachmentId(next.at(-1)?.id);
    await client.discardAiAttachment(id).catch(() => undefined);
  }
  async function removeConversation(id: string) {
    try {
      const latest = (await conversations.refetch()).data?.find((item) => item.id === id);
      if (!latest) return;
      await client.deleteAiConversation(latest);
      setDeleteConversationId(null);
      if (currentConversationId === id) setCurrentConversationId(null);
      await Promise.all([conversations.refetch(), runs.refetch()]);
    } catch (cause) {
      setError(messageOf(cause));
    }
  }
  async function copyGeneratedCode(runId: string, value: string) {
    const code = aiGeneratedCode(value);
    if (!code) {
      setChatActionStatus((current) => ({ ...current, [runId]: x('ai.codeTooLarge') }));
      return;
    }
    try {
      await navigator.clipboard.writeText(code);
      setChatActionStatus((current) => ({ ...current, [runId]: x('ai.codeCopied') }));
    } catch {
      setChatActionStatus((current) => ({ ...current, [runId]: x('ai.codeCopyFailed') }));
    }
  }
  function insertGeneratedCode(runId: string, value: string) {
    const code = aiTerminalInsertion(value);
    if (!code || !activeTerminalId) {
      setChatActionStatus((current) => ({
        ...current,
        [runId]: code ? x('ai.noActiveTerminal') : x('ai.codeTooLarge'),
      }));
      return;
    }
    insertTerminal(activeTerminalId, code);
    setChatActionStatus((current) => ({ ...current, [runId]: x('ai.codeInserted') }));
  }
  async function proposeCommand(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!activeTerminalId || !models.data?.[0]) return;
    const form = new FormData(event.currentTarget);
    try {
      await client.startAi({
        modelId: models.data[0].id,
        useCase: 'diagnose',
        prompt: x('panels.executeApprovedCommandPrompt'),
        context: '',
        tool: {
          name: 'terminal.exec',
          args: { command: String(form.get('command')) },
          target: activeTerminalId,
        },
      });
      await Promise.all([runs.refetch(), approvals.refetch()]);
    } catch (cause) {
      setError(messageOf(cause));
    }
  }
  async function inspectRecentOutput() {
    if (!activeTerminalId || !models.data?.[0]) return;
    try {
      await client.startAi({
        modelId: models.data[0].id,
        useCase: 'diagnose',
        prompt: x('ai.inspectRecentOutputPrompt'),
        context: '',
        tool: {
          name: 'terminal.getRecentOutput',
          args: {},
          target: activeTerminalId,
        },
      });
      await Promise.all([runs.refetch(), toolCalls.refetch()]);
    } catch (cause) {
      setError(messageOf(cause));
    }
  }
  return (
    <PanelFrame
      eyebrow={x('panels.aiInspector')}
      title={x('panels.aiAssistant')}
      description={x('panels.aiDescription')}
      action={
        <button onClick={() => setSetup(!setup)}>
          <KeyRound size={13} /> {x('panels.provider')}
        </button>
      }
    >
      {error && <ErrorBanner text={error} />}
      {setup && (
        <div
          className="ai-provider-modal"
          role="dialog"
          aria-modal="true"
          aria-label={x('ai.configTitle')}
        >
          <form
            className="setup-form surface ai-provider-form"
            onSubmit={(event) => void configure(event)}
          >
            <header className="ai-provider-modal-header">
              <strong>{x('ai.configTitle')}</strong>
              <button type="button" aria-label={x('panels.cancel')} onClick={() => setSetup(false)}>
                <X size={15} />
              </button>
            </header>
            <label>
              {x('panels.name')}
              <input name="name" defaultValue="OpenAI Compatible" required />
            </label>
            <label>
              {x('ai.providerProtocol')}
              <select
                name="protocol"
                value={providerProtocol}
                onChange={(event) =>
                  setProviderProtocol(event.currentTarget.value as AiProviderProtocol)
                }
              >
                <option value="openai-chat">{x('ai.protocolOpenAiChat')}</option>
                <option value="openai-responses">{x('ai.protocolOpenAiResponses')}</option>
                <option value="anthropic">{x('ai.protocolAnthropic')}</option>
              </select>
            </label>
            <label>
              {x('panels.baseUrl')}
              <input name="baseUrl" defaultValue="https://api.openai.com/v1/" required />
            </label>
            <label>
              {x('ai.apiPath')}
              <input
                name="apiPath"
                key={providerProtocol}
                defaultValue={
                  providerProtocol === 'anthropic'
                    ? '/messages'
                    : providerProtocol === 'openai-responses'
                      ? '/responses'
                      : '/chat/completions'
                }
                required
              />
            </label>
            <label>
              {x('panels.model')}
              <input name="model" placeholder="gpt-4.1-mini" required />
            </label>
            <label>
              {x('ai.authMethod')}
              <select
                name="auth"
                key={`${providerProtocol}-auth`}
                defaultValue={providerProtocol === 'anthropic' ? 'x-api-key' : 'bearer'}
              >
                <option value="bearer">{x('ai.authBearer')}</option>
                <option value="x-api-key">{x('ai.authApiKey')}</option>
              </select>
            </label>
            <label>
              {x('panels.apiKey')}
              <input name="apiKey" type="password" autoComplete="off" required />
            </label>
            <label>
              {x('ai.timeout')}
              <input
                name="timeoutMs"
                type="number"
                min="1000"
                max="300000"
                defaultValue="60000"
                required
              />
            </label>
            <label className="full-field">
              {x('ai.systemRole')}
              <textarea name="role" defaultValue={DEFAULT_AI_ROLE} rows={3} required />
            </label>
            <label className="full-field">
              {x('ai.proxyUrl')}
              <input name="proxyUrl" placeholder="socks5://127.0.0.1:1080" />
            </label>
            <label>
              {x('ai.proxyUsername')}
              <input name="proxyUsername" autoComplete="off" />
            </label>
            <label>
              {x('ai.proxyPassword')}
              <input name="proxyPassword" type="password" autoComplete="off" />
            </label>
            <button className="primary">
              <Save size={13} /> {x('panels.saveConfiguration')}
            </button>
          </form>
        </div>
      )}
      {!!providers.data?.length && (
        <section className="ai-provider-grid" aria-label={x('ai.savedProviders')}>
          {providers.data.map((provider) => (
            <article className="surface ai-provider-card" key={provider.id}>
              <div>
                <strong>{provider.name}</strong>
                <span>{provider.protocol}</span>
                <small>
                  {provider.baseUrl} · {provider.apiPath}
                </small>
              </div>
              <span className={`run-state ${provider.enabled ? 'succeeded' : 'canceled'}`}>
                {provider.enabled ? x('ai.enabled') : x('ai.disabled')}
              </span>
              <button
                type="button"
                onClick={() => void testProvider(provider.id)}
                disabled={!provider.enabled}
              >
                <RefreshCw size={13} /> {x('ai.testConnection')}
              </button>
              <button type="button" onClick={() => void toggleProvider(provider.id)}>
                {provider.enabled ? x('ai.disable') : x('ai.enable')}
              </button>
              {providerStatus[provider.id] && <p role="status">{providerStatus[provider.id]}</p>}
            </article>
          ))}
        </section>
      )}
      <section
        className={`ai-chat-workspace${showConversationHistory ? '' : ' history-hidden'}`}
        aria-label={x('ai.chatWorkspace')}
      >
        {showConversationHistory && (
          <aside className="surface ai-chat-sessions">
            <div className="ai-chat-sessions-toolbar">
              <strong>{x('ai.chatHistory')}</strong>
              <button
                type="button"
                className="primary"
                onClick={() => {
                  setCurrentConversationId(null);
                  setShowConversationHistory(false);
                }}
              >
                <Plus size={13} /> {x('ai.newChat')}
              </button>
            </div>
            <div className="ai-chat-session-list">
              {!conversations.data?.length && (
                <div className="ai-chat-empty compact">
                  <Bot size={22} />
                  <span>{x('ai.noChatHistory')}</span>
                </div>
              )}
              {conversations.data?.map((item) => (
                <article
                  key={item.id}
                  className={`ai-chat-session${item.id === currentConversationId ? ' active' : ''}`}
                >
                  <button
                    type="button"
                    className="ai-chat-session-select"
                    onClick={() => setCurrentConversationId(item.id)}
                  >
                    <strong>{item.name}</strong>
                    <span>
                      {x('ai.messageCount', { count: item.messageCount })} ·{' '}
                      {new Date(item.lastMessageAt ?? item.updatedAt).toLocaleString(language)}
                    </span>
                  </button>
                  <button
                    type="button"
                    className="danger-icon"
                    aria-label={x('ai.deleteChatNamed', { name: item.name })}
                    onClick={() => setDeleteConversationId(item.id)}
                  >
                    <Trash2 size={13} />
                  </button>
                </article>
              ))}
            </div>
          </aside>
        )}
        <div className="surface ai-chat-main">
          <header className="ai-chat-header">
            <div>
              <strong>{currentConversation?.name ?? x('ai.newChat')}</strong>
              <span>
                {currentConversation
                  ? (models.data?.find(({ id }) => id === currentConversation.modelId)?.name ??
                    x('ai.savedModel'))
                  : x('ai.newChatHint')}
              </span>
            </div>
            <button
              type="button"
              aria-pressed={showConversationHistory}
              onClick={() => setShowConversationHistory((shown) => !shown)}
            >
              <History size={13} /> {x('ai.history')}
            </button>
          </header>
          {deleteConversationId && (
            <div className="ai-chat-delete-confirm" role="alertdialog" aria-modal="true">
              <span>{x('ai.deleteChatConfirm')}</span>
              <button type="button" onClick={() => setDeleteConversationId(null)}>
                {x('panels.cancel')}
              </button>
              <button
                type="button"
                className="danger"
                onClick={() => void removeConversation(deleteConversationId)}
              >
                {x('ai.deleteChat')}
              </button>
            </div>
          )}
          <div className="ai-chat-messages" aria-live="polite">
            {!conversation.data?.messages.length && !activeConversationRun && (
              <div className="ai-chat-empty">
                <span className="ai-chat-empty-mark">
                  <WandSparkles size={22} />
                </span>
                <strong>{x('ai.emptyConversation')}</strong>
                <p>{x('ai.emptyConversationHint')}</p>
              </div>
            )}
            {conversation.data?.messages.map((message) => {
              const messageRun = runs.data?.find(({ id }) => id === message.runId);
              return (
                <article className={`ai-chat-message ${message.role}`} key={message.id}>
                  <div className="ai-chat-message-meta">
                    <strong>
                      {message.role === 'user' ? x('ai.you') : x('panels.aiAssistant')}
                    </strong>
                    <span>{new Date(message.createdAt).toLocaleString(language)}</span>
                  </div>
                  {!!message.attachments.length && (
                    <div className="ai-message-attachments" aria-label={x('ai.sentAttachments')}>
                      {message.attachments.map((attachment) => (
                        <span key={`${attachment.name}-${attachment.size}`}>
                          <Paperclip size={10} />
                          {attachment.name}
                          <small>{formatBytes(attachment.size)}</small>
                          {attachment.truncated && <em>{x('ai.truncated')}</em>}
                        </span>
                      ))}
                    </div>
                  )}
                  {(message.content || !message.attachments.length) && (
                    <p>{message.content || x('ai.emptyResponse')}</p>
                  )}
                  {message.errorCode && <small>{message.errorCode}</small>}
                  {message.role === 'assistant' &&
                    messageRun?.useCase === 'generateCommand' &&
                    message.content && (
                      <div className="ai-chat-code-actions">
                        <button
                          type="button"
                          onClick={() => void copyGeneratedCode(message.runId, message.content)}
                        >
                          <Copy size={12} /> {x('ai.copyCode')}
                        </button>
                        <button
                          type="button"
                          disabled={!activeTerminalId || !aiTerminalInsertion(message.content)}
                          onClick={() => insertGeneratedCode(message.runId, message.content)}
                        >
                          <TerminalIcon size={12} /> {x('panels.insertIntoTerminal')}
                        </button>
                        {chatActionStatus[message.runId] && (
                          <span role="status">{chatActionStatus[message.runId]}</span>
                        )}
                      </div>
                    )}
                </article>
              );
            })}
            {activeConversationRun && (
              <article className="ai-chat-message assistant pending">
                <div className="ai-chat-message-meta">
                  <strong>{x('panels.aiAssistant')}</strong>
                  <span className={`run-state ${activeConversationRun.state}`}>
                    {activeConversationRun.state === 'waiting_approval'
                      ? x('ai.waitingApproval')
                      : x('ai.thinking')}
                  </span>
                </div>
                <p>{x('ai.generatingResponse')}</p>
                <button
                  type="button"
                  onClick={() =>
                    void client.cancelAi(activeConversationRun.id).then(async () => {
                      await Promise.all([
                        runs.refetch(),
                        conversations.refetch(),
                        conversation.refetch(),
                      ]);
                    })
                  }
                >
                  <Square size={11} /> {x('panels.cancel')}
                </button>
              </article>
            )}
          </div>
          <form
            className={`ai-chat-composer${attachmentDragOver ? ' attachment-dragover' : ''}`}
            key={currentConversationId ?? 'new'}
            onSubmit={(event) => void run(event)}
            onDragEnter={(event) => {
              if (!event.dataTransfer.types.includes('Files')) return;
              event.preventDefault();
              setAttachmentDragOver(true);
            }}
            onDragOver={(event) => {
              if (!event.dataTransfer.types.includes('Files')) return;
              event.preventDefault();
              event.dataTransfer.dropEffect = 'copy';
            }}
            onDragLeave={(event) => {
              if (!event.currentTarget.contains(event.relatedTarget as Node | null))
                setAttachmentDragOver(false);
            }}
            onDrop={(event) => {
              event.preventDefault();
              void importDroppedAttachments(event.dataTransfer.files);
            }}
          >
            <div className="ai-chat-options">
              <label>
                <span>{x('panels.model')}</span>
                <select
                  name="modelId"
                  defaultValue={currentConversation?.modelId ?? models.data?.[0]?.id}
                  required
                >
                  {models.data?.map((model) => (
                    <option key={model.id} value={model.id}>
                      {model.name}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                <span>{x('panels.task')}</span>
                <select name="useCase" defaultValue={currentConversation?.useCase ?? 'diagnose'}>
                  <option value="explainCommand">{x('panels.explainCommand')}</option>
                  <option value="explainOutput">{x('panels.explainOutput')}</option>
                  <option value="generateCommand">{x('ai.generateCommandOrScript')}</option>
                  <option value="diagnose">{x('panels.diagnose')}</option>
                </select>
              </label>
              <button
                type="button"
                className="ai-attachment-button"
                onClick={() => void chooseAttachment()}
                disabled={attachmentBusy || attachments.length >= 8}
              >
                {attachmentBusy ? (
                  <LoaderCircle className="spin" size={12} />
                ) : (
                  <Paperclip size={12} />
                )}
                {x('ai.attachTextFile')}
              </button>
              {attachmentBusy && (
                <button
                  type="button"
                  className="ai-attachment-cancel"
                  onClick={() => attachmentControllerRef.current?.abort()}
                >
                  <Square size={10} /> {x('panels.cancel')}
                </button>
              )}
            </div>
            {!!attachments.length && (
              <div className="ai-attachment-drafts" aria-label={x('ai.pendingAttachments')}>
                {attachments.map((attachment) => (
                  <span
                    key={attachment.id}
                    className={previewAttachmentId === attachment.id ? 'active' : ''}
                  >
                    <button type="button" onClick={() => setPreviewAttachmentId(attachment.id)}>
                      <Paperclip size={10} />
                      <strong>{attachment.name}</strong>
                      <small>{formatBytes(attachment.size)}</small>
                      {attachment.truncated && <em>{x('ai.truncated')}</em>}
                      {attachment.redacted && <em>{x('ai.redacted')}</em>}
                    </button>
                    <button
                      type="button"
                      aria-label={x('ai.removeAttachmentNamed', { name: attachment.name })}
                      onClick={() => void removeAttachment(attachment.id)}
                    >
                      <X size={10} />
                    </button>
                  </span>
                ))}
              </div>
            )}
            {previewAttachmentId && (
              <div className="ai-attachment-preview">
                <header>
                  <strong>{x('ai.attachmentPreview')}</strong>
                  <span>{x('ai.attachmentPreviewHint')}</span>
                </header>
                <pre>{attachments.find(({ id }) => id === previewAttachmentId)?.preview ?? ''}</pre>
              </div>
            )}
            <label className="ai-chat-prompt">
              <span className="sr-only">{x('panels.question')}</span>
              <textarea
                name="prompt"
                rows={3}
                value={promptDraft}
                onChange={(event) => setPromptDraft(event.currentTarget.value)}
                placeholder={x('ai.promptPlaceholder')}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && !event.shiftKey) {
                    event.preventDefault();
                    event.currentTarget.form?.requestSubmit();
                  }
                }}
              />
              <button
                type="submit"
                className="primary ai-chat-send"
                disabled={
                  !models.data?.length ||
                  !!activeConversationRun ||
                  (!promptDraft.trim() && !attachments.length)
                }
                aria-label={x('ai.send')}
              >
                <Send size={15} />
              </button>
            </label>
            <small>{attachmentDragOver ? x('ai.dropAttachmentHere') : x('ai.sendHint')}</small>
          </form>
        </div>
      </section>
      {activeTerminalId && models.data?.length ? (
        <form
          className="approval-proposal surface"
          onSubmit={(event) => void proposeCommand(event)}
        >
          <ShieldAlert size={16} />
          <div>
            <strong>{x('panels.terminalOperationApproval')}</strong>
            <input name="command" placeholder={x('panels.commandForReview')} required />
          </div>
          <button type="button" onClick={() => void inspectRecentOutput()}>
            <Search size={13} /> {x('ai.inspectRecentOutput')}
          </button>
          <button>{x('panels.submitForApproval')}</button>
        </form>
      ) : null}
      <AgentToolCards
        approvals={approvals.data ?? []}
        toolCalls={toolCalls.data ?? []}
        decide={async (approval, decision) => {
          try {
            await client.decideApproval(approval.id, decision, approval.argsHash);
            await Promise.all([approvals.refetch(), runs.refetch(), toolCalls.refetch()]);
          } catch (cause) {
            setError(messageOf(cause));
            await Promise.all([approvals.refetch(), runs.refetch(), toolCalls.refetch()]);
          }
        }}
        cancel={async (runId) => {
          try {
            await client.cancelAi(runId);
            await Promise.all([approvals.refetch(), runs.refetch(), toolCalls.refetch()]);
          } catch (cause) {
            setError(messageOf(cause));
          }
        }}
      />
    </PanelFrame>
  );
}

function AgentToolCards({
  approvals,
  toolCalls,
  decide,
  cancel,
}: {
  approvals: AiApproval[];
  toolCalls: AiToolCall[];
  decide(approval: AiApproval, decision: 'approve_once' | 'reject'): Promise<unknown>;
  cancel(runId: string): Promise<unknown>;
}) {
  const { x } = useI18n();
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  async function runAction(callId: string, action: () => Promise<unknown>) {
    if (busy[callId]) return;
    setExpanded((current) => ({ ...current, [callId]: true }));
    setBusy((current) => ({ ...current, [callId]: true }));
    try {
      await action();
    } finally {
      setBusy((current) => {
        const next = { ...current };
        delete next[callId];
        return next;
      });
    }
  }
  if (!toolCalls.length) return null;
  return (
    <section className="agent-tool-list" aria-label={x('ai.agentActivity')}>
      <header>
        <div>
          <Bot size={16} />
          <span>
            <strong>{x('ai.agentActivity')}</strong>
            <small>{x('ai.agentActivityHint')}</small>
          </span>
        </div>
        <span>{x('ai.toolCount', { count: toolCalls.length })}</span>
      </header>
      {[...toolCalls].reverse().map((call) => {
        const approval = approvals.find((item) => item.toolCallId === call.id);
        const isExpanded =
          expanded[call.id] ?? ['running', 'waiting_approval'].includes(call.state);
        const active = ['proposed', 'running'].includes(call.state);
        return (
          <article
            aria-busy={busy[call.id] || undefined}
            className={`agent-tool-card state-${call.state}`}
            key={call.id}
          >
            <button
              aria-expanded={isExpanded}
              className="agent-tool-card-header"
              type="button"
              onClick={() => setExpanded((current) => ({ ...current, [call.id]: !isExpanded }))}
            >
              {isExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
              <TerminalIcon size={15} />
              <span>
                <strong>{call.toolName}</strong>
                <small>{call.target}</small>
              </span>
              <em className={`risk-${call.risk}`}>{toolRiskLabel(call.risk, x)}</em>
              <i className={`run-state ${call.state}`}>
                {['proposed', 'running'].includes(call.state) && (
                  <LoaderCircle className="spin" size={11} />
                )}
                {call.state === 'succeeded' && <Check size={11} />}
                {['failed', 'canceled'].includes(call.state) && <X size={11} />}
                {toolStateLabel(call.state, x)}
              </i>
            </button>
            {isExpanded && (
              <div className="agent-tool-card-detail">
                <section>
                  <strong>{x('ai.arguments')}</strong>
                  <pre>{JSON.stringify(call.args, null, 2)}</pre>
                </section>
                <dl>
                  <div>
                    <dt>{x('ai.target')}</dt>
                    <dd>{call.target}</dd>
                  </div>
                  <div>
                    <dt>{x('ai.argumentsHash')}</dt>
                    <dd>{call.argsHash}</dd>
                  </div>
                  {approval && (
                    <div>
                      <dt>{x('ai.approval')}</dt>
                      <dd>{approvalStateLabel(approval.state, x)}</dd>
                    </div>
                  )}
                </dl>
                {call.resultMetadata && (
                  <section>
                    <strong>{x('ai.result')}</strong>
                    <pre>{formatToolResult(call.resultMetadata)}</pre>
                  </section>
                )}
                {call.state === 'failed' && !call.resultMetadata && (
                  <p className="agent-tool-error">{x('ai.toolFailed')}</p>
                )}
                {approval?.state === 'pending' && (
                  <div className="agent-tool-approval">
                    <span>
                      <ShieldAlert size={14} />
                      {x('panels.expiresAt', {
                        time: new Date(approval.expiresAt).toLocaleTimeString(),
                      })}
                    </span>
                    <button
                      type="button"
                      disabled={busy[call.id]}
                      onClick={() => void runAction(call.id, () => decide(approval, 'reject'))}
                    >
                      {x('panels.reject')}
                    </button>
                    <button
                      className="danger"
                      type="button"
                      disabled={busy[call.id]}
                      onClick={() =>
                        void runAction(call.id, () => decide(approval, 'approve_once'))
                      }
                    >
                      {x('panels.runOnce')}
                    </button>
                  </div>
                )}
                {active && (
                  <div className="agent-tool-approval">
                    <span>{x('ai.cancelHint')}</span>
                    <button
                      type="button"
                      disabled={busy[call.id]}
                      onClick={() => void runAction(call.id, () => cancel(call.runId))}
                    >
                      <Square size={11} /> {x('panels.cancel')}
                    </button>
                  </div>
                )}
              </div>
            )}
          </article>
        );
      })}
    </section>
  );
}

function formatToolResult(value: Record<string, unknown>): string {
  const output = typeof value.output === 'string' ? value.output : undefined;
  return (output ?? JSON.stringify(value, null, 2)).slice(0, 65_536);
}

function toolStateLabel(state: AiToolCall['state'], x: Translator) {
  const labels: Record<AiToolCall['state'], AxtermMessageKey> = {
    proposed: 'ai.toolProposed',
    waiting_approval: 'ai.toolWaitingApproval',
    running: 'ai.toolRunning',
    succeeded: 'ai.toolSucceeded',
    failed: 'ai.toolFailedState',
    canceled: 'ai.toolCanceled',
  };
  return x(labels[state]);
}

function toolRiskLabel(risk: AiToolCall['risk'], x: Translator) {
  const labels: Record<AiToolCall['risk'], AxtermMessageKey> = {
    read_only: 'ai.riskReadOnly',
    mutating: 'ai.riskMutating',
    destructive: 'ai.riskDestructive',
    privileged: 'ai.riskPrivileged',
  };
  return x(labels[risk]);
}

function approvalStateLabel(state: AiApproval['state'], x: Translator) {
  const labels: Record<AiApproval['state'], AxtermMessageKey> = {
    pending: 'ai.approvalPending',
    approved: 'ai.approvalApproved',
    rejected: 'ai.approvalRejected',
    expired: 'ai.approvalExpired',
  };
  return x(labels[state]);
}

export function RuntimePanel({
  client,
  initialTab = 'setting',
  initialItem = 'terminal',
}: {
  client: Client;
  initialTab?: 'setting' | 'themes' | 'profiles' | 'widgets';
  initialItem?: SettingsCategoryId;
}) {
  const { language, t, x } = useI18n();
  const [settingsTab, setSettingsTab] = useState<'setting' | 'themes' | 'profiles' | 'widgets'>(
    initialTab,
  );
  const [settingsItem, setSettingsItem] = useState<SettingsCategoryId>(initialItem);
  const [settingsSearch, setSettingsSearch] = useState('');
  const settingsCategorySidebar = useRef<HTMLElement>(null);
  const visibleSettingsCategories = filterSettingsCategories(
    settingsSearch,
    ({ label, translationKey }) => t(translationKey, label),
  );
  const showSection = useWorkspace((state) => state.showSection);
  const diagnostics = useQuery({
    queryKey: ['diagnostics'],
    queryFn: client.diagnostics,
    refetchInterval: 3000,
  });
  const updater = useQuery({
    queryKey: ['desktop-updater'],
    queryFn: client.updaterStatus,
    refetchInterval: (query) =>
      ['checking', 'downloading'].includes(query.state.data?.state ?? '') ? 250 : 3000,
  });
  const settings = useQuery({ queryKey: ['settings'], queryFn: client.settings });
  const profiles = useQuery({ queryKey: ['terminal-profiles'], queryFn: client.terminalProfiles });
  const credentials = useQuery({
    queryKey: ['credentials'],
    queryFn: client.credentials,
    enabled: settingsItem === 'password',
  });
  const [message, setMessage] = useState('');
  const [updaterAction, setUpdaterAction] = useState<string>();
  const [editingProfile, setEditingProfile] = useState<TerminalProfile>();
  async function exportDiagnostics() {
    try {
      const grant = await client.createFileGrant('save-file');
      if (!grant) return;
      const result = await client.exportDiagnostics(grant.grantId);
      setMessage(x('settings.diagnosticsExported', { bytes: formatBytes(result.bytes) }));
    } catch (cause) {
      setMessage(messageOf(cause));
    }
  }
  async function performUpdaterAction(action: 'check' | 'download' | 'cancel' | 'install') {
    if (action !== 'cancel' && updaterAction) return;
    if (action !== 'cancel') setUpdaterAction(action);
    try {
      const operation = client.performUpdaterAction(action);
      if (action === 'check' || action === 'download') {
        await new Promise((resolve) => window.setTimeout(resolve, 25));
        await updater.refetch();
      }
      await operation;
      await Promise.all([updater.refetch(), diagnostics.refetch()]);
    } catch (cause) {
      setMessage(messageOf(cause));
    } finally {
      if (action !== 'cancel') setUpdaterAction(undefined);
    }
  }
  async function setHideAddresses(hideAddresses: boolean) {
    if (!settings.data) return;
    setMessage('');
    try {
      const updated = await client.updateSettings(settings.data, {
        privacy: { hideAddresses },
      });
      await settings.refetch();
      setMessage(
        updated.privacy.hideAddresses
          ? x('settings.addressesHidden')
          : x('settings.addressesVisible'),
      );
    } catch (cause) {
      setMessage(messageOf(cause));
      await settings.refetch();
    }
  }
  async function saveProfile(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    try {
      const input = terminalProfileInput(form, x);
      if (editingProfile) await client.updateTerminalProfile(editingProfile, input);
      else await client.createTerminalProfile(input);
      formElement.reset();
      setEditingProfile(undefined);
      setMessage(editingProfile ? x('terminalProfile.updated') : x('terminalProfile.saved'));
      await profiles.refetch();
    } catch (cause) {
      setMessage(messageOf(cause));
    }
  }
  return (
    <div className={`settings-workspace settings-tab-${settingsTab}`}>
      <button
        className="settings-workspace-close left"
        aria-label={x('settings.close')}
        type="button"
        onClick={() => showSection('hosts')}
      >
        ×
      </button>
      <button
        className="settings-workspace-close right"
        aria-label={x('settings.closeToWorkspace')}
        type="button"
        onClick={() => showSection('hosts')}
      >
        ×
      </button>
      <nav className="settings-workspace-tabs" aria-label={x('settings.categories')}>
        <button type="button" onClick={() => showSection('hosts')}>
          {t('bookmarks', 'Bookmarks')}
        </button>
        <button
          aria-selected={settingsTab === 'setting'}
          className={settingsTab === 'setting' ? 'active' : ''}
          role="tab"
          type="button"
          onClick={() => setSettingsTab('setting')}
        >
          {t('setting', 'Setting')}
        </button>
        <button
          aria-selected={settingsTab === 'themes'}
          className={settingsTab === 'themes' ? 'active' : ''}
          role="tab"
          type="button"
          onClick={() => setSettingsTab('themes')}
        >
          {t('uiThemes', 'UI Themes')}
        </button>
        <button type="button" onClick={() => showSection('commands')}>
          {t('quickCommands', 'Quick commands')}
        </button>
        <button type="button" onClick={() => showSection('commands')}>
          {x('settings.triggers')} <sup>{x('settings.beta')}</sup>
        </button>
        <button
          aria-selected={settingsTab === 'profiles'}
          className={settingsTab === 'profiles' ? 'active' : ''}
          role="tab"
          type="button"
          onClick={() => setSettingsTab('profiles')}
        >
          {t('profiles', 'Profiles')}
        </button>
        <button
          aria-selected={settingsTab === 'widgets'}
          className={settingsTab === 'widgets' ? 'active' : ''}
          role="tab"
          type="button"
          onClick={() => setSettingsTab('widgets')}
        >
          {x('settings.widgets')} <sup>{x('settings.beta')}</sup>
        </button>
      </nav>
      {settingsTab === 'themes' ? (
        <TerminalThemeWorkspace client={client} />
      ) : settingsTab === 'widgets' ? (
        <WidgetWorkspace client={client} />
      ) : settingsTab === 'profiles' ? (
        <div className="panel-page connection-profile-page">
          <ConnectionProfilesPanel
            client={client}
            onOpenDataMigration={() => {
              setSettingsTab('setting');
              requestAnimationFrame(() =>
                document.querySelector('.electerm-data-panel')?.scrollIntoView(),
              );
            }}
          />
        </div>
      ) : (
        <div className={`settings-category-layout settings-item-${settingsItem}`}>
          <aside
            className="settings-category-sidebar"
            aria-label={x('settings.items')}
            ref={settingsCategorySidebar}
            onKeyDown={(event) => {
              if (event.target instanceof HTMLInputElement) return;
              if (!['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
              const next = moveSettingsCategory(
                visibleSettingsCategories,
                settingsItem,
                event.key as 'ArrowUp' | 'ArrowDown' | 'Home' | 'End',
              );
              if (!next) return;
              event.preventDefault();
              setSettingsItem(next);
              window.requestAnimationFrame(() =>
                settingsCategorySidebar.current
                  ?.querySelector<HTMLButtonElement>(`button[data-settings-category="${next}"]`)
                  ?.focus(),
              );
            }}
          >
            <label className="settings-category-search">
              <span className="sr-only">{x('settings.search')}</span>
              <input
                aria-label={x('settings.search')}
                value={settingsSearch}
                onChange={(event) => setSettingsSearch(event.target.value)}
              />
              <Search size={15} aria-hidden="true" />
            </label>
            {visibleSettingsCategories.map(({ id, label, translationKey }) => (
              <button
                aria-current={settingsItem === id ? 'page' : undefined}
                className={settingsItem === id ? 'active' : ''}
                data-settings-category={id}
                key={id}
                onClick={() => setSettingsItem(id)}
                type="button"
              >
                {t(translationKey, label)}
              </button>
            ))}
            {!visibleSettingsCategories.length && (
              <p className="settings-category-empty">{x('settings.noMatch')}</p>
            )}
          </aside>
          <PanelFrame
            eyebrow={
              settingsItem === 'common' ? x('settings.diagnosticsEyebrow') : t('setting', 'SETTING')
            }
            title={
              settingsItem === 'common'
                ? x('settings.runtimeTitle')
                : settingsItem === 'terminal'
                  ? x('settings.terminalTitle')
                  : settingsItem === 'shortcuts'
                    ? x('settings.shortcutsTitle')
                    : settingsItem === 'sync'
                      ? x('settings.syncTitle')
                      : settingsItem === 'ai'
                        ? t('aiConfig', 'AI')
                        : x('settings.passwordTitle')
            }
            description={
              settingsItem === 'common'
                ? x('settings.runtimeDescription')
                : settingsItem === 'terminal'
                  ? x('settings.terminalDescription')
                  : settingsItem === 'shortcuts'
                    ? x('settings.shortcutsDescription')
                    : settingsItem === 'ai'
                      ? x('settings.aiDescription')
                      : x('settings.categoryDescription')
            }
            action={
              settingsItem === 'common' ? (
                <button onClick={() => void exportDiagnostics()}>
                  {x('settings.exportDiagnostics')}
                </button>
              ) : undefined
            }
          >
            {settingsItem === 'common' && (
              <>
                <div className="diagnostic-grid">
                  <Metric
                    label={x('settings.database')}
                    value={diagnostics.data?.database ?? '—'}
                  />
                  <Metric
                    label={x('settings.updater')}
                    value={
                      updater.data
                        ? updaterStateLabel(updater.data.state, x)
                        : x('settings.updaterLoading')
                    }
                  />
                  <Metric
                    label={x('settings.uptime')}
                    value={
                      diagnostics.data
                        ? x('settings.uptimeSeconds', {
                            seconds: Math.round(diagnostics.data.uptimeSeconds),
                          })
                        : '—'
                    }
                  />
                  {Object.entries(diagnostics.data?.resources ?? {}).map(([key, value]) => (
                    <Metric key={key} label={key} value={String(value)} />
                  ))}
                </div>
                {updater.data && (
                  <section className="surface updater-panel" aria-label={x('settings.updater')}>
                    <header>
                      <div>
                        <small>{x('settings.updater')}</small>
                        <h3>{updaterStateLabel(updater.data.state, x)}</h3>
                        <p>
                          {updater.data.state === 'disabled'
                            ? x('settings.updaterDisabledHint')
                            : x('settings.updaterConfiguredHint')}
                        </p>
                      </div>
                      <div className="updater-actions">
                        {['idle', 'available', 'ready', 'error'].includes(updater.data.state) && (
                          <button
                            type="button"
                            disabled={Boolean(updaterAction)}
                            onClick={() => void performUpdaterAction('check')}
                          >
                            <RefreshCw size={13} /> {x('settings.updaterCheck')}
                          </button>
                        )}
                        {updater.data.state === 'available' && (
                          <button
                            className="primary"
                            type="button"
                            disabled={Boolean(updaterAction)}
                            onClick={() => void performUpdaterAction('download')}
                          >
                            <Download size={13} /> {x('settings.updaterDownload')}
                          </button>
                        )}
                        {['checking', 'downloading'].includes(updater.data.state) && (
                          <button type="button" onClick={() => void performUpdaterAction('cancel')}>
                            <Square size={11} /> {x('settings.updaterCancel')}
                          </button>
                        )}
                        {updater.data.state === 'ready' && (
                          <button
                            className="primary"
                            type="button"
                            disabled={Boolean(updaterAction)}
                            onClick={() => void performUpdaterAction('install')}
                          >
                            <Upload size={13} /> {x('settings.updaterInstall')}
                          </button>
                        )}
                      </div>
                    </header>
                    {updater.data.availableVersion && (
                      <div className="updater-detail">
                        <span>{x('settings.updaterVersion')}</span>
                        <strong>{updater.data.availableVersion}</strong>
                      </div>
                    )}
                    {updater.data.state === 'downloading' && (
                      <div className="updater-progress">
                        <progress max={100} value={updater.data.progress ?? 0} />
                        <span>
                          {x('settings.updaterProgress', { progress: updater.data.progress ?? 0 })}
                        </span>
                      </div>
                    )}
                    {updater.data.errorCode && (
                      <code className="updater-error">{updater.data.errorCode}</code>
                    )}
                  </section>
                )}
                {message && <p className="hint">{message}</p>}
                <LanguageSettingsPanel client={client} />
                <section
                  className="surface settings-privacy-panel"
                  aria-label={x('settings.privacy')}
                >
                  <header>
                    <div>
                      <small>{x('settings.privacy').toLocaleUpperCase()}</small>
                      <h3>{x('settings.addressDisplay')}</h3>
                    </div>
                    <label className="check">
                      <input
                        type="checkbox"
                        checked={settings.data?.privacy.hideAddresses ?? false}
                        disabled={!settings.data || settings.isFetching}
                        onChange={(event) => void setHideAddresses(event.currentTarget.checked)}
                      />
                      {x('settings.hideAddresses')}
                    </label>
                  </header>
                  <p className="hint">{x('settings.hideAddressesHint')}</p>
                </section>
                <WindowPreferencesPanel client={client} />
                <TabPreferencesPanel client={client} />
                <ActivityRailSettingsPanel client={client} />
                <ElectermBehaviorSettingsPanel client={client} />
                <ProxySettingsPanel client={client} />
                <KnownHostKeysPanel client={client} />
                <ElectermDataPanel client={client} />
              </>
            )}
            {settingsItem === 'shortcuts' && (
              <div className="stack shortcut-settings-stack">
                <ShortcutSettingsPanel client={client} />
                <CommandHistorySettingsPanel client={client} />
              </div>
            )}
            {settingsItem === 'terminal' && (
              <div className="two-column terminal-profile-settings">
                <form
                  className="stack surface"
                  key={editingProfile?.id ?? 'new-terminal-profile'}
                  onSubmit={(event) => void saveProfile(event)}
                >
                  <h3
                    aria-label={
                      editingProfile
                        ? x('terminalProfile.editAria')
                        : x('terminalProfile.createAria')
                    }
                  >
                    <TerminalIcon size={15} aria-hidden="true" />{' '}
                    {editingProfile
                      ? x('terminalProfile.editTitle')
                      : x('terminalProfile.createTitle')}
                  </h3>
                  <label className="terminal-setting-profile">
                    {x('terminalProfile.name')}
                    <input name="name" required defaultValue={editingProfile?.name} />
                  </label>
                  <label className="terminal-setting-profile">
                    Shell
                    <input
                      name="shell"
                      placeholder={x('terminalProfile.shellPlaceholder')}
                      defaultValue={editingProfile?.shell ?? ''}
                    />
                  </label>
                  <label className="terminal-setting-profile">
                    {x('terminalProfile.shellArguments')}
                    <textarea
                      name="shellArgs"
                      rows={3}
                      defaultValue={editingProfile?.shellArgs.join('\n') ?? ''}
                    />
                  </label>
                  <label className="terminal-setting-profile">
                    {x('terminalProfile.workingDirectory')}
                    <input name="cwd" defaultValue={editingProfile?.cwd ?? ''} />
                  </label>
                  <label className="terminal-setting-term">
                    TERM
                    <input
                      name="term"
                      required
                      defaultValue={editingProfile?.term ?? DEFAULT_TERMINAL_TYPE}
                    />
                  </label>
                  <label className="terminal-setting-profile">
                    LANG
                    <input
                      name="lang"
                      placeholder={x('terminalProfile.langPlaceholder')}
                      defaultValue={editingProfile?.lang ?? ''}
                    />
                  </label>
                  <label className="terminal-setting-profile">
                    {x('terminalProfile.environment')}
                    <textarea
                      name="env"
                      rows={4}
                      placeholder={'EDITOR=vim\nCOLORTERM=truecolor'}
                      defaultValue={formatTerminalEnvironment(editingProfile?.env ?? {})}
                    />
                    <small className="hint">{x('terminalProfile.environmentHint')}</small>
                  </label>
                  <label className="terminal-setting-font-family">
                    {x('terminalProfile.fontFamily')}
                    <input
                      name="fontFamily"
                      required
                      defaultValue={
                        editingProfile?.fontFamily ?? DEFAULT_TERMINAL_APPEARANCE.fontFamily
                      }
                    />
                  </label>
                  <label className="terminal-setting-font-size">
                    {x('terminalProfile.fontSize')}
                    <input
                      name="fontSize"
                      type="number"
                      min="8"
                      max="72"
                      step="1"
                      defaultValue={
                        editingProfile?.fontSize ?? DEFAULT_TERMINAL_APPEARANCE.fontSize
                      }
                    />
                  </label>
                  <label className="terminal-setting-advanced">
                    {x('terminalProfile.lineHeight')}
                    <input
                      name="lineHeight"
                      type="number"
                      min="1"
                      max="2"
                      step="0.05"
                      defaultValue={
                        editingProfile?.lineHeight ?? DEFAULT_TERMINAL_APPEARANCE.lineHeight
                      }
                    />
                  </label>
                  <label className="terminal-setting-advanced">
                    {x('terminalProfile.cursorStyle')}
                    <select
                      name="cursorStyle"
                      defaultValue={
                        editingProfile?.cursorStyle ?? DEFAULT_TERMINAL_APPEARANCE.cursorStyle
                      }
                    >
                      <option value="block">{x('terminalProfile.cursorBlock')}</option>
                      <option value="underline">{x('terminalProfile.cursorUnderline')}</option>
                      <option value="bar">{x('terminalProfile.cursorBar')}</option>
                    </select>
                  </label>
                  <label className="check terminal-setting-profile">
                    <input
                      name="loginShell"
                      type="checkbox"
                      defaultChecked={editingProfile?.loginShell}
                    />
                    {x('terminalProfile.loginShell')}
                  </label>
                  <label className="check terminal-setting-advanced">
                    <input
                      name="cursorBlink"
                      type="checkbox"
                      defaultChecked={editingProfile?.cursorBlink}
                    />
                    {x('terminalProfile.cursorBlink')}
                  </label>
                  <fieldset className="terminal-security-settings">
                    <legend>{x('terminalProfile.renderingCompatibility')}</legend>
                    <label className="terminal-setting-scrollback">
                      {x('terminalProfile.scrollback')}
                      <input
                        name="scrollback"
                        type="number"
                        min="0"
                        max="100000"
                        step="100"
                        defaultValue={
                          editingProfile?.scrollback ?? DEFAULT_TERMINAL_BEHAVIOR.scrollback
                        }
                      />
                    </label>
                    <label className="terminal-setting-renderer">
                      {x('terminalProfile.renderer')}
                      <select
                        name="rendererPreference"
                        defaultValue={
                          editingProfile?.rendererPreference ??
                          DEFAULT_TERMINAL_BEHAVIOR.rendererPreference
                        }
                      >
                        <option value="dom">{x('terminalProfile.domCompatible')}</option>
                        <option value="webgl">{x('terminalProfile.webglAccelerated')}</option>
                      </select>
                    </label>
                    <label className="terminal-setting-advanced">
                      {x('terminalProfile.unicodeWidth')}
                      <select
                        name="unicodeVersion"
                        defaultValue={
                          editingProfile?.unicodeVersion ?? DEFAULT_TERMINAL_BEHAVIOR.unicodeVersion
                        }
                      >
                        <option value="11">Unicode 11</option>
                        <option value="6">Unicode 6</option>
                      </select>
                    </label>
                    <label className="terminal-setting-advanced">
                      {x('terminalProfile.wordSeparator')}
                      <input
                        name="wordSeparator"
                        maxLength={256}
                        defaultValue={
                          editingProfile?.wordSeparator ?? DEFAULT_TERMINAL_BEHAVIOR.wordSeparator
                        }
                      />
                    </label>
                    <label className="terminal-setting-advanced">
                      {x('terminalProfile.backspaceSequence')}
                      <select
                        name="backspaceMode"
                        defaultValue={
                          editingProfile?.backspaceMode ?? DEFAULT_TERMINAL_BEHAVIOR.backspaceMode
                        }
                      >
                        <option value="^?">^?</option>
                        <option value="^H">^H</option>
                      </select>
                    </label>
                    <label className="full-field terminal-setting-advanced">
                      {x('terminalProfile.shiftEnterSends')}
                      <input
                        name="shiftEnterMode"
                        maxLength={256}
                        defaultValue={
                          editingProfile?.shiftEnterMode ?? DEFAULT_TERMINAL_BEHAVIOR.shiftEnterMode
                        }
                      />
                    </label>
                    <label className="terminal-setting-advanced">
                      {x('terminalProfile.outputEncoding')}
                      <select
                        name="encoding"
                        defaultValue={
                          editingProfile?.encoding ?? DEFAULT_TERMINAL_BEHAVIOR.encoding
                        }
                      >
                        {TERMINAL_ENCODINGS.map((encoding) => (
                          <option key={encoding} value={encoding}>
                            {encoding.toUpperCase()}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="check terminal-setting-advanced">
                      <input
                        name="displayRaw"
                        type="checkbox"
                        defaultChecked={
                          editingProfile?.displayRaw ?? DEFAULT_TERMINAL_BEHAVIOR.displayRaw
                        }
                      />
                      {x('terminalProfile.displayRaw')}
                    </label>
                    <label className="check terminal-setting-advanced">
                      <input
                        name="logTimestamps"
                        type="checkbox"
                        defaultChecked={
                          editingProfile?.logTimestamps ?? DEFAULT_TERMINAL_BEHAVIOR.logTimestamps
                        }
                      />
                      {x('terminalProfile.logTimestamps')}
                    </label>
                    <small className="hint terminal-setting-advanced">
                      {x('terminalProfile.keySequenceHint')}
                    </small>
                    <label className="check terminal-setting-advanced">
                      <input
                        name="ligaturesEnabled"
                        type="checkbox"
                        defaultChecked={
                          editingProfile?.ligaturesEnabled ??
                          DEFAULT_TERMINAL_BEHAVIOR.ligaturesEnabled
                        }
                      />
                      {x('terminalProfile.ligatures')}
                    </label>
                    <label className="check terminal-setting-advanced">
                      <input
                        name="imageSequencesEnabled"
                        type="checkbox"
                        defaultChecked={
                          editingProfile?.imageSequencesEnabled ??
                          DEFAULT_TERMINAL_BEHAVIOR.imageSequencesEnabled
                        }
                      />
                      {x('terminalProfile.imageSequences')}
                    </label>
                    <small className="hint terminal-setting-advanced">
                      {x('terminalProfile.imageSequencesHint')}
                    </small>
                  </fieldset>
                  <fieldset className="terminal-security-settings">
                    <legend>{x('terminalProfile.clipboardSecurity')}</legend>
                    <label className="check">
                      <input
                        name="pasteProtection"
                        type="checkbox"
                        defaultChecked={
                          editingProfile?.pasteProtection ??
                          DEFAULT_TERMINAL_BEHAVIOR.pasteProtection
                        }
                      />
                      {x('terminalProfile.pasteProtection')}
                    </label>
                    <label className="check">
                      <input
                        name="osc52Enabled"
                        type="checkbox"
                        defaultChecked={
                          editingProfile?.osc52Enabled ?? DEFAULT_TERMINAL_BEHAVIOR.osc52Enabled
                        }
                      />
                      {x('terminalProfile.osc52Enabled')}
                    </label>
                    <label>
                      {x('terminalProfile.osc52Read')}
                      <select
                        name="osc52ReadPolicy"
                        defaultValue={
                          editingProfile?.osc52ReadPolicy ??
                          DEFAULT_TERMINAL_BEHAVIOR.osc52ReadPolicy
                        }
                      >
                        <option value="deny">{x('terminalProfile.deny')}</option>
                        <option value="allow">{x('terminalProfile.allow')}</option>
                      </select>
                    </label>
                    <label>
                      {x('terminalProfile.osc52Write')}
                      <select
                        name="osc52WritePolicy"
                        defaultValue={
                          editingProfile?.osc52WritePolicy ??
                          DEFAULT_TERMINAL_BEHAVIOR.osc52WritePolicy
                        }
                      >
                        <option value="deny">{x('terminalProfile.deny')}</option>
                        <option value="allow">{x('terminalProfile.allow')}</option>
                      </select>
                    </label>
                    <small className="hint">{x('terminalProfile.osc52Hint')}</small>
                  </fieldset>
                  <div className="modal-actions">
                    {editingProfile && (
                      <button type="button" onClick={() => setEditingProfile(undefined)}>
                        {x('terminalProfile.cancelEdit')}
                      </button>
                    )}
                    <button className="primary">
                      {editingProfile ? x('terminalProfile.update') : x('terminalProfile.save')}
                    </button>
                  </div>
                </form>
                <div className="surface list">
                  <h3>{x('terminalProfile.savedProfiles')}</h3>
                  {profiles.data?.map((profile) => (
                    <div className="list-row" key={profile.id}>
                      <TerminalIcon size={14} />
                      <div>
                        <strong>{profile.name}</strong>
                        <small>
                          {x('terminalProfile.summary', {
                            shell: profile.shell ?? x('terminalProfile.systemDefault'),
                            term: profile.term,
                            fontSize: profile.fontSize,
                            lineHeight: profile.lineHeight,
                            encoding: profile.encoding.toUpperCase(),
                            raw: x(
                              profile.displayRaw ? 'terminalProfile.on' : 'terminalProfile.off',
                            ),
                            paste: x(
                              profile.pasteProtection
                                ? 'terminalProfile.on'
                                : 'terminalProfile.off',
                            ),
                            osc52: x(
                              profile.osc52Enabled ? 'terminalProfile.on' : 'terminalProfile.off',
                            ),
                          })}
                        </small>
                      </div>
                      <button type="button" onClick={() => setEditingProfile(profile)}>
                        {x('terminalProfile.edit')}
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            )}
            {settingsItem === 'terminal' && <TerminalRecoverySettingsPanel client={client} />}
            {settingsItem === 'sync' && <DataSyncPanel client={client} />}
            {settingsItem === 'ai' && (
              <div className="surface settings-category-pending">
                <p>{x('settings.aiManagedInInspector')}</p>
                <button className="primary" type="button" onClick={() => showSection('ai')}>
                  {x('settings.openAiInspector')}
                </button>
              </div>
            )}
            {settingsItem === 'password' && (
              <section
                className="surface settings-credential-list"
                aria-label={x('credentials.title')}
              >
                <header>
                  <div>
                    <small>{x('credentials.localVaultEyebrow')}</small>
                    <h3>{x('credentials.title')}</h3>
                  </div>
                  <span>{credentials.data?.length ?? 0}</span>
                </header>
                <p className="hint">{x('credentials.description')}</p>
                <div className="list">
                  {credentials.data?.map((credential) => (
                    <div className="list-row" key={credential.ref}>
                      <KeyRound size={14} aria-hidden="true" />
                      <div>
                        <strong>{credential.label}</strong>
                        <small>
                          {credentialKindLabel(credential.kind, x)} ·{' '}
                          {x('credentials.savedLocally')} ·{' '}
                          {new Date(credential.updatedAt).toLocaleString(language)}
                        </small>
                      </div>
                    </div>
                  ))}
                  {credentials.isLoading && <p>{x('credentials.loading')}</p>}
                  {credentials.isError && <p>{x('credentials.error')}</p>}
                  {credentials.isSuccess && !credentials.data.length && (
                    <p>{x('credentials.empty')}</p>
                  )}
                </div>
              </section>
            )}
          </PanelFrame>
        </div>
      )}
    </div>
  );
}

function KnownHostKeysPanel({ client }: { client: Client }) {
  const { language, x } = useI18n();
  const knownHostKeys = useQuery({ queryKey: ['known-host-keys'], queryFn: client.knownHostKeys });
  const [revoking, setRevoking] = useState<string>();
  const [message, setMessage] = useState('');

  async function revoke(key: KnownHostKey) {
    if (!window.confirm(x('knownHosts.revokeConfirm', { host: key.host, port: key.port }))) return;
    setRevoking(key.id);
    setMessage('');
    try {
      await client.deleteKnownHostKey(key);
      await knownHostKeys.refetch();
      setMessage(x('knownHosts.revokeSuccess', { host: key.host, port: key.port }));
    } catch (cause) {
      setMessage(messageOf(cause));
      await knownHostKeys.refetch();
    } finally {
      setRevoking(undefined);
    }
  }

  return (
    <section className="surface known-host-keys-panel" aria-label={x('knownHosts.title')}>
      <header>
        <div>
          <h3>
            <ShieldAlert size={15} aria-hidden="true" /> {x('knownHosts.title')}
          </h3>
          <p>{x('knownHosts.description')}</p>
        </div>
        <button type="button" onClick={() => void knownHostKeys.refetch()}>
          <RefreshCw size={13} aria-hidden="true" /> {x('knownHosts.refresh')}
        </button>
      </header>
      {knownHostKeys.isLoading ? <p className="hint">{x('knownHosts.loading')}</p> : null}
      {knownHostKeys.isError ? <ErrorBanner text={messageOf(knownHostKeys.error)} /> : null}
      {knownHostKeys.data?.length ? (
        <div className="known-host-key-list" role="list">
          {knownHostKeys.data.map((key) => (
            <article key={key.id} role="listitem">
              <div className="known-host-key-target">
                <strong>
                  {key.host}:{key.port}
                </strong>
                <span>{key.algorithm}</span>
              </div>
              <code title={key.fingerprint}>{key.fingerprint}</code>
              <small>
                {x('knownHosts.seenDates', {
                  first: new Date(key.firstSeenAt).toLocaleString(language),
                  last: new Date(key.lastSeenAt).toLocaleString(language),
                })}
              </small>
              <button
                className="danger"
                disabled={revoking === key.id}
                onClick={() => void revoke(key)}
                type="button"
              >
                {revoking === key.id ? x('knownHosts.revoking') : x('knownHosts.revokeTrust')}
              </button>
            </article>
          ))}
        </div>
      ) : knownHostKeys.isSuccess ? (
        <p className="known-host-key-empty">{x('knownHosts.empty')}</p>
      ) : null}
      {message ? (
        <p className="hint" role="status">
          {message}
        </p>
      ) : null}
    </section>
  );
}

export function InteractionOverlay({
  client,
  queryClient,
}: {
  client: Client;
  queryClient: QueryClient;
}) {
  const { x } = useI18n();
  const [submitting, setSubmitting] = useState(false);
  const interactions = useQuery({
    queryKey: ['interactions'],
    queryFn: client.interactions,
    refetchInterval: 500,
  });
  const current = interactions.data?.[0];
  if (!current) return null;
  const hostKeyInteraction = current.kind === 'unknownHostKey' || current.kind === 'changedHostKey';
  async function respond(accepted: boolean, remember = false, values: Record<string, string> = {}) {
    if (!current || submitting) return;
    setSubmitting(true);
    try {
      await client.respondInteraction(current.id, { accepted, remember, values });
      await Promise.all([
        interactions.refetch(),
        queryClient.invalidateQueries({ queryKey: ['connections'] }),
      ]);
    } finally {
      setSubmitting(false);
    }
  }
  return (
    <Modal title={current.title} onClose={() => void respond(false)}>
      <form
        className="stack"
        onSubmit={(event) => {
          event.preventDefault();
          const data = new FormData(event.currentTarget);
          const values = Object.fromEntries(
            current.fields.map((field) => [field.id, String(data.get(field.id) ?? '')]),
          );
          void respond(true, data.get('remember') === 'on', values);
        }}
      >
        <p className={current.severity === 'high' ? 'danger-text' : ''}>{current.detail}</p>
        {current.fields.map((field) => (
          <label key={field.id}>
            {field.label}
            <input
              name={field.id}
              type={field.secret ? 'password' : 'text'}
              autoComplete="off"
              required
              autoFocus={field.id === current.fields[0]?.id}
            />
          </label>
        ))}
        {hostKeyInteraction && (
          <label className="check">
            <input
              defaultChecked
              required={current.kind === 'changedHostKey'}
              type="checkbox"
              name="remember"
            />{' '}
            {current.kind === 'changedHostKey'
              ? x('interaction.confirmChangedHostKey')
              : x('interaction.rememberHostKey')}
          </label>
        )}
        <div className="modal-actions">
          <button type="button" disabled={submitting} onClick={() => void respond(false)}>
            {x('panels.reject')}
          </button>
          <button
            className={current.severity === 'high' ? 'danger' : 'primary'}
            disabled={submitting}
          >
            {submitting
              ? x('interaction.submitting')
              : current.kind === 'changedHostKey'
                ? x('interaction.replaceAndConnect')
                : current.kind === 'unknownHostKey'
                  ? x('interaction.trustAndConnect')
                  : x('interaction.confirm')}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function AiBookmarkDialog({
  client,
  bookmarkTree,
  defaultGroupId,
  onClose,
  onSaved,
}: {
  client: Client;
  bookmarkTree: BookmarkTree;
  defaultGroupId: string | null;
  onClose(): void;
  onSaved(tree: BookmarkTree): Promise<void>;
}) {
  const { x } = useI18n();
  const models = useQuery({ queryKey: ['ai-models'], queryFn: client.aiModels });
  const requestRef = useRef(0);
  const activeRunRef = useRef<string | undefined>(undefined);
  const [prompt, setPrompt] = useState('');
  const [modelId, setModelId] = useState('');
  const [draft, setDraft] = useState<AiBookmarkDraft>();
  const [groupId, setGroupId] = useState(defaultGroupId ?? '');
  const [generating, setGenerating] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const selectedModelId = modelId || models.data?.[0]?.id || '';

  useEffect(
    () => () => {
      requestRef.current += 1;
      if (activeRunRef.current) void client.cancelAi(activeRunRef.current).catch(() => undefined);
    },
    [client],
  );

  function close() {
    requestRef.current += 1;
    if (activeRunRef.current) void client.cancelAi(activeRunRef.current).catch(() => undefined);
    onClose();
  }

  async function generate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selectedModelId || !prompt.trim() || generating) return;
    const request = ++requestRef.current;
    setGenerating(true);
    setError('');
    try {
      const started = await client.startAi({
        modelId: selectedModelId,
        useCase: 'createBookmark',
        prompt: prompt.trim(),
        context: '',
      });
      activeRunRef.current = started.id;
      let run = started;
      const deadline = Date.now() + 30_000;
      while (
        requestRef.current === request &&
        !['succeeded', 'failed', 'canceled'].includes(run.state) &&
        Date.now() < deadline
      ) {
        await new Promise((resolve) => setTimeout(resolve, 350));
        if (requestRef.current !== request) return;
        run = await client.aiRun(started.id);
      }
      if (requestRef.current !== request) return;
      if (!['succeeded', 'failed', 'canceled'].includes(run.state)) {
        await client.cancelAi(started.id);
        throw new Error(x('aiBookmark.timeout'));
      }
      if (run.state !== 'succeeded' || !run.result)
        throw new Error(
          run.errorCode === 'AI_OUTPUT_INVALID'
            ? x('aiBookmark.invalidResult')
            : x('aiBookmark.generationFailed'),
        );
      setDraft(parseAiBookmarkDraft(run.result));
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      if (requestRef.current === request) {
        activeRunRef.current = undefined;
        setGenerating(false);
      }
    }
  }

  function updateDraft<K extends keyof AiBookmarkDraft>(key: K, value: AiBookmarkDraft[K]) {
    setDraft((current) => (current ? { ...current, [key]: value } : current));
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!draft || saving) return;
    setSaving(true);
    setError('');
    try {
      const reviewed = parseAiBookmarkDraft(JSON.stringify(draft));
      const latestTree = await client.bookmarkTree();
      const result = await client.createSshBookmark(latestTree, {
        host: {
          name: reviewed.name,
          hostname: reviewed.hostname,
          port: reviewed.port,
          username: reviewed.username,
          authType: reviewed.authType,
          credentialRef: null,
          passphraseCredentialRef: null,
          certificateCredentialRef: null,
          jumpHostId: null,
          jumpHostIds: [],
          favorite: reviewed.favorite,
          proxy: { mode: 'inherit' },
          connectionOptions: {
            ...DEFAULT_SSH_CONNECTION_OPTIONS,
            algorithms: {
              kex: [...DEFAULT_SSH_CONNECTION_OPTIONS.algorithms.kex],
              cipher: [...DEFAULT_SSH_CONNECTION_OPTIONS.algorithms.cipher],
              serverHostKey: [...DEFAULT_SSH_CONNECTION_OPTIONS.algorithms.serverHostKey],
              hmac: [...DEFAULT_SSH_CONNECTION_OPTIONS.algorithms.hmac],
            },
            reconnectPolicy: { ...DEFAULT_SSH_CONNECTION_OPTIONS.reconnectPolicy },
          },
          startup: {
            ...DEFAULT_SSH_STARTUP,
            environment: { ...DEFAULT_SSH_STARTUP.environment },
            loginScripts: [...DEFAULT_SSH_STARTUP.loginScripts],
            runScripts: [...DEFAULT_SSH_STARTUP.runScripts],
          },
          x11: { enabled: false, display: null },
          sshAgent: { enabled: true, path: null },
        },
        bookmark: {
          groupId: groupId || null,
          title: reviewed.title,
          color: null,
          description: reviewed.description,
          profileId: null,
          connectionProfileId: null,
          quickCommands: [],
          triggers: [],
        },
      });
      await onSaved(result.tree);
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal className="ai-bookmark-modal" title={x('aiBookmark.title')} onClose={close}>
      <div className="ai-bookmark-progress" aria-label={x('aiBookmark.progress')}>
        <span className="complete">
          <Bot size={14} /> {x('aiBookmark.describeStep')}
        </span>
        <i />
        <span className={draft ? 'complete' : ''}>
          <ListChecks size={14} /> {x('aiBookmark.reviewStep')}
        </span>
        <i />
        <span>
          <Save size={14} /> {x('aiBookmark.saveStep')}
        </span>
      </div>
      {!draft ? (
        <form className="ai-bookmark-generate" onSubmit={(event) => void generate(event)}>
          <div className="ai-bookmark-hero">
            <span>
              <WandSparkles size={20} />
            </span>
            <div>
              <strong>{x('aiBookmark.describeTitle')}</strong>
              <p>{x('aiBookmark.describeHint')}</p>
            </div>
          </div>
          {error && <ErrorBanner text={error} />}
          <label>
            {x('aiBookmark.model')}
            <select
              aria-label={x('aiBookmark.model')}
              required
              value={selectedModelId}
              onChange={(event) => setModelId(event.target.value)}
            >
              <option value="">{x('aiBookmark.selectModel')}</option>
              {(models.data ?? []).map((model) => (
                <option key={model.id} value={model.id}>
                  {model.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            {x('aiBookmark.description')}
            <textarea
              autoFocus
              maxLength={16_384}
              name="description"
              onChange={(event) => setPrompt(event.target.value)}
              placeholder={x('aiBookmark.descriptionPlaceholder')}
              required
              rows={7}
              value={prompt}
            />
          </label>
          <p className="ai-bookmark-security">
            <ShieldAlert size={14} /> {x('aiBookmark.noSecrets')}
          </p>
          {!models.isLoading && !models.data?.length && (
            <p className="hint">{x('aiBookmark.noModels')}</p>
          )}
          <div className="modal-actions">
            <button type="button" onClick={close}>
              {x('common.cancel')}
            </button>
            <button
              className="primary"
              disabled={generating || !selectedModelId || !prompt.trim()}
              type="submit"
            >
              {generating ? <LoaderCircle className="spin" size={14} /> : <Bot size={14} />}
              {generating ? x('aiBookmark.generating') : x('aiBookmark.generate')}
            </button>
          </div>
        </form>
      ) : (
        <form className="ai-bookmark-review form-grid" onSubmit={(event) => void save(event)}>
          <div className="ai-bookmark-review-heading full-field">
            <div>
              <strong>{x('aiBookmark.reviewTitle')}</strong>
              <p>{x('aiBookmark.reviewHint')}</p>
            </div>
            <button type="button" onClick={() => setDraft(undefined)}>
              <RefreshCw size={13} /> {x('aiBookmark.regenerate')}
            </button>
          </div>
          {error && <ErrorBanner text={error} />}
          <label>
            {x('hosts.displayName')}
            <input
              maxLength={100}
              onChange={(event) => updateDraft('name', event.target.value)}
              required
              value={draft.name}
            />
          </label>
          <label>
            {x('hosts.bookmarkTitle')}
            <input
              maxLength={100}
              onChange={(event) => updateDraft('title', event.target.value)}
              required
              value={draft.title}
            />
          </label>
          <label>
            {x('hosts.address')}
            <input
              maxLength={253}
              onChange={(event) => updateDraft('hostname', event.target.value)}
              required
              value={draft.hostname}
            />
          </label>
          <label>
            {x('hosts.port')}
            <input
              max={65_535}
              min={1}
              onChange={(event) => updateDraft('port', Number(event.target.value))}
              required
              type="number"
              value={draft.port}
            />
          </label>
          <label>
            {x('hosts.username')}
            <input
              maxLength={128}
              onChange={(event) => updateDraft('username', event.target.value)}
              required
              value={draft.username}
            />
          </label>
          <label>
            {x('hosts.authMethod')}
            <select
              onChange={(event) =>
                updateDraft('authType', event.target.value as AiBookmarkDraft['authType'])
              }
              value={draft.authType}
            >
              <option value="password">{x('hosts.password')}</option>
              <option value="privateKey">{x('hosts.privateKey')}</option>
              <option value="keyboardInteractive">{x('aiBookmark.keyboardInteractive')}</option>
              <option value="agent">{x('hosts.authAgent')}</option>
            </select>
          </label>
          <label>
            {x('hosts.group')}
            <select value={groupId} onChange={(event) => setGroupId(event.target.value)}>
              <option value="">{x('hosts.uncategorized')}</option>
              {bookmarkTree.groups.map((group) => (
                <option key={group.id} value={group.id}>
                  {group.name}
                </option>
              ))}
            </select>
          </label>
          <label className="check ai-bookmark-favorite">
            <input
              checked={draft.favorite}
              onChange={(event) => updateDraft('favorite', event.target.checked)}
              type="checkbox"
            />{' '}
            {x('hosts.favorite')}
          </label>
          <label className="full-field">
            {x('hosts.descriptionField')}
            <textarea
              maxLength={2_000}
              onChange={(event) => updateDraft('description', event.target.value)}
              rows={3}
              value={draft.description}
            />
          </label>
          <p className="ai-bookmark-security full-field">
            <ShieldAlert size={14} /> {x('aiBookmark.credentialAfterSave')}
          </p>
          <div className="modal-actions">
            <button type="button" onClick={close}>
              {x('common.cancel')}
            </button>
            <button className="primary" disabled={saving} type="submit">
              {saving ? <LoaderCircle className="spin" size={14} /> : <Save size={14} />}
              {saving ? x('aiBookmark.saving') : x('aiBookmark.save')}
            </button>
          </div>
        </form>
      )}
    </Modal>
  );
}

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
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className={className ? `panel-page ${className}` : 'panel-page'}>
      <header className="panel-heading">
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
function Modal({
  title,
  onClose,
  children,
  className,
  chrome,
}: {
  title: string;
  onClose(): void;
  children: React.ReactNode;
  className?: string;
  chrome?: ReactNode;
}) {
  const { x } = useI18n();
  const dialog = useRef<HTMLElement>(null);
  const close = useRef(onClose);
  const [restoreFocus] = useState<HTMLElement | undefined>(() =>
    document.activeElement instanceof HTMLElement ? document.activeElement : undefined,
  );
  useEffect(() => {
    close.current = onClose;
  }, [onClose]);
  useEffect(() => {
    const focusableSelector = [
      'button:not(:disabled)',
      'input:not(:disabled):not([type="hidden"])',
      'select:not(:disabled)',
      'textarea:not(:disabled)',
      'a[href]',
      '[tabindex]:not([tabindex="-1"])',
    ].join(',');
    const focusable = () =>
      [...(dialog.current?.querySelectorAll<HTMLElement>(focusableSelector) ?? [])].filter(
        (element) => element.getClientRects().length > 0,
      );
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        close.current();
        return;
      }
      if (event.key !== 'Tab') return;
      const controls = focusable();
      if (!controls.length) {
        event.preventDefault();
        dialog.current?.focus();
        return;
      }
      const first = controls[0]!;
      const last = controls.at(-1)!;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKeyDown, true);
    requestAnimationFrame(() => {
      if (dialog.current?.contains(document.activeElement)) return;
      const preferred = dialog.current?.querySelector<HTMLElement>('[autofocus],[data-autofocus]');
      (preferred ?? focusable()[0] ?? dialog.current)?.focus();
    });
    return () => {
      document.removeEventListener('keydown', onKeyDown, true);
      if (restoreFocus?.isConnected) requestAnimationFrame(() => restoreFocus.focus());
    };
  }, [restoreFocus]);
  return (
    <div
      className="modal-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section
        ref={dialog}
        className={className ? `modal ${className}` : 'modal'}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
      >
        {chrome}
        <header>
          <h2>{title}</h2>
          <button aria-label={x('common.close')} onClick={onClose}>
            ×
          </button>
        </header>
        {children}
      </section>
    </div>
  );
}
function EmptyState({
  icon: Icon,
  title,
  text,
}: {
  icon: typeof Server;
  title: string;
  text: string;
}) {
  return (
    <div className="empty-state">
      <Icon size={26} />
      <strong>{title}</strong>
      <span>{text}</span>
    </div>
  );
}
function ErrorBanner({ text }: { text: string }) {
  return (
    <div className="error-banner" role="alert">
      <ShieldAlert size={14} /> {text}
    </div>
  );
}

function BookmarkCardHeading({ bookmark }: { bookmark: Bookmark }) {
  return (
    <strong>
      {bookmark.color && (
        <span
          className="bookmark-title-color"
          data-bookmark-color={bookmark.color}
          style={{ color: bookmark.color }}
          aria-hidden="true"
        >
          ●
        </span>
      )}
      {bookmark.title}
    </strong>
  );
}
async function cleanupReplacedCredentials(
  client: Client,
  hosts: Host[],
  previous: Host,
  next: Host,
): Promise<void> {
  const retained = new Set(
    [
      next.credentialRef,
      next.passphraseCredentialRef,
      next.certificateCredentialRef,
      ...proxyCredentialRefs(next.proxy),
    ].filter(Boolean),
  );
  const candidates = [
    previous.credentialRef,
    previous.passphraseCredentialRef,
    previous.certificateCredentialRef,
    ...proxyCredentialRefs(previous.proxy),
  ].filter(
    (value): value is string =>
      !!value &&
      !retained.has(value) &&
      !hosts.some(
        (host) =>
          host.id !== previous.id &&
          (host.credentialRef === value ||
            host.passphraseCredentialRef === value ||
            host.certificateCredentialRef === value ||
            proxyCredentialRefs(host.proxy).includes(value)),
      ),
  );
  await Promise.allSettled(
    [...new Set(candidates)].map((credentialRef) => client.deleteCredential(credentialRef)),
  );
}
async function waitForReadyConnection(
  client: Client,
  connectionId: string,
  x: ReturnType<typeof useI18n>['x'],
): Promise<Connection> {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    const connection = (await client.connections()).find(({ id }) => id === connectionId);
    if (!connection) throw new Error(x('app.connectionClosed'));
    if (connection.state === 'ready') return connection;
    if (connection.state === 'failed')
      throw new Error(
        x('app.connectionFailed', {
          detail: connection.errorCode ? `: ${connection.errorCode}` : '',
        }),
      );
    if (connection.state === 'closing' || connection.state === 'closed')
      throw new Error(x('app.connectionClosed'));
    await new Promise((resolve) => window.setTimeout(resolve, 200));
  }
  throw new Error(x('app.sshWaitTimeout'));
}
function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="metric">
      <span title={label}>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}
function updaterStateLabel(state: UpdaterStatus['state'], x: Translator): string {
  const labels: Record<UpdaterStatus['state'], AxtermMessageKey> = {
    disabled: 'settings.updaterDisabled',
    idle: 'settings.updaterIdle',
    checking: 'settings.updaterChecking',
    available: 'settings.updaterAvailable',
    downloading: 'settings.updaterDownloading',
    ready: 'settings.updaterReady',
    error: 'settings.updaterError',
  };
  return x(labels[state]);
}
function credentialKindLabel(kind: string, x: ReturnType<typeof useI18n>['x']): string {
  const key = {
    sshPassword: 'credentials.kindSshPassword',
    privateKey: 'credentials.kindPrivateKey',
    privateKeyPassphrase: 'credentials.kindPrivateKeyPassphrase',
    sshCertificate: 'credentials.kindSshCertificate',
    protocolPassword: 'credentials.kindProtocolPassword',
    proxyPassword: 'credentials.kindProxyPassword',
    aiApiKey: 'credentials.kindAiApiKey',
    syncAccessToken: 'credentials.kindSyncAccessToken',
    syncEncryptionPassword: 'credentials.kindSyncEncryptionPassword',
  }[kind] as Parameters<typeof x>[0] | undefined;
  return key ? x(key) : kind;
}
function messageOf(value: unknown, x?: Translator) {
  return value instanceof Error
    ? value.message
    : (x?.('common.operationFailed') ?? 'Operation failed');
}
function terminalProfileInput(form: FormData, x: Translator): TerminalProfileInput {
  return {
    name: String(form.get('name') ?? '').trim(),
    shell: String(form.get('shell') ?? '').trim() || null,
    shellArgs: String(form.get('shellArgs') ?? '')
      .split(/\r?\n/)
      .map((value) => value.trim())
      .filter(Boolean),
    cwd: String(form.get('cwd') ?? '').trim() || null,
    loginShell: form.get('loginShell') === 'on',
    env: parseTerminalEnvironment(String(form.get('env') ?? ''), x),
    term: String(form.get('term') ?? '').trim(),
    lang: String(form.get('lang') ?? '').trim() || null,
    fontFamily: String(form.get('fontFamily') ?? '').trim(),
    fontSize: Number(form.get('fontSize')),
    lineHeight: Number(form.get('lineHeight')),
    cursorStyle: String(form.get('cursorStyle')) as TerminalProfileInput['cursorStyle'],
    cursorBlink: form.get('cursorBlink') === 'on',
    scrollback: Number(form.get('scrollback')),
    rendererPreference: String(
      form.get('rendererPreference'),
    ) as TerminalProfileInput['rendererPreference'],
    unicodeVersion: String(form.get('unicodeVersion')) as TerminalProfileInput['unicodeVersion'],
    ligaturesEnabled: form.get('ligaturesEnabled') === 'on',
    imageSequencesEnabled: form.get('imageSequencesEnabled') === 'on',
    wordSeparator: String(form.get('wordSeparator') ?? ''),
    backspaceMode: String(form.get('backspaceMode')) as TerminalProfileInput['backspaceMode'],
    shiftEnterMode: String(form.get('shiftEnterMode') ?? ''),
    encoding: String(form.get('encoding')) as TerminalProfileInput['encoding'],
    displayRaw: form.get('displayRaw') === 'on',
    logTimestamps: form.get('logTimestamps') === 'on',
    pasteProtection: form.get('pasteProtection') === 'on',
    osc52Enabled: form.get('osc52Enabled') === 'on',
    osc52ReadPolicy: String(form.get('osc52ReadPolicy')) as TerminalProfileInput['osc52ReadPolicy'],
    osc52WritePolicy: String(
      form.get('osc52WritePolicy'),
    ) as TerminalProfileInput['osc52WritePolicy'],
  };
}
function parseTerminalEnvironment(source: string, x: Translator): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [index, rawLine] of source.split(/\r?\n/).entries()) {
    if (!rawLine.trim()) continue;
    const separator = rawLine.indexOf('=');
    if (separator < 1) throw new Error(x('hosts.environmentLineInvalid', { line: index + 1 }));
    const name = rawLine.slice(0, separator).trim();
    if (Object.hasOwn(result, name)) throw new Error(x('hosts.environmentDuplicate', { name }));
    result[name] = rawLine.slice(separator + 1);
  }
  return result;
}
function formatTerminalEnvironment(environment: Record<string, string>): string {
  return Object.entries(environment)
    .map(([name, value]) => `${name}=${value}`)
    .join('\n');
}
function descendantGroupIds(tree: BookmarkTree | undefined, rootId: string): Set<string> {
  const result = new Set([rootId]);
  if (!tree) return result;
  let changed = true;
  while (changed) {
    changed = false;
    for (const group of tree.groups) {
      if (group.parentId && result.has(group.parentId) && !result.has(group.id)) {
        result.add(group.id);
        changed = true;
      }
    }
  }
  return result;
}
function hostsInGroup(tree: BookmarkTree | undefined, groupId: string): Set<string> {
  const groupIds = descendantGroupIds(tree, groupId);
  return new Set(
    tree?.bookmarks
      .filter((bookmark) => bookmark.groupId && groupIds.has(bookmark.groupId))
      .flatMap((bookmark) => (bookmark.hostId ? [bookmark.hostId] : [])) ?? [],
  );
}
function connectionStateLabel(state: Connection['state'], x: Translator) {
  const keys: Record<Connection['state'], AxtermMessageKey> = {
    created: 'hosts.stateWaiting',
    resolving: 'hosts.stateResolving',
    connecting: 'hosts.stateConnecting',
    authenticating: 'hosts.stateAuthenticating',
    ready: 'hosts.stateReady',
    reconnecting: 'hosts.stateReconnecting',
    closing: 'hosts.stateClosing',
    closed: 'hosts.stateClosed',
    failed: 'hosts.stateFailed',
  };
  return x(keys[state]);
}
function authTypeLabel(authType: Host['authType'], x: Translator) {
  const keys: Record<Host['authType'], AxtermMessageKey> = {
    password: 'hosts.authPassword',
    privateKey: 'hosts.authPrivateKey',
    keyboardInteractive: 'hosts.authInteractive',
    agent: 'hosts.authAgent',
  };
  return x(keys[authType]);
}
function formatBytes(value: number) {
  if (value < 1024) return `${value} B`;
  if (value < 1024 ** 2) return `${(value / 1024).toFixed(1)} KiB`;
  return `${(value / 1024 ** 2).toFixed(1)} MiB`;
}
function boundedPathHistory(path: string, current: string[]): string[] {
  return [path, ...current.filter((item) => item !== path)].slice(0, 32);
}
function normalizeLocalAddress(value: string, x: Translator): string {
  const segments = value.trim().replaceAll('\\', '/').split('/').filter(Boolean);
  if (segments.some((segment) => segment === '.' || segment === '..' || segment.includes('\0')))
    throw new Error(x('fileManager.localPathInvalid'));
  return segments.join('/');
}

function localAbsoluteAddress(grant: FileGrant | undefined, relativePath: string): string {
  const rootPath = grant?.rootPath;
  if (!rootPath) return relativePath ? `/${relativePath}` : '/';
  if (!relativePath) return rootPath;
  const separator = rootPath.includes('\\') ? '\\' : '/';
  const root =
    rootPath.endsWith('/') || rootPath.endsWith('\\') ? rootPath : `${rootPath}${separator}`;
  return `${root}${relativePath.replaceAll('/', separator)}`;
}

function localRelativeAddress(
  value: string,
  grant: FileGrant | undefined,
  x: Translator,
): string | undefined {
  const address = value.trim().replaceAll('\\', '/');
  const rootPath = grant?.rootPath?.replaceAll('\\', '/');
  const absolute = address.startsWith('/') || /^[a-z]:\//iu.test(address);
  if (!absolute || !rootPath || address.includes('\0'))
    throw new Error(x('fileManager.localPathInvalid'));
  const root = rootPath.length > 1 ? rootPath.replace(/\/+$/u, '') : rootPath;
  const caseInsensitive = /^[a-z]:\//iu.test(root);
  const comparableAddress = caseInsensitive ? address.toLocaleLowerCase() : address;
  const comparableRoot = caseInsensitive ? root.toLocaleLowerCase() : root;
  if (comparableAddress === comparableRoot) return '';
  const prefix = comparableRoot.endsWith('/') ? comparableRoot : `${comparableRoot}/`;
  if (!comparableAddress.startsWith(prefix)) return undefined;
  return normalizeLocalAddress(address.slice(prefix.length), x);
}

function localParentPath(value: string): string {
  const separator = value.lastIndexOf('/');
  return separator < 0 ? '' : value.slice(0, separator);
}
function appendLocalPath(directory: string, name: string): string {
  return directory ? `${directory}/${name}` : name;
}
function appendRemotePath(directory: string, name: string): string {
  return `${directory.replace(/\/$/, '')}/${name}`;
}
function normalizeRemoteAddress(value: string, x: Translator): string {
  const trimmed = value.trim().replaceAll('\\', '/');
  if (!trimmed.startsWith('/') || trimmed.includes('\0'))
    throw new Error(x('fileManager.remotePathInvalid'));
  const segments = trimmed.split('/').filter(Boolean);
  const normalized: string[] = [];
  for (const segment of segments) {
    if (segment === '.') continue;
    if (segment === '..') normalized.pop();
    else normalized.push(segment);
  }
  return `/${normalized.join('/')}`;
}
