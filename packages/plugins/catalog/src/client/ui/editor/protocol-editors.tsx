import type { QuickConnectTarget } from '../session/parser.ts';
import { useState, useRef, useSyncExternalStore, type FormEvent, type ReactNode } from 'react';
import { RefreshCw } from 'lucide-react';
import type {
  Bookmark,
  BookmarkTree,
  Host,
  ConnectionProfile,
  CatalogReceipt,
} from '@axterm/plugin-api/catalog';
import type { SerialPortInfo } from '@axterm/plugin-api/connections';
import { TERMINAL_ENCODINGS, type TerminalProfile } from '@axterm/plugin-api/terminals';
import { Dialog, DialogContent, DialogTitle } from '@axterm/ui/controls';
import { useI18n } from '../i18n.tsx';
import type { ProtocolSaveWorkflow, ProtocolCredentialDraft } from './protocol-save-workflow.ts';
import styles from './editor.module.css';
const classes = (value: string) =>
  value
    .split(/\s+/u)
    .filter(Boolean)
    .map((name) => name + ' ' + (styles[name] ?? ''))
    .join(' ');
function ErrorBanner({ text }: { text: string }) {
  return <p role="alert">{text}</p>;
}
function Modal({
  title,
  className,
  children,
  onClose,
  notice,
}: {
  notice?: ReactNode;
  title: string;
  className: string;
  children: ReactNode;
  onClose(): void;
}) {
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent
        overlayClassName={classes('modal-backdrop protocol-backdrop')}
        asChild
        aria-describedby={undefined}
        onOpenAutoFocus={(event) => {
          const field =
            event.target instanceof HTMLElement
              ? event.target.querySelector<HTMLElement>('[data-autofocus]:not(:disabled)')
              : null;
          if (field) {
            event.preventDefault();
            field.focus();
          }
        }}
      >
        <section className={classes(classes('modal ' + className))}>
          <header>
            <DialogTitle asChild>
              <h2>{title}</h2>
            </DialogTitle>
            <button type="button" onClick={onClose} aria-label={title}>
              ×
            </button>
          </header>
          {notice}
          {children}
        </section>
      </DialogContent>
    </Dialog>
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
interface ProtocolEditorProps {
  initialTarget?: QuickConnectTarget | undefined;
  terminalProfiles: readonly TerminalProfile[];
  bookmarkTree: BookmarkTree;
  bookmark?: Bookmark | undefined;
  defaultGroupId: string | null;
  hosts: Host[];
  profiles: readonly ConnectionProfile[];
  ports: SerialPortInfo[];
  portsError?: string | undefined;
  onRefreshPorts(): void;
  workflow: ProtocolSaveWorkflow;
  onClose(): void;
  onSaved(receipt: CatalogReceipt, connect: boolean): Promise<void>;
}
export function FtpBookmarkDialog({
  bookmarkTree,
  bookmark,
  initialTarget: target,
  defaultGroupId,
  workflow,
  onClose,
  onSaved,
}: ProtocolEditorProps) {
  const { x } = useI18n();
  const initialTarget = target?.protocol === 'ftp' ? target : undefined;
  const settings = bookmark?.ftp;
  const state = useSyncExternalStore(workflow.subscribe, workflow.getSnapshot);
  const busy =
    state.status === 'running' || state.status === 'uncertain' || state.status === 'completed';
  const [error, setError] = useState('');
  const action = useRef(false);
  async function finish() {
    const current = workflow.getSnapshot();
    if (current.status === 'completed' && current.receipt)
      await onSaved(current.receipt, action.current);
  }
  async function retry() {
    try {
      await workflow.retry();
      await finish();
    } catch {
      setError(x('protocolBookmark.operationFailed'));
    }
  }
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const form = new FormData(event.currentTarget);
    const credentials: ProtocolCredentialDraft[] = [];
    const password = String(form.get('password') ?? ''),
      removePassword = form.get('removePassword') === 'on';
    const previousCredentialRef = settings?.credentialRef ?? null;
    if (password)
      credentials.push({
        field: 'credentialRef',
        input: {
          kind: 'protocolPassword',
          label: ('Ftp · ' + String(form.get('name') ?? '')).slice(0, 100),
          secret: password,
        },
      });
    try {
      const input = {
        ...protocolBookmarkMetadata(form, bookmark, defaultGroupId),
        ftp: {
          hostname: String(form.get('hostname') ?? ''),
          port: Number(form.get('port') ?? 21),
          username: String(form.get('username') ?? 'anonymous'),
          credentialRef: removePassword ? null : previousCredentialRef,
          security: String(form.get('security') ?? 'plain') as
            'plain' | 'explicit-tls' | 'implicit-tls',
          tlsVerify: form.get('tlsVerify') === 'on',
          encoding: String(form.get('encoding') ?? 'utf-8') as NonNullable<
            Bookmark['ftp']
          >['encoding'],
          initialDirectory: String(form.get('initialDirectory') ?? '/'),
        },
      };
      const parsed = Object.assign(
        {
          profileId: null,
          connectionProfileId: null,
          quickCommands: bookmark?.quickCommands ?? [],
          triggers: bookmark?.triggers ?? [],
        },
        input,
        { protocol: 'ftp' as const, hostId: null },
      );
      action.current =
        ((event.nativeEvent as SubmitEvent).submitter as HTMLButtonElement | null)?.value ===
        'connect';
      setError('');
      await workflow.start({ input: parsed, credentials, bookmark });
      await finish();
    } catch {
      setError(x('protocolBookmark.operationFailed'));
    }
  }
  const dismiss = () => {
    if (!busy) onClose();
  };
  return (
    <Modal
      notice={
        state.status === 'uncertain' ? (
          <p role="alert">
            {x('sshConfigImport.uncertain')}{' '}
            <button type="button" onClick={() => void retry()}>
              {x('history.retryPending')}
            </button>
          </p>
        ) : state.status === 'failed' ? (
          <p role="alert">
            {x('protocolBookmark.operationFailed')}
            {state.retainedCredentials && ' ' + x('catalogEditor.savedCredentialsRetained')}
          </p>
        ) : null
      }
      className={classes('protocol-bookmark-modal')}
      title={bookmark ? x('protocolBookmark.editFtp') : x('protocolBookmark.addFtp')}
      onClose={dismiss}
    >
      <form
        className={classes('form-grid protocol-bookmark-form')}
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
            max={65535}
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
          <label className={classes('check')}>
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
        <label className={classes('check')}>
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
        <label className={classes('full-field')}>
          {x('protocolBookmark.description')}
          <textarea
            name="description"
            rows={3}
            maxLength={2000}
            defaultValue={bookmark?.description ?? ''}
          />
        </label>
        <p className={classes('hint full-field')}>{x('protocolBookmark.ftpVaultHint')}</p>
        <div className={classes('modal-actions full-field')}>
          <button type="button" onClick={dismiss}>
            {x('common.cancel')}
          </button>
          <button disabled={busy} value="save">
            {busy ? x('protocolBookmark.saving') : x('common.save')}
          </button>
          <button className={classes('primary')} disabled={busy} value="connect">
            {x('protocolBookmark.saveAndConnect')}
          </button>
        </div>
      </form>
    </Modal>
  );
}
export function TelnetBookmarkDialog({
  bookmarkTree,
  bookmark,
  initialTarget: target,
  defaultGroupId,
  profiles,
  workflow,
  onClose,
  onSaved,
  terminalProfiles,
}: ProtocolEditorProps) {
  const { x } = useI18n();
  const initialTarget = target?.protocol === 'telnet' ? target : undefined;
  const settings = bookmark?.telnet;
  const state = useSyncExternalStore(workflow.subscribe, workflow.getSnapshot);
  const busy =
    state.status === 'running' || state.status === 'uncertain' || state.status === 'completed';
  const [error, setError] = useState('');
  const action = useRef(false);
  async function finish() {
    const current = workflow.getSnapshot();
    if (current.status === 'completed' && current.receipt)
      await onSaved(current.receipt, action.current);
  }
  async function retry() {
    try {
      await workflow.retry();
      await finish();
    } catch {
      setError(x('protocolBookmark.operationFailed'));
    }
  }
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const form = new FormData(event.currentTarget);
    const credentials: ProtocolCredentialDraft[] = [];
    const password = String(form.get('password') ?? ''),
      removePassword = form.get('removePassword') === 'on';
    const previousCredentialRef = settings?.credentialRef ?? null;
    if (password)
      credentials.push({
        field: 'credentialRef',
        input: {
          kind: 'protocolPassword',
          label: ('Telnet · ' + String(form.get('name') ?? '')).slice(0, 100),
          secret: password,
        },
      });
    try {
      const input = {
        ...protocolBookmarkMetadata(form, bookmark, defaultGroupId),
        profileId: String(form.get('profileId') || '') || null,
        connectionProfileId: String(form.get('connectionProfileId') || '') || null,
        telnet: {
          hostname: String(form.get('hostname') ?? ''),
          port: Number(form.get('port') ?? 23),
          username: String(form.get('username') ?? ''),
          credentialRef: removePassword ? null : previousCredentialRef,
          loginPrompt: String(form.get('loginPrompt') ?? ''),
          passwordPrompt: String(form.get('passwordPrompt') ?? ''),
          encoding: String(form.get('encoding') ?? 'utf-8') as NonNullable<
            Bookmark['telnet']
          >['encoding'],
          connectionTimeoutMs: Number(form.get('connectionTimeoutMs') ?? 10000),
        },
      };
      const parsed = Object.assign(
        {
          profileId: null,
          connectionProfileId: null,
          quickCommands: bookmark?.quickCommands ?? [],
          triggers: bookmark?.triggers ?? [],
        },
        input,
        { protocol: 'telnet' as const, hostId: null },
      );
      action.current =
        ((event.nativeEvent as SubmitEvent).submitter as HTMLButtonElement | null)?.value ===
        'connect';
      setError('');
      await workflow.start({ input: parsed, credentials, bookmark });
      await finish();
    } catch {
      setError(x('protocolBookmark.operationFailed'));
    }
  }
  const dismiss = () => {
    if (!busy) onClose();
  };
  return (
    <Modal
      notice={
        state.status === 'uncertain' ? (
          <p role="alert">
            {x('sshConfigImport.uncertain')}{' '}
            <button type="button" onClick={() => void retry()}>
              {x('history.retryPending')}
            </button>
          </p>
        ) : state.status === 'failed' ? (
          <p role="alert">
            {x('protocolBookmark.operationFailed')}
            {state.retainedCredentials && ' ' + x('catalogEditor.savedCredentialsRetained')}
          </p>
        ) : null
      }
      className={classes('protocol-bookmark-modal')}
      title={bookmark ? x('protocolBookmark.editTelnet') : x('protocolBookmark.addTelnet')}
      onClose={dismiss}
    >
      <form
        className={classes('form-grid protocol-bookmark-form')}
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
            max={65535}
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
          <label className={classes('check')}>
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
            max={120000}
            required
            defaultValue={settings?.connectionTimeoutMs ?? 10000}
          />
        </label>
        <label>
          {x('protocolBookmark.terminalProfile')}
          <select name="profileId" defaultValue={bookmark?.profileId ?? ''}>
            <option value="">{x('protocolBookmark.defaultProfile')}</option>
            {terminalProfiles.map((profile) => (
              <option key={profile.id} value={profile.id}>
                {profile.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          {x('protocolBookmark.connectionProfile')}
          <select name="connectionProfileId" defaultValue={bookmark?.connectionProfileId ?? ''}>
            <option value="">{x('protocolBookmark.noConnectionProfile')}</option>
            {profiles.map((profile) => (
              <option key={profile.id} value={profile.id}>
                {profile.name}
              </option>
            ))}
          </select>
        </label>
        <label className={classes('full-field')}>
          {x('protocolBookmark.description')}
          <textarea
            name="description"
            rows={3}
            maxLength={2000}
            defaultValue={bookmark?.description ?? ''}
          />
        </label>
        <p className={classes('hint full-field')}>{x('protocolBookmark.telnetVaultHint')}</p>
        <div className={classes('modal-actions full-field')}>
          <button type="button" onClick={dismiss}>
            {x('common.cancel')}
          </button>
          <button disabled={busy} value="save">
            {busy ? x('protocolBookmark.saving') : x('common.save')}
          </button>
          <button className={classes('primary')} disabled={busy} value="connect">
            {x('protocolBookmark.saveAndConnect')}
          </button>
        </div>
      </form>
    </Modal>
  );
}
export function SerialBookmarkDialog({
  bookmarkTree,
  bookmark,
  initialTarget: target,
  defaultGroupId,
  ports,
  portsError,
  onRefreshPorts,
  workflow,
  onClose,
  onSaved,
  terminalProfiles,
}: ProtocolEditorProps) {
  const { x } = useI18n();
  const initialTarget = target?.protocol === 'serial' ? target : undefined;
  const settings = bookmark?.serial;
  const state = useSyncExternalStore(workflow.subscribe, workflow.getSnapshot);
  const busy =
    state.status === 'running' || state.status === 'uncertain' || state.status === 'completed';
  const [error, setError] = useState('');
  const action = useRef(false);
  async function finish() {
    const current = workflow.getSnapshot();
    if (current.status === 'completed' && current.receipt)
      await onSaved(current.receipt, action.current);
  }
  async function retry() {
    try {
      await workflow.retry();
      await finish();
    } catch {
      setError(x('protocolBookmark.operationFailed'));
    }
  }
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const form = new FormData(event.currentTarget);
    const credentials: ProtocolCredentialDraft[] = [];
    try {
      const input = {
        ...protocolBookmarkMetadata(form, bookmark, defaultGroupId),
        profileId: String(form.get('profileId') || '') || null,
        serial: {
          path: String(form.get('path') ?? ''),
          baudRate: Number(form.get('baudRate') ?? 9600),
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
      const parsed = Object.assign(
        {
          profileId: null,
          connectionProfileId: null,
          quickCommands: bookmark?.quickCommands ?? [],
          triggers: bookmark?.triggers ?? [],
        },
        input,
        { protocol: 'serial' as const, hostId: null },
      );
      action.current =
        ((event.nativeEvent as SubmitEvent).submitter as HTMLButtonElement | null)?.value ===
        'connect';
      setError('');
      await workflow.start({ input: parsed, credentials, bookmark });
      await finish();
    } catch {
      setError(x('protocolBookmark.operationFailed'));
    }
  }
  const dismiss = () => {
    if (!busy) onClose();
  };
  return (
    <Modal
      notice={
        state.status === 'uncertain' ? (
          <p role="alert">
            {x('sshConfigImport.uncertain')}{' '}
            <button type="button" onClick={() => void retry()}>
              {x('history.retryPending')}
            </button>
          </p>
        ) : state.status === 'failed' ? (
          <p role="alert">
            {x('protocolBookmark.operationFailed')}
            {state.retainedCredentials && ' ' + x('catalogEditor.savedCredentialsRetained')}
          </p>
        ) : null
      }
      className={classes('protocol-bookmark-modal')}
      title={bookmark ? x('protocolBookmark.editSerial') : x('protocolBookmark.addSerial')}
      onClose={dismiss}
    >
      <form
        className={classes('form-grid protocol-bookmark-form')}
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
        <label className={classes('full-field')}>
          {x('protocolBookmark.serialPath')}
          <div className={classes('inline-field-actions')}>
            <input
              name="path"
              list="serial-port-paths"
              required
              maxLength={1024}
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
          <p className={classes('hint full-field')}>
            {x('protocolBookmark.serialEnumerationFailed', { message: portsError })}
          </p>
        ) : (
          <p className={classes('hint full-field')} data-testid="serial-enumeration-ready">
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
            max={4000000}
            required
            defaultValue={settings?.baudRate ?? initialTarget?.baudRate ?? 9_600}
          />
          <datalist id="serial-baud-rates">
            {[110, 300, 1200, 2400, 4800, 9600, 14400, 19200, 38400, 57600, 115200].map((rate) => (
              <option key={rate} value={rate} />
            ))}
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
        <fieldset className={classes('full-field checkbox-grid')}>
          <legend>{x('protocolBookmark.portFlowControl')}</legend>
          <label className={classes('check')}>
            <input
              name="lock"
              type="checkbox"
              defaultChecked={settings?.lock ?? initialTarget?.lock ?? true}
            />{' '}
            {x('protocolBookmark.exclusiveLock')}
          </label>
          {(['rtscts', 'xon', 'xoff', 'xany'] as const).map((name) => (
            <label className={classes('check')} key={name}>
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
            max={10000}
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
            {terminalProfiles.map((profile) => (
              <option key={profile.id} value={profile.id}>
                {profile.name}
              </option>
            ))}
          </select>
        </label>
        <label className={classes('full-field')}>
          {x('protocolBookmark.description')}
          <textarea
            name="description"
            rows={3}
            maxLength={2000}
            defaultValue={bookmark?.description ?? ''}
          />
        </label>
        <p className={classes('hint full-field')}>{x('protocolBookmark.serialHint')}</p>
        <div className={classes('modal-actions full-field')}>
          <button type="button" onClick={dismiss}>
            {x('common.cancel')}
          </button>
          <button disabled={busy} value="save">
            {busy ? x('protocolBookmark.saving') : x('common.save')}
          </button>
          <button className={classes('primary')} disabled={busy} value="connect">
            {x('protocolBookmark.saveAndOpen')}
          </button>
        </div>
      </form>
    </Modal>
  );
}
export function RdpBookmarkDialog({
  bookmarkTree,
  bookmark,
  initialTarget: target,
  defaultGroupId,
  hosts,
  profiles,
  workflow,
  onClose,
  onSaved,
}: ProtocolEditorProps) {
  const { x } = useI18n();
  const initialTarget = target?.protocol === 'rdp' ? target : undefined;
  const settings = bookmark?.rdp;
  const state = useSyncExternalStore(workflow.subscribe, workflow.getSnapshot);
  const busy =
    state.status === 'running' || state.status === 'uncertain' || state.status === 'completed';
  const [error, setError] = useState('');
  const action = useRef(false);
  const customProxy = settings?.proxy.mode === 'custom' ? settings.proxy.endpoint : undefined;
  const [proxyMode, setProxyMode] = useState<'inherit' | 'direct' | 'custom'>(
    settings?.proxy.mode === 'custom'
      ? 'custom'
      : settings?.proxy.mode === 'direct'
        ? 'direct'
        : 'inherit',
  );
  async function finish() {
    const current = workflow.getSnapshot();
    if (current.status === 'completed' && current.receipt)
      await onSaved(current.receipt, action.current);
  }
  async function retry() {
    try {
      await workflow.retry();
      await finish();
    } catch {
      setError(x('protocolBookmark.operationFailed'));
    }
  }
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const form = new FormData(event.currentTarget);
    const credentials: ProtocolCredentialDraft[] = [];
    const password = String(form.get('password') ?? ''),
      removePassword = form.get('removePassword') === 'on';
    const previousCredentialRef = settings?.credentialRef ?? null;
    const credentialRef = removePassword ? null : previousCredentialRef;
    if (password)
      credentials.push({
        field: 'credentialRef',
        input: {
          kind: 'protocolPassword',
          label: ('Rdp · ' + String(form.get('name') ?? '')).slice(0, 100),
          secret: password,
        },
      });
    let proxy: NonNullable<Bookmark['rdp']>['proxy'];
    if (proxyMode === 'custom') {
      const username = String(form.get('proxyUsername') ?? '').trim() || null;
      const secret = String(form.get('proxyPassword') ?? '');
      const ref = customProxy?.username === username ? customProxy.credentialRef : null;
      if ((!username && secret) || (username && !secret && !ref)) {
        setError(x('protocolBookmark.proxyPairRequired'));
        return;
      }
      proxy = {
        mode: 'custom',
        endpoint: { url: String(form.get('proxyUrl') ?? ''), username, credentialRef: ref },
      };
      if (secret)
        credentials.push({
          field: 'proxy',
          input: {
            kind: 'proxyPassword',
            label: ('Rdp Proxy · ' + String(form.get('name') ?? '')).slice(0, 100),
            secret,
          },
        });
    } else proxy = { mode: proxyMode };
    try {
      const input = {
        ...protocolBookmarkMetadata(form, bookmark, defaultGroupId),
        connectionProfileId: String(form.get('connectionProfileId') || '') || null,
        rdp: {
          hostname: String(form.get('hostname') ?? ''),
          port: Number(form.get('port') ?? 3389),
          username: String(form.get('username') ?? ''),
          credentialRef,
          domain: String(form.get('domain') ?? ''),
          proxy,
          jumpHostId: String(form.get('jumpHostId') || '') || null,
          connectionTimeoutMs: Number(form.get('connectionTimeoutMs') ?? 15000),
          desktopWidth: Number(form.get('desktopWidth') ?? 1280),
          desktopHeight: Number(form.get('desktopHeight') ?? 720),
          scaleViewport: form.get('scaleViewport') === 'on',
          clipboard: form.get('clipboard') === 'on',
        },
      };
      const parsed = Object.assign(
        {
          profileId: null,
          connectionProfileId: null,
          quickCommands: bookmark?.quickCommands ?? [],
          triggers: bookmark?.triggers ?? [],
        },
        input,
        { protocol: 'rdp' as const, hostId: null },
      );
      action.current =
        ((event.nativeEvent as SubmitEvent).submitter as HTMLButtonElement | null)?.value ===
        'connect';
      setError('');
      await workflow.start({ input: parsed, credentials, bookmark });
      await finish();
    } catch {
      setError(x('protocolBookmark.operationFailed'));
    }
  }
  const dismiss = () => {
    if (!busy) onClose();
  };
  return (
    <Modal
      notice={
        state.status === 'uncertain' ? (
          <p role="alert">
            {x('sshConfigImport.uncertain')}{' '}
            <button type="button" onClick={() => void retry()}>
              {x('history.retryPending')}
            </button>
          </p>
        ) : state.status === 'failed' ? (
          <p role="alert">
            {x('protocolBookmark.operationFailed')}
            {state.retainedCredentials && ' ' + x('catalogEditor.savedCredentialsRetained')}
          </p>
        ) : null
      }
      className={classes('protocol-bookmark-modal')}
      title={bookmark ? x('protocolBookmark.editRdp') : x('protocolBookmark.addRdp')}
      onClose={dismiss}
    >
      <form
        className={classes('form-grid protocol-bookmark-form')}
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
            max={65535}
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
          <label className={classes('check full-field')}>
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
            min={1000}
            max={120000}
            step={1000}
            defaultValue={settings?.connectionTimeoutMs ?? 15000}
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
            max={8192}
            defaultValue={settings?.desktopWidth ?? 1280}
          />
        </label>
        <label>
          {x('protocolBookmark.desktopHeight')}
          <input
            name="desktopHeight"
            type="number"
            min={240}
            max={4320}
            defaultValue={settings?.desktopHeight ?? 720}
          />
        </label>
        <fieldset className={classes('full-field checkbox-grid')}>
          <legend>{x('protocolBookmark.sessionExperience')}</legend>
          <label className={classes('check')}>
            <input
              name="scaleViewport"
              type="checkbox"
              defaultChecked={settings?.scaleViewport ?? false}
            />{' '}
            {x('protocolBookmark.fitToWindow')}
          </label>
          <label className={classes('check')}>
            <input name="clipboard" type="checkbox" defaultChecked={settings?.clipboard ?? true} />{' '}
            {x('protocolBookmark.clipboardSync')}
          </label>
        </fieldset>
        <label className={classes('full-field')}>
          {x('protocolBookmark.description')}
          <textarea
            name="description"
            rows={3}
            maxLength={2000}
            defaultValue={bookmark?.description ?? ''}
          />
        </label>
        <p className={classes('hint full-field')}>{x('protocolBookmark.rdpVaultHint')}</p>
        <div className={classes('modal-actions full-field')}>
          <button type="button" onClick={dismiss}>
            {x('common.cancel')}
          </button>
          <button disabled={busy} value="save">
            {busy ? x('protocolBookmark.saving') : x('common.save')}
          </button>
          <button className={classes('primary')} disabled={busy} value="connect">
            {x('protocolBookmark.saveAndConnect')}
          </button>
        </div>
      </form>
    </Modal>
  );
}
export function VncBookmarkDialog({
  bookmarkTree,
  bookmark,
  initialTarget: target,
  defaultGroupId,
  hosts,
  profiles,
  workflow,
  onClose,
  onSaved,
}: ProtocolEditorProps) {
  const { x } = useI18n();
  const initialTarget = target?.protocol === 'vnc' ? target : undefined;
  const settings = bookmark?.vnc;
  const state = useSyncExternalStore(workflow.subscribe, workflow.getSnapshot);
  const busy =
    state.status === 'running' || state.status === 'uncertain' || state.status === 'completed';
  const [error, setError] = useState('');
  const action = useRef(false);
  const customProxy = settings?.proxy.mode === 'custom' ? settings.proxy.endpoint : undefined;
  const [proxyMode, setProxyMode] = useState<'inherit' | 'direct' | 'custom'>(
    settings?.proxy.mode === 'custom'
      ? 'custom'
      : settings?.proxy.mode === 'direct'
        ? 'direct'
        : 'inherit',
  );
  async function finish() {
    const current = workflow.getSnapshot();
    if (current.status === 'completed' && current.receipt)
      await onSaved(current.receipt, action.current);
  }
  async function retry() {
    try {
      await workflow.retry();
      await finish();
    } catch {
      setError(x('protocolBookmark.operationFailed'));
    }
  }
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const form = new FormData(event.currentTarget);
    const credentials: ProtocolCredentialDraft[] = [];
    const password = String(form.get('password') ?? ''),
      removePassword = form.get('removePassword') === 'on';
    const previousCredentialRef = settings?.credentialRef ?? null;
    const credentialRef = removePassword ? null : previousCredentialRef;
    if (password)
      credentials.push({
        field: 'credentialRef',
        input: {
          kind: 'protocolPassword',
          label: ('Vnc · ' + String(form.get('name') ?? '')).slice(0, 100),
          secret: password,
        },
      });
    let proxy: NonNullable<Bookmark['vnc']>['proxy'];
    if (proxyMode === 'custom') {
      const username = String(form.get('proxyUsername') ?? '').trim() || null;
      const secret = String(form.get('proxyPassword') ?? '');
      const ref = customProxy?.username === username ? customProxy.credentialRef : null;
      if ((!username && secret) || (username && !secret && !ref)) {
        setError(x('protocolBookmark.proxyPairRequired'));
        return;
      }
      proxy = {
        mode: 'custom',
        endpoint: { url: String(form.get('proxyUrl') ?? ''), username, credentialRef: ref },
      };
      if (secret)
        credentials.push({
          field: 'proxy',
          input: {
            kind: 'proxyPassword',
            label: ('Vnc Proxy · ' + String(form.get('name') ?? '')).slice(0, 100),
            secret,
          },
        });
    } else proxy = { mode: proxyMode };
    try {
      const input = {
        ...protocolBookmarkMetadata(form, bookmark, defaultGroupId),
        connectionProfileId: String(form.get('connectionProfileId') || '') || null,
        vnc: {
          hostname: String(form.get('hostname') ?? ''),
          port: Number(form.get('port') ?? 5900),
          username: String(form.get('username') ?? ''),
          credentialRef,
          proxy,
          jumpHostId: String(form.get('jumpHostId') || '') || null,
          connectionTimeoutMs: Number(form.get('connectionTimeoutMs') ?? 15000),
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
      const parsed = Object.assign(
        {
          profileId: null,
          connectionProfileId: null,
          quickCommands: bookmark?.quickCommands ?? [],
          triggers: bookmark?.triggers ?? [],
        },
        input,
        { protocol: 'vnc' as const, hostId: null },
      );
      action.current =
        ((event.nativeEvent as SubmitEvent).submitter as HTMLButtonElement | null)?.value ===
        'connect';
      setError('');
      await workflow.start({ input: parsed, credentials, bookmark });
      await finish();
    } catch {
      setError(x('protocolBookmark.operationFailed'));
    }
  }
  const dismiss = () => {
    if (!busy) onClose();
  };
  return (
    <Modal
      notice={
        state.status === 'uncertain' ? (
          <p role="alert">
            {x('sshConfigImport.uncertain')}{' '}
            <button type="button" onClick={() => void retry()}>
              {x('history.retryPending')}
            </button>
          </p>
        ) : state.status === 'failed' ? (
          <p role="alert">
            {x('protocolBookmark.operationFailed')}
            {state.retainedCredentials && ' ' + x('catalogEditor.savedCredentialsRetained')}
          </p>
        ) : null
      }
      className={classes('protocol-bookmark-modal')}
      title={bookmark ? x('protocolBookmark.editVnc') : x('protocolBookmark.addVnc')}
      onClose={dismiss}
    >
      <form
        className={classes('form-grid protocol-bookmark-form')}
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
            max={65535}
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
          <label className={classes('check full-field')}>
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
            min={1000}
            max={120000}
            step={1000}
            defaultValue={settings?.connectionTimeoutMs ?? 15000}
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
        <fieldset className={classes('full-field checkbox-grid')}>
          <legend>{x('protocolBookmark.sessionExperience')}</legend>
          <label className={classes('check')}>
            <input
              name="viewOnly"
              type="checkbox"
              defaultChecked={settings?.viewOnly ?? initialTarget?.viewOnly ?? false}
            />{' '}
            {x('protocolBookmark.viewOnly')}
          </label>
          <label className={classes('check')}>
            <input
              name="clipViewport"
              type="checkbox"
              defaultChecked={settings?.clipViewport ?? initialTarget?.clipViewport ?? false}
            />{' '}
            {x('protocolBookmark.clipOverflow')}
          </label>
          <label className={classes('check')}>
            <input
              name="scaleViewport"
              type="checkbox"
              defaultChecked={settings?.scaleViewport ?? initialTarget?.scaleViewport ?? true}
            />{' '}
            {x('protocolBookmark.fitToWindow')}
          </label>
          <label className={classes('check')}>
            <input
              name="shared"
              type="checkbox"
              defaultChecked={settings?.shared ?? initialTarget?.shared ?? true}
            />{' '}
            {x('protocolBookmark.sharedSession')}
          </label>
          <label className={classes('check')}>
            <input
              name="showDotCursor"
              type="checkbox"
              defaultChecked={settings?.showDotCursor ?? true}
            />{' '}
            {x('protocolBookmark.dotCursor')}
          </label>
          <label className={classes('check')}>
            <input name="clipboard" type="checkbox" defaultChecked={settings?.clipboard ?? true} />{' '}
            {x('protocolBookmark.clipboardSync')}
          </label>
        </fieldset>
        <label className={classes('full-field')}>
          {x('protocolBookmark.description')}
          <textarea
            name="description"
            rows={3}
            maxLength={2000}
            defaultValue={bookmark?.description ?? ''}
          />
        </label>
        <p className={classes('hint full-field')}>{x('protocolBookmark.vncVaultHint')}</p>
        <div className={classes('modal-actions full-field')}>
          <button type="button" onClick={dismiss}>
            {x('common.cancel')}
          </button>
          <button disabled={busy} value="save">
            {busy ? x('protocolBookmark.saving') : x('common.save')}
          </button>
          <button className={classes('primary')} disabled={busy} value="connect">
            {x('protocolBookmark.saveAndConnect')}
          </button>
        </div>
      </form>
    </Modal>
  );
}
export function SpiceBookmarkDialog({
  bookmarkTree,
  bookmark,
  initialTarget: target,
  defaultGroupId,
  hosts,
  profiles,
  workflow,
  onClose,
  onSaved,
}: ProtocolEditorProps) {
  const { x } = useI18n();
  const initialTarget = target?.protocol === 'spice' ? target : undefined;
  const settings = bookmark?.spice;
  const state = useSyncExternalStore(workflow.subscribe, workflow.getSnapshot);
  const busy =
    state.status === 'running' || state.status === 'uncertain' || state.status === 'completed';
  const [error, setError] = useState('');
  const action = useRef(false);
  const customProxy = settings?.proxy.mode === 'custom' ? settings.proxy.endpoint : undefined;
  const [proxyMode, setProxyMode] = useState<'inherit' | 'direct' | 'custom'>(
    settings?.proxy.mode === 'custom'
      ? 'custom'
      : settings?.proxy.mode === 'direct'
        ? 'direct'
        : 'inherit',
  );
  async function finish() {
    const current = workflow.getSnapshot();
    if (current.status === 'completed' && current.receipt)
      await onSaved(current.receipt, action.current);
  }
  async function retry() {
    try {
      await workflow.retry();
      await finish();
    } catch {
      setError(x('protocolBookmark.operationFailed'));
    }
  }
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const form = new FormData(event.currentTarget);
    const credentials: ProtocolCredentialDraft[] = [];
    const password = String(form.get('password') ?? ''),
      removePassword = form.get('removePassword') === 'on';
    const previousCredentialRef = settings?.credentialRef ?? null;
    const credentialRef = removePassword ? null : previousCredentialRef;
    if (password)
      credentials.push({
        field: 'credentialRef',
        input: {
          kind: 'protocolPassword',
          label: ('Spice · ' + String(form.get('name') ?? '')).slice(0, 100),
          secret: password,
        },
      });
    let proxy: NonNullable<Bookmark['spice']>['proxy'];
    if (proxyMode === 'custom') {
      const username = String(form.get('proxyUsername') ?? '').trim() || null;
      const secret = String(form.get('proxyPassword') ?? '');
      const ref = customProxy?.username === username ? customProxy.credentialRef : null;
      if ((!username && secret) || (username && !secret && !ref)) {
        setError(x('protocolBookmark.proxyPairRequired'));
        return;
      }
      proxy = {
        mode: 'custom',
        endpoint: { url: String(form.get('proxyUrl') ?? ''), username, credentialRef: ref },
      };
      if (secret)
        credentials.push({
          field: 'proxy',
          input: {
            kind: 'proxyPassword',
            label: ('Spice Proxy · ' + String(form.get('name') ?? '')).slice(0, 100),
            secret,
          },
        });
    } else proxy = { mode: proxyMode };
    try {
      const input = {
        ...protocolBookmarkMetadata(form, bookmark, defaultGroupId),
        connectionProfileId: String(form.get('connectionProfileId') || '') || null,
        spice: {
          hostname: String(form.get('hostname') ?? ''),
          port: Number(form.get('port') ?? 5900),
          credentialRef,
          proxy,
          jumpHostId: String(form.get('jumpHostId') || '') || null,
          connectionTimeoutMs: Number(form.get('connectionTimeoutMs') ?? 15000),
          viewOnly: form.get('viewOnly') === 'on',
          scaleViewport: form.get('scaleViewport') === 'on',
        },
      };
      const parsed = Object.assign(
        {
          profileId: null,
          connectionProfileId: null,
          quickCommands: bookmark?.quickCommands ?? [],
          triggers: bookmark?.triggers ?? [],
        },
        input,
        { protocol: 'spice' as const, hostId: null },
      );
      action.current =
        ((event.nativeEvent as SubmitEvent).submitter as HTMLButtonElement | null)?.value ===
        'connect';
      setError('');
      await workflow.start({ input: parsed, credentials, bookmark });
      await finish();
    } catch {
      setError(x('protocolBookmark.operationFailed'));
    }
  }
  const dismiss = () => {
    if (!busy) onClose();
  };
  return (
    <Modal
      notice={
        state.status === 'uncertain' ? (
          <p role="alert">
            {x('sshConfigImport.uncertain')}{' '}
            <button type="button" onClick={() => void retry()}>
              {x('history.retryPending')}
            </button>
          </p>
        ) : state.status === 'failed' ? (
          <p role="alert">
            {x('protocolBookmark.operationFailed')}
            {state.retainedCredentials && ' ' + x('catalogEditor.savedCredentialsRetained')}
          </p>
        ) : null
      }
      className={classes('protocol-bookmark-modal')}
      title={bookmark ? x('protocolBookmark.editSpice') : x('protocolBookmark.addSpice')}
      onClose={dismiss}
    >
      <form
        className={classes('form-grid protocol-bookmark-form')}
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
            max={65535}
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
          <label className={classes('check full-field')}>
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
            min={1000}
            max={120000}
            step={1000}
            defaultValue={settings?.connectionTimeoutMs ?? 15000}
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
        <fieldset className={classes('full-field checkbox-grid')}>
          <legend>{x('protocolBookmark.sessionExperience')}</legend>
          <label className={classes('check')}>
            <input
              name="viewOnly"
              type="checkbox"
              defaultChecked={settings?.viewOnly ?? initialTarget?.viewOnly ?? false}
            />{' '}
            {x('protocolBookmark.viewOnly')}
          </label>
          <label className={classes('check')}>
            <input
              name="scaleViewport"
              type="checkbox"
              defaultChecked={settings?.scaleViewport ?? initialTarget?.scaleViewport ?? true}
            />{' '}
            {x('protocolBookmark.fitToWindow')}
          </label>
        </fieldset>
        <label className={classes('full-field')}>
          {x('protocolBookmark.description')}
          <textarea
            name="description"
            rows={3}
            maxLength={2000}
            defaultValue={bookmark?.description ?? ''}
          />
        </label>
        <p className={classes('hint full-field')}>{x('protocolBookmark.spiceVaultHint')}</p>
        <div className={classes('modal-actions full-field')}>
          <button type="button" onClick={dismiss}>
            {x('common.cancel')}
          </button>
          <button disabled={busy} value="save">
            {busy ? x('protocolBookmark.saving') : x('common.save')}
          </button>
          <button className={classes('primary')} disabled={busy} value="connect">
            {x('protocolBookmark.saveAndConnect')}
          </button>
        </div>
      </form>
    </Modal>
  );
}
export function WebBookmarkDialog({
  bookmarkTree,
  bookmark,
  initialTarget: target,
  defaultGroupId,
  workflow,
  onClose,
  onSaved,
}: ProtocolEditorProps) {
  const { x } = useI18n();
  const initialTarget =
    target?.protocol === 'http' || target?.protocol === 'https' ? target : undefined;
  const settings = bookmark?.web;
  const state = useSyncExternalStore(workflow.subscribe, workflow.getSnapshot);
  const busy =
    state.status === 'running' || state.status === 'uncertain' || state.status === 'completed';
  const [error, setError] = useState('');
  const action = useRef(false);
  async function finish() {
    const current = workflow.getSnapshot();
    if (current.status === 'completed' && current.receipt)
      await onSaved(current.receipt, action.current);
  }
  async function retry() {
    try {
      await workflow.retry();
      await finish();
    } catch {
      setError(x('protocolBookmark.operationFailed'));
    }
  }
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const form = new FormData(event.currentTarget);
    const credentials: ProtocolCredentialDraft[] = [];
    try {
      const input = {
        ...protocolBookmarkMetadata(form, bookmark, defaultGroupId),
        connectionProfileId: null,
        web: {
          url: String(form.get('url') ?? ''),
          userAgent: String(form.get('userAgent') ?? '').trim() || null,
          hideAddressBar: form.get('hideAddressBar') === 'on',
        },
      };
      const parsed = Object.assign(
        {
          profileId: null,
          connectionProfileId: null,
          quickCommands: bookmark?.quickCommands ?? [],
          triggers: bookmark?.triggers ?? [],
        },
        input,
        { protocol: 'web' as const, hostId: null },
      );
      action.current =
        ((event.nativeEvent as SubmitEvent).submitter as HTMLButtonElement | null)?.value ===
        'connect';
      setError('');
      await workflow.start({ input: parsed, credentials, bookmark });
      await finish();
    } catch {
      setError(x('protocolBookmark.operationFailed'));
    }
  }
  const dismiss = () => {
    if (!busy) onClose();
  };
  return (
    <Modal
      notice={
        state.status === 'uncertain' ? (
          <p role="alert">
            {x('sshConfigImport.uncertain')}{' '}
            <button type="button" onClick={() => void retry()}>
              {x('history.retryPending')}
            </button>
          </p>
        ) : state.status === 'failed' ? (
          <p role="alert">
            {x('protocolBookmark.operationFailed')}
            {state.retainedCredentials && ' ' + x('catalogEditor.savedCredentialsRetained')}
          </p>
        ) : null
      }
      className={classes('protocol-bookmark-modal')}
      title={bookmark ? x('protocolBookmark.editWeb') : x('protocolBookmark.addWeb')}
      onClose={dismiss}
    >
      <form
        className={classes('form-grid protocol-bookmark-form')}
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
        <label className={classes('full-field')}>
          URL
          <input
            name="url"
            type="url"
            required
            maxLength={4096}
            placeholder="https://example.com"
            defaultValue={settings?.url ?? initialTarget?.url ?? 'https://'}
          />
        </label>
        <label className={classes('full-field')}>
          User-Agent
          <input
            name="userAgent"
            maxLength={512}
            placeholder={x('protocolBookmark.electronDefaultPlaceholder')}
            defaultValue={settings?.userAgent ?? initialTarget?.userAgent ?? ''}
          />
        </label>
        <fieldset className={classes('full-field checkbox-grid')}>
          <legend>{x('protocolBookmark.pageExperience')}</legend>
          <label className={classes('check')}>
            <input
              name="hideAddressBar"
              type="checkbox"
              defaultChecked={settings?.hideAddressBar ?? false}
            />{' '}
            {x('protocolBookmark.hideAddressBar')}
          </label>
        </fieldset>
        <label className={classes('full-field')}>
          {x('protocolBookmark.description')}
          <textarea
            name="description"
            rows={3}
            maxLength={2000}
            defaultValue={bookmark?.description ?? ''}
          />
        </label>
        <p className={classes('hint full-field')}>{x('protocolBookmark.webSecurityHint')}</p>
        <div className={classes('modal-actions full-field')}>
          <button type="button" onClick={dismiss}>
            {x('common.cancel')}
          </button>
          <button disabled={busy} value="save">
            {busy ? x('protocolBookmark.saving') : x('common.save')}
          </button>
          <button className={classes('primary')} disabled={busy} value="connect">
            {x('protocolBookmark.saveAndOpen')}
          </button>
        </div>
      </form>
    </Modal>
  );
}
