import { describe, expect, it } from 'vitest';
import {
  globalProxySchema,
  hostProxySchema,
  proxyEndpointSchema,
  proxyTestRequestSchema,
} from '../../packages/contracts/src/index';
import {
  createProxyTestRequest,
  proxyCredentialRefs,
  retainedProxyCredentialRef,
  type ProxyDraft,
} from '../../apps/desktop/src/renderer/src/app/proxy-settings-model';

const customProxy = {
  mode: 'custom',
  endpoint: {
    url: 'socks5h://127.0.0.1:1080',
    username: 'proxy-user',
    credentialRef: 'credential:proxy:1',
  },
} as const;

describe('SSH proxy contract and renderer model', () => {
  it('uses deterministic direct/inherit defaults without reading environment configuration', () => {
    expect(globalProxySchema.parse(undefined)).toEqual({ mode: 'direct' });
    expect(hostProxySchema.parse(undefined)).toEqual({ mode: 'inherit' });
  });

  it('accepts supported proxy origins and rejects embedded credentials or URL paths', () => {
    expect(
      proxyEndpointSchema.parse({
        url: 'https://[2001:db8::1]:8443',
        username: null,
        credentialRef: null,
      }),
    ).toMatchObject({ url: 'https://[2001:db8::1]:8443' });
    expect(() =>
      proxyEndpointSchema.parse({
        url: 'http://user:password@127.0.0.1:8080',
        username: null,
        credentialRef: null,
      }),
    ).toThrow();
    expect(() =>
      proxyEndpointSchema.parse({
        url: 'socks5://127.0.0.1:1080/tunnel',
        username: null,
        credentialRef: null,
      }),
    ).toThrow();
  });

  it('accepts structured ProxyCommand templates and rejects control lines or unknown placeholders', () => {
    expect(
      hostProxySchema.parse({
        mode: 'command',
        command: { executable: 'ssh', arguments: ['-W', '%h:%p', 'jump.example.test'] },
      }),
    ).toMatchObject({ mode: 'command' });
    expect(() =>
      hostProxySchema.parse({
        mode: 'command',
        command: { executable: 'ssh', arguments: ['-W', '%h:%x'] },
      }),
    ).toThrow();
    expect(() =>
      hostProxySchema.parse({
        mode: 'command',
        command: { executable: 'ssh\nmalicious', arguments: ['%h', '%p'] },
      }),
    ).toThrow();
  });

  it('keeps proxy authentication metadata paired and exposes only credential references', () => {
    expect(retainedProxyCredentialRef(customProxy, ' proxy-user ')).toBe('credential:proxy:1');
    expect(retainedProxyCredentialRef(customProxy, 'different-user')).toBeNull();
    expect(proxyCredentialRefs(customProxy)).toEqual(['credential:proxy:1']);
    expect(() =>
      proxyEndpointSchema.parse({
        url: 'http://127.0.0.1:8080',
        username: 'proxy-user',
        credentialRef: null,
      }),
    ).toThrow();
  });

  it('builds a transient authenticated test request without persisting the password', () => {
    const request = createProxyTestRequest(draft({ password: 'one-request-only' }), customProxy);
    expect(request).toMatchObject({
      ok: true,
      value: {
        source: {
          kind: 'custom',
          endpoint: { username: 'proxy-user', credentialRef: null },
          temporaryPassword: 'one-request-only',
        },
      },
    });
    if (!request.ok) throw new Error(request.code);
    expect(proxyTestRequestSchema.parse(request.value)).toEqual(request.value);
    expect(JSON.stringify(request.value)).not.toContain('credential:proxy:1');
  });

  it('tests inherited Host policy against the current global proxy and rejects incomplete auth', () => {
    const inherited = createProxyTestRequest(draft({ mode: 'inherit' }), undefined);
    expect(inherited).toMatchObject({ ok: true, value: { source: { kind: 'global' } } });

    expect(
      createProxyTestRequest(draft({ username: 'new-user', password: '' }), customProxy),
    ).toEqual({ ok: false, code: 'passwordRequired' });
  });
});

function draft(overrides: Partial<ProxyDraft> = {}): ProxyDraft {
  return {
    mode: 'custom',
    url: 'socks5h://127.0.0.1:1080',
    username: 'proxy-user',
    password: '',
    targetHost: 'ssh.example.test',
    targetPort: '22',
    ...overrides,
  };
}
