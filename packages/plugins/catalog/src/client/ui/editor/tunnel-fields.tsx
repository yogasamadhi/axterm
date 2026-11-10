import type { TunnelWorkspaceUi } from '@axterm/ui/workspace';
import { useState } from 'react';
import { Trash2, Pencil, Play, Square, Save } from 'lucide-react';
import type {
  Host,
  Connection,
  ConnectionClientActions,
  Tunnel,
  TunnelProfile,
} from '@axterm/plugin-api/connections';
import type { EditorOperations } from './operations.ts';
import { useI18n } from '../i18n.tsx';
import styles from './editor.module.css';
const classes = (value: string) =>
  value
    .split(/\s+/u)
    .filter(Boolean)
    .map((name) => name + ' ' + (styles[name] ?? ''))
    .join(' ');
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
export function HostTunnelFields({
  tunnels,
  actions,
  operations,
  host,
  profiles,
  active,
  connections,
  onChanged,
  onError,
}: {
  tunnels?: TunnelWorkspaceUi | undefined;
  actions: ConnectionClientActions;
  operations: EditorOperations;
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
      if (draft.editing)
        await operations.fact((key) =>
          actions.updateTunnelProfile(
            key,
            draft.editing!.id,
            input,
            '"v' + draft.editing!.version + '"',
          ),
        );
      else await operations.fact((key) => actions.createTunnelProfile(key, input));
      setDraft(emptyTunnelDraft());
      onError('');
      onChanged();
    } catch {
      onError(x('common.operationFailed'));
    }
  }
  async function remove(profile: TunnelProfile) {
    if (!window.confirm(x('hostTunnel.deleteConfirm', { name: profile.name }))) return;
    try {
      for (const tunnel of active.filter((value) => value.profileId === profile.id))
        await operations.admit(() => actions.stopTunnel(tunnel.id));
      await operations.fact((key) =>
        actions.deleteTunnelProfile(key, profile.id, '"v' + profile.version + '"'),
      );
      if (draft.editing?.id === profile.id) setDraft(emptyTunnelDraft());
      onError('');
      onChanged();
    } catch {
      onError(x('common.operationFailed'));
    }
  }
  async function toggle(profile: TunnelProfile, tunnel?: Tunnel) {
    try {
      if (tunnel) await operations.admit(() => actions.stopTunnel(tunnel.id));
      else if (connection)
        await operations.admit((signal) => {
          if (!tunnels) throw Error('TUNNEL_WORKSPACE_UNAVAILABLE');
          return tunnels.start({ connectionId: connection.id, profileId: profile.id }, signal);
        });
      else throw new Error(x('hostTunnel.connectFirst'));
      onError('');
      onChanged();
    } catch {
      onError(x('common.operationFailed'));
      onChanged();
    }
  }
  return (
    <fieldset
      aria-labelledby="ssh-bookmark-tab-tunnels"
      className={classes('host-tunnel-editor host-form-field full-field')}
      data-tab="tunnels"
      id="ssh-bookmark-tunnels"
      role="tabpanel"
    >
      <legend>{x('hostTunnel.title')}</legend>
      {!host ? (
        <p className={classes('hint')}>{x('hostTunnel.saveHostFirst')}</p>
      ) : (
        <>
          <div className={classes('host-tunnel-draft')}>
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
              <label className={classes('check host-tunnel-non-loopback')}>
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
            <div className={classes('host-tunnel-draft-actions')}>
              {draft.editing && (
                <button type="button" onClick={() => setDraft(emptyTunnelDraft())}>
                  {x('common.cancel')}
                </button>
              )}
              <button className={classes('primary')} type="button" onClick={() => void save()}>
                <Save size={13} />{' '}
                {draft.editing ? x('hostTunnel.saveChanges') : x('hostTunnel.add')}
              </button>
            </div>
          </div>
          <div className={classes('host-tunnel-list')}>
            {!profiles.length && <p className={classes('hint')}>{x('hostTunnel.empty')}</p>}
            {profiles.map((profile) => {
              const tunnel = active.find(({ profileId }) => profileId === profile.id);
              return (
                <div className={classes(`host-tunnel-row ${tunnel?.state ?? ''}`)} key={profile.id}>
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
function tunnelTypeLabel(type: TunnelProfile['type'], x: ReturnType<typeof useI18n>['x']) {
  return x(
    type === 'local'
      ? 'hostTunnel.local'
      : type === 'remote'
        ? 'hostTunnel.remote'
        : 'hostTunnel.dynamic',
  );
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
