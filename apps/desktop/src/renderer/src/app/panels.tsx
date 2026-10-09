import { useQuery, type QueryClient } from '@tanstack/react-query';
import type { createRuntimeClient } from '@workspace/client';
import type {
  AiBookmarkDraft,
  Bookmark,
  BookmarkTree,
  Connection,
  Host,
  HostProxyConfig,
  KnownHostKey,
  SerialPortInfo,
  SshAgentStatus,
  TerminalProfile,
  TerminalProfileInput,
  Tunnel,
  TunnelProfile,
} from '@workspace/contracts';
import {
  DEFAULT_SSH_CONNECTION_OPTIONS,
  DEFAULT_SSH_STARTUP,
  DEFAULT_TERMINAL_APPEARANCE,
  DEFAULT_TERMINAL_BEHAVIOR,
  DEFAULT_TERMINAL_TYPE,
  TERMINAL_ENCODINGS,
} from '@workspace/contracts';
import type { FileGrant, UpdaterStatus } from '@workspace/contracts/desktop';
import type { QuickConnectTarget } from '@workspace/shared';
import {
  Bot,
  Check,
  ChevronDown,
  ChevronUp,
  Copy,
  Download,
  FolderInput,
  Globe2,
  KeyRound,
  ListChecks,
  LoaderCircle,
  Monitor,
  Network,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  Save,
  Search,
  Server,
  ShieldAlert,
  Square,
  Star,
  Terminal as TerminalIcon,
  Trash2,
  Upload,
  WandSparkles,
} from 'lucide-react';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { createPortal } from 'react-dom';
import { useI18n } from '../i18n/context';
import type { AxtermMessageKey } from '../i18n/core';
import { useWorkspace } from '../stores/workspace';
import { ActivityRailSettingsPanel } from './activity-rail-settings-panel';
import { parseAiBookmarkDraft } from './ai-bookmark-draft';
import { BatchOperationWorkspace } from './batch-operations/batch-operation-workspace';
import { BehaviorSettingsPanel } from './behavior-settings-panel';
import { BookmarkQuickCommandsEditor } from './bookmarks/bookmark-quick-commands-editor';
import { BookmarkTriggersEditor } from './bookmarks/bookmark-triggers-editor';
import './bookmarks/ssh-bookmark-form.css';
import { CommandHistorySettingsPanel } from './command-history/command-history-settings-panel';
import { ConnectionProfilesPanel } from './connection-profiles/connection-profiles-panel';
import { DataMigrationPanel } from './data-migration/data-migration-panel';
import { DataSyncPanel } from './data-sync/data-sync-panel';
import { LanguageSettingsPanel } from './language-settings-panel';
import { LegalNoticesPanel } from './legal-notices-panel';
import { maskHostAddress } from './privacy';
import {
  normalizeProxyUsername,
  proxyCredentialRefs,
  retainedProxyCredentialRef,
} from './proxy-settings-model';
import { HostProxyFields, ProxySettingsPanel } from './proxy-settings-panel';
import { QuickCommandWorkspace } from './quick-commands/quick-command-workspace';
import {
  filterSettingsCategories,
  moveSettingsCategory,
  type SettingsCategoryId,
} from './settings-navigation';
import { PrivacySettingsPanel } from './settings/privacy-settings-panel';
import { RuntimeDiagnosticsPanel } from './settings/runtime-diagnostics-panel';
import { ShortcutSettingsPanel } from './shortcuts/shortcut-settings-panel';
import { SshConfigImportDialog } from './ssh-config-import/ssh-config-import-dialog';
import { TabPreferencesPanel } from './tab-preferences-panel';
import { TerminalRecoverySettingsPanel } from './terminal-recovery-settings-panel';
import { TerminalThemeWorkspace } from './terminal-themes/terminal-theme-workspace';
import { TriggerWorkspace } from './triggers/trigger-workspace';
import { messageOf } from './ui/format';
import { EmptyState, ErrorBanner, Modal, PanelFrame } from './ui/panel-scaffold';
import { WidgetWorkspace } from './widgets/widget-workspace';
import { WindowPreferencesPanel } from './window-preferences-panel';

type Client = ReturnType<typeof createRuntimeClient>;
type Translator = ReturnType<typeof useI18n>['x'];
type HostFormTab = 'auth' | 'settings' | 'quickCommands' | 'triggers' | 'tunnels' | 'hops';
type HostAuthType = Host['authType'];

export function HostsPanel({
  managerContainer,
  managerActive,
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
  managerContainer: HTMLElement | null;
  managerActive: boolean;
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
  const active =
    managerActive ||
    editing ||
    requestedCreate ||
    !!requestedBookmark ||
    !!requestedQuickConnect ||
    ftpEditing !== undefined ||
    telnetEditing !== undefined ||
    serialEditing !== undefined ||
    rdpEditing !== undefined ||
    vncEditing !== undefined ||
    spiceEditing !== undefined ||
    webEditing !== undefined ||
    aiBookmarkOpen ||
    !!connecting ||
    !!importGrant;
  const terminalProfiles = useQuery({
    queryKey: ['terminal-profiles'],
    queryFn: client.terminalProfiles,
    enabled: active,
  });
  const connectionProfiles = useQuery({
    queryKey: ['connection-profiles'],
    queryFn: client.connectionProfiles,
    enabled: active,
  });
  const tunnelProfiles = useQuery({
    queryKey: ['tunnel-profiles'],
    queryFn: client.tunnelProfiles,
    enabled: active,
  });
  const serialPorts = useQuery({
    queryKey: ['serial-ports'],
    queryFn: client.serialPorts,
    enabled: active,
    retry: false,
  });
  const tunnels = useQuery({
    queryKey: ['tunnels'],
    queryFn: client.tunnels,
    enabled: active,
    refetchInterval: active ? 1_500 : false,
  });
  const addTerminal = useWorkspace((state) => state.addTerminal);
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
        if (!proxyUsername && proxyPassword)
          throw new HostFormInputError(x('hosts.proxyUsernameRequired'));
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
        if (proxyUsername && !proxyCredentialRef)
          throw new HostFormInputError(x('hosts.proxyPasswordRequired'));
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
        if (!tree || !bookmark) throw new HostFormInputError(x('hosts.sshBookmarkMissing'));
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
        if (!tree) throw new HostFormInputError(x('hosts.treeUnavailable'));
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
      setError(cause instanceof HostFormInputError ? cause.message : x('hosts.operationFailed'));
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
    setError('');
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

  return (
    <>
      {managerContainer &&
        createPortal(
          <PanelFrame
            eyebrow={x('hosts.eyebrow')}
            title={x('hosts.title')}
            description={x('hosts.description')}
            action={
              <div className="toolbar host-manager-toolbar">
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
            {error && !editorOpen && <ErrorBanner text={error} />}
            <div className="host-filter-bar">
              <div className="group-strip" role="group" aria-label={x('hosts.groups')}>
                <button
                  className={!activeGroupId ? 'active' : ''}
                  aria-pressed={!activeGroupId}
                  onClick={() => setActiveGroupId(undefined)}
                >
                  {x('hosts.all')} <small>{hosts.length}</small>
                </button>
                {bookmarkTree?.groups.map((group) => (
                  <button
                    className={activeGroupId === group.id ? 'active' : ''}
                    key={group.id}
                    aria-pressed={activeGroupId === group.id}
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
                    (item.connectionProfileId ?? null) ===
                      (bookmark?.connectionProfileId ?? null) &&
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
                        {host.username}@
                        {hideAddresses ? maskHostAddress(host.hostname) : host.hostname}:{host.port}
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
                      {hideAddresses
                        ? maskHostAddress(bookmark.ftp!.hostname)
                        : bookmark.ftp!.hostname}
                      :{bookmark.ftp!.port}
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
                      {hideAddresses
                        ? maskHostAddress(bookmark.rdp!.hostname)
                        : bookmark.rdp!.hostname}
                      :{bookmark.rdp!.port}
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
                      {hideAddresses
                        ? maskHostAddress(bookmark.vnc!.hostname)
                        : bookmark.vnc!.hostname}
                      :{bookmark.vnc!.port}
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
          </PanelFrame>,
          managerContainer,
        )}
      {error && !editorOpen && !managerActive && (
        <Modal title={x('hosts.title')} onClose={() => setError('')}>
          <ErrorBanner text={error} />
        </Modal>
      )}
      {editorOpen && (
        <Modal
          className="host-bookmark-modal"
          title={activeEditingHost ? x('hosts.editSshHost') : x('hosts.addSshHost')}
          onClose={closeEditor}
        >
          <form
            className="form-grid host-protocol-form"
            data-active-tab={hostFormTab}
            key={activeEditingBookmark?.id ?? 'new'}
            noValidate
            onSubmit={(event) => void createHost(event)}
          >
            {error && (
              <div className="full-field">
                <ErrorBanner text={error} />
              </div>
            )}
            <section
              aria-label={x('hosts.connectionProtocol')}
              className="host-bookmark-dialog-intro full-field"
            >
              <div className="host-bookmark-dialog-summary">
                <div>
                  <strong>{x('hosts.protocolSsh')}</strong>
                  <p>{x('hosts.protocolSwitchHint')}</p>
                </div>
                <button type="button" onClick={() => setAiBookmarkOpen(true)}>
                  <Bot size={13} /> {x('aiBookmark.create')}
                </button>
              </div>
              <nav className="host-bookmark-protocols" aria-label={x('hosts.connectionProtocol')}>
                <button
                  aria-current="page"
                  className="active"
                  data-bookmark-protocol="ssh"
                  type="button"
                >
                  {x('hosts.protocolSsh')}
                </button>
                {(
                  [
                    ['telnet', x('hosts.protocolTelnet')],
                    ['serial', x('hosts.protocolSerial')],
                    ['local', x('hosts.protocolLocal')],
                    ['vnc', x('hosts.protocolVnc')],
                    ['rdp', x('hosts.protocolRdp')],
                    ['ftp', x('hosts.protocolFtp')],
                    ['web', x('hosts.protocolWeb')],
                    ['spice', x('hosts.protocolSpice')],
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
              </nav>
            </section>
            <div
              className="host-form-tabs full-field"
              role="tablist"
              aria-label={x('hosts.bookmarkSettings')}
            >
              {(
                [
                  ['auth', x('hosts.auth')],
                  ['settings', x('hosts.settings')],
                ] as const
              ).map(([tab, label]) => (
                <button
                  aria-label={label}
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
                {x('hosts.bookmarkQuickCommands')}
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
                {x('hosts.bookmarkTriggers')}
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
                {x('hosts.sshTunnels')}
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
                {x('hosts.jumpHosts')}
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
            <div className="host-form-field host-field-category" data-tab="auth settings">
              <label>
                {x('hosts.group')}
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
              <button
                aria-label={x('hosts.newGroup')}
                title={x('hosts.newGroup')}
                type="button"
                onClick={onCreateBookmarkGroup}
              >
                <Plus size={14} />
              </button>
            </div>
            <label className="host-form-field host-field-title" data-tab="auth">
              {x('hosts.displayName')}
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
              {x('hosts.address')}
              <input
                aria-label={x('hosts.address')}
                name="hostname"
                placeholder={x('hosts.addressPlaceholder')}
                required
                defaultValue={activeEditingHost?.hostname}
              />
            </label>
            <label className="host-form-field host-field-username" data-tab="auth">
              {x('hosts.username')}
              <input
                aria-label={x('hosts.username')}
                name="username"
                required
                defaultValue={activeEditingHost?.username}
              />
            </label>
            <div className="host-form-field host-auth-selector" data-tab="auth">
              <span>{x('hosts.authMethod')}</span>
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
                  {x('hosts.password')}
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
                  {x('hosts.privateKey')}
                </button>
                <button
                  aria-pressed={useConnectionProfile}
                  className={useConnectionProfile ? 'active' : ''}
                  onClick={() => setUseConnectionProfile(true)}
                  type="button"
                >
                  {x('hosts.connectionProfile')}
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
                <option value="keyboardInteractive">{x('hosts.authInteractive')}</option>
                <option value="agent">{x('hosts.authAgent')}</option>
              </select>
            </div>
            {useConnectionProfile ? (
              <label className="host-form-field host-field-profile" data-tab="auth">
                {x('hosts.connectionProfile')}
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
                <i>*</i> {x('hosts.port')}
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
                {x('hosts.privateKey')}
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
                {x('hosts.password')}
                <input
                  aria-label={x('hosts.password')}
                  name="password"
                  type="password"
                  autoComplete="new-password"
                  placeholder={
                    activeEditingHost?.credentialRef
                      ? x('hosts.savedSecretPlaceholder')
                      : x('hosts.password')
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
              <span>{x('hosts.useAgent')}</span>
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
                  aria-label={x('hosts.sshAgentPath')}
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
              <span>{x('hosts.mfaOtp')}</span>
              <button
                aria-checked={hostAuthType === 'keyboardInteractive'}
                aria-label={x('hosts.mfaOtp')}
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
    </>
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
    } catch {
      if (createdCredentialRef) await client.deleteCredential(createdCredentialRef).catch(() => {});
      setError(x('protocolBookmark.operationFailed'));
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
      <form
        className="form-grid protocol-bookmark-form"
        data-protocol="ftp"
        onSubmit={(event) => void save(event)}
      >
        {error && <ErrorBanner text={error} />}
        <label>
          {x('protocolBookmark.name')}
          <input
            data-autofocus
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
      <form
        className="form-grid protocol-bookmark-form"
        data-protocol="telnet"
        onSubmit={(event) => void save(event)}
      >
        {error && <ErrorBanner text={error} />}
        <label>
          {x('protocolBookmark.name')}
          <input
            data-autofocus
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
      <form
        className="form-grid protocol-bookmark-form"
        data-protocol="serial"
        onSubmit={(event) => void save(event)}
      >
        {error && <ErrorBanner text={error} />}
        <label>
          {x('protocolBookmark.name')}
          <input
            data-autofocus
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
      <form
        className="form-grid protocol-bookmark-form"
        data-protocol="rdp"
        onSubmit={(event) => void save(event)}
      >
        {error && <ErrorBanner text={error} />}
        <label>
          {x('protocolBookmark.name')}
          <input
            data-autofocus
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
      <form
        className="form-grid protocol-bookmark-form"
        data-protocol="vnc"
        onSubmit={(event) => void save(event)}
      >
        {error && <ErrorBanner text={error} />}
        <label>
          {x('protocolBookmark.name')}
          <input
            data-autofocus
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
      <form
        className="form-grid protocol-bookmark-form"
        data-protocol="spice"
        onSubmit={(event) => void save(event)}
      >
        {error && <ErrorBanner text={error} />}
        <label>
          {x('protocolBookmark.name')}
          <input
            data-autofocus
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
      <form
        className="form-grid protocol-bookmark-form"
        data-protocol="web"
        onSubmit={(event) => void save(event)}
      >
        {error && <ErrorBanner text={error} />}
        <label>
          {x('protocolBookmark.name')}
          <input
            data-autofocus
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
    if (separator <= 0)
      throw new HostFormInputError(x('hosts.environmentLineInvalid', { line: index + 1 }));
    const name = source.slice(0, separator).trim();
    if (name in environment)
      throw new HostFormInputError(x('hosts.environmentDuplicate', { name }));
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
      await updater.refetch();
    } catch (cause) {
      setMessage(messageOf(cause));
    } finally {
      if (action !== 'cancel') setUpdaterAction(undefined);
    }
  }
  async function setDefaultTerminalProfile(defaultProfileId: string | null) {
    if (!settings.data) return;
    setMessage('');
    try {
      await client.updateSettings(settings.data, { terminal: { defaultProfileId } });
      await settings.refetch();
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
          aria-current={settingsTab === 'setting' ? 'page' : undefined}
          className={settingsTab === 'setting' ? 'active' : ''}
          type="button"
          onClick={() => setSettingsTab('setting')}
        >
          {t('setting', 'Setting')}
        </button>
        <button
          aria-current={settingsTab === 'themes' ? 'page' : undefined}
          className={settingsTab === 'themes' ? 'active' : ''}
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
          aria-current={settingsTab === 'profiles' ? 'page' : undefined}
          className={settingsTab === 'profiles' ? 'active' : ''}
          type="button"
          onClick={() => setSettingsTab('profiles')}
        >
          {t('profiles', 'Profiles')}
        </button>
        <button
          aria-current={settingsTab === 'widgets' ? 'page' : undefined}
          className={settingsTab === 'widgets' ? 'active' : ''}
          type="button"
          onClick={() => setSettingsTab('widgets')}
        >
          {x('settings.widgets')} <sup>{x('settings.beta')}</sup>
        </button>
        <button
          type="button"
          data-settings-destination="tunnels"
          onClick={() => showSection('tunnels')}
        >
          {x('app.tunnels')}
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
                document.querySelector('.data-migration-panel')?.scrollIntoView(),
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
            eyebrow={t('setting', 'SETTING')}
            title={
              settingsItem === 'common'
                ? t('common', 'Common')
                : settingsItem === 'legal'
                  ? x('legal.title')
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
                ? x('settings.generalDescription')
                : settingsItem === 'legal'
                  ? x('legal.description')
                  : settingsItem === 'terminal'
                    ? x('settings.terminalDescription')
                    : settingsItem === 'shortcuts'
                      ? x('settings.shortcutsDescription')
                      : settingsItem === 'ai'
                        ? x('settings.aiDescription')
                        : x('settings.categoryDescription')
            }
          >
            {settings.isError && !settings.data && (
              <div className="surface stack settings-load-error" role="alert">
                <p>{x('settings.loadFailed')}</p>
                <button type="button" onClick={() => void settings.refetch()}>
                  {x('settings.retryLoad')}
                </button>
              </div>
            )}
            {settingsItem === 'legal' && <LegalNoticesPanel />}
            {settingsItem === 'common' && (
              <>
                <LanguageSettingsPanel client={client} />
                {updater.data && (
                  <section className="surface updater-panel" aria-label={x('settings.updater')}>
                    <header>
                      <div>
                        <small>{x('settings.updater')}</small>
                        <h2>{updaterStateLabel(updater.data.state, x)}</h2>
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
                <PrivacySettingsPanel client={client} />
                <section
                  className="settings-preference-group"
                  aria-labelledby="settings-appearance-group"
                >
                  <h2 id="settings-appearance-group">{x('settings.appearanceGroup')}</h2>
                  <WindowPreferencesPanel client={client} />
                  <TabPreferencesPanel client={client} />
                  <ActivityRailSettingsPanel client={client} />
                  <BehaviorSettingsPanel client={client} />
                </section>
                <section
                  className="settings-preference-group"
                  aria-labelledby="settings-connection-group"
                >
                  <h2 id="settings-connection-group">{x('settings.connectionGroup')}</h2>
                  <ProxySettingsPanel client={client} />
                  <KnownHostKeysPanel client={client} />
                </section>
                <DataMigrationPanel client={client} />
                <RuntimeDiagnosticsPanel client={client} />
              </>
            )}
            {settingsItem === 'shortcuts' && (
              <div className="stack shortcut-settings-stack">
                <ShortcutSettingsPanel client={client} />
                <CommandHistorySettingsPanel client={client} />
              </div>
            )}
            {settingsItem === 'terminal' && (
              <section
                className="surface stack terminal-default-profile-settings"
                aria-labelledby="terminal-default-profile-title"
              >
                <h2 id="terminal-default-profile-title">{x('shell.terminalProfile')}</h2>
                <label className="field compact-field">
                  <span>{x('terminalRecovery.defaultProfile')}</span>
                  <select
                    aria-label={x('terminalRecovery.defaultProfile')}
                    value={settings.data?.terminal.defaultProfileId ?? ''}
                    disabled={!settings.data || settings.isFetching || profiles.isLoading}
                    onChange={(event) => void setDefaultTerminalProfile(event.target.value || null)}
                  >
                    <option value="">{x('terminalRecovery.platformDefault')}</option>
                    {settings.data?.terminal.defaultProfileId &&
                      !profiles.data?.some(
                        (profile) => profile.id === settings.data?.terminal.defaultProfileId,
                      ) && (
                        <option value={settings.data.terminal.defaultProfileId} disabled>
                          {x('terminalRecovery.deletedProfile')}
                        </option>
                      )}
                    {profiles.data?.map((profile) => (
                      <option key={profile.id} value={profile.id}>
                        {profile.name}
                      </option>
                    ))}
                  </select>
                  <small className="hint">{x('terminalRecovery.profileHint')}</small>
                </label>
              </section>
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
  const [missingHostKeyConfirmationId, setMissingHostKeyConfirmationId] = useState<string>();
  const interactions = useQuery({
    queryKey: ['interactions'],
    queryFn: client.interactions,
    refetchInterval: 500,
  });
  const current = interactions.data?.[0];
  if (!current) return null;
  const hostKeyInteraction = current.kind === 'unknownHostKey' || current.kind === 'changedHostKey';
  const hostKeyPresentation =
    current.presentation?.kind === 'sshHostKey' ? current.presentation : undefined;
  const keyboardPresentation =
    current.presentation?.kind === 'keyboardInteractive' ? current.presentation : undefined;
  const interactionTitle = hostKeyPresentation
    ? x(
        current.kind === 'changedHostKey'
          ? 'interaction.changedHostKeyTitle'
          : 'interaction.unknownHostKeyTitle',
      )
    : keyboardPresentation
      ? x('interaction.keyboardTitle', {
          name: keyboardPresentation.challengeName || x('interaction.keyboardDefaultName'),
          attempt: keyboardPresentation.attempt,
        })
      : current.title;
  const target = hostKeyPresentation ?? keyboardPresentation;
  const targetLabel = target ? `${target.username}@${target.hostname}:${target.port}` : undefined;
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
    <Modal
      className={
        hostKeyPresentation
          ? `interaction-modal host-key-interaction-modal ${current.kind === 'changedHostKey' ? 'changed' : 'unknown'}`
          : keyboardPresentation
            ? 'interaction-modal keyboard-interaction-modal'
            : 'interaction-modal'
      }
      title={interactionTitle}
      onClose={() => void respond(false)}
    >
      <form
        key={current.id}
        className="stack"
        data-interaction-kind={current.kind}
        onSubmit={(event) => {
          event.preventDefault();
          const data = new FormData(event.currentTarget);
          const remember = data.get('remember') === 'on';
          if (current.kind === 'changedHostKey' && !remember) {
            setMissingHostKeyConfirmationId(current.id);
            return;
          }
          setMissingHostKeyConfirmationId(undefined);
          const values = Object.fromEntries(
            current.fields.map((field) => [field.id, String(data.get(field.id) ?? '')]),
          );
          void respond(true, remember, values);
        }}
      >
        {hostKeyPresentation ? (
          <section
            className="host-key-interaction-detail"
            role={current.kind === 'changedHostKey' ? 'alert' : 'status'}
            aria-label={
              current.kind === 'changedHostKey'
                ? x('interaction.hostKeyChangedSummary')
                : x('interaction.hostKeyUnknownSummary')
            }
          >
            <div className="host-key-interaction-summary">
              <ShieldAlert aria-hidden="true" size={18} />
              <strong>
                {current.kind === 'changedHostKey'
                  ? x('interaction.hostKeyChangedSummary')
                  : x('interaction.hostKeyUnknownSummary')}
              </strong>
              {current.kind === 'changedHostKey' ? (
                <span>{x('interaction.hostKeyHighRisk')}</span>
              ) : null}
            </div>
            <dl>
              <div>
                <dt>{x('interaction.hostKeyTarget')}</dt>
                <dd>
                  <code dir="ltr">{targetLabel}</code>
                </dd>
              </div>
              <div>
                <dt>{x('interaction.hostKeyAlgorithm')}</dt>
                <dd>
                  <code dir="ltr">{hostKeyPresentation.algorithm}</code>
                </dd>
              </div>
              {hostKeyPresentation.previousFingerprint ? (
                <div>
                  <dt>{x('interaction.hostKeySavedFingerprint')}</dt>
                  <dd>
                    <code dir="ltr">{hostKeyPresentation.previousFingerprint}</code>
                  </dd>
                </div>
              ) : null}
              <div>
                <dt>
                  {x(
                    hostKeyPresentation.previousFingerprint
                      ? 'interaction.hostKeyPresentedFingerprint'
                      : 'interaction.hostKeyFingerprint',
                  )}
                </dt>
                <dd>
                  <code dir="ltr">{hostKeyPresentation.fingerprint}</code>
                </dd>
              </div>
            </dl>
            <p>
              {x(
                current.kind === 'changedHostKey'
                  ? 'interaction.hostKeyChangedGuidance'
                  : 'interaction.hostKeyVerifyGuidance',
              )}
            </p>
          </section>
        ) : keyboardPresentation ? (
          <section className="keyboard-interaction-detail">
            <code dir="ltr">{targetLabel}</code>
            {keyboardPresentation.instructions ? <p>{keyboardPresentation.instructions}</p> : null}
            <p>{x('interaction.keyboardSummary', { count: keyboardPresentation.promptCount })}</p>
          </section>
        ) : (
          <p className={current.severity === 'high' ? 'danger-text' : ''}>{current.detail}</p>
        )}
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
              defaultChecked={current.kind !== 'changedHostKey'}
              type="checkbox"
              name="remember"
              aria-invalid={missingHostKeyConfirmationId === current.id ? 'true' : undefined}
              aria-describedby={
                missingHostKeyConfirmationId === current.id
                  ? `host-key-confirmation-error-${current.id}`
                  : undefined
              }
              onChange={(event) => {
                if (event.currentTarget.checked) setMissingHostKeyConfirmationId(undefined);
              }}
            />{' '}
            {current.kind === 'changedHostKey'
              ? x('interaction.confirmChangedHostKey')
              : x('interaction.rememberHostKey')}
          </label>
        )}
        {current.kind === 'changedHostKey' && missingHostKeyConfirmationId === current.id ? (
          <p
            className="host-key-confirmation-error"
            id={`host-key-confirmation-error-${current.id}`}
            role="alert"
          >
            {x('interaction.confirmChangedHostKeyRequired')}
          </p>
        ) : null}
        <div className="modal-actions">
          <button
            data-autofocus={hostKeyInteraction ? '' : undefined}
            type="button"
            disabled={submitting}
            onClick={() => void respond(false)}
          >
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
class HostFormInputError extends Error {}
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
