import { useEffect, useId, useRef, useState, useSyncExternalStore, type FormEvent } from 'react';
import type {
  ConnectionProfile,
  ConnectionProfileInput,
  SshProfileValues,
  PasswordProfileValues,
} from '@axterm/plugin-api/catalog';
import type { WorkspaceUi } from '@axterm/ui/workspace';
import { Download, Upload, Eye, EyeOff, Plus, Search, Trash2, RefreshCw } from 'lucide-react';
import { useI18n } from '../i18n.tsx';
import type { CatalogModel } from '../../index.ts';
import {
  type ConnectionProfileCommands,
  profileCredentialTargets,
  type ProfileDraft,
  type ProfileCredentialField,
} from './commands.ts';
import styles from './profiles.module.css';
const classes = (value: string) =>
  value
    .split(/\s+/u)
    .filter(Boolean)
    .map((name) => name + ' ' + (styles[name] ?? ''))
    .join(' ');
type Protocol = 'ssh' | 'telnet' | 'vnc' | 'rdp' | 'ftp' | 'spice';
type SecretKind = 'password' | 'privateKey' | 'passphrase' | 'certificate';

const protocols: Array<{ id: Protocol; label: string }> = [
  { id: 'ssh', label: 'SSH' },
  { id: 'telnet', label: 'Telnet' },
  { id: 'vnc', label: 'VNC' },
  { id: 'rdp', label: 'RDP' },
  { id: 'ftp', label: 'FTP' },
  { id: 'spice', label: 'SPICE' },
];

export function ConnectionProfilesPanel({
  model,
  commands,
  workspace,
}: {
  model: CatalogModel;
  commands: ConnectionProfileCommands;
  workspace: WorkspaceUi;
}) {
  const { x } = useI18n();
  const protocolTabsId = useId();
  const protocolTabRefs = useRef<Partial<Record<Protocol, HTMLButtonElement>>>({});
  const facts = useSyncExternalStore(model.subscribe, model.getSnapshot);
  const command = useSyncExternalStore(commands.subscribe, commands.getSnapshot);
  const profiles = {
    data: facts.status === 'ready' ? facts.baseline.connectionProfiles : [],
    isLoading: facts.status !== 'ready',
  };
  const saving =
    command.status === 'running' ||
    command.status === 'uncertain' ||
    command.status === 'selecting';
  const generation = facts.status === 'ready' ? facts.baseline.generation : undefined;
  const [editing, setEditing] = useState<ConnectionProfile>();
  const [protocol, setProtocol] = useState<Protocol>('ssh');
  const [query, setQuery] = useState('');
  const [message, setMessage] = useState('');
  const visibleProfiles =
    profiles.data?.filter((profile) =>
      profile.name.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()),
    ) ?? [];

  const generationRef = useRef(generation);
  useEffect(() => {
    if (generation && generationRef.current && generation !== generationRef.current) {
      setEditing(undefined);
      setProtocol('ssh');
      setMessage(x('connectionProfiles.operationFailed'));
      if (commands.getSnapshot().status === 'uncertain') void commands.retry();
    }
    if (generation) generationRef.current = generation;
  }, [commands, generation, x]);
  async function completed(form?: HTMLFormElement) {
    const result = commands.getSnapshot();
    if (result.status === 'completed') {
      setMessage(
        x(
          result.operation === 'delete'
            ? 'connectionProfiles.deleted'
            : editing
              ? 'connectionProfiles.updated'
              : 'connectionProfiles.saved',
        ),
      );
      setEditing(undefined);
      setProtocol('ssh');
      form?.reset();
      await commands.reset();
    } else if (result.status === 'failed') setMessage(x('connectionProfiles.operationFailed'));
  }
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (saving) return;
    const element = event.currentTarget;
    setMessage('');
    try {
      const draft = connectionProfileDraft(new FormData(element), editing, commands, x);
      const pending = commands.start(draft);
      // Accepted secrets belong only to the private workflow until the Vault admission drains.
      for (const control of element.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>(
        '[data-profile-secret]',
      ))
        control.value = '';
      await pending;
      await completed(element);
    } catch {
      setMessage(x('connectionProfiles.operationFailed'));
    }
  }
  async function remove(profile: ConnectionProfile) {
    if (saving || !window.confirm(x('connectionProfiles.deleteConfirm', { name: profile.name })))
      return;
    setMessage('');
    try {
      await commands.remove(profile);
      await completed();
    } catch {
      setMessage(x('connectionProfiles.operationFailed'));
    }
  }
  async function select(profile?: ConnectionProfile) {
    if (saving) return;
    try {
      await commands.reset();
      setEditing(profile);
      setProtocol('ssh');
      setMessage('');
    } catch {
      setMessage(x('connectionProfiles.operationFailed'));
    }
  }
  const onOpenDataMigration = () => {
    void workspace.invokeAction('settings.open.sync');
  };

  return (
    <section
      className={classes('connection-profile-panel')}
      aria-labelledby="connection-profile-title"
    >
      <header className={classes('connection-profile-heading')}>
        <div>
          <span>{x('connectionProfiles.eyebrow')}</span>
          <h1 id="connection-profile-title">{x('connectionProfiles.title')}</h1>
          <p>{x('connectionProfiles.description')}</p>
        </div>
      </header>

      {message && (
        <p className={classes('connection-profile-message')} role="status">
          {message}
        </p>
      )}
      {command.status === 'uncertain' && (
        <p role="alert">
          {x('history.actionFailed')}{' '}
          <button
            type="button"
            onClick={() => {
              void commands
                .retry()
                .then(() => completed())
                .catch(() => setMessage(x('connectionProfiles.operationFailed')));
            }}
          >
            <RefreshCw size={14} />
            {x('history.retry')}
          </button>
        </p>
      )}
      {command.status === 'failed' && !message && (
        <p role="alert">{x('connectionProfiles.operationFailed')}</p>
      )}
      {command.retainedCredentials && (
        <p role="status">{x('catalogEditor.savedCredentialsRetained')}</p>
      )}
      <div className={classes('connection-profile-layout')}>
        <aside
          className={classes('connection-profile-list')}
          aria-label={x('connectionProfiles.savedList')}
        >
          <div className={classes('connection-profile-transport')}>
            <button
              type="button"
              title={x('connectionProfiles.importData')}
              onClick={onOpenDataMigration}
            >
              <Upload size={14} aria-hidden="true" />
            </button>
            <button
              type="button"
              title={x('connectionProfiles.exportData')}
              onClick={onOpenDataMigration}
            >
              <Download size={14} aria-hidden="true" />
            </button>
          </div>
          <label className={classes('connection-profile-search')}>
            <input
              aria-label={x('connectionProfiles.searchProfiles')}
              placeholder={x('connectionProfiles.search')}
              maxLength={1024}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
            <Search size={14} aria-hidden="true" />
          </label>
          <button
            className={classes('connection-profile-new')}
            type="button"
            disabled={saving}
            onClick={() => {
              void select();
            }}
          >
            <Plus size={14} />
            <span>
              <strong>{x('connectionProfiles.title')}</strong>
            </span>
          </button>
          {profiles.isLoading && (
            <p className={classes('hint')}>{x('connectionProfiles.loading')}</p>
          )}
          {visibleProfiles.map((profile) => (
            <button
              className={classes(editing?.id === profile.id ? 'active' : '')}
              key={profile.id}
              type="button"
              title={`${profile.name} · ${
                profile.isDefault
                  ? x('connectionProfiles.defaultProfile')
                  : profileSummary(profile, x)
              }`}
              disabled={saving}
              onClick={() => {
                void select(profile);
              }}
            >
              <span>
                <strong>{profile.name}</strong>
              </span>
            </button>
          ))}
          {!profiles.isLoading && !profiles.data?.length && (
            <p className={classes('connection-profile-empty')}>{x('connectionProfiles.empty')}</p>
          )}
          {!profiles.isLoading && !!profiles.data?.length && !visibleProfiles.length && (
            <p className={classes('connection-profile-empty')}>
              {x('connectionProfiles.noMatches')}
            </p>
          )}
        </aside>

        <form
          className={classes('connection-profile-editor')}
          key={
            editing?.id ??
            `new-connection-profile-${profiles.data?.find((profile) => profile.isDefault)?.id ?? 'none'}`
          }
          onSubmit={(event) => void save(event)}
          data-testid="connection-profile-form"
        >
          <fieldset className={styles.formBody} disabled={saving}>
            <div className={classes('connection-profile-basics')}>
              <label>
                {x('connectionProfiles.name')}
                <input
                  aria-label={x('connectionProfiles.nameAria')}
                  name="name"
                  required
                  maxLength={60}
                  autoFocus
                  defaultValue={editing?.name}
                />
              </label>
              <label className={classes('connection-profile-default')}>
                <span>
                  {x('connectionProfiles.default')}{' '}
                  <span title={x('connectionProfiles.defaultHint')}>?</span>
                </span>
                <input
                  aria-label={x('connectionProfiles.setDefault')}
                  name="isDefault"
                  type="checkbox"
                  defaultChecked={editing?.isDefault}
                />
                <i aria-hidden="true" />
              </label>
            </div>

            <div
              className={classes('connection-profile-tabs')}
              role="tablist"
              aria-label={x('connectionProfiles.protocols')}
            >
              {protocols.map((item) => (
                <button
                  aria-controls={`${protocolTabsId}-panel-${item.id}`}
                  aria-selected={protocol === item.id}
                  className={classes(protocol === item.id ? 'active' : '')}
                  id={`${protocolTabsId}-tab-${item.id}`}
                  key={item.id}
                  ref={(element) => {
                    if (element) protocolTabRefs.current[item.id] = element;
                    else delete protocolTabRefs.current[item.id];
                  }}
                  role="tab"
                  tabIndex={protocol === item.id ? 0 : -1}
                  type="button"
                  onClick={() => setProtocol(item.id)}
                  onKeyDown={(event) => {
                    const index = protocols.findIndex((candidate) => candidate.id === item.id);
                    let nextIndex: number;
                    switch (event.key) {
                      case 'ArrowRight':
                        nextIndex = (index + 1) % protocols.length;
                        break;
                      case 'ArrowLeft':
                        nextIndex = (index - 1 + protocols.length) % protocols.length;
                        break;
                      case 'Home':
                        nextIndex = 0;
                        break;
                      case 'End':
                        nextIndex = protocols.length - 1;
                        break;
                      default:
                        return;
                    }
                    event.preventDefault();
                    const next = protocols[nextIndex];
                    if (!next) return;
                    setProtocol(next.id);
                    protocolTabRefs.current[next.id]?.focus();
                  }}
                >
                  {item.label}
                </button>
              ))}
            </div>

            <ProtocolFields
              commands={commands}
              tabGroupId={protocolTabsId}
              protocol="ssh"
              active={protocol === 'ssh'}
              values={editing?.ssh}
            />
            {protocols.slice(1).map((item) => (
              <ProtocolFields
                commands={commands}
                key={item.id}
                tabGroupId={protocolTabsId}
                protocol={item.id}
                active={protocol === item.id}
                values={editing?.[item.id]}
              />
            ))}

            <div className={classes('connection-profile-actions')}>
              {editing && (
                <button
                  className={classes('danger')}
                  type="button"
                  onClick={() => void remove(editing)}
                >
                  <Trash2 size={14} /> {x('common.delete')}
                </button>
              )}
              <span />
              {editing && (
                <button
                  type="button"
                  onClick={() => {
                    void select();
                  }}
                >
                  {x('connectionProfiles.cancelEdit')}
                </button>
              )}
              <button
                aria-label={x(editing ? 'connectionProfiles.update' : 'connectionProfiles.save')}
                className={classes('primary')}
                disabled={saving}
              >
                {saving ? x('connectionProfiles.saving') : x('connectionProfiles.submit')}
              </button>
            </div>
          </fieldset>
        </form>
      </div>
    </section>
  );
}

function ProtocolFields({
  commands,
  tabGroupId,
  protocol,
  active,
  values,
}: {
  commands: ConnectionProfileCommands;
  tabGroupId: string;
  protocol: Protocol;
  active: boolean;
  values: SshProfileValues | PasswordProfileValues | undefined;
}) {
  const { x } = useI18n();
  const ssh = values as SshProfileValues | undefined;
  return (
    <div
      aria-labelledby={`${tabGroupId}-tab-${protocol}`}
      hidden={!active}
      id={`${tabGroupId}-panel-${protocol}`}
      role="tabpanel"
    >
      <fieldset className={classes('connection-profile-fields')}>
        <legend>
          {x('connectionProfiles.protocolCredentials', { protocol: protocol.toUpperCase() })}
        </legend>
        <label>
          {x('connectionProfiles.username')}
          <input
            aria-label={x('connectionProfiles.username')}
            name={`${protocol}.username`}
            maxLength={128}
            defaultValue={values?.username ?? ''}
          />
        </label>
        <SecretField
          commands={commands}
          name={`${protocol}.password` as ProfileCredentialField}
          kind="password"
          saved={!!values?.passwordCredentialRef}
        />
        {protocol === 'ssh' && (
          <>
            <SecretField
              commands={commands}
              name="ssh.privateKey"
              kind="privateKey"
              saved={!!ssh?.privateKeyCredentialRef}
              multiline
            />
            <SecretField
              commands={commands}
              name="ssh.passphrase"
              kind="passphrase"
              saved={!!ssh?.passphraseCredentialRef}
            />
            <SecretField
              commands={commands}
              name="ssh.certificate"
              kind="certificate"
              saved={!!ssh?.certificateCredentialRef}
              multiline
            />
          </>
        )}
        {protocol !== 'ssh' && (
          <p className={classes('hint full-field')}>
            {x('connectionProfiles.protocolOverrideHint', { protocol: protocol.toUpperCase() })}
          </p>
        )}
      </fieldset>
    </div>
  );
}

function SecretField({
  commands,
  name,
  kind,
  saved,
  multiline = false,
}: {
  commands: ConnectionProfileCommands;
  name: ProfileCredentialField;
  kind: SecretKind;
  saved: boolean;
  multiline?: boolean;
}) {
  const { x } = useI18n();
  const label = x(`connectionProfiles.secret.${kind}`);
  const control = useRef<HTMLInputElement | HTMLTextAreaElement | null>(null);
  const [revealed, setRevealed] = useState(false);
  const view = useSyncExternalStore(commands.subscribe, commands.getSnapshot);
  const [importError, setImportError] = useState('');
  async function importFromFile() {
    setImportError('');
    try {
      await commands.choose(name);
      if (control.current) control.current.value = '';
    } catch {
      setImportError(x('connectionProfiles.operationFailed'));
    }
  }

  return (
    <label className={classes(multiline ? 'full-field' : '')}>
      {label}
      {multiline ? (
        <>
          <textarea
            ref={(element) => {
              control.current = element;
            }}
            aria-label={label}
            name={name}
            data-profile-secret
            disabled={!!view.files[name]}
            maxLength={131072}
            rows={4}
            spellCheck={false}
            placeholder={
              saved
                ? x('connectionProfiles.savedKeepBlank')
                : x(`connectionProfiles.placeholder.${kind}`)
            }
          />
          {view.files[name] && (
            <button
              type="button"
              onClick={() => {
                void commands
                  .clearFile(name)
                  .catch(() => setImportError(x('connectionProfiles.operationFailed')));
              }}
            >
              {x('common.delete')}
            </button>
          )}
          <button
            className={classes('connection-profile-file-import')}
            type="button"
            onClick={() => void importFromFile()}
          >
            {view.files[name] ?? x('connectionProfiles.importFromFile')}
          </button>
        </>
      ) : (
        <span className={classes('connection-profile-secret-input')}>
          <input
            ref={(element) => {
              control.current = element;
            }}
            aria-label={label}
            name={name}
            data-profile-secret
            maxLength={131072}
            type={revealed ? 'text' : 'password'}
            autoComplete="new-password"
            placeholder={
              saved
                ? x('connectionProfiles.savedKeepBlank')
                : x(`connectionProfiles.placeholder.${kind}`)
            }
          />
          <button
            aria-label={x(
              revealed ? 'connectionProfiles.hideSecret' : 'connectionProfiles.showSecret',
              { label },
            )}
            type="button"
            onClick={() => setRevealed((value) => !value)}
          >
            {revealed ? <Eye size={14} /> : <EyeOff size={14} />}
          </button>
        </span>
      )}
      {importError && (
        <span className={classes('connection-profile-import-error')}>{importError}</span>
      )}
      {saved && (
        <span className={classes('connection-profile-clear')}>
          <input name={`${name}.clear`} type="checkbox" />{' '}
          {x('connectionProfiles.clearSaved', { label })}
        </span>
      )}
    </label>
  );
}

function connectionProfileDraft(
  form: FormData,
  current: ConnectionProfile | undefined,
  commands: ConnectionProfileCommands,
  x: ReturnType<typeof useI18n>['x'],
): ProfileDraft {
  const name = String(form.get('name') ?? '').trim();
  const input: ConnectionProfileInput = { name, isDefault: form.get('isDefault') === 'on' };
  const credentials: ProfileDraft['credentials'][number][] = [];
  for (const { id } of protocols)
    input[id] = { ...current?.[id], username: optionalText(form, `${id}.username`) };
  for (const [protocol, field, key, kind] of profileCredentialTargets) {
    const section = input[protocol]!;
    const secret = String(form.get(key) ?? '');
    const grant = commands.grant(key);
    const clear = form.get(`${key}.clear`) === 'on';
    Object.assign(section, {
      [field]: clear ? null : (current?.[protocol][field as 'passwordCredentialRef'] ?? null),
    });
    const label =
      `${name} ${x(kind === 'privateKey' ? 'connectionProfiles.credentialPrivateKey' : kind === 'privateKeyPassphrase' ? 'connectionProfiles.credentialPassphrase' : kind === 'sshCertificate' ? 'connectionProfiles.credentialCertificate' : 'connectionProfiles.credentialPassword', { protocol: protocol.toUpperCase() })}`.slice(
        0,
        100,
      );
    if (secret) credentials.push({ field: key, input: { kind, label, secret } });
    else if (grant && !clear && (kind === 'privateKey' || kind === 'sshCertificate'))
      credentials.push({ field: key, grant: { kind, label, grantId: grant.grantId } });
  }
  return { input, credentials, ...(current ? { current } : {}) };
}

function optionalText(form: FormData, key: string): string | null {
  return String(form.get(key) ?? '').trim() || null;
}

function profileSummary(profile: ConnectionProfile, x: ReturnType<typeof useI18n>['x']): string {
  const configured = protocols.filter(({ id }) => {
    const values = profile[id];
    return (
      !!values.username ||
      Object.entries(values).some(([key, value]) => key.endsWith('Ref') && value)
    );
  });
  return configured.length
    ? configured.map(({ label }) => label).join(' · ')
    : x('connectionProfiles.noCredentials');
}
