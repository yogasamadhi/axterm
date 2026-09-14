import { randomUUID } from 'node:crypto';
import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_TERMINAL_BEHAVIOR } from '@workspace/contracts';
import { ProductDatabase } from '../adapters/sqlite/database';
import { ProductRepository, etagFor } from '../adapters/sqlite/product-repository';
import type { SshConnectionHandle, SshTransport } from '../ports/ssh-transport';
import type { TerminalChannel } from '../ports/terminal-channel';
import { buildSshStartupSequence, ConnectionService } from './connection-service';
import { InteractionService } from './interaction-service';
import { RealtimeHub } from './realtime-hub';
import { TerminalService } from './terminal-service';
import { ProxyService } from './proxy-service';
import { ConnectionProfileRepository } from '../adapters/sqlite/connection-profile-repository';
import { ConnectionProfileService } from './connection-profile-service';

const handle = (): SshConnectionHandle => ({
  id: randomUUID(),
  onClose: () => () => {},
  openShell: async () => {
    throw new Error('unused');
  },
  openSftp: async () => {
    throw new Error('unused');
  },
  exec: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
  forwardOut: async () => {
    throw new Error('unused');
  },
  forwardIn: async () => 0,
  unforwardIn: async () => {},
  close: async () => {},
});

describe('ConnectionService', () => {
  it('consumes and revokes a command-line private-key grant without exposing its path', async () => {
    const database = await ProductDatabase.open();
    const repository = new ProductRepository(database);
    repository.saveKnownHostKey({
      host: 'cli-key.example.test',
      port: 22,
      algorithm: 'ssh-ed25519',
      fingerprint: 'SHA256:cli-key',
      publicKey: 'cli-public-key',
    });
    const connect = vi.fn(async (input) => {
      expect(
        await input.verifyHostKey({
          algorithm: 'ssh-ed25519',
          fingerprint: 'SHA256:cli-key',
          publicKey: 'cli-public-key',
        }),
      ).toBe(true);
      return handle();
    });
    const readGrantedText = vi.fn(async () => ({
      name: 'id_ed25519',
      content: 'COMMAND LINE PRIVATE KEY',
    }));
    const revokeGrant = vi.fn(async () => undefined);
    const realtime = new RealtimeHub();
    const interactions = new InteractionService(realtime);
    const service = new ConnectionService(
      repository,
      { connect },
      { readGrantedText, revokeGrant } as never,
      interactions,
      realtime,
      new TerminalService({
        open: () => {
          throw new Error('unused');
        },
      }),
    );
    const connection = service.create({
      target: {
        hostname: 'cli-key.example.test',
        username: 'operator',
        authType: 'privateKey',
      },
      temporaryCredentialGrantId: 'grant_cli_key',
      temporaryPassphrase: 'session-passphrase',
    });
    await vi.waitFor(() => expect(service.get(connection.id).state).toBe('ready'));
    expect(readGrantedText).toHaveBeenCalledWith('grant_cli_key');
    expect(revokeGrant).toHaveBeenCalledWith('grant_cli_key');
    expect(connect.mock.calls[0]?.[0]).toMatchObject({
      privateKey: 'COMMAND LINE PRIVATE KEY',
      passphrase: 'session-passphrase',
    });
    await service.closeAll();
    interactions.close();
    database.close();
  });

  it('opens an SSH shell with the selected TERM/LANG/env and renderer snapshot', async () => {
    const database = await ProductDatabase.open();
    const repository = new ProductRepository(database);
    const dataListeners = new Set<(data: Uint8Array) => void>();
    const exitListeners = new Set<(code: number | null) => void>();
    const write = vi.fn();
    const channel: TerminalChannel = {
      write,
      resize: () => {},
      signal: () => {},
      onData: (listener) => {
        dataListeners.add(listener);
        return () => dataListeners.delete(listener);
      },
      onExit: (listener) => {
        exitListeners.add(listener);
        return () => exitListeners.delete(listener);
      },
      pause: () => {},
      resume: () => {},
      close: async () => {},
    };
    const openShell = vi.fn(async () => channel);
    const transport: SshTransport = {
      agentStatus: async (path) => ({
        platform: 'macos',
        state: 'available',
        kind: 'unixSocket',
        endpoint: path ?? '/tmp/default-agent.sock',
        message: 'available',
      }),
      connect: async (input) => {
        expect(input).toMatchObject({
          connectionTimeoutMs: 50_000,
          keepaliveIntervalMs: 10_000,
          keepaliveCountMax: 10,
          compression: true,
        });
        expect(
          await input.verifyHostKey({
            algorithm: 'ssh-ed25519',
            fingerprint: 'SHA256:profile',
            publicKey: 'profile-key',
          }),
        ).toBe(true);
        return { ...handle(), openShell };
      },
    };
    repository.saveKnownHostKey({
      host: 'profile.example',
      port: 22,
      algorithm: 'ssh-ed25519',
      fingerprint: 'SHA256:profile',
      publicKey: 'profile-key',
    });
    const host = repository.createHost({
      groupId: null,
      name: 'profile fixture',
      hostname: 'profile.example',
      port: 22,
      username: 'fixture',
      authType: 'agent',
      credentialRef: null,
      passphraseCredentialRef: null,
      jumpHostId: null,
      favorite: false,
      startup: {
        directory: "/srv/projects/O'Reilly",
        environment: { APP_MODE: 'saved', LANG: 'saved.UTF-8' },
        loginScripts: [{ command: 'source ~/.profile', delayMs: 250 }],
        runScripts: [{ command: 'printf ready', delayMs: 0 }],
      },
      x11: { enabled: true, display: ':7.1' },
    });
    const realtime = new RealtimeHub();
    const interactions = new InteractionService(realtime);
    const terminals = new TerminalService({
      open: () => {
        throw new Error('unused');
      },
    });
    const service = new ConnectionService(
      repository,
      transport,
      undefined,
      interactions,
      realtime,
      terminals,
    );
    const connection = service.create({ hostId: host.id });
    await vi.waitFor(() => expect(service.get(connection.id).state).toBe('ready'));
    const profileId = randomUUID();
    const appearance = {
      fontFamily: 'Iosevka, monospace',
      fontSize: 17,
      lineHeight: 1.25,
      cursorStyle: 'underline' as const,
      cursorBlink: true,
    };
    const behavior = {
      ...DEFAULT_TERMINAL_BEHAVIOR,
      wordSeparator: ':',
      backspaceMode: '^H' as const,
      shiftEnterMode: '\\r',
    };

    const terminal = await service.openTerminal(connection.id, {
      cols: 120,
      rows: 36,
      profileId,
      term: 'screen-256color',
      env: { LANG: 'en_GB.UTF-8', PROFILE_MARKER: 'ssh' },
      directory: "/tmp/selected O'Reilly",
      appearance,
      behavior,
    });

    expect(openShell).toHaveBeenCalledWith({
      cols: 120,
      rows: 36,
      term: 'screen-256color',
      env: {
        APP_MODE: 'saved',
        LANG: 'en_GB.UTF-8',
        PROFILE_MARKER: 'ssh',
      },
      x11: { display: ':7.1' },
    });
    expect(terminal).toMatchObject({ kind: 'ssh', profileId, appearance, behavior });
    await vi.waitFor(() => expect(write).toHaveBeenCalledTimes(4), { timeout: 2_000 });
    expect(
      Buffer.concat(write.mock.calls.map(([data]) => Buffer.from(data))).toString('utf8'),
    ).toBe(
      "export APP_MODE='saved'; export LANG='en_GB.UTF-8'; export PROFILE_MARKER='ssh'\rsource ~/.profile\rcd -- '/tmp/selected O'\"'\"'Reilly'\rprintf ready\r",
    );
    await terminals.closeAll();
    await service.closeAll();
    interactions.close();
    database.close();
  });

  it('builds fish startup steps in deterministic environment, login, directory and run order', () => {
    expect(
      buildSshStartupSequence(
        {
          directory: '/srv/测试',
          environment: { ZED: 'last', ALPHA: "a'b" },
          loginScripts: [
            {
              command: 'echo login',
              delayMs: 10,
              sendEnter: true,
              waitForOutput: true,
              settleIdleMs: 400,
              settleTimeoutMs: 3_000,
            },
          ],
          runScripts: [
            {
              command: 'echo run',
              delayMs: 500,
              sendEnter: true,
              waitForOutput: true,
              settleIdleMs: 400,
              settleTimeoutMs: 3_000,
            },
          ],
        },
        'fish',
      ),
    ).toEqual([
      expect.objectContaining({
        text: "set -gx ALPHA 'a'\"'\"'b'; set -gx ZED 'last'",
        waitForOutput: false,
      }),
      expect.objectContaining({ text: 'echo login', delayMs: 10, waitForOutput: true }),
      expect.objectContaining({ text: "cd -- '/srv/测试'", waitForOutput: false }),
      expect.objectContaining({ text: 'echo run', delayMs: 500, waitForOutput: true }),
    ]);
  });

  it('opens and retries a Quick Connect target without persisting a bookmark', async () => {
    const database = await ProductDatabase.open();
    const repository = new ProductRepository(database);
    repository.saveKnownHostKey({
      host: 'quick.example',
      port: 2202,
      algorithm: 'ssh-ed25519',
      fingerprint: 'SHA256:quick',
      publicKey: 'quick-key',
    });
    const attempts: Parameters<SshTransport['connect']>[0][] = [];
    const transport: SshTransport = {
      connect: async (input) => {
        attempts.push(input);
        expect(
          await input.verifyHostKey({
            algorithm: 'ssh-ed25519',
            fingerprint: 'SHA256:quick',
            publicKey: 'quick-key',
          }),
        ).toBe(true);
        return handle();
      },
    };
    const realtime = new RealtimeHub();
    const interactions = new InteractionService(realtime);
    const service = new ConnectionService(
      repository,
      transport,
      undefined,
      interactions,
      realtime,
      new TerminalService({
        open: () => {
          throw new Error('unused');
        },
      }),
    );

    const connection = service.create({
      target: {
        name: 'Ephemeral host',
        hostname: 'quick.example',
        port: 2202,
        username: 'operator',
        authType: 'agent',
      },
    });
    await vi.waitFor(() => expect(service.get(connection.id).state).toBe('ready'));
    expect(repository.listHosts()).toEqual([]);
    expect(attempts[0]).toMatchObject({
      host: 'quick.example',
      port: 2202,
      username: 'operator',
    });

    const retried = await service.retry(connection.id);
    await vi.waitFor(() => expect(service.get(retried.id).state).toBe('ready'));
    expect(repository.listHosts()).toEqual([]);
    expect(attempts).toHaveLength(2);
    await service.closeAll();
    interactions.close();
    database.close();
  });

  it('reconnects with the persisted policy and cancels the owned timer and handles on close', async () => {
    vi.useFakeTimers();
    const database = await ProductDatabase.open();
    const repository = new ProductRepository(database);
    const controls: Array<{
      disconnect(error?: Error): void;
      close: ReturnType<typeof vi.fn<() => Promise<void>>>;
    }> = [];
    const attempts: Parameters<SshTransport['connect']>[0][] = [];
    const transport: SshTransport = {
      connect: vi.fn(async (connectInput) => {
        attempts.push(connectInput);
        const listeners = new Set<(error?: Error) => void>();
        const close = vi.fn(async () => {
          listeners.clear();
        });
        controls.push({
          disconnect: (error) => {
            for (const listener of [...listeners]) listener(error);
          },
          close,
        });
        return {
          ...handle(),
          onClose: (listener: (error?: Error) => void) => {
            listeners.add(listener);
            return () => listeners.delete(listener);
          },
          close,
        };
      }),
    };
    const host = repository.createHost({
      name: 'reconnect fixture',
      hostname: 'reconnect.example.test',
      username: 'operator',
      authType: 'agent',
      connectionOptions: {
        connectionTimeoutMs: 12_345,
        keepaliveIntervalMs: 0,
        keepaliveCountMax: 4,
        compression: false,
        reconnectPolicy: { mode: 'automatic', delayMs: 250, maxAttempts: 2 },
      },
    });
    const realtime = new RealtimeHub();
    const interactions = new InteractionService(realtime);
    const service = new ConnectionService(
      repository,
      transport,
      undefined,
      interactions,
      realtime,
      new TerminalService({
        open: () => {
          throw new Error('unused');
        },
      }),
    );
    try {
      const connection = service.create({ hostId: host.id });
      await vi.advanceTimersByTimeAsync(0);
      expect(service.get(connection.id)).toMatchObject({
        state: 'ready',
        reconnectAttempt: 0,
        nextReconnectAt: null,
      });
      expect(attempts[0]).toMatchObject({
        connectionTimeoutMs: 12_345,
        keepaliveIntervalMs: 0,
        keepaliveCountMax: 4,
        compression: false,
      });

      controls[0]!.disconnect(new Error('network lost'));
      await vi.advanceTimersByTimeAsync(0);
      expect(service.get(connection.id)).toMatchObject({
        state: 'reconnecting',
        errorCode: 'SSH_CONNECTION_FAILED',
        reconnectAttempt: 1,
      });
      expect(service.get(connection.id).nextReconnectAt).not.toBeNull();
      expect(controls[0]!.close).toHaveBeenCalledOnce();

      await vi.advanceTimersByTimeAsync(250);
      expect(attempts).toHaveLength(2);
      expect(service.get(connection.id)).toMatchObject({
        state: 'ready',
        reconnectAttempt: 0,
        nextReconnectAt: null,
      });

      controls[1]!.disconnect(new Error('network lost again'));
      await vi.advanceTimersByTimeAsync(0);
      expect(service.get(connection.id).state).toBe('reconnecting');
      await service.close(connection.id);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(attempts).toHaveLength(2);
      expect(controls[1]!.close).toHaveBeenCalledOnce();
      expect(service.resourceCount()).toBe(0);
    } finally {
      await service.closeAll();
      interactions.close();
      database.close();
      vi.useRealTimers();
    }
  });

  it('does not schedule automatic retries for the default manual policy', async () => {
    const database = await ProductDatabase.open();
    const repository = new ProductRepository(database);
    const connect = vi.fn(async () => {
      throw new Error('offline');
    });
    const host = repository.createHost({
      name: 'manual fixture',
      hostname: 'manual.example.test',
      username: 'operator',
      authType: 'agent',
    });
    const realtime = new RealtimeHub();
    const interactions = new InteractionService(realtime);
    const service = new ConnectionService(
      repository,
      { connect },
      undefined,
      interactions,
      realtime,
      new TerminalService({
        open: () => {
          throw new Error('unused');
        },
      }),
    );
    try {
      const connection = service.create({ hostId: host.id });
      await vi.waitFor(() => expect(service.get(connection.id).state).toBe('failed'));
      expect(service.get(connection.id)).toMatchObject({
        reconnectAttempt: 0,
        nextReconnectAt: null,
      });
      expect(connect).toHaveBeenCalledOnce();
    } finally {
      await service.closeAll();
      interactions.close();
      database.close();
    }
  });

  it('does not auto-retry an initial failure even when the host override is automatic', async () => {
    vi.useFakeTimers();
    const database = await ProductDatabase.open();
    const repository = new ProductRepository(database);
    const connect = vi.fn(async () => {
      throw new Error('offline on first connect');
    });
    const host = repository.createHost({
      name: 'initial failure fixture',
      hostname: 'initial-failure.example.test',
      username: 'operator',
      authType: 'agent',
      connectionOptions: {
        reconnectPolicy: { mode: 'automatic', delayMs: 250, maxAttempts: 2 },
      },
    });
    const realtime = new RealtimeHub();
    const interactions = new InteractionService(realtime);
    const service = new ConnectionService(
      repository,
      { connect },
      undefined,
      interactions,
      realtime,
      new TerminalService({
        open: () => {
          throw new Error('unused');
        },
      }),
    );
    try {
      const connection = service.create({ hostId: host.id });
      await vi.advanceTimersByTimeAsync(0);
      expect(service.get(connection.id)).toMatchObject({
        state: 'failed',
        reconnectAttempt: 0,
        nextReconnectAt: null,
      });
      await vi.advanceTimersByTimeAsync(60_000);
      expect(connect).toHaveBeenCalledOnce();
    } finally {
      await service.closeAll();
      interactions.close();
      database.close();
      vi.useRealTimers();
    }
  });

  it('uses the global auto-reconnect switch and cancels a pending countdown deterministically', async () => {
    vi.useFakeTimers();
    const database = await ProductDatabase.open();
    const repository = new ProductRepository(database);
    repository.updateSettings(
      { terminal: { autoReconnectTerminal: true } },
      etagFor(repository.getSettings().version),
    );
    let disconnect: ((error?: Error) => void) | undefined;
    const connect = vi.fn(async () => {
      const listeners = new Set<(error?: Error) => void>();
      disconnect = (error) => {
        for (const listener of [...listeners]) listener(error);
      };
      return {
        ...handle(),
        onClose: (listener: (error?: Error) => void) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
        close: async () => listeners.clear(),
      };
    });
    const host = repository.createHost({
      name: 'global reconnect fixture',
      hostname: 'global-reconnect.example.test',
      username: 'operator',
      authType: 'agent',
    });
    const realtime = new RealtimeHub();
    const interactions = new InteractionService(realtime);
    const service = new ConnectionService(
      repository,
      { connect },
      undefined,
      interactions,
      realtime,
      new TerminalService({
        open: () => {
          throw new Error('unused');
        },
      }),
    );
    try {
      const connection = service.create({ hostId: host.id });
      await vi.advanceTimersByTimeAsync(0);
      expect(service.get(connection.id).state).toBe('ready');
      disconnect?.(new Error('network lost'));
      await vi.advanceTimersByTimeAsync(0);
      expect(service.get(connection.id).state).toBe('reconnecting');

      expect(service.cancelReconnect(connection.id)).toMatchObject({
        state: 'failed',
        errorCode: 'RECONNECT_CANCELED',
        nextReconnectAt: null,
      });
      await vi.advanceTimersByTimeAsync(60_000);
      expect(connect).toHaveBeenCalledOnce();
      expect(() => service.cancelReconnect(connection.id)).toThrowError(
        expect.objectContaining({ code: 'INVALID_STATE' }),
      );
    } finally {
      await service.closeAll();
      interactions.close();
      database.close();
      vi.useRealTimers();
    }
  });

  it('re-checks the global switch before a pending reconnect starts', async () => {
    vi.useFakeTimers();
    const database = await ProductDatabase.open();
    const repository = new ProductRepository(database);
    repository.updateSettings(
      { terminal: { autoReconnectTerminal: true } },
      etagFor(repository.getSettings().version),
    );
    let disconnect: ((error?: Error) => void) | undefined;
    const connect = vi.fn(async () => {
      const listeners = new Set<(error?: Error) => void>();
      disconnect = (error) => {
        for (const listener of [...listeners]) listener(error);
      };
      return {
        ...handle(),
        onClose: (listener: (error?: Error) => void) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
        close: async () => listeners.clear(),
      };
    });
    const host = repository.createHost({
      name: 'disabled reconnect fixture',
      hostname: 'disabled-reconnect.example.test',
      username: 'operator',
      authType: 'agent',
    });
    const realtime = new RealtimeHub();
    const interactions = new InteractionService(realtime);
    const service = new ConnectionService(
      repository,
      { connect },
      undefined,
      interactions,
      realtime,
      new TerminalService({
        open: () => {
          throw new Error('unused');
        },
      }),
    );
    try {
      const connection = service.create({ hostId: host.id });
      await vi.advanceTimersByTimeAsync(0);
      disconnect?.(new Error('network lost'));
      await vi.advanceTimersByTimeAsync(0);
      expect(service.get(connection.id).state).toBe('reconnecting');

      repository.updateSettings(
        { terminal: { autoReconnectTerminal: false } },
        etagFor(repository.getSettings().version),
      );
      await vi.advanceTimersByTimeAsync(3_000);
      expect(service.get(connection.id)).toMatchObject({
        state: 'failed',
        errorCode: 'AUTO_RECONNECT_DISABLED',
        nextReconnectAt: null,
      });
      expect(connect).toHaveBeenCalledOnce();
    } finally {
      await service.closeAll();
      interactions.close();
      database.close();
      vi.useRealTimers();
    }
  });

  it('stops after the persisted automatic reconnect attempt limit', async () => {
    vi.useFakeTimers();
    const database = await ProductDatabase.open();
    const repository = new ProductRepository(database);
    let disconnect: ((error?: Error) => void) | undefined;
    const connect = vi.fn(async () => {
      if (connect.mock.calls.length > 1) throw new Error('still offline');
      const listeners = new Set<(error?: Error) => void>();
      disconnect = (error) => {
        for (const listener of [...listeners]) listener(error);
      };
      return {
        ...handle(),
        onClose: (listener: (error?: Error) => void) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
        close: async () => listeners.clear(),
      };
    });
    const host = repository.createHost({
      name: 'bounded reconnect fixture',
      hostname: 'bounded.example.test',
      username: 'operator',
      authType: 'agent',
      connectionOptions: {
        reconnectPolicy: { mode: 'automatic', delayMs: 250, maxAttempts: 2 },
      },
    });
    const realtime = new RealtimeHub();
    const interactions = new InteractionService(realtime);
    const service = new ConnectionService(
      repository,
      { connect },
      undefined,
      interactions,
      realtime,
      new TerminalService({
        open: () => {
          throw new Error('unused');
        },
      }),
    );
    try {
      const connection = service.create({ hostId: host.id });
      await vi.advanceTimersByTimeAsync(0);
      expect(service.get(connection.id).state).toBe('ready');
      disconnect?.(new Error('network lost'));
      await vi.advanceTimersByTimeAsync(0);
      expect(service.get(connection.id)).toMatchObject({
        state: 'reconnecting',
        reconnectAttempt: 1,
      });
      await vi.advanceTimersByTimeAsync(250);
      expect(service.get(connection.id)).toMatchObject({
        state: 'reconnecting',
        reconnectAttempt: 2,
      });
      await vi.advanceTimersByTimeAsync(250);
      expect(service.get(connection.id)).toMatchObject({
        state: 'failed',
        reconnectAttempt: 2,
        nextReconnectAt: null,
      });
      await vi.advanceTimersByTimeAsync(60_000);
      expect(connect).toHaveBeenCalledTimes(3);
    } finally {
      await service.closeAll();
      interactions.close();
      database.close();
      vi.useRealTimers();
    }
  });

  it('requires first-use host-key approval, flags changes as high risk and resolves key passphrases', async () => {
    const database = await ProductDatabase.open();
    const repository = new ProductRepository(database);
    let publicKey = 'key-one';
    const attempts: Parameters<SshTransport['connect']>[0][] = [];
    const transport: SshTransport = {
      agentStatus: async (path) => ({
        platform: 'macos',
        state: 'available',
        kind: 'unixSocket',
        endpoint: path ?? '/tmp/default-agent.sock',
        message: 'available',
      }),
      connect: async (input) => {
        attempts.push(input);
        const accepted = await input.verifyHostKey({
          algorithm: 'ssh-ed25519',
          fingerprint: `SHA256:${publicKey}`,
          publicKey,
        });
        if (!accepted) throw new Error('host key rejected');
        return handle();
      },
    };
    const realtime = new RealtimeHub();
    const interactions = new InteractionService(realtime);
    const hostCapabilities = {
      resolveCredential: async (ref: string) =>
        ({
          cred_key: 'ENCRYPTED PRIVATE KEY',
          cred_pass: 'key-passphrase',
          cred_certificate: 'OPENSSH CERTIFICATE',
        })[ref]!,
    };
    const service = new ConnectionService(
      repository,
      transport,
      hostCapabilities as never,
      interactions,
      realtime,
      new TerminalService({
        open: () => {
          throw new Error('unused');
        },
      }),
    );
    let host = repository.createHost({
      groupId: null,
      name: 'fixture',
      hostname: '127.0.0.1',
      port: 22,
      username: 'fixture',
      authType: 'password',
      credentialRef: null,
      passphraseCredentialRef: null,
      jumpHostId: null,
      favorite: false,
    });
    const first = service.create({ hostId: host.id, temporarySecret: 'one-time-password' });
    await vi.waitFor(() => expect(interactions.list()[0]?.kind).toBe('unknownHostKey'));
    expect(interactions.list()[0]?.detail).toContain('目标：fixture@127.0.0.1:22');
    expect(interactions.list()[0]?.detail).toContain('SHA256:key-one');
    interactions.respond(interactions.list()[0]!.id, {
      accepted: true,
      remember: true,
      values: {},
    });
    await vi.waitFor(() => expect(service.get(first.id).state).toBe('ready'));
    expect(attempts[0]?.password).toBe('one-time-password');
    await service.close(first.id);

    host = repository.updateHost(
      host.id,
      {
        authType: 'privateKey',
        credentialRef: 'cred_key',
        passphraseCredentialRef: 'cred_pass',
        certificateCredentialRef: 'cred_certificate',
        sshAgent: { enabled: true, path: '/tmp/custom-agent.sock' },
      },
      etagFor(host.version),
    );
    const withKey = service.create({ hostId: host.id });
    await vi.waitFor(() => expect(service.get(withKey.id).state).toBe('ready'));
    expect(attempts[1]).toMatchObject({
      privateKey: 'ENCRYPTED PRIVATE KEY',
      passphrase: 'key-passphrase',
      certificate: 'OPENSSH CERTIFICATE',
      agent: '/tmp/custom-agent.sock',
    });
    await service.close(withKey.id);

    publicKey = 'key-two';
    const changed = service.create({ hostId: host.id });
    await vi.waitFor(() => {
      expect(interactions.list()[0]).toMatchObject({ kind: 'changedHostKey', severity: 'high' });
    });
    expect(interactions.list()[0]?.detail).toContain('已保存指纹：SHA256:key-one');
    expect(interactions.list()[0]?.detail).toContain('本次指纹：SHA256:key-two');
    expect(interactions.list()[0]?.detail).toContain('连接被拦截');
    interactions.respond(interactions.list()[0]!.id, {
      accepted: false,
      remember: false,
      values: {},
    });
    await vi.waitFor(() => expect(service.get(changed.id).state).toBe('failed'));
    await service.closeAll();
    interactions.close();
    database.close();
  });

  it('applies an SSH Connection Profile snapshot without persisting plaintext credentials', async () => {
    const database = await ProductDatabase.open();
    const repository = new ProductRepository(database);
    const host = repository.createHost({
      name: 'Profile target',
      hostname: 'profile-target.example.test',
      username: 'fallback-user',
      authType: 'agent',
    });
    repository.saveKnownHostKey({
      host: host.hostname,
      port: host.port,
      algorithm: 'ssh-ed25519',
      fingerprint: 'SHA256:connection-profile',
      publicKey: 'connection-profile-key',
    });
    const profileRepository = new ConnectionProfileRepository(database);
    const profiles = new ConnectionProfileService(profileRepository);
    const profile = profiles.create({
      name: 'Production identity',
      ssh: {
        username: 'deploy',
        passwordCredentialRef: 'credential-password',
        privateKeyCredentialRef: 'credential-private-key',
        passphraseCredentialRef: 'credential-passphrase',
        certificateCredentialRef: 'credential-certificate',
      },
    });
    const resolved: Record<string, string> = {
      'credential-password': 'profile-password-secret',
      'credential-private-key': 'PROFILE PRIVATE KEY SECRET',
      'credential-passphrase': 'profile-passphrase-secret',
      'credential-certificate': 'PROFILE CERTIFICATE SECRET',
    };
    const attempt = vi.fn(async (input: Parameters<SshTransport['connect']>[0]) => {
      expect(
        await input.verifyHostKey({
          algorithm: 'ssh-ed25519',
          fingerprint: 'SHA256:connection-profile',
          publicKey: 'connection-profile-key',
        }),
      ).toBe(true);
      return handle();
    });
    const realtime = new RealtimeHub();
    const interactions = new InteractionService(realtime);
    const service = new ConnectionService(
      repository,
      { connect: attempt },
      { resolveCredential: async (ref: string) => resolved[ref]! } as never,
      interactions,
      realtime,
      new TerminalService({
        open: () => {
          throw new Error('unused');
        },
      }),
      undefined,
      undefined,
      profiles,
    );

    try {
      const connection = service.create({ hostId: host.id, connectionProfileId: profile.id });
      await vi.waitFor(() => expect(service.get(connection.id).state).toBe('ready'));
      expect(attempt).toHaveBeenCalledWith(
        expect.objectContaining({
          username: 'deploy',
          password: 'profile-password-secret',
          privateKey: 'PROFILE PRIVATE KEY SECRET',
          passphrase: 'profile-passphrase-secret',
          certificate: 'PROFILE CERTIFICATE SECRET',
        }),
      );
      const persisted = database.get<{ payload: string }>(
        'SELECT payload FROM connection_profiles WHERE id=?',
        profile.id,
      )!.payload;
      expect(persisted).toContain('credential-private-key');
      expect(persisted).not.toContain('PROFILE PRIVATE KEY SECRET');
      expect(persisted).not.toContain('profile-password-secret');
      expect(persisted).not.toContain('PROFILE CERTIFICATE SECRET');
    } finally {
      await service.closeAll();
      interactions.close();
      database.close();
    }
  });

  it('uses a jump channel, completes keyboard-interactive authentication and rejects jump cycles', async () => {
    const database = await ProductDatabase.open();
    const repository = new ProductRepository(database);
    const proxy = new PassThrough();
    const answers: string[][] = [];
    let jumpClosed = false;
    const attempts: Parameters<SshTransport['connect']>[0][] = [];
    const transport: SshTransport = {
      connect: async (input) => {
        attempts.push(input);
        expect(
          await input.verifyHostKey({
            algorithm: 'ssh-ed25519',
            fingerprint: `SHA256:${input.host}`,
            publicKey: `key-${input.host}`,
          }),
        ).toBe(true);
        if (input.host === 'target') {
          answers.push(
            await input.keyboardInteractive({
              name: 'Password verification',
              instructions: '',
              prompts: [{ prompt: 'Password: ', echo: false }],
            }),
          );
          answers.push(
            await input.keyboardInteractive({
              name: 'One-time code',
              instructions: 'Enter the current code',
              prompts: [{ prompt: 'Code: ', echo: false }],
            }),
          );
          answers.push(
            await input.keyboardInteractive({
              name: 'Backup factor',
              instructions: 'Enter the second code',
              prompts: [{ prompt: 'Backup code: ', echo: false }],
            }),
          );
        }
        return input.host === 'jump'
          ? {
              ...handle(),
              forwardOut: async () => proxy,
              close: async () => {
                jumpClosed = true;
                proxy.destroy();
              },
            }
          : handle();
      },
    };
    const realtime = new RealtimeHub();
    const interactions = new InteractionService(realtime);
    const service = new ConnectionService(
      repository,
      transport,
      {
        resolveCredential: async (reference: string) =>
          reference === 'target-password-ref' ? 'target-password' : 'jump-password',
      } as never,
      interactions,
      realtime,
      new TerminalService({
        open: () => {
          throw new Error('unused');
        },
      }),
    );
    const base = {
      groupId: null,
      port: 22,
      username: 'fixture',
      passphraseCredentialRef: null,
      favorite: false,
    } as const;
    const jump = repository.createHost({
      ...base,
      name: 'jump',
      hostname: 'jump',
      authType: 'password',
      credentialRef: 'jump-password-ref',
      jumpHostId: null,
    });
    const target = repository.createHost({
      ...base,
      name: 'target',
      hostname: 'target',
      authType: 'keyboardInteractive',
      credentialRef: 'target-password-ref',
      jumpHostId: jump.id,
    });
    for (const hostname of ['jump', 'target'])
      repository.saveKnownHostKey({
        host: hostname,
        port: 22,
        algorithm: 'ssh-ed25519',
        fingerprint: `SHA256:${hostname}`,
        publicKey: `key-${hostname}`,
      });

    expect(() =>
      repository.updateHost(jump.id, { jumpHostId: target.id }, etagFor(jump.version)),
    ).toThrow(/cycle/i);
    const connection = service.create({ hostId: target.id });
    await vi.waitFor(() =>
      expect(interactions.list()[0]).toMatchObject({
        kind: 'keyboardInteractive',
        title: 'One-time code · 挑战 2',
      }),
    );
    const firstChallengeId = interactions.list()[0]!.id;
    interactions.respond(firstChallengeId, {
      accepted: true,
      remember: false,
      values: { '0': '123456' },
    });
    await vi.waitFor(() =>
      expect(interactions.list()[0]).toMatchObject({
        kind: 'keyboardInteractive',
        title: 'Backup factor · 挑战 3',
      }),
    );
    expect(interactions.list()[0]!.id).not.toBe(firstChallengeId);
    interactions.respond(interactions.list()[0]!.id, {
      accepted: true,
      remember: false,
      values: { '0': 'backup-654321' },
    });
    await vi.waitFor(() => expect(service.get(connection.id).state).toBe('ready'));
    expect(attempts[0]).toMatchObject({ host: 'jump', password: 'jump-password' });
    expect(attempts[1]?.socket).toBe(proxy);
    expect(attempts[1]).not.toHaveProperty('password');
    expect(answers).toEqual([['target-password'], ['123456'], ['backup-654321']]);
    await service.closeAll();
    expect(jumpClosed).toBe(true);
    interactions.close();
    database.close();
  });

  it('opens the configured proxy only for the first SSH hop', async () => {
    const database = await ProductDatabase.open();
    const repository = new ProductRepository(database);
    repository.updateSettings(
      {
        network: {
          proxy: {
            mode: 'custom',
            endpoint: { url: 'socks5h://proxy.example.test:1080' },
          },
        },
      },
      etagFor(repository.getSettings().version),
    );
    const jump = repository.createHost({
      name: 'proxied jump',
      hostname: 'jump.example.test',
      username: 'jump-user',
      authType: 'agent',
    });
    const target = repository.createHost({
      name: 'proxied target',
      hostname: 'target.example.test',
      username: 'target-user',
      authType: 'agent',
      jumpHostId: jump.id,
    });
    const proxySocket = new PassThrough();
    const jumpChannel = new PassThrough();
    const proxyConnect = vi.fn(async () => proxySocket);
    const attempts: Parameters<SshTransport['connect']>[0][] = [];
    const transport: SshTransport = {
      connect: async (input) => {
        attempts.push(input);
        return input.host === jump.hostname
          ? { ...handle(), forwardOut: async () => jumpChannel }
          : handle();
      },
    };
    const realtime = new RealtimeHub();
    const interactions = new InteractionService(realtime);
    const service = new ConnectionService(
      repository,
      transport,
      undefined,
      interactions,
      realtime,
      new TerminalService({
        open: () => {
          throw new Error('unused');
        },
      }),
      undefined,
      new ProxyService(repository, { connect: proxyConnect }),
    );
    try {
      const connection = service.create({ hostId: target.id });
      await vi.waitFor(() => expect(service.get(connection.id).state).toBe('ready'));
      expect(proxyConnect).toHaveBeenCalledOnce();
      expect(proxyConnect).toHaveBeenCalledWith({
        proxy: { url: 'socks5h://proxy.example.test:1080' },
        target: { host: jump.hostname, port: jump.port },
        timeoutMs: jump.connectionOptions.connectionTimeoutMs,
        signal: expect.any(AbortSignal),
      });
      expect(attempts).toHaveLength(2);
      expect(attempts[0]?.socket).toBe(proxySocket);
      expect(attempts[1]?.socket).toBe(jumpChannel);
    } finally {
      await service.closeAll();
      interactions.close();
      proxySocket.destroy();
      jumpChannel.destroy();
      database.close();
    }
  });

  it('connects an explicit ordered jump chain and applies reordering without mutating hop Hosts', async () => {
    const database = await ProductDatabase.open();
    const repository = new ProductRepository(database);
    const first = repository.createHost({
      name: 'ordered first',
      hostname: 'first.example.test',
      username: 'first-user',
      authType: 'agent',
    });
    const second = repository.createHost({
      name: 'ordered second',
      hostname: 'second.example.test',
      username: 'second-user',
      authType: 'agent',
    });
    let target = repository.createHost({
      name: 'ordered target',
      hostname: 'target.example.test',
      username: 'target-user',
      authType: 'agent',
      jumpHostIds: [second.id, first.id],
    });
    target = repository.updateHost(
      target.id,
      { jumpHostIds: [first.id, second.id] },
      etagFor(target.version),
    );
    const attempts: Parameters<SshTransport['connect']>[0][] = [];
    const channels = [new PassThrough(), new PassThrough()];
    let forwardIndex = 0;
    const transport: SshTransport = {
      connect: async (input) => {
        attempts.push(input);
        return {
          ...handle(),
          forwardOut: async () => channels[forwardIndex++]!,
        };
      },
    };
    const realtime = new RealtimeHub();
    const interactions = new InteractionService(realtime);
    const service = new ConnectionService(
      repository,
      transport,
      undefined,
      interactions,
      realtime,
      new TerminalService({
        open: () => {
          throw new Error('unused');
        },
      }),
    );
    try {
      const connection = service.create({ hostId: target.id });
      await vi.waitFor(() => expect(service.get(connection.id).state).toBe('ready'));
      expect(attempts.map(({ host }) => host)).toEqual([
        first.hostname,
        second.hostname,
        target.hostname,
      ]);
      expect(attempts[1]?.socket).toBe(channels[0]);
      expect(attempts[2]?.socket).toBe(channels[1]);
      expect(repository.getHost(first.id).jumpHostIds).toEqual([]);
      expect(repository.getHost(second.id).jumpHostIds).toEqual([]);
    } finally {
      await service.closeAll();
      interactions.close();
      channels.forEach((channel) => channel.destroy());
      database.close();
    }
  });

  it('destroys an unclaimed proxy socket when the first SSH handshake fails', async () => {
    const database = await ProductDatabase.open();
    const repository = new ProductRepository(database);
    const host = repository.createHost({
      name: 'failed proxy host',
      hostname: 'failed.example.test',
      username: 'operator',
      authType: 'agent',
      proxy: {
        mode: 'custom',
        endpoint: { url: 'http://proxy.example.test:8080' },
      },
    });
    const proxySocket = new PassThrough();
    const realtime = new RealtimeHub();
    const interactions = new InteractionService(realtime);
    const service = new ConnectionService(
      repository,
      {
        connect: async () => {
          throw new Error('fixture SSH failure');
        },
      },
      undefined,
      interactions,
      realtime,
      new TerminalService({
        open: () => {
          throw new Error('unused');
        },
      }),
      undefined,
      new ProxyService(repository, { connect: async () => proxySocket }),
    );
    try {
      const connection = service.create({ hostId: host.id });
      await vi.waitFor(() => expect(service.get(connection.id).state).toBe('failed'));
      expect(proxySocket.destroyed).toBe(true);
      expect(service.get(connection.id).errorCode).toBe('SSH_CONNECTION_FAILED');
    } finally {
      await service.closeAll();
      interactions.close();
      database.close();
    }
  });
});
