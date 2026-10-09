import type { GlobalProxyConfig, HostProxyConfig, ProxyTestRequest } from '@workspace/contracts';

export type ProxyMode = 'inherit' | 'direct' | 'custom';
export type ProxyTestErrorCode =
  'invalidTarget' | 'directNoTest' | 'passwordRequired' | 'usernameRequired';

export interface ProxyDraft {
  mode: ProxyMode;
  url: string;
  username: string;
  password: string;
  targetHost: string;
  targetPort: string;
}

type PersistedProxy = GlobalProxyConfig | HostProxyConfig;

export function retainedProxyCredentialRef(
  proxy: PersistedProxy | undefined,
  username: string,
): string | null {
  if (proxy?.mode !== 'custom') return null;
  return proxy.endpoint.username === normalizeProxyUsername(username)
    ? proxy.endpoint.credentialRef
    : null;
}

export function normalizeProxyUsername(username: string): string | null {
  return username.trim() || null;
}

export function createProxyTestRequest(
  draft: ProxyDraft,
  persisted: PersistedProxy | undefined,
): { ok: true; value: ProxyTestRequest } | { ok: false; code: ProxyTestErrorCode } {
  const targetHost = draft.targetHost.trim();
  const targetPort = Number(draft.targetPort);
  if (!targetHost || !Number.isInteger(targetPort) || targetPort < 1 || targetPort > 65_535)
    return { ok: false, code: 'invalidTarget' };

  if (draft.mode === 'direct') return { ok: false, code: 'directNoTest' };
  if (draft.mode === 'inherit') {
    return {
      ok: true,
      value: {
        source: { kind: 'global' },
        target: { host: targetHost, port: targetPort },
        timeoutMs: 10_000,
      },
    };
  }

  const username = normalizeProxyUsername(draft.username);
  const temporaryPassword = draft.password || undefined;
  const credentialRef = temporaryPassword
    ? null
    : retainedProxyCredentialRef(persisted, draft.username);
  if (username && !temporaryPassword && !credentialRef)
    return { ok: false, code: 'passwordRequired' };
  if (!username && temporaryPassword) return { ok: false, code: 'usernameRequired' };

  return {
    ok: true,
    value: {
      source: {
        kind: 'custom',
        endpoint: {
          url: draft.url.trim(),
          username,
          credentialRef,
        },
        ...(temporaryPassword ? { temporaryPassword } : {}),
      },
      target: { host: targetHost, port: targetPort },
      timeoutMs: 10_000,
    },
  };
}

export function proxyCredentialRefs(proxy: PersistedProxy | undefined): string[] {
  return proxy?.mode === 'custom' && proxy.endpoint.credentialRef
    ? [proxy.endpoint.credentialRef]
    : [];
}
