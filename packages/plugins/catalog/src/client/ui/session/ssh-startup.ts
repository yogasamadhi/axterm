import { tunnelProfileInputSchema, type ConnectionHopInput } from '@axterm/plugin-api/connections';
import type { CatalogBaseline } from '@axterm/plugin-api/catalog';
import type { QuickConnectSshTarget } from '@axterm/plugin-api/session-intents';
import type { SshStartupTunnel } from '@axterm/ui/workspace';
/** Translate retained UI grammar; only Connections resolves credentials and opens network resources. */
export function sshStartupIntent(
  target: QuickConnectSshTarget,
  facts: Pick<CatalogBaseline, 'hosts' | 'connectionProfiles'>,
): { hops: ConnectionHopInput[]; tunnels: SshStartupTunnel[] } {
  if ((target.connectionHoppings?.length ?? 0) > 8 || (target.sshTunnels?.length ?? 0) > 8)
    throw Error('SSH_STARTUP_CAPACITY');
  const hops = (target.connectionHoppings ?? []).map((hop): ConnectionHopInput => {
    const selected = hop.profile
      ? (facts.connectionProfiles ?? []).filter(
          (profile) => profile.id === hop.profile || profile.name === hop.profile,
        )
      : [];
    if (hop.profile && selected.length !== 1) throw Error('SSH_HOP_PROFILE_UNAVAILABLE');
    const saved = hop.temporarySecret
      ? undefined
      : facts.hosts.find(
          (host) =>
            host.hostname === hop.hostname &&
            host.port === hop.port &&
            (!hop.username || host.username === hop.username),
        );
    return {
      ...(saved
        ? { hostId: saved.id }
        : {
            target: {
              hostname: hop.hostname,
              port: hop.port,
              username: hop.username ?? 'root',
              authType: hop.temporarySecret ? 'password' : (hop.authType ?? 'agent'),
            },
          }),
      ...(selected[0] ? { connectionProfileId: selected[0].id } : {}),
      ...(hop.temporarySecret !== undefined ? { temporarySecret: hop.temporarySecret } : {}),
    };
  });
  const tunnels = (target.sshTunnels ?? []).map((tunnel, index): SshStartupTunnel => {
    const type =
      tunnel.sshTunnel === 'dynamicForward'
        ? 'dynamic'
        : tunnel.sshTunnel === 'forwardLocalToRemote'
          ? 'local'
          : 'remote';
    const { hostId: _host, ...profile } = tunnelProfileInputSchema.parse({
      hostId: crypto.randomUUID(),
      name: (tunnel.name || 'Quick Connect ' + (index + 1)).slice(0, 100),
      type,
      bindHost:
        (type === 'remote' ? tunnel.sshTunnelRemoteHost : tunnel.sshTunnelLocalHost) ?? '127.0.0.1',
      bindPort: type === 'remote' ? tunnel.sshTunnelRemotePort : tunnel.sshTunnelLocalPort,
      targetHost:
        type === 'dynamic'
          ? null
          : type === 'remote'
            ? (tunnel.sshTunnelLocalHost ?? '127.0.0.1')
            : tunnel.sshTunnelRemoteHost,
      targetPort:
        type === 'dynamic'
          ? null
          : type === 'remote'
            ? tunnel.sshTunnelLocalPort
            : tunnel.sshTunnelRemotePort,
      allowNonLoopback: false,
    });
    return profile;
  });
  return { hops, tunnels };
}
