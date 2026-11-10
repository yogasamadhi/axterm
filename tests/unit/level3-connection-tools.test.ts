import { randomUUID } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { RemoteError } from '@axterm/plugin-api';
import type {
  ConnectionsBaseline,
  StartTunnelInput,
  ConnectionCommandOutcome,
  Tunnel,
} from '@axterm/plugin-api/connections';
import {
  settingsSchema,
  type ConfigurationClientActions,
  type SettingsBaseline,
} from '@axterm/plugin-api/configuration';
import type {
  SavedCredentialActions,
  CredentialCommandReceipt,
} from '@axterm/plugin-api/saved-credentials';
import { TunnelOperations } from '../../packages/plugins/connections/src/client/ui/tools/operations.ts';
import { ProxySave } from '../../packages/plugins/connections/src/client/ui/tools/proxy-save.ts';
function tunnelFixture() {
  let baseline: ConnectionsBaseline = {
    generation: randomUUID(),
    cursor: 0,
    revision: 0,
    connections: [],
    ftpConnections: [],
    interactions: [],
    knownHosts: [],
    tunnelProfiles: [],
    tunnels: [],
  };
  const model = {
    getSnapshot: () => ({ status: 'ready' as const, baseline }),
    startTunnel: vi.fn<
      (key: string, input: StartTunnelInput, signal?: AbortSignal) => Promise<Tunnel>
    >(async () => {
      throw Error('LOST_RESPONSE');
    }),
    getTunnelCommandOutcome: vi.fn<
      (_: string, key: string) => Promise<ConnectionCommandOutcome | { status: 'rejected' }>
    >(async () => ({ status: 'pending' })),
  };
  const owner = new TunnelOperations(model);
  return {
    model,
    owner,
    retire: () => {
      baseline = { ...baseline, generation: randomUUID() };
    },
  };
}
const input = (): StartTunnelInput => ({ connectionId: randomUUID(), profileId: randomUUID() });
it('reconciles an unknown tunnel opening with the original generation/key and never starts it again', async () => {
  const { model, owner } = tunnelFixture();
  await expect(owner.start(input())).rejects.toThrow('FAILED');
  expect(owner.getSnapshot()).toMatchObject({ busy: false, uncertain: true, failed: true });
  expect(() => owner.start(input())).toThrow('BUSY');
  const [key] = model.startTunnel.mock.calls[0]!;
  model.getTunnelCommandOutcome.mockResolvedValue({ status: 'accepted', id: randomUUID() });
  await owner.retry();
  expect(model.startTunnel).toHaveBeenCalledOnce();
  expect(model.getTunnelCommandOutcome.mock.calls.every(([, id]) => id === key)).toBe(true);
  expect(owner.getSnapshot().uncertain).toBe(false);
  await owner.close();
});
it('retires unresolved intents on generation change without querying a new Host for old resources', async () => {
  const f = tunnelFixture();
  await expect(f.owner.start(input())).rejects.toThrow();
  f.model.getTunnelCommandOutcome.mockClear();
  f.retire();
  await f.owner.retry();
  expect(f.model.getTunnelCommandOutcome).not.toHaveBeenCalled();
  await f.owner.close();
});
it('rejects cancellation before IO and waits for an in-flight opening before UI unload completes', async () => {
  const f = tunnelFixture();
  const canceled = new AbortController();
  canceled.abort();
  expect(() => f.owner.start(input(), canceled.signal)).toThrow();
  expect(f.model.startTunnel).not.toHaveBeenCalled();
  const pending = Promise.withResolvers<never>();
  f.model.startTunnel.mockImplementation(() => pending.promise);
  f.model.getTunnelCommandOutcome.mockResolvedValue({ status: 'rejected' });
  const opening = f.owner.start(input());
  const rejected = expect(opening).rejects.toThrow();
  await vi.waitFor(() => expect(f.model.startTunnel).toHaveBeenCalledOnce());
  let closed = false;
  const closing = f.owner.close().then(() => {
    closed = true;
  });
  await Promise.resolve();
  expect(closed).toBe(false);
  pending.reject(Error('CANCELED'));
  await rejected;
  await closing;
  expect(closed).toBe(true);
});
it('retries a durable fact with the same idempotency identity and does not mutate again during unload', async () => {
  const f = tunnelFixture(),
    write = vi.fn(async (_key: string) => {
      throw Error('LOST_RESPONSE');
    });
  await expect(f.owner.fact(write)).rejects.toThrow();
  await expect(f.owner.close()).rejects.toThrow('UNDRAINED');
  expect(write).toHaveBeenCalledOnce();
  const g = tunnelFixture(),
    fact = vi.fn(async (_key: string) => {
      if (fact.mock.calls.length === 1) throw Error('LOST_RESPONSE');
      return 'committed';
    });
  await expect(g.owner.fact(fact)).rejects.toThrow();
  await g.owner.retry();
  expect(fact.mock.calls[0]![0]).toBe(fact.mock.calls[1]![0]);
  await g.owner.close();
});
it('clears a definitive version rejection and keeps failures out of retained command state', async () => {
  const f = tunnelFixture();
  await expect(
    f.owner.fact(async () => {
      throw new RemoteError('connections/failure', 'Changed', { reason: 'precondition-failed' });
    }),
  ).rejects.toThrow();
  expect(f.owner.getSnapshot()).toMatchObject({ busy: false, uncertain: false, failed: true });
  await f.owner.close();
});
function proxyFixture() {
  let baseline: SettingsBaseline = {
    generation: randomUUID(),
    cursor: 0,
    settings: settingsSchema.parse({
      version: 1,
      appearance: { theme: 'dark', language: 'en' },
      workspace: { restoreLayout: true, aiInspectorOpen: false },
    }),
  };
  const settings = {
    getSnapshot: () => ({ status: 'ready' as const, baseline }),
    subscribe: () => () => {},
    retry: vi.fn(async () => {}),
    setNetworkProxy: vi.fn(async () => ({ version: 2, cursor: 1 })),
    setFileManagerPreferences: vi.fn(),
    setDefaultTerminalProfile: vi.fn(),
    setConnectionHistoryEnabled: vi.fn(),
  } satisfies ConfigurationClientActions;
  const ref = 'cred_' + randomUUID();
  const commandId = randomUUID();
  const receipt = (status: CredentialCommandReceipt['status']): CredentialCommandReceipt => ({
    commandId,
    generation: baseline.generation,
    operation: 'create',
    status,
    ref,
  });
  const vault = {
    submitCreate: vi.fn<SavedCredentialActions['submitCreate']>(() => ({
      commandId,
      generation: baseline.generation,
      result: Promise.resolve(receipt('completed')),
    })),
    outcome: vi.fn(async () => receipt('completed')),
    submitFromGrant: vi.fn(),
    submitRemove: vi.fn(),
    create: vi.fn(),
    remove: vi.fn(),
  } satisfies SavedCredentialActions;
  return {
    settings,
    vault,
    ref,
    receipt,
    owner: new ProxySave(settings, vault),
    retire: () => {
      baseline = { ...baseline, generation: randomUUID() };
    },
  };
}
const proxy = () => ({
  mode: 'custom' as const,
  endpoint: { url: 'http://127.0.0.1:3128', username: 'operator', credentialRef: null },
});
it('submits a proxy secret once, clears its input and reconciles readonly Vault metadata before settings', async () => {
  const f = proxyFixture();
  f.vault.submitCreate.mockImplementation(() => ({
    commandId: f.receipt('running').commandId,
    generation: f.receipt('running').generation,
    result: Promise.resolve(f.receipt('running')),
  }));
  await f.owner.save(proxy(), 'TRANSIENT_PROXY_SECRET', 'Local proxy');
  expect(f.owner.getSnapshot().status).toBe('uncertain');
  expect(f.settings.setNetworkProxy).not.toHaveBeenCalled();
  expect(f.vault.submitCreate.mock.calls[0]![0].secret).toBe('');
  expect(JSON.stringify(f.owner.getSnapshot())).not.toContain('TRANSIENT');
  await f.owner.retry();
  expect(f.vault.submitCreate).toHaveBeenCalledOnce();
  expect(f.vault.outcome).toHaveBeenCalledOnce();
  expect(f.settings.setNetworkProxy).toHaveBeenCalledWith(
    expect.any(String),
    {
      mode: 'custom',
      endpoint: { url: 'http://127.0.0.1:3128', username: 'operator', credentialRef: f.ref },
    },
    '"v1"',
  );
  expect(f.owner.getSnapshot()).toMatchObject({ status: 'saved', credentialRetained: true });
  expect(f.vault.remove).not.toHaveBeenCalled();
  await f.owner.close();
});
it('retains a referenced credential across uncertain settings writes and retries the identical fact command', async () => {
  const f = proxyFixture();
  f.settings.setNetworkProxy.mockRejectedValueOnce(Error('LOST_RESPONSE'));
  await f.owner.save(proxy(), 'TRANSIENT_PROXY_SECRET', 'Local proxy');
  expect(f.owner.getSnapshot().status).toBe('uncertain');
  await f.owner.retry();
  expect(f.settings.setNetworkProxy.mock.calls[0]).toEqual(
    f.settings.setNetworkProxy.mock.calls[1],
  );
  expect(f.vault.submitCreate).toHaveBeenCalledOnce();
  expect(f.vault.submitRemove).not.toHaveBeenCalled();
  expect(f.vault.remove).not.toHaveBeenCalled();
  await f.owner.close();
});
it('never applies an old proxy intent to a replacement generation', async () => {
  const f = proxyFixture();
  f.settings.setNetworkProxy.mockRejectedValueOnce(Error('LOST_RESPONSE'));
  await f.owner.save(proxy(), 'TRANSIENT_PROXY_SECRET', 'Local proxy');
  f.retire();
  await f.owner.retry();
  expect(f.settings.setNetworkProxy).toHaveBeenCalledOnce();
  expect(f.vault.remove).not.toHaveBeenCalled();
  expect(f.owner.getSnapshot().status).toBe('failed');
  await f.owner.close();
});
it('validates proxy input before creating a credential and preserves it on a definitive settings conflict', async () => {
  const f = proxyFixture();
  expect(() => f.owner.save({ mode: 'direct' }, 'SECRET', 'Invalid')).toThrow('USERNAME');
  expect(() =>
    f.owner.save(
      { ...proxy(), endpoint: { ...proxy().endpoint, url: 'file:///secret' } },
      'SECRET',
      'Invalid',
    ),
  ).toThrow();
  expect(f.vault.submitCreate).not.toHaveBeenCalled();
  f.settings.setNetworkProxy.mockRejectedValueOnce(
    new RemoteError('configuration/failure', 'Changed', { reason: 'precondition-failed' }),
  );
  await f.owner.save(proxy(), 'SECRET', 'Local proxy');
  expect(f.owner.getSnapshot()).toMatchObject({ status: 'failed', credentialRetained: true });
  expect(f.vault.submitRemove).not.toHaveBeenCalled();
  await f.owner.close();
});
