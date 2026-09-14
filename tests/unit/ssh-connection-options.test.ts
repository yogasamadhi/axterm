import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  connectionSchema,
  createHostSchema,
  DEFAULT_SSH_CONNECTION_OPTIONS,
  DEFAULT_SSH_AGENT,
  DEFAULT_SSH_STARTUP,
  DEFAULT_SSH_X11,
  quickConnectTargetSchema,
  updateHostSchema,
} from '../../packages/contracts/src';

const hostInput = {
  name: 'settings fixture',
  hostname: 'ssh.example.test',
  username: 'operator',
  authType: 'agent' as const,
};

describe('SSH connection option contracts', () => {
  it('applies Electerm-compatible bounded defaults to saved and transient targets', () => {
    expect(createHostSchema.parse(hostInput).connectionOptions).toEqual(
      DEFAULT_SSH_CONNECTION_OPTIONS,
    );
    expect(createHostSchema.parse(hostInput).startup).toEqual(DEFAULT_SSH_STARTUP);
    expect(createHostSchema.parse(hostInput).x11).toEqual(DEFAULT_SSH_X11);
    expect(createHostSchema.parse(hostInput).sshAgent).toEqual(DEFAULT_SSH_AGENT);
    expect(
      quickConnectTargetSchema.parse({ hostname: 'quick.example.test', username: 'operator' })
        .connectionOptions,
    ).toEqual(DEFAULT_SSH_CONNECTION_OPTIONS);
    expect(
      createHostSchema.parse({
        ...hostInput,
        connectionOptions: {
          connectionTimeoutMs: 25_000,
          reconnectPolicy: { mode: 'automatic' },
        },
      }).connectionOptions,
    ).toEqual({
      ...DEFAULT_SSH_CONNECTION_OPTIONS,
      connectionTimeoutMs: 25_000,
      reconnectPolicy: { ...DEFAULT_SSH_CONNECTION_OPTIONS.reconnectPolicy, mode: 'automatic' },
    });
  });

  it('keeps certificate references opaque and validates sparse SSH Agent settings', () => {
    expect(
      createHostSchema.parse({
        ...hostInput,
        certificateCredentialRef: 'credential-certificate',
        sshAgent: { enabled: false, path: '/tmp/agent.sock' },
      }),
    ).toMatchObject({
      certificateCredentialRef: 'credential-certificate',
      sshAgent: { enabled: false, path: '/tmp/agent.sock' },
    });
    expect(updateHostSchema.parse({ sshAgent: { path: '/tmp/other.sock' } })).toEqual({
      sshAgent: { path: '/tmp/other.sock' },
    });
    expect(
      createHostSchema.safeParse({ ...hostInput, sshAgent: { path: '/tmp/agent.sock\nBAD' } })
        .success,
    ).toBe(false);
  });

  it('accepts an explicit local X11 display and preserves sparse patches', () => {
    expect(
      createHostSchema.parse({ ...hostInput, x11: { enabled: true, display: ':7.1' } }).x11,
    ).toEqual({
      enabled: true,
      display: ':7.1',
    });
    expect(updateHostSchema.parse({ x11: { enabled: false } })).toEqual({
      x11: { enabled: false },
    });
    expect(
      createHostSchema.safeParse({ ...hostInput, x11: { enabled: true, display: ':0\nBAD' } })
        .success,
    ).toBe(false);
  });

  it('accepts bounded startup settings and rejects secrets, control lines and oversized lists', () => {
    expect(
      createHostSchema.parse({
        ...hostInput,
        startup: {
          directory: '/srv/project',
          environment: { APP_MODE: 'staging' },
          loginScripts: [{ command: 'source ~/.profile', delayMs: 250 }],
          runScripts: [{ command: 'printf ready', delayMs: 0 }],
        },
      }).startup,
    ).toEqual({
      directory: '/srv/project',
      environment: { APP_MODE: 'staging' },
      loginScripts: [
        {
          command: 'source ~/.profile',
          delayMs: 250,
          sendEnter: true,
          waitForOutput: true,
          settleIdleMs: 400,
          settleTimeoutMs: 3_000,
        },
      ],
      runScripts: [
        {
          command: 'printf ready',
          delayMs: 0,
          sendEnter: true,
          waitForOutput: true,
          settleIdleMs: 400,
          settleTimeoutMs: 3_000,
        },
      ],
    });
    for (const startup of [
      { environment: { API_TOKEN: 'must-not-persist' } },
      { environment: { SAFE_NAME: 'line\nbreak' } },
      { directory: '/srv\nother' },
      { runScripts: [{ command: 'echo ok', delayMs: 60_001 }] },
      {
        loginScripts: Array.from({ length: 17 }, () => ({ command: 'true', delayMs: 0 })),
      },
    ])
      expect(createHostSchema.safeParse({ ...hostInput, startup }).success).toBe(false);
  });

  it('accepts a nested patch without resetting unspecified persisted settings', () => {
    expect(
      updateHostSchema.parse({
        connectionOptions: { reconnectPolicy: { delayMs: 750 } },
      }),
    ).toEqual({ connectionOptions: { reconnectPolicy: { delayMs: 750 } } });
  });

  it('accepts bounded algorithm preference lists and rejects unsafe or oversized names', () => {
    expect(
      createHostSchema.parse({
        ...hostInput,
        connectionOptions: {
          algorithms: {
            kex: ['curve25519-sha256'],
            cipher: ['aes256-ctr'],
            serverHostKey: ['ssh-ed25519'],
            hmac: ['hmac-sha2-256-etm@openssh.com'],
          },
        },
      }).connectionOptions.algorithms,
    ).toEqual({
      kex: ['curve25519-sha256'],
      cipher: ['aes256-ctr'],
      serverHostKey: ['ssh-ed25519'],
      hmac: ['hmac-sha2-256-etm@openssh.com'],
    });
    expect(
      createHostSchema.safeParse({
        ...hostInput,
        connectionOptions: { algorithms: { cipher: ['aes256-ctr\nmalicious'] } },
      }).success,
    ).toBe(false);
    expect(
      createHostSchema.safeParse({
        ...hostInput,
        connectionOptions: {
          algorithms: { kex: Array.from({ length: 33 }, (_, index) => `kex-${index}`) },
        },
      }).success,
    ).toBe(false);
  });

  it.each([
    { connectionTimeoutMs: 999 },
    { connectionTimeoutMs: 300_001 },
    { keepaliveIntervalMs: -1 },
    { keepaliveIntervalMs: 300_001 },
    { keepaliveCountMax: 0 },
    { keepaliveCountMax: 101 },
    { reconnectPolicy: { delayMs: 249 } },
    { reconnectPolicy: { delayMs: 60_001 } },
    { reconnectPolicy: { maxAttempts: 0 } },
    { reconnectPolicy: { maxAttempts: 21 } },
    { reconnectPolicy: { mode: 'forever' } },
  ])('rejects invalid or unbounded option %#', (connectionOptions) => {
    expect(createHostSchema.safeParse({ ...hostInput, connectionOptions }).success).toBe(false);
  });

  it('keeps persisted policy separate from live reconnect state', () => {
    const runtime = {
      id: randomUUID(),
      hostId: randomUUID(),
      state: 'reconnecting',
      reconnectAttempt: 2,
      nextReconnectAt: new Date(Date.now() + 3_000).toISOString(),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    expect(connectionSchema.safeParse(runtime).success).toBe(true);
    expect(
      connectionSchema.safeParse({
        ...runtime,
        connectionOptions: DEFAULT_SSH_CONNECTION_OPTIONS,
      }).success,
    ).toBe(false);
  });
});
