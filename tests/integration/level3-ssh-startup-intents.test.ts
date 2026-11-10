import { randomUUID } from 'node:crypto';
import { PassThrough } from 'node:stream';
import { expect, it, vi } from 'vitest';
import {
  createConnectionSchema,
  connectionSchema,
  type ConnectionsBaseline,
  type CreateConnectionInput,
} from '@axterm/plugin-api/connections';
import { connectionProfileSchema, type CatalogBaseline } from '@axterm/plugin-api/catalog';
import { settingsSchema } from '@axterm/plugin-api/configuration';
import { parseQuickConnect, type QuickConnectSshTarget } from '@axterm/plugin-api/session-intents';
import { ConnectionService } from '../../packages/plugins/connections/src/application/connection-service.ts';
import { InteractionService } from '../../packages/plugins/connections/src/application/interaction-service.ts';
import type { ConnectionEvents } from '../../packages/plugins/connections/src/ports/events.ts';
import type {
  SshConnectionHandle,
  SshTransport,
} from '../../packages/plugins/connections/src/ports/ssh-transport.ts';
import type { ConnectionRepository } from '../../packages/plugins/connections/src/ports/repository.ts';
import { TerminalService } from '../../packages/plugins/terminals/src/application/terminal-service.ts';
import { TerminalRecordingWriter } from '../../packages/plugins/terminals/src/adapters/terminal-recording.ts';
import { ConnectionWorkspaceAdmissions } from '../../packages/plugins/connections/src/client/ui/workspace-owner.ts';
import { sshStartupIntent } from '../../packages/plugins/catalog/src/client/ui/session/ssh-startup.ts';
const now = new Date().toISOString();
const profile = connectionProfileSchema.parse({
  id: randomUUID(),
  name: 'Hop Profile',
  isDefault: false,
  version: 1,
  createdAt: now,
  updatedAt: now,
  ssh: { username: 'profile-user' },
});
const facts: Pick<CatalogBaseline, 'hosts' | 'connectionProfiles'> = {
  hosts: [],
  connectionProfiles: [profile],
};
const target = (opts: unknown) =>
  parseQuickConnect(
    'ssh://target-user@target.test?opts=' + encodeURIComponent(JSON.stringify(opts)),
  ) as QuickConnectSshTarget;
it('translates flat hopping/profile selectors and all three retained forwarding directions without persisting Hosts', () => {
  const result = sshStartupIntent(
    target({
      connectionHoppings: [
        {
          host: 'jump.test',
          username: 'hop-user',
          password: 'HOP_TRANSIENT',
          profile: 'Hop Profile',
        },
      ],
      sshTunnels: [
        {
          sshTunnel: 'forwardLocalToRemote',
          sshTunnelLocalHost: '127.0.0.1',
          sshTunnelLocalPort: 8080,
          sshTunnelRemoteHost: 'service.test',
          sshTunnelRemotePort: 80,
        },
        {
          sshTunnel: 'forwardRemoteToLocal',
          sshTunnelLocalHost: 'local.test',
          sshTunnelLocalPort: 9000,
          sshTunnelRemoteHost: '127.0.0.1',
          sshTunnelRemotePort: 9001,
        },
        { sshTunnel: 'dynamicForward', sshTunnelLocalPort: 1080 },
      ],
    }),
    facts,
  );
  expect(result.hops).toEqual([
    {
      target: { hostname: 'jump.test', port: 22, username: 'hop-user', authType: 'password' },
      temporarySecret: 'HOP_TRANSIENT',
      connectionProfileId: profile.id,
    },
  ]);
  expect(result.tunnels).toMatchObject([
    { type: 'local', bindPort: 8080, targetHost: 'service.test', targetPort: 80 },
    { type: 'remote', bindPort: 9001, targetHost: 'local.test', targetPort: 9000 },
    { type: 'dynamic', bindPort: 1080, targetHost: null, targetPort: null },
  ]);
  expect(JSON.stringify(facts)).not.toContain('HOP_TRANSIENT');
});
it('rejects missing/ambiguous Profiles, unsafe binding and malformed or oversized routes before IO', () => {
  expect(() =>
    sshStartupIntent(
      target({ connectionHoppings: [{ host: 'jump.test', profile: 'Missing' }] }),
      facts,
    ),
  ).toThrow('PROFILE');
  expect(() =>
    sshStartupIntent(
      target({ connectionHoppings: [{ host: 'jump.test', profile: 'Hop Profile' }] }),
      { ...facts, connectionProfiles: [profile, { ...profile, id: randomUUID() }] },
    ),
  ).toThrow('PROFILE');
  expect(() =>
    sshStartupIntent(
      target({
        sshTunnels: [
          { sshTunnel: 'dynamicForward', sshTunnelLocalHost: '0.0.0.0', sshTunnelLocalPort: 1080 },
        ],
      }),
      facts,
    ),
  ).toThrow('Non-loopback');
  expect(() =>
    createConnectionSchema.parse({
      target: { hostname: 'target.test', username: 'operator' },
      hops: Array.from({ length: 9 }, () => ({
        target: { hostname: 'hop.test', username: 'operator' },
      })),
    }),
  ).toThrow();
  expect(() =>
    createConnectionSchema.parse({
      target: { hostname: 'target.test', username: 'operator' },
      hops: [{ hostId: randomUUID(), target: { hostname: 'hop.test', username: 'operator' } }],
    }),
  ).toThrow();
});
const handle = (): SshConnectionHandle => ({
  id: randomUUID(),
  onClose: () => () => {},
  openShell: async () => {
    throw Error('UNUSED');
  },
  openSftp: async () => {
    throw Error('UNUSED');
  },
  exec: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
  forwardOut: async () => new PassThrough(),
  forwardIn: async () => 0,
  unforwardIn: async () => {},
  close: vi.fn(async () => {}),
});
function serviceFixture(transport: SshTransport) {
  const published: unknown[] = [];
  const events = {
    publish: (...input: unknown[]) => {
      published.push(input);
    },
  } as ConnectionEvents;
  const interactions = new InteractionService(events);
  const repository: ConnectionRepository = {
    getHost: () => {
      throw Error('UNKNOWN_SAVED_HOST');
    },
    getSettings: () =>
      settingsSchema.parse({
        version: 1,
        appearance: { theme: 'dark', language: 'en' },
        workspace: { restoreLayout: true, aiInspectorOpen: false },
      }),
    getKnownHostKey: () => undefined,
    saveKnownHostKey: () => {
      throw Error('UNEXPECTED_PERSIST');
    },
  };
  const history = { recordSuccessful: vi.fn() };
  const terminals = new TerminalService(
    {
      open: () => {
        throw Error('UNUSED');
      },
    },
    TerminalRecordingWriter,
  );
  const service = new ConnectionService(
    repository,
    transport,
    undefined,
    interactions,
    events,
    terminals,
    history,
    undefined,
    {
      get: (id) => {
        if (id !== profile.id) throw Error('UNKNOWN_PROFILE');
        return profile;
      },
    },
  );
  return {
    service,
    interactions,
    published,
    history,
    close: async () => {
      await service.closeAll();
      interactions.close();
    },
  };
}
it('authenticates and verifies every transient hop, keeps secrets out of facts/history and drops them on explicit retry', async () => {
  const attempts: Parameters<SshTransport['connect']>[0][] = [];
  const channels: PassThrough[] = [];
  const handles: SshConnectionHandle[] = [];
  const f = serviceFixture({
    connect: async (input) => {
      attempts.push(input);
      if (
        !(await input.verifyHostKey({
          algorithm: 'ssh-ed25519',
          fingerprint: 'SHA256:fixture',
          publicKey: 'fixture-key',
        }))
      )
        throw Error('REJECTED');
      const value = handle();
      value.forwardOut = async () => {
        const socket = new PassThrough();
        channels.push(socket);
        return socket;
      };
      handles.push(value);
      return value;
    },
  });
  try {
    const row = f.service.create({
      target: { hostname: 'target.test', username: 'target-user', authType: 'password' },
      temporarySecret: 'TARGET_SECRET',
      hops: [
        {
          target: { hostname: 'jump.test', username: 'hop-user', authType: 'password' },
          temporarySecret: 'HOP_SECRET',
          connectionProfileId: profile.id,
        },
      ],
    });
    for (let index = 0; index < 2; index++) {
      await vi.waitFor(() => expect(f.interactions.list()).toHaveLength(1));
      f.interactions.respond(f.interactions.list()[0]!.id, {
        accepted: true,
        remember: false,
        values: {},
      });
    }
    await vi.waitFor(() => expect(f.service.get(row.id).state).toBe('ready'));
    expect(attempts.map((value) => [value.host, value.username, value.password])).toEqual([
      ['jump.test', 'profile-user', 'HOP_SECRET'],
      ['target.test', 'target-user', 'TARGET_SECRET'],
    ]);
    expect(attempts[1]!.socket).toBe(channels[0]);
    expect(JSON.stringify([...f.published, ...f.history.recordSuccessful.mock.calls])).not.toMatch(
      /HOP_SECRET|TARGET_SECRET/,
    );
    const retried = await f.service.retry(row.id);
    for (let index = 0; index < 2; index++) {
      await vi.waitFor(() => expect(f.interactions.list()).toHaveLength(1));
      f.interactions.respond(f.interactions.list()[0]!.id, {
        accepted: true,
        remember: false,
        values: {},
      });
    }
    await vi.waitFor(() => expect(f.service.get(retried.id).state).toBe('ready'));
    expect(attempts.slice(2).every((value) => value.password === undefined)).toBe(true);
    expect(attempts[2]!.host).toBe('jump.test');
  } finally {
    await f.close();
    for (const socket of channels) socket.destroy();
  }
  expect(handles.every((value) => vi.mocked(value.close).mock.calls.length === 1)).toBe(true);
});
it('validates cycles and missing Profiles before allocating a connection or opening a transport', async () => {
  const connect = vi.fn(async () => handle()),
    f = serviceFixture({ connect });
  try {
    expect(() =>
      f.service.create({
        target: { hostname: 'target.test', username: 'operator' },
        hops: [{ target: { hostname: 'target.test', username: 'operator' } }],
      }),
    ).toThrow('cycle');
    expect(() =>
      f.service.create({
        target: { hostname: 'target.test', username: 'operator' },
        hops: [
          {
            target: { hostname: 'hop.test', username: 'operator' },
            connectionProfileId: randomUUID(),
          },
        ],
      }),
    ).toThrow('PROFILE');
    expect(f.service.list()).toEqual([]);
    expect(connect).not.toHaveBeenCalled();
  } finally {
    await f.close();
  }
});
it('waits for a canceled hop handshake and its late handle cleanup before accepting explicit close', async () => {
  const pending = Promise.withResolvers<SshConnectionHandle>(),
    value = handle(),
    connect = vi.fn(() => pending.promise),
    f = serviceFixture({ connect });
  const row = f.service.create({
    target: { hostname: 'target.test', username: 'operator' },
    hops: [{ target: { hostname: 'hop.test', username: 'operator' } }],
  });
  await vi.waitFor(() => expect(connect).toHaveBeenCalledOnce());
  let drained = false;
  const close = f.service.close(row.id).then(() => {
    drained = true;
  });
  await Promise.resolve();
  expect(drained).toBe(false);
  pending.resolve(value);
  await close;
  expect(value.close).toHaveBeenCalledOnce();
  expect(connect).toHaveBeenCalledOnce();
  await f.close();
});
function admissionFixture() {
  const row = connectionSchema.parse({
    id: randomUUID(),
    hostId: randomUUID(),
    state: 'ready',
    reconnectAttempt: 0,
    nextReconnectAt: null,
    createdAt: now,
    updatedAt: now,
  });
  const baseline: ConnectionsBaseline = {
    generation: randomUUID(),
    cursor: 0,
    revision: 0,
    connections: [row],
    ftpConnections: [],
    interactions: [],
    knownHosts: [],
    tunnelProfiles: [],
    tunnels: [],
  };
  const model = {
    getSnapshot: () => ({ status: 'ready' as const, baseline }),
    subscribe: () => () => {},
    createConnection: vi.fn(async (_key: string, _input: CreateConnectionInput) => row),
    closeConnection: vi.fn(async () => {}),
    reconnectConnectionHistory: vi.fn(),
    getConnectionCommandOutcome: vi.fn(),
  };
  const terminals = { open: vi.fn(async () => 'terminal-view'), activate: vi.fn() };
  const tunnels = { start: vi.fn(async () => {}) };
  return {
    row,
    model,
    terminals,
    tunnels,
    owner: new ConnectionWorkspaceAdmissions(model, terminals, tunnels),
  };
}
const inlineTunnel = {
  name: 'Inline',
  type: 'local' as const,
  bindHost: '127.0.0.1',
  bindPort: 1080,
  targetHost: 'service.test',
  targetPort: 80,
  allowNonLoopback: false,
};
it('starts inline tunnels on its own ready connection before a view and never borrows an existing connection', async () => {
  const f = admissionFixture();
  await f.owner.openSsh({ hostId: f.row.hostId }, undefined, undefined, undefined, undefined, [
    inlineTunnel,
  ]);
  expect(f.model.createConnection).toHaveBeenCalledOnce();
  expect(f.tunnels.start).toHaveBeenCalledWith(
    { connectionId: f.row.id, profile: { ...inlineTunnel, hostId: f.row.hostId } },
    expect.any(AbortSignal),
  );
  expect(f.tunnels.start.mock.invocationCallOrder[0]).toBeLessThan(
    f.terminals.open.mock.invocationCallOrder[0]!,
  );
  await f.owner.dispose();
  expect(f.model.closeConnection).not.toHaveBeenCalled();
});
it('closes an unaccepted startup connection and its tunnels on failure, and rejects unsafe profiles before connection IO', async () => {
  const f = admissionFixture();
  f.tunnels.start.mockRejectedValueOnce(Error('UNKNOWN_START'));
  await expect(
    f.owner.openSsh({ hostId: f.row.hostId }, undefined, undefined, undefined, undefined, [
      inlineTunnel,
    ]),
  ).rejects.toThrow('UNKNOWN_START');
  expect(f.model.closeConnection).toHaveBeenCalledWith(f.row.id, expect.any(String));
  expect(f.terminals.open).not.toHaveBeenCalled();
  await f.owner.dispose();
  const g = admissionFixture();
  await expect(
    g.owner.openSsh({ hostId: g.row.hostId }, undefined, undefined, undefined, undefined, [
      { ...inlineTunnel, bindHost: '0.0.0.0' },
    ]),
  ).rejects.toThrow('INVALID');
  expect(g.model.createConnection).not.toHaveBeenCalled();
  await g.owner.dispose();
});
