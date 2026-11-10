import { formatSshHostFailure, sshHostErrorMessage } from './ssh-host-error.ts';
import { useState, useRef, useEffect, useSyncExternalStore, type FormEvent } from 'react';
import { Bot, Plus, Save, Play, LoaderCircle } from 'lucide-react';
import { Dialog, DialogContent, DialogTitle } from '@axterm/ui/controls';
import {
  DEFAULT_SSH_CONNECTION_OPTIONS,
  type CreateSshBookmarkInput,
  type Host,
  type Bookmark,
  type CatalogReceipt,
} from '@axterm/plugin-api/catalog';
import type {
  ConnectionClientActions,
  SshAgentStatus,
  HostProxyConfig,
  CreateConnectionInput,
} from '@axterm/plugin-api/connections';
import type { TerminalFactsView } from '@axterm/plugin-api/terminals';
import type { WorkspaceUi, ConnectionWorkspaceUi, TunnelWorkspaceUi } from '@axterm/ui/workspace';
import { useI18n } from '../i18n.tsx';
import type { SshSaveWorkflow } from './ssh-save-workflow.ts';
import { type SshCredentialDraft } from './ssh-save-workflow.ts';
import type { EditorOperations } from './operations.ts';
import { HostProxyFields } from './proxy-fields.tsx';
import { normalizeProxyUsername, retainedProxyCredentialRef } from './proxy-model.ts';
import { HostTunnelFields } from './tunnel-fields.tsx';
import { BookmarkQuickCommandsEditor } from './bookmark-quick-commands-editor.tsx';
import { BookmarkTriggersEditor } from './bookmark-triggers-editor.tsx';
import {
  SshAlgorithmField,
  SshStartupFields,
  HostJumpChainFields,
  HostFormInputError,
  parseSshStartupEnvironment,
  readSshStartupScripts,
  SSH_KEX_OPTIONS,
  SSH_CIPHER_OPTIONS,
  SSH_HOST_KEY_OPTIONS,
  SSH_HMAC_OPTIONS,
} from './ssh-fields.tsx';
import type { CatalogModel } from '../../index.ts';
import styles from './editor.module.css';
const classes = (value: string) =>
  value
    .split(/\s+/u)
    .filter(Boolean)
    .map((name) => name + ' ' + (styles[name] ?? ''))
    .join(' ');
type HostFormTab = 'auth' | 'settings' | 'quickCommands' | 'triggers' | 'tunnels' | 'hops';
type HostAuthType = Host['authType'];
export interface SshEditorServices {
  readonly catalog: CatalogModel;
  readonly connections: ConnectionClientActions;
  readonly terminals: TerminalFactsView;
  readonly workspace: WorkspaceUi;
  readonly connectionWorkspace: ConnectionWorkspaceUi;
  readonly tunnels?: TunnelWorkspaceUi;
}
export function SshBookmarkEditor({
  services,
  workflow,
  operations,
  host: activeEditingHost,
  bookmark: activeEditingBookmark,
  onClose,
  onCreateBookmarkGroup,
  onProtocol,
  onSaved,
}: {
  services: SshEditorServices;
  workflow: SshSaveWorkflow;
  operations: EditorOperations;
  host?: Host;
  bookmark?: Bookmark;
  onClose(): void;
  onCreateBookmarkGroup(): void;
  onProtocol(protocol: Bookmark['protocol']): void;
  onSaved(
    receipt: CatalogReceipt,
    action: string,
    temporary: Pick<
      CreateConnectionInput,
      'temporarySecret' | 'temporaryPassphrase' | 'temporaryCertificate' | 'connectionProfileId'
    >,
  ): Promise<void>;
}) {
  const { x } = useI18n();
  const facts = useSyncExternalStore(services.catalog.subscribe, services.catalog.getSnapshot);
  const connectionFacts = useSyncExternalStore(
    services.connections.subscribe,
    services.connections.getSnapshot,
  );
  const terminalFacts = useSyncExternalStore(
    services.terminals.subscribe,
    services.terminals.getSnapshot,
  );
  const saveState = useSyncExternalStore(workflow.subscribe, workflow.getSnapshot);
  const auxiliary = useSyncExternalStore(operations.subscribe, operations.getSnapshot);
  const [hostFormTab, setHostFormTab] = useState<HostFormTab>('auth');
  const [hostAuthType, setHostAuthType] = useState<HostAuthType>(
    activeEditingHost?.authType === 'agent'
      ? 'password'
      : (activeEditingHost?.authType ?? 'password'),
  );
  const [preferSshAgent, setPreferSshAgent] = useState(activeEditingHost?.sshAgent.enabled ?? true);
  const [sshAgentPath, setSshAgentPath] = useState(activeEditingHost?.sshAgent.path ?? '');
  const [sshAgentStatus, setSshAgentStatus] = useState<SshAgentStatus>();
  const [useConnectionProfile, setUseConnectionProfile] = useState(
    !!activeEditingBookmark?.connectionProfileId,
  );
  const [bookmarkQuickCommands, setBookmarkQuickCommands] = useState(
    activeEditingBookmark?.quickCommands ?? [],
  );
  const [bookmarkTriggers, setBookmarkTriggers] = useState(activeEditingBookmark?.triggers ?? []);
  const [error, setError] = useState('');
  const [overwritePrompt, setOverwritePrompt] = useState<Host>();
  const overwriteDecision = useRef<(value: boolean) => void>();
  const cancelOverwrite = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (overwritePrompt) cancelOverwrite.current?.focus();
  }, [overwritePrompt]);
  function decideOverwrite(value: boolean) {
    overwriteDecision.current?.(value);
  }
  function confirmOverwrite(host: Host): Promise<boolean> {
    return operations.admit(
      (signal) =>
        new Promise<boolean>((resolve) => {
          const finish = (value: boolean) => {
            signal.removeEventListener('abort', abort);
            overwriteDecision.current = undefined;
            setOverwritePrompt(undefined);
            resolve(value);
          };
          const abort = () => finish(false);
          overwriteDecision.current = finish;
          signal.addEventListener('abort', abort, { once: true });
          if (signal.aborted) abort();
          else setOverwritePrompt(host);
        }),
    );
  }

  const formRef = useRef<HTMLFormElement>(null);
  const submit = useRef<{
    action: string;
    temporary: Pick<
      CreateConnectionInput,
      'temporarySecret' | 'temporaryPassphrase' | 'temporaryCertificate' | 'connectionProfileId'
    >;
  }>();
  const savingBookmark =
    saveState.status === 'running' ||
    saveState.status === 'uncertain' ||
    saveState.status === 'completed' ||
    auxiliary.busy ||
    auxiliary.uncertain;
  const probingSshAgent = auxiliary.busy;
  if (
    facts.status !== 'ready' ||
    connectionFacts.status !== 'ready' ||
    terminalFacts.status !== 'ready' ||
    facts.baseline.generation !== connectionFacts.baseline.generation ||
    facts.baseline.generation !== terminalFacts.baseline.generation
  )
    return <p role="status">{x('history.loading')}</p>;
  const bookmarkTree = facts.baseline.bookmarks,
    hosts = [...facts.baseline.hosts],
    terminalProfiles = terminalFacts.baseline.profiles,
    connectionProfiles = facts.baseline.connectionProfiles,
    activeGroupId = activeEditingBookmark?.groupId;
  const closeEditor = () => {
    if (overwritePrompt) {
      decideOverwrite(false);
      return;
    }
    if (!savingBookmark) onClose();
  };
  const openProtocolBookmarkEditor = (protocol: Bookmark['protocol']) => {
    if (!savingBookmark) onProtocol(protocol);
  };
  async function probeAgent() {
    try {
      setError('');
      setSshAgentStatus(
        await operations.admit(() =>
          services.connections.sshAgentStatus({ path: sshAgentPath.trim() || undefined }),
        ),
      );
    } catch {
      setError(x('common.operationFailed'));
    }
  }
  async function finish() {
    const state = workflow.getSnapshot();
    if (state.status === 'completed' && state.receipt && submit.current) {
      const selected = submit.current;
      submit.current = undefined;
      if (formRef.current)
        for (const name of ['password', 'passphrase', 'certificate', 'proxyPassword']) {
          const field = formRef.current.elements.namedItem(name);
          if (field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement)
            field.value = '';
        }
      try {
        await onSaved(state.receipt, selected.action, selected.temporary);
      } catch (error) {
        setError(sshHostErrorMessage(error, 'connect', x));
      }
    }
  }
  async function retry() {
    try {
      if (auxiliary.uncertain) await operations.retry();
      else {
        await workflow.retry();
        await finish();
      }
    } catch {
      setError(x('common.operationFailed'));
    }
  }
  async function createHost(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (savingBookmark) return;
    const element = event.currentTarget;
    if (!element.checkValidity()) {
      const invalid = [...element.elements].find(
        (field) =>
          (field instanceof HTMLInputElement ||
            field instanceof HTMLSelectElement ||
            field instanceof HTMLTextAreaElement) &&
          !field.validity.valid,
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
      requestAnimationFrame(() => element.reportValidity());
      return;
    }
    const form = new FormData(element);
    const action =
      ((event.nativeEvent as SubmitEvent).submitter as HTMLButtonElement | null)?.value ?? 'save';
    setError('');
    try {
      const password = String(form.get('password') ?? ''),
        passphrase = String(form.get('passphrase') ?? ''),
        certificate = String(form.get('certificate') ?? ''),
        save = form.get('save') === 'on';
      const selectedAuthType = String(form.get('authType')) as HostAuthType;
      const authType =
        selectedAuthType === 'password' &&
        preferSshAgent &&
        !password &&
        !activeEditingHost?.credentialRef
          ? 'agent'
          : selectedAuthType;
      const keepExistingCredential = activeEditingHost?.authType === authType;
      const credentials: SshCredentialDraft[] = [];
      if (password && save)
        credentials.push({
          field: 'credentialRef',
          input: {
            kind: authType === 'privateKey' ? 'privateKey' : 'sshPassword',
            label: (String(form.get('name')) + ' SSH').slice(0, 100),
            secret: password,
          },
        });
      if (passphrase && save)
        credentials.push({
          field: 'passphraseCredentialRef',
          input: {
            kind: 'privateKeyPassphrase',
            label: (String(form.get('name')) + ' key passphrase').slice(0, 100),
            secret: passphrase,
          },
        });
      if (certificate && save)
        credentials.push({
          field: 'certificateCredentialRef',
          input: {
            kind: 'sshCertificate',
            label: (String(form.get('name')) + ' SSH certificate').slice(0, 100),
            secret: certificate,
          },
        });
      const proxyMode = String(form.get('proxyMode') ?? 'inherit') as HostProxyConfig['mode'];
      let proxy: HostProxyConfig =
        proxyMode === 'direct' ? { mode: 'direct' } : { mode: 'inherit' };
      if (proxyMode === 'custom') {
        const username = normalizeProxyUsername(String(form.get('proxyUsername') ?? '')),
          secret = String(form.get('proxyPassword') ?? '');
        if (!username && secret) throw new HostFormInputError(x('hosts.proxyUsernameRequired'));
        const ref = username
          ? retainedProxyCredentialRef(activeEditingHost?.proxy, username)
          : null;
        if (username && !secret && !ref)
          throw new HostFormInputError(x('hosts.proxyPasswordRequired'));
        proxy = {
          mode: 'custom',
          endpoint: {
            url: String(form.get('proxyUrl') ?? '').trim(),
            username,
            credentialRef: ref,
          },
        };
        if (username && secret)
          credentials.push({
            field: 'proxy',
            input: {
              kind: 'proxyPassword',
              label: x('hosts.proxyCredentialLabel', { name: String(form.get('name')) }).slice(
                0,
                100,
              ),
              secret,
            },
          });
      } else if (proxyMode === 'command') {
        proxy = {
          mode: 'command',
          command: {
            executable: String(form.get('proxyCommandExecutable') ?? '').trim(),
            arguments: String(form.get('proxyCommandArguments') ?? '')
              .split(/\r?\n/u)
              .map((value) => value.trim())
              .filter(Boolean),
          },
        };
      }
      const input = {
        name: String(form.get('name')),
        hostname: String(form.get('hostname')),
        username: String(form.get('username')),
        port: Number(form.get('port')),
        authType,
        credentialRef: (keepExistingCredential ? activeEditingHost?.credentialRef : null) ?? null,
        passphraseCredentialRef:
          authType === 'privateKey'
            ? ((keepExistingCredential ? activeEditingHost?.passphraseCredentialRef : null) ?? null)
            : null,
        certificateCredentialRef:
          authType === 'privateKey'
            ? ((keepExistingCredential ? activeEditingHost?.certificateCredentialRef : null) ??
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
      const draft: CreateSshBookmarkInput = {
        host: input,
        bookmark: {
          groupId: String(form.get('groupId') || '') || null,
          title: String(form.get('bookmarkTitle') || '').trim() || input.name,
          color: String(form.get('color') || '').trim() || null,
          description: String(form.get('description') || ''),
          profileId: String(form.get('profileId') || '') || null,
          connectionProfileId: useConnectionProfile
            ? String(form.get('connectionProfileId') || '') || null
            : null,
          quickCommands: bookmarkQuickCommands,
          triggers: bookmarkTriggers,
        },
      };
      if (!activeEditingHost) {
        const current = services.catalog.getSnapshot();
        if (current.status !== 'ready') throw new Error('CATALOG_UNAVAILABLE');
        const existing = current.baseline.hosts.find((value) => value.name === input.name.trim());
        if (existing) {
          if (!(await confirmOverwrite(existing))) return;
          draft.overwrite = { hostId: existing.id, hostVersion: existing.version };
        }
      }
      submit.current = {
        action,
        temporary: save
          ? { connectionProfileId: draft.bookmark.connectionProfileId ?? undefined }
          : {
              connectionProfileId: draft.bookmark.connectionProfileId ?? undefined,
              temporarySecret: password || undefined,
              temporaryPassphrase: passphrase || undefined,
              temporaryCertificate: certificate || undefined,
            },
      };
      await workflow.start({
        input: draft,
        credentials,
        host: activeEditingHost,
        bookmark: activeEditingBookmark,
      });
      await finish();
    } catch (cause) {
      setError(
        cause instanceof HostFormInputError ? cause.message : sshHostErrorMessage(cause, 'save', x),
      );
    }
  }
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) closeEditor();
      }}
    >
      <DialogContent
        overlayClassName={classes('modal-backdrop')}
        asChild
        aria-describedby={undefined}
        onEscapeKeyDown={(event) => {
          if (savingBookmark) event.preventDefault();
        }}
        onInteractOutside={(event) => {
          if (savingBookmark) event.preventDefault();
        }}
      >
        <section className={classes(classes('modal host-bookmark-modal'))}>
          <header>
            <DialogTitle asChild>
              <h2>
                {x(
                  overwritePrompt
                    ? 'hosts.overwriteTitle'
                    : activeEditingHost
                      ? 'hosts.editSshHost'
                      : 'hosts.addSshHost',
                )}
              </h2>
            </DialogTitle>
            <button disabled={savingBookmark} onClick={closeEditor} aria-label={x('common.close')}>
              ×
            </button>
          </header>
          {(saveState.status === 'uncertain' || auxiliary.uncertain) && (
            <p role="alert">
              {x('sshConfigImport.uncertain')}{' '}
              <button
                disabled={auxiliary.busy || saveState.status === 'running'}
                onClick={() => void retry()}
              >
                {x('history.retryPending')}
              </button>
            </p>
          )}
          {saveState.status === 'failed' && (
            <p role="alert">
              {formatSshHostFailure(saveState.failure ?? { stage: 'save' }, x)}
              {saveState.retainedCredentials && ' ' + x('catalogEditor.savedCredentialsRetained')}
            </p>
          )}
          {overwritePrompt && (
            <div className={classes('ssh-overwrite-confirmation')}>
              <p>{x('hosts.overwriteMessage', { name: overwritePrompt.name })}</p>
              <p>{x('hosts.overwriteReferences')}</p>
              <div className={classes('modal-actions')}>
                <button ref={cancelOverwrite} type="button" onClick={() => decideOverwrite(false)}>
                  {x('common.cancel')}
                </button>
                <button
                  type="button"
                  className={classes('primary')}
                  onClick={() => decideOverwrite(true)}
                >
                  {x('hosts.overwriteConfirm')}
                </button>
              </div>
            </div>
          )}
          <form
            style={overwritePrompt ? { display: 'none' } : undefined}
            ref={formRef}
            className={classes('form-grid host-protocol-form')}
            data-active-tab={hostFormTab}
            key={activeEditingBookmark?.id ?? 'new'}
            noValidate
            onSubmit={(event) => void createHost(event)}
          >
            {error && (
              <div className={classes('full-field')}>
                <p role="alert">{error}</p>
              </div>
            )}
            <section
              aria-label={x('hosts.connectionProtocol')}
              className={classes('host-bookmark-dialog-intro full-field')}
            >
              <div className={classes('host-bookmark-dialog-summary')}>
                <div>
                  <strong>{x('hosts.protocolSsh')}</strong>
                  <p>{x('hosts.protocolSwitchHint')}</p>
                </div>
                <button
                  type="button"
                  onClick={() => {
                    void services.workspace
                      .invokeAction('ai-create-bookmark')
                      .catch(() => setError(x('common.operationFailed')));
                  }}
                >
                  <Bot size={13} /> {x('aiBookmark.create')}
                </button>
              </div>
              <nav
                className={classes('host-bookmark-protocols')}
                aria-label={x('hosts.connectionProtocol')}
              >
                <button
                  aria-current="page"
                  className={classes('active')}
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
              className={classes('host-form-tabs full-field')}
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
                  className={classes(hostFormTab === tab ? 'active' : '')}
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
                className={classes(hostFormTab === 'quickCommands' ? 'active' : '')}
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
                className={classes(hostFormTab === 'triggers' ? 'active' : '')}
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
                className={classes(hostFormTab === 'tunnels' ? 'active' : '')}
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
                className={classes(hostFormTab === 'hops' ? 'active' : '')}
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
              className={classes('host-form-tab-intro host-form-field full-field')}
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
            <div
              className={classes('host-form-field host-field-category')}
              data-tab="auth settings"
            >
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
            <label className={classes('host-form-field host-field-title')} data-tab="auth">
              {x('hosts.displayName')}
              <input
                aria-label={x('hosts.displayName')}
                name="name"
                required
                autoFocus
                defaultValue={activeEditingHost?.name}
              />
            </label>
            <label className={classes('host-form-field')} data-tab="settings">
              {x('hosts.bookmarkTitle')}
              <input
                name="bookmarkTitle"
                maxLength={100}
                placeholder={x('hosts.bookmarkTitlePlaceholder')}
                defaultValue={activeEditingBookmark?.title ?? ''}
              />
            </label>
            <label className={classes('host-form-field host-field-host')} data-tab="auth">
              {x('hosts.address')}
              <input
                aria-label={x('hosts.address')}
                name="hostname"
                placeholder={x('hosts.addressPlaceholder')}
                required
                defaultValue={activeEditingHost?.hostname}
              />
            </label>
            <label className={classes('host-form-field host-field-username')} data-tab="auth">
              {x('hosts.username')}
              <input
                aria-label={x('hosts.username')}
                name="username"
                required
                defaultValue={activeEditingHost?.username}
              />
            </label>
            <div className={classes('host-form-field host-auth-selector')} data-tab="auth">
              <span>{x('hosts.authMethod')}</span>
              <div role="group" aria-label={x('hosts.authType')}>
                <button
                  aria-pressed={!useConnectionProfile && hostAuthType === 'password'}
                  className={classes(
                    !useConnectionProfile && hostAuthType === 'password' ? 'active' : '',
                  )}
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
                  className={classes(
                    !useConnectionProfile && hostAuthType === 'privateKey' ? 'active' : '',
                  )}
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
                  className={classes(useConnectionProfile ? 'active' : '')}
                  onClick={() => setUseConnectionProfile(true)}
                  type="button"
                >
                  {x('hosts.connectionProfile')}
                </button>
              </div>
              <select
                aria-label={x('hosts.authMethod')}
                className={classes('host-auth-native-select')}
                aria-hidden="true"
                tabIndex={-1}
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
              <label className={classes('host-form-field host-field-profile')} data-tab="auth">
                {x('hosts.connectionProfile')}
                <select
                  aria-label={x('hosts.connectionProfile')}
                  name="connectionProfileId"
                  required
                  defaultValue={
                    activeEditingBookmark?.connectionProfileId ??
                    connectionProfiles?.find((profile) => profile.isDefault)?.id ??
                    ''
                  }
                >
                  <option value="" disabled>
                    {x('hosts.selectConnectionProfile')}
                  </option>
                  {connectionProfiles?.map((profile) => (
                    <option key={profile.id} value={profile.id}>
                      {profile.name}
                      {profile.isDefault ? x('hosts.defaultSuffix') : ''}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}
            <label className={classes('host-form-field host-field-port')} data-tab="auth">
              <span className={classes('host-required-label')}>
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
              className={classes('host-form-tab-intro host-form-field full-field')}
              data-tab="settings"
              id="ssh-bookmark-settings"
              role="tabpanel"
            >
              {x('hosts.settingsIntro')}
            </p>
            <label className={classes('host-form-field')} data-tab="settings">
              {x('hosts.terminalProfile')}
              <select name="profileId" defaultValue={activeEditingBookmark?.profileId ?? ''}>
                <option value="">{x('hosts.platformDefault')}</option>
                {terminalProfiles?.map((profile) => (
                  <option key={profile.id} value={profile.id}>
                    {profile.name}
                  </option>
                ))}
              </select>
            </label>
            <label className={classes('host-form-field')} data-tab="settings">
              {x('hosts.titleColor')}
              <input
                name="color"
                maxLength={7}
                pattern="^#[0-9a-fA-F]{6}$"
                placeholder={x('hosts.optionalColorPlaceholder')}
                defaultValue={activeEditingBookmark?.color ?? ''}
              />
            </label>
            <label className={classes('full-field host-form-field')} data-tab="settings">
              {x('hosts.descriptionField')}
              <textarea
                name="description"
                rows={3}
                maxLength={2000}
                defaultValue={activeEditingBookmark?.description ?? ''}
              />
            </label>
            <HostJumpChainFields
              key={`host-jump-chain:${activeEditingHost?.id ?? 'new'}`}
              host={activeEditingHost}
              hosts={hosts}
            />
            <HostTunnelFields
              tunnels={services.tunnels}
              active={[...connectionFacts.baseline.tunnels]}
              actions={services.connections}
              connections={[...connectionFacts.baseline.connections]}
              host={activeEditingHost}
              key={`host-tunnels:${activeEditingHost?.id ?? 'new'}`}
              operations={operations}
              onChanged={() => {}}
              onError={setError}
              profiles={connectionFacts.baseline.tunnelProfiles.filter(
                ({ hostId }) => hostId === activeEditingHost?.id,
              )}
            />
            <fieldset
              className={classes('connection-options full-field host-form-field')}
              data-tab="settings"
            >
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
              <label className={classes('check')}>
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
              <details className={classes('ssh-algorithm-settings full-field')}>
                <summary>{x('hosts.advancedAlgorithms')}</summary>
                <p className={classes('hint')}>{x('hosts.algorithmHint')}</p>
                <div className={classes('ssh-algorithm-grid')}>
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
            <details
              className={classes('ssh-x11-settings full-field host-form-field')}
              data-tab="settings"
            >
              <summary>{x('hosts.x11Forwarding')}</summary>
              <p className={classes('hint')}>{x('hosts.x11Hint')}</p>
              <label className={classes('check')}>
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
                  maxLength={1024}
                  name="sshX11Display"
                  placeholder={x('hosts.localDisplayPlaceholder')}
                />
              </label>
            </details>
            <HostProxyFields
              className={classes('host-form-field')}
              actions={{
                testProxy: (input, signal) =>
                  operations.admit((ownedSignal) =>
                    services.connections.testProxy(
                      input,
                      signal ? AbortSignal.any([signal, ownedSignal]) : ownedSignal,
                    ),
                  ),
              }}
              dataTab="settings"
              host={activeEditingHost}
            />
            {!useConnectionProfile && hostAuthType === 'privateKey' ? (
              <label
                className={classes('host-form-field full-field host-field-password')}
                data-tab="auth"
              >
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
              <label className={classes('host-form-field host-field-password')} data-tab="auth">
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
              <p className={classes('host-auth-note host-form-field full-field')} data-tab="auth">
                {hostAuthType === 'agent'
                  ? x('hosts.agentAuthHint')
                  : x('hosts.keyboardInteractiveHint')}
              </p>
            ) : null}
            <div className={classes('host-form-field host-field-agent')} data-tab="auth">
              <span>{x('hosts.useAgent')}</span>
              <div>
                <button
                  aria-checked={preferSshAgent}
                  aria-label={x('hosts.useAgent')}
                  className={classes('host-switch')}
                  onClick={() => setPreferSshAgent(!preferSshAgent)}
                  role="switch"
                  type="button"
                >
                  <i />
                </button>
                <input
                  aria-label={x('hosts.sshAgentPath')}
                  disabled={!preferSshAgent}
                  maxLength={4096}
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
                  className={classes(
                    sshAgentStatus.state === 'available' ? 'connection-state ready' : 'error-text',
                  )}
                  role="status"
                >
                  {sshAgentStatus.message}
                </small>
              ) : null}
            </div>
            <div className={classes('host-form-field host-field-mfa')} data-tab="auth">
              <span>{x('hosts.mfaOtp')}</span>
              <button
                aria-checked={hostAuthType === 'keyboardInteractive'}
                aria-label={x('hosts.mfaOtp')}
                className={classes('host-switch')}
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
                <label className={classes('host-form-field host-field-passphrase')} data-tab="auth">
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
                <label className={classes('host-form-field full-field')} data-tab="auth">
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
              <label className={classes('check host-form-field host-field-save')} data-tab="auth">
                <input name="save" type="checkbox" defaultChecked /> {x('hosts.saveInVault')}
              </label>
            ) : null}
            <label className={classes('check host-form-field')} data-tab="settings">
              <input name="favorite" type="checkbox" defaultChecked={activeEditingHost?.favorite} />{' '}
              {x('hosts.favorite')}
            </label>
            <div className={classes('modal-actions')}>
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
                className={classes('primary')}
                disabled={savingBookmark}
                name="submitAction"
                type="submit"
                value="save-and-connect"
              >
                {savingBookmark ? (
                  <LoaderCircle className={classes('spin')} size={13} />
                ) : (
                  <Play size={13} />
                )}
                {x('hosts.saveAndConnect')}
              </button>
            </div>
          </form>
        </section>
      </DialogContent>
    </Dialog>
  );
}
