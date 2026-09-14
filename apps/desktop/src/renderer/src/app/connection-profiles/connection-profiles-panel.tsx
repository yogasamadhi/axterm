import { useRef, useState, type FormEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { createRuntimeClient } from '@workspace/client';
import type {
  ConnectionProfile,
  ConnectionProfileInput,
  CredentialKind,
  PasswordProfileValues,
  SshProfileValues,
} from '@workspace/contracts';
import { Download, Eye, EyeOff, Plus, Search, Trash2, Upload } from 'lucide-react';
import { useI18n } from '../../i18n/context';
import './connection-profiles.css';

type Client = ReturnType<typeof createRuntimeClient>;
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
  client,
  onOpenDataMigration,
}: {
  client: Client;
  onOpenDataMigration?(): void;
}) {
  const { x } = useI18n();
  const profiles = useQuery({
    queryKey: ['connection-profiles'],
    queryFn: client.connectionProfiles,
  });
  const [editing, setEditing] = useState<ConnectionProfile>();
  const [protocol, setProtocol] = useState<Protocol>('ssh');
  const [query, setQuery] = useState('');
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');
  const visibleProfiles =
    profiles.data?.filter((profile) =>
      profile.name.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()),
    ) ?? [];

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (saving) return;
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    const createdRefs: string[] = [];
    const previousRefs = editing ? profileCredentialRefs(editing) : [];
    let committed = false;
    setSaving(true);
    setMessage('');
    try {
      const input = await connectionProfileInput(client, form, editing, x, (ref) =>
        createdRefs.push(ref),
      );
      if (editing) await client.updateConnectionProfile(editing, input);
      else await client.createConnectionProfile(input);
      committed = true;
      await profiles.refetch();
      await cleanupUnreferencedCredentials(client, previousRefs).catch(() => undefined);
      setEditing(undefined);
      setProtocol('ssh');
      formElement.reset();
      setMessage(x(editing ? 'connectionProfiles.updated' : 'connectionProfiles.saved'));
    } catch (cause) {
      if (!committed)
        await Promise.allSettled(createdRefs.map((ref) => client.deleteCredential(ref)));
      setMessage(messageOf(cause, x));
    } finally {
      setSaving(false);
    }
  }

  async function remove(profile: ConnectionProfile) {
    if (!window.confirm(x('connectionProfiles.deleteConfirm', { name: profile.name }))) return;
    setMessage('');
    try {
      await client.deleteConnectionProfile(profile);
      if (editing?.id === profile.id) setEditing(undefined);
      await profiles.refetch();
      await cleanupUnreferencedCredentials(client, profileCredentialRefs(profile)).catch(
        () => undefined,
      );
      setMessage(x('connectionProfiles.deleted'));
    } catch (cause) {
      setMessage(messageOf(cause, x));
    }
  }

  return (
    <section className="connection-profile-panel" aria-labelledby="connection-profile-title">
      <header className="connection-profile-heading">
        <div>
          <span>{x('connectionProfiles.eyebrow')}</span>
          <h3 id="connection-profile-title">{x('connectionProfiles.title')}</h3>
          <p>{x('connectionProfiles.description')}</p>
        </div>
      </header>

      {message && <p className="connection-profile-message">{message}</p>}
      <div className="connection-profile-layout">
        <aside className="connection-profile-list" aria-label={x('connectionProfiles.savedList')}>
          <div className="connection-profile-transport">
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
          <label className="connection-profile-search">
            <input
              aria-label={x('connectionProfiles.searchProfiles')}
              placeholder={x('connectionProfiles.search')}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
            <Search size={14} aria-hidden="true" />
          </label>
          <button
            className="connection-profile-new"
            type="button"
            onClick={() => {
              setEditing(undefined);
              setProtocol('ssh');
            }}
          >
            <Plus size={14} />
            <span>
              <strong>Profiles</strong>
            </span>
          </button>
          {profiles.isLoading && <p className="hint">{x('connectionProfiles.loading')}</p>}
          {visibleProfiles.map((profile) => (
            <button
              className={editing?.id === profile.id ? 'active' : ''}
              key={profile.id}
              type="button"
              title={`${profile.name} · ${
                profile.isDefault
                  ? x('connectionProfiles.defaultProfile')
                  : profileSummary(profile, x)
              }`}
              onClick={() => {
                setEditing(profile);
                setProtocol('ssh');
              }}
            >
              <span>
                <strong>{profile.name}</strong>
              </span>
            </button>
          ))}
          {!profiles.isLoading && !profiles.data?.length && (
            <p className="connection-profile-empty">{x('connectionProfiles.empty')}</p>
          )}
          {!profiles.isLoading && !!profiles.data?.length && !visibleProfiles.length && (
            <p className="connection-profile-empty">{x('connectionProfiles.noMatches')}</p>
          )}
        </aside>

        <form
          className="connection-profile-editor"
          key={
            editing?.id ??
            `new-connection-profile-${profiles.data?.find((profile) => profile.isDefault)?.id ?? 'none'}`
          }
          onSubmit={(event) => void save(event)}
          data-testid="connection-profile-form"
        >
          <p className="connection-profile-id" title={editing?.id}>
            ID: {displayProfileId(editing, profiles.data ?? [])}
          </p>
          <div className="connection-profile-basics">
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
            <label className="connection-profile-default">
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
            className="connection-profile-tabs"
            role="tablist"
            aria-label={x('connectionProfiles.protocols')}
          >
            {protocols.map((item) => (
              <button
                aria-selected={protocol === item.id}
                className={protocol === item.id ? 'active' : ''}
                key={item.id}
                role="tab"
                type="button"
                onClick={() => setProtocol(item.id)}
              >
                {item.label}
              </button>
            ))}
          </div>

          <ProtocolFields
            client={client}
            protocol="ssh"
            active={protocol === 'ssh'}
            values={editing?.ssh}
          />
          {protocols.slice(1).map((item) => (
            <ProtocolFields
              client={client}
              key={item.id}
              protocol={item.id}
              active={protocol === item.id}
              values={editing?.[item.id]}
            />
          ))}

          <div className="connection-profile-actions">
            {editing && (
              <button className="danger" type="button" onClick={() => void remove(editing)}>
                <Trash2 size={14} /> {x('common.delete')}
              </button>
            )}
            <span />
            {editing && (
              <button type="button" onClick={() => setEditing(undefined)}>
                {x('connectionProfiles.cancelEdit')}
              </button>
            )}
            <button
              aria-label={x(editing ? 'connectionProfiles.update' : 'connectionProfiles.save')}
              className="primary"
              disabled={saving}
            >
              {saving ? x('connectionProfiles.saving') : x('connectionProfiles.submit')}
            </button>
          </div>
        </form>
      </div>
    </section>
  );
}

function ProtocolFields({
  client,
  protocol,
  active,
  values,
}: {
  client: Client;
  protocol: Protocol;
  active: boolean;
  values: SshProfileValues | PasswordProfileValues | undefined;
}) {
  const { x } = useI18n();
  const ssh = values as SshProfileValues | undefined;
  return (
    <fieldset className="connection-profile-fields" hidden={!active} aria-hidden={!active}>
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
        client={client}
        name={`${protocol}.password`}
        kind="password"
        saved={!!values?.passwordCredentialRef}
      />
      {protocol === 'ssh' && (
        <>
          <SecretField
            client={client}
            name="ssh.privateKey"
            kind="privateKey"
            saved={!!ssh?.privateKeyCredentialRef}
            multiline
          />
          <SecretField
            client={client}
            name="ssh.passphrase"
            kind="passphrase"
            saved={!!ssh?.passphraseCredentialRef}
          />
          <SecretField
            client={client}
            name="ssh.certificate"
            kind="certificate"
            saved={!!ssh?.certificateCredentialRef}
            multiline
          />
        </>
      )}
      {protocol !== 'ssh' && (
        <p className="hint full-field">
          {x('connectionProfiles.protocolOverrideHint', { protocol: protocol.toUpperCase() })}
        </p>
      )}
    </fieldset>
  );
}

function SecretField({
  client,
  name,
  kind,
  saved,
  multiline = false,
}: {
  client: Client;
  name: string;
  kind: SecretKind;
  saved: boolean;
  multiline?: boolean;
}) {
  const { x } = useI18n();
  const label = x(`connectionProfiles.secret.${kind}`);
  const control = useRef<HTMLInputElement | HTMLTextAreaElement>(null);
  const [revealed, setRevealed] = useState(false);
  const [importError, setImportError] = useState('');

  async function importFromFile() {
    let grantId: string | undefined;
    setImportError('');
    try {
      const grant = await client.createFileGrant('open-file');
      if (!grant) return;
      grantId = grant.grantId;
      const text = await client.readGrantedText(grant.grantId);
      if (control.current) {
        control.current.value = text.content;
        control.current.focus();
      }
    } catch (cause) {
      setImportError(messageOf(cause, x));
    } finally {
      if (grantId) await client.revokeFileGrant(grantId).catch(() => undefined);
    }
  }

  return (
    <label className={multiline ? 'full-field' : ''}>
      {label}
      {multiline ? (
        <>
          <textarea
            ref={(element) => {
              control.current = element;
            }}
            aria-label={label}
            name={name}
            rows={4}
            spellCheck={false}
            placeholder={
              saved
                ? x('connectionProfiles.savedKeepBlank')
                : x(`connectionProfiles.placeholder.${kind}`)
            }
          />
          <button
            className="connection-profile-file-import"
            type="button"
            onClick={() => void importFromFile()}
          >
            {x('connectionProfiles.importFromFile')}
          </button>
        </>
      ) : (
        <span className="connection-profile-secret-input">
          <input
            ref={(element) => {
              control.current = element;
            }}
            aria-label={label}
            name={name}
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
      {importError && <span className="connection-profile-import-error">{importError}</span>}
      {saved && (
        <span className="connection-profile-clear">
          <input name={`${name}.clear`} type="checkbox" />{' '}
          {x('connectionProfiles.clearSaved', { label })}
        </span>
      )}
    </label>
  );
}

function displayProfileId(
  profile: ConnectionProfile | undefined,
  profiles: ConnectionProfile[],
): string {
  if (!profile) return `PROFILE${profiles.length}`;
  const index = profiles.findIndex((candidate) => candidate.id === profile.id);
  return `PROFILE${Math.max(0, index)}`;
}

async function connectionProfileInput(
  client: Client,
  form: FormData,
  current: ConnectionProfile | undefined,
  x: ReturnType<typeof useI18n>['x'],
  created: (ref: string) => void,
): Promise<ConnectionProfileInput> {
  const name = String(form.get('name') ?? '').trim();
  const credential = async (
    field: string,
    existingRef: string | null | undefined,
    kind: CredentialKind,
    label: string,
  ) => {
    const secret = String(form.get(field) ?? '');
    if (secret) {
      const metadata = await client.createCredential({ kind, label: `${name} ${label}`, secret });
      created(metadata.ref);
      return metadata.ref;
    }
    if (form.get(`${field}.clear`) === 'on') return null;
    return existingRef ?? null;
  };
  const passwordSection = async (protocol: Exclude<Protocol, 'ssh'>) => ({
    username: optionalText(form, `${protocol}.username`),
    passwordCredentialRef: await credential(
      `${protocol}.password`,
      current?.[protocol].passwordCredentialRef,
      'protocolPassword',
      x('connectionProfiles.credentialPassword', { protocol: protocol.toUpperCase() }),
    ),
  });

  return {
    name,
    isDefault: form.get('isDefault') === 'on',
    ssh: {
      username: optionalText(form, 'ssh.username'),
      passwordCredentialRef: await credential(
        'ssh.password',
        current?.ssh.passwordCredentialRef,
        'sshPassword',
        x('connectionProfiles.credentialPassword', { protocol: 'SSH' }),
      ),
      privateKeyCredentialRef: await credential(
        'ssh.privateKey',
        current?.ssh.privateKeyCredentialRef,
        'privateKey',
        x('connectionProfiles.credentialPrivateKey'),
      ),
      passphraseCredentialRef: await credential(
        'ssh.passphrase',
        current?.ssh.passphraseCredentialRef,
        'privateKeyPassphrase',
        x('connectionProfiles.credentialPassphrase'),
      ),
      certificateCredentialRef: await credential(
        'ssh.certificate',
        current?.ssh.certificateCredentialRef,
        'sshCertificate',
        x('connectionProfiles.credentialCertificate'),
      ),
    },
    telnet: await passwordSection('telnet'),
    vnc: await passwordSection('vnc'),
    rdp: await passwordSection('rdp'),
    ftp: await passwordSection('ftp'),
    spice: await passwordSection('spice'),
  };
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

function messageOf(cause: unknown, x: ReturnType<typeof useI18n>['x']): string {
  return cause instanceof Error ? cause.message : x('connectionProfiles.operationFailed');
}

function profileCredentialRefs(profile: ConnectionProfile): string[] {
  return [
    profile.ssh.passwordCredentialRef,
    profile.ssh.privateKeyCredentialRef,
    profile.ssh.passphraseCredentialRef,
    profile.ssh.certificateCredentialRef,
    profile.telnet.passwordCredentialRef,
    profile.vnc.passwordCredentialRef,
    profile.rdp.passwordCredentialRef,
    profile.ftp.passwordCredentialRef,
    profile.spice.passwordCredentialRef,
  ].filter((value): value is string => !!value);
}

async function cleanupUnreferencedCredentials(client: Client, candidates: string[]) {
  if (!candidates.length) return;
  const [profiles, hosts, settings, providers] = await Promise.all([
    client.connectionProfiles(),
    client.hosts(),
    client.settings(),
    client.aiProviders(),
  ]);
  const referenced = new Set([
    ...profiles.flatMap(profileCredentialRefs),
    ...hosts.flatMap((host) => [
      host.credentialRef,
      host.passphraseCredentialRef,
      host.certificateCredentialRef,
      ...(host.proxy.mode === 'custom' ? [host.proxy.endpoint.credentialRef] : []),
    ]),
    ...(settings.network.proxy.mode === 'custom'
      ? [settings.network.proxy.endpoint.credentialRef]
      : []),
    ...providers.map((provider) => provider.credentialRef),
  ]);
  await Promise.allSettled(
    [...new Set(candidates)]
      .filter((reference) => !referenced.has(reference))
      .map((reference) => client.deleteCredential(reference)),
  );
}
