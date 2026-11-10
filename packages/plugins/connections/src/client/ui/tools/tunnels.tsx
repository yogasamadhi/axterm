import { useState, useSyncExternalStore, type FormEvent } from 'react';
import { Save, Check, Network, Square, Play, Pencil, Trash2 } from 'lucide-react';
import type { Connection, Host, TunnelProfile } from '@axterm/plugin-api/connections';
import type { ConnectionsModel } from '../../index.ts';
import type { TunnelOperations } from './operations.ts';
import { useI18n } from './i18n.tsx';
import { cx } from './styles.ts';
import { PanelFrame, ErrorBanner } from './scaffold.tsx';
export function TunnelsPanel({
  model,
  operations,
  connections,
  hosts,
}: {
  model: ConnectionsModel;
  operations: TunnelOperations;
  connections: readonly Connection[];
  hosts: readonly Host[];
}) {
  const { x } = useI18n();
  const state = useSyncExternalStore(model.subscribe, model.getSnapshot);
  const command = useSyncExternalStore(operations.subscribe, operations.getSnapshot);
  const profiles = state.status === 'ready' ? state.baseline.tunnelProfiles : [];
  const active = state.status === 'ready' ? state.baseline.tunnels : [];
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
      if (editingProfile)
        await operations.fact((key) =>
          model.updateTunnelProfile(
            key,
            editingProfile!.id,
            input,
            '"v' + editingProfile!.version + '"',
          ),
        );
      else await operations.fact((key) => model.createTunnelProfile(key, input));
      formElement.reset();
      setEditingProfile(undefined);
      setProfileType('local');
      setError('');
    } catch {
      setError(x('common.operationFailed'));
    }
  }
  async function start(profileId: string, hostId: string) {
    const connection = ready.find((item) => item.hostId === hostId);
    if (!connection) return setError(x('tunnels.connectHostFirst'));
    try {
      await operations.start({ connectionId: connection.id, profileId });
    } catch {
      setError(x('common.operationFailed'));
    }
  }
  async function stop(tunnelId: string) {
    try {
      await operations.action(() => model.stopTunnel(tunnelId));
      setError('');
    } catch {
      setError(x('common.operationFailed'));
    }
  }
  async function remove(profile: TunnelProfile) {
    if (!window.confirm(x('tunnels.deleteConfirm', { name: profile.name }))) return;
    try {
      const ids = active.filter(({ profileId }) => profileId === profile.id).map(({ id }) => id);
      await operations.fact(async (key) => {
        for (const id of ids) await model.stopTunnel(id);
        return model.deleteTunnelProfile(key, profile.id, '"v' + profile.version + '"');
      });
      if (editingProfile?.id === profile.id) setEditingProfile(undefined);
      setError('');
    } catch {
      setError(x('common.operationFailed'));
    }
  }
  return (
    <PanelFrame
      eyebrow={x('tunnels.eyebrow')}
      title={x('tunnels.title')}
      description={x('tunnels.description')}
    >
      {error && <ErrorBanner text={error} />}
      {command.uncertain && (
        <p role="alert">
          {x('tools.uncertain')}{' '}
          <button
            type="button"
            onClick={() =>
              void operations.retry().catch(() => setError(x('common.operationFailed')))
            }
          >
            {x('tools.checkAgain')}
          </button>
        </p>
      )}
      <fieldset disabled={command.busy || command.uncertain} className={cx('tools-fieldset')}>
        <div className={cx('two-column tunnel-manager')}>
          <form
            className={cx('stack surface')}
            key={editingProfile?.id ?? 'new-tunnel'}
            onSubmit={(event) => void save(event)}
          >
            <div className={cx('panel-heading-inline')}>
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
            <div className={cx('inline')}>
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
              <div className={cx('inline')}>
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
              <label className={cx('check')}>
                <input
                  defaultChecked={editingProfile?.allowNonLoopback ?? false}
                  name="allowNonLoopback"
                  type="checkbox"
                />
                {x('tunnels.allowNonLoopback')}
              </label>
            )}
            <button
              className={cx('primary')}
              disabled={!hosts.length || command.busy || command.uncertain}
            >
              <Save size={13} />{' '}
              {editingProfile ? x('tunnels.saveChanges') : x('tunnels.saveProfile')}
            </button>
          </form>
          <div className={cx('surface list')}>
            <h3>{x('tunnels.profilesAndInstances')}</h3>
            {!profiles.length && <p className={cx('hint')}>{x('tunnels.empty')}</p>}
            {profiles.map((profile) => {
              const tunnel = active.find(({ profileId }) => profileId === profile.id);
              const host = hosts.find(({ id }) => id === profile.hostId);
              const canStart = ready.some(({ hostId }) => hostId === profile.hostId);
              return (
                <div
                  className={cx(`list-row tunnel-profile-row ${tunnel?.state ?? ''}`)}
                  key={profile.id}
                >
                  {tunnel?.state === 'active' ? <Check size={15} /> : <Network size={15} />}
                  <div>
                    <strong>{profile.name}</strong>
                    <small>
                      {host?.name ?? x('tunnels.unknownHost')} · {tunnelTypeLabel(profile.type, x)}{' '}
                      · {profile.bindHost}:{tunnel?.bindPort ?? profile.bindPort}
                      {profile.type !== 'dynamic'
                        ? ` → ${profile.targetHost}:${profile.targetPort}`
                        : ''}
                    </small>
                    <small className={cx('tunnel-status')}>
                      {tunnel
                        ? tunnelStateLabel(tunnel.state, x, tunnel.errorCode)
                        : canStart
                          ? x('tunnels.connectedReady')
                          : x('tunnels.waitingForHost')}
                    </small>
                  </div>
                  <div className={cx('row-actions')}>
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
                        disabled={!canStart || command.busy || command.uncertain}
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
      </fieldset>
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
