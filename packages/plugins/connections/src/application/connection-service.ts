import { randomUUID } from 'node:crypto';
import type { Duplex, Readable } from 'node:stream';
import type {
  Connection,
  ConnectionProfile,
  CreateConnectionInput,
  ConnectionHopInput,
  Host,
  QuickConnectTarget,
  SshStartup,
  TerminalAppearance,
  TerminalBehavior,
  TerminalSession,
} from '@axterm/plugin-api/connections';
import {
  createConnectionSchema,
  DEFAULT_TERMINAL_APPEARANCE,
  DEFAULT_TERMINAL_BEHAVIOR,
  DEFAULT_TERMINAL_TYPE,
} from '@axterm/plugin-api/connections';
import type { CredentialAccess } from '../ports/credentials.ts';
import type { ConnectionRepository } from '../ports/repository.ts';
import type { SshConnectionHandle, SshHostKey, SshTransport } from '../ports/ssh-transport.ts';
import type {
  RemoteFileLease,
  TerminalApplication,
  TerminalStartupStep,
} from '@axterm/plugin-api/host';
import type { RemoteFileLeaseFactory } from '../ports/file-leases.ts';
import type { InteractionService } from './interaction-service.ts';
import type { ConnectionEvents } from '../ports/events.ts';
import { ApplicationError } from './errors.ts';
import type { ConnectionHistoryRecorder } from '../ports/connection-history.ts';
import type { ProxyService } from './proxy-service.ts';
import type { ShellIntegrationKind, TerminalChannel } from '../ports/terminal-channel.ts';
import { detectShellIntegrationKind } from './shell-kind.ts';
import type { ConnectionProfiles } from '../ports/repository.ts';

interface ManagedConnection {
  connecting: Set<Promise<void>>;
  terminalIds: Set<string>;
  sftpLeases: Set<RemoteFileLease>;
  sftpOpening: Set<Promise<RemoteFileLease>>;
  sftpCleanupFailed: boolean;
  executionGeneration: number;
  metadata: Connection;
  host: Host;
  hops?: Array<{ host: Host; profile?: ConnectionProfile; temporarySecret?: string }>;
  source: (
    | { hostId: string; connectionProfileId?: string }
    | { target: QuickConnectTarget; connectionProfileId?: string }
  ) & { hops?: ConnectionHopInput[] };
  handles: Array<{ handle: SshConnectionHandle; unsubscribe: () => void }>;
  abort: AbortController;
  temporarySecret?: string;
  temporaryPassphrase?: string;
  temporaryCertificate?: string;
  temporaryCredentialGrantId?: string;
  connectionProfile?: ConnectionProfile;
  reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  reconnectAttempt: number;
  nextReconnectAt: string | null;
  everReady: boolean;
  automaticReconnectCanceled: boolean;
  recovering: boolean;
  historyRecorded: boolean;
  pendingProxySocket: Duplex | undefined;
  interactionAttempt: number;
}

interface ResolvedSshCredentials {
  password?: string;
  privateKey?: string;
  passphrase?: string;
  agent?: string;
  certificate?: string;
  interactivePassword?: string;
}

export class ConnectionService {
  private readonly connections = new Map<string, ManagedConnection>();
  private readonly closing = new Map<string, Promise<void>>();
  private readonly pending = new Set<Promise<unknown>>();
  private accepting = true;
  constructor(
    private readonly repository: ConnectionRepository,
    private readonly transport: SshTransport,
    private readonly hostCapabilities: CredentialAccess | undefined,
    private readonly interactions: InteractionService,
    private readonly realtime: ConnectionEvents,
    private readonly terminals: TerminalApplication,
    private readonly history?: ConnectionHistoryRecorder,
    private readonly proxies?: ProxyService,
    private readonly profiles?: Pick<ConnectionProfiles, 'get'>,
    private readonly leaseSftp?: RemoteFileLeaseFactory,
  ) {}

  create(input: CreateConnectionInput): Connection {
    if (!this.accepting)
      throw new ApplicationError('CAPABILITY_UNAVAILABLE', 'Connections are closed', 503);
    if (this.connections.size >= 64)
      throw new ApplicationError('CAPACITY_EXCEEDED', 'Connection capacity exceeded', 503);
    const command = createConnectionSchema.parse(input);
    const now = new Date().toISOString();
    const baseHost = command.hostId
      ? this.repository.getHost(command.hostId)
      : this.createTransientHost(command.target!, now);
    const connectionProfile = command.connectionProfileId
      ? this.requireConnectionProfiles().get(command.connectionProfileId)
      : undefined;
    const host = connectionProfile?.ssh.username
      ? { ...baseHost, username: connectionProfile.ssh.username }
      : baseHost;
    const hops = command.hops?.map((hop) => {
      const base = hop.hostId
        ? this.repository.getHost(hop.hostId)
        : this.createTransientHost(hop.target!, now);
      const profile = hop.connectionProfileId
        ? this.requireConnectionProfiles().get(hop.connectionProfileId)
        : undefined;
      const host = profile?.ssh.username ? { ...base, username: profile.ssh.username } : base;
      return {
        host,
        ...(profile ? { profile } : {}),
        ...(hop.temporarySecret !== undefined ? { temporarySecret: hop.temporarySecret } : {}),
      };
    });
    if (hops?.length) {
      const seen = new Set([host.hostname.toLowerCase() + ':' + host.port + ':' + host.username]);
      for (const hop of hops) {
        const identity =
          hop.host.hostname.toLowerCase() + ':' + hop.host.port + ':' + hop.host.username;
        if (seen.has(identity))
          throw new ApplicationError('CONFLICT', 'Jump host cycle detected', 409);
        seen.add(identity);
      }
    }
    const metadata: Connection = {
      id: randomUUID(),
      hostId: host.id,
      ...(connectionProfile ? { connectionProfileId: connectionProfile.id } : {}),
      state: 'created',
      reconnectAttempt: 0,
      nextReconnectAt: null,
      createdAt: now,
      updatedAt: now,
    };
    const source = command.hostId
      ? ({
          hostId: command.hostId,
          ...(command.connectionProfileId
            ? { connectionProfileId: command.connectionProfileId }
            : {}),
        } as const)
      : ({
          target: command.target!,
          ...(command.connectionProfileId
            ? { connectionProfileId: command.connectionProfileId }
            : {}),
        } as const);
    const managed: ManagedConnection = {
      connecting: new Set(),
      terminalIds: new Set(),
      sftpLeases: new Set(),
      sftpOpening: new Set(),
      sftpCleanupFailed: false,
      metadata,
      host,
      source: {
        ...source,
        ...(command.hops
          ? { hops: command.hops.map(({ temporarySecret: _secret, ...selector }) => selector) }
          : {}),
      },
      ...(hops ? { hops } : {}),
      handles: [],
      abort: new AbortController(),
      ...(command.temporarySecret ? { temporarySecret: command.temporarySecret } : {}),
      ...(command.temporaryPassphrase ? { temporaryPassphrase: command.temporaryPassphrase } : {}),
      ...(command.temporaryCertificate
        ? { temporaryCertificate: command.temporaryCertificate }
        : {}),
      ...(command.temporaryCredentialGrantId
        ? { temporaryCredentialGrantId: command.temporaryCredentialGrantId }
        : {}),
      ...(connectionProfile ? { connectionProfile } : {}),
      reconnectAttempt: 0,
      nextReconnectAt: null,
      everReady: false,
      automaticReconnectCanceled: false,
      recovering: false,
      historyRecorded: false,
      reconnectTimer: undefined,
      pendingProxySocket: undefined,
      interactionAttempt: 0,
      executionGeneration: 0,
    };
    this.connections.set(metadata.id, managed);
    this.transition(managed, 'resolving');
    this.startConnect(managed);
    return { ...metadata };
  }

  private startConnect(managed: ManagedConnection): void {
    managed.executionGeneration++;
    const task = this.track(this.connect(managed).catch((error) => this.recover(managed, error)));
    managed.connecting.add(task);
    const settled = () => managed.connecting.delete(task);
    void task.then(settled, settled);
  }
  private track<T>(task: Promise<T>): Promise<T> {
    this.pending.add(task);
    void task.then(
      () => this.pending.delete(task),
      () => this.pending.delete(task),
    );
    return task;
  }

  private async connect(managed: ManagedConnection): Promise<void> {
    managed.interactionAttempt = 0;
    if (managed.temporaryCredentialGrantId && !managed.temporarySecret) {
      const grantId = managed.temporaryCredentialGrantId;
      const hostCapabilities = this.requireHostCapabilities();
      try {
        const selected = await hostCapabilities.readGrantedText(grantId, managed.abort.signal);
        managed.abort.signal.throwIfAborted();
        managed.temporarySecret = selected.content;
        delete managed.temporaryCredentialGrantId;
      } finally {
        await hostCapabilities.revokeGrant(grantId).catch(() => undefined);
      }
    }
    const host = managed.host;
    const chain = managed.hops?.length
      ? [...managed.hops.map((hop) => hop.host), host]
      : this.resolveChain(host);
    const first = chain[0]!;
    let jumpSocket = await this.proxies?.connectForHost(
      host,
      { host: first.hostname, port: first.port },
      first.connectionOptions.connectionTimeoutMs,
      managed.abort.signal,
    );
    managed.pendingProxySocket = jumpSocket;
    try {
      for (const [index, current] of chain.entries()) {
        managed.abort.signal.throwIfAborted();
        this.transition(managed, 'connecting');
        const hop = managed.hops?.find((value) => value.host.id === current.id);
        const credentials = await this.resolveCredentials(
          current,
          current.id === host.id ? managed.temporarySecret : hop?.temporarySecret,
          current.id === host.id ? managed.temporaryPassphrase : undefined,
          current.id === host.id ? managed.temporaryCertificate : undefined,
          current.id === host.id ? managed.connectionProfile : hop?.profile,
        );
        const { interactivePassword, ...transportCredentials } = credentials;
        managed.abort.signal.throwIfAborted();
        this.transition(managed, 'authenticating');
        const handle = await this.transport.connect({
          host: current.hostname,
          port: current.port,
          username: current.username,
          ...transportCredentials,
          ...(jumpSocket ? { socket: jumpSocket as Readable } : {}),
          signal: managed.abort.signal,
          connectionTimeoutMs: current.connectionOptions.connectionTimeoutMs,
          keepaliveIntervalMs: current.connectionOptions.keepaliveIntervalMs,
          keepaliveCountMax: current.connectionOptions.keepaliveCountMax,
          compression: current.connectionOptions.compression,
          algorithms: current.connectionOptions.algorithms,
          verifyHostKey: (key) =>
            this.verifyHostKey(managed.metadata.id, current, key, managed.abort.signal),
          keyboardInteractive: (challenge) =>
            this.keyboardInteractive(managed, current, challenge, interactivePassword),
        });
        if (index === 0) managed.pendingProxySocket = undefined;
        if (managed.abort.signal.aborted || !this.connections.has(managed.metadata.id)) {
          await handle.close();
          throw managed.abort.signal.reason ?? new Error('SSH connection was closed');
        }
        const unsubscribe = handle.onClose((error) => {
          if (managed.metadata.state === 'ready') void this.track(this.recover(managed, error));
        });
        managed.handles.push({ handle, unsubscribe });
        const next = chain[index + 1];
        if (next)
          jumpSocket = (await handle.forwardOut(
            { host: '127.0.0.1', port: 0 },
            { host: next.hostname, port: next.port },
          )) as Duplex;
      }
    } catch (error) {
      managed.pendingProxySocket?.destroy();
      managed.pendingProxySocket = undefined;
      throw error;
    }
    if (managed.abort.signal.aborted || !this.connections.has(managed.metadata.id))
      throw managed.abort.signal.reason ?? new Error('SSH connection was closed');
    managed.reconnectAttempt = 0;
    managed.nextReconnectAt = null;
    managed.everReady = true;
    managed.automaticReconnectCanceled = false;
    this.transition(managed, 'ready');
    if (!managed.historyRecorded && this.history) {
      try {
        this.history.recordSuccessful({
          host: managed.host,
          persistedHostId: 'hostId' in managed.source ? managed.source.hostId : null,
        });
        managed.historyRecorded = true;
      } catch {
        // History is ancillary. A database failure must not tear down an otherwise
        // healthy SSH transport or expose database details to the Renderer.
        this.realtime.publish('connection.history-failed', {
          connectionId: managed.metadata.id,
          errorCode: 'CONNECTION_HISTORY_WRITE_FAILED',
        });
      }
    }
  }

  private createTransientHost(target: QuickConnectTarget, now: string): Host {
    return {
      id: randomUUID(),
      groupId: null,
      name: target.name ?? target.hostname,
      hostname: target.hostname,
      port: target.port ?? 22,
      username: target.username,
      authType: target.authType ?? 'agent',
      credentialRef: null,
      passphraseCredentialRef: null,
      certificateCredentialRef: null,
      jumpHostId: null,
      jumpHostIds: [],
      favorite: false,
      proxy: target.proxy,
      connectionOptions: target.connectionOptions,
      startup: {
        directory: null,
        environment: {},
        loginScripts: [],
        runScripts: [],
      },
      x11: { enabled: false, display: null },
      sshAgent: { enabled: true, path: null },
      createdAt: now,
      updatedAt: now,
      version: 1,
    };
  }

  private resolveChain(host: Host): Host[] {
    if (host.jumpHostIds.length) {
      const seen = new Set([host.id]);
      const chain = host.jumpHostIds.map((id) => {
        if (seen.has(id)) throw new ApplicationError('CONFLICT', 'Jump host cycle detected', 409);
        seen.add(id);
        return this.repository.getHost(id);
      });
      return [...chain, host];
    }
    const chain: Host[] = [host];
    const seen = new Set([host.id]);
    let jump = host.jumpHostId;
    while (jump) {
      if (seen.has(jump)) throw new ApplicationError('CONFLICT', 'Jump host cycle detected', 409);
      seen.add(jump);
      const item = this.repository.getHost(jump);
      chain.unshift(item);
      jump = item.jumpHostId;
    }
    return chain;
  }

  private async resolveCredentials(
    host: Host,
    temporarySecret?: string,
    temporaryPassphrase?: string,
    temporaryCertificate?: string,
    profile?: ConnectionProfile,
  ): Promise<ResolvedSshCredentials> {
    const primary =
      temporarySecret ??
      (host.credentialRef
        ? await this.requireHostCapabilities().resolveCredential(host.credentialRef)
        : undefined);
    const passphrase =
      temporaryPassphrase ??
      (host.passphraseCredentialRef
        ? await this.requireHostCapabilities().resolveCredential(host.passphraseCredentialRef)
        : undefined);
    const certificate =
      temporaryCertificate ??
      (host.certificateCredentialRef
        ? await this.requireHostCapabilities().resolveCredential(host.certificateCredentialRef)
        : undefined);
    const agent = host.sshAgent.enabled
      ? await this.resolveAgent(host.sshAgent.path ?? undefined)
      : undefined;
    const base =
      host.authType === 'password'
        ? primary
          ? { password: primary, interactivePassword: primary }
          : {}
        : host.authType === 'privateKey'
          ? {
              ...(primary ? { privateKey: primary } : {}),
              ...(passphrase ? { passphrase } : {}),
              ...(certificate ? { certificate } : {}),
            }
          : host.authType === 'keyboardInteractive'
            ? primary
              ? { interactivePassword: primary }
              : {}
            : {};
    const withAgent = { ...base, ...(agent ? { agent } : {}) };
    if (profile) {
      const ssh = profile.ssh;
      const resolve = async (ref: string | null) =>
        ref ? this.requireHostCapabilities().resolveCredential(ref) : undefined;
      const [password, privateKey, profilePassphrase, profileCertificate] = await Promise.all([
        resolve(ssh.passwordCredentialRef),
        resolve(ssh.privateKeyCredentialRef),
        resolve(ssh.passphraseCredentialRef),
        resolve(ssh.certificateCredentialRef),
      ]);
      const combined = {
        ...withAgent,
        ...(password ? { password } : {}),
        ...(password ? { interactivePassword: password } : {}),
        ...(privateKey ? { privateKey } : {}),
        ...(profilePassphrase ? { passphrase: profilePassphrase } : {}),
        ...(profileCertificate ? { certificate: profileCertificate } : {}),
      };
      if ('password' in combined || 'privateKey' in combined || 'interactivePassword' in combined)
        return combined;
    } else if (Object.keys(withAgent).length) return withAgent;
    return {};
  }

  async agentStatus(path?: string) {
    if (!this.transport.agentStatus)
      return {
        platform: 'other' as const,
        state: 'unavailable' as const,
        kind: null,
        endpoint: null,
        message: 'This SSH transport does not expose an Agent capability.',
      };
    return this.transport.agentStatus(path);
  }

  private async resolveAgent(path?: string): Promise<string | undefined> {
    const status = await this.agentStatus(path);
    return status.state === 'available' ? (status.endpoint ?? undefined) : undefined;
  }

  private async verifyHostKey(
    connectionId: string,
    host: Host,
    key: SshHostKey,
    signal?: AbortSignal,
  ): Promise<boolean> {
    signal?.throwIfAborted();
    const known = this.repository.getKnownHostKey(host.hostname, host.port);
    if (known?.publicKey === key.publicKey) return true;
    const changed = !!known;
    const decision = await this.interactions.request(
      {
        kind: changed ? 'changedHostKey' : 'unknownHostKey',
        connectionId,
        severity: changed ? 'high' : 'warning',
        title: changed ? 'SSH host key changed' : 'SSH host key verification',
        detail: changed
          ? 'The presented SSH host key differs from the saved key.'
          : 'No SSH host key is saved for this target.',
        presentation: {
          kind: 'sshHostKey',
          username: host.username,
          hostname: host.hostname,
          port: host.port,
          algorithm: key.algorithm,
          fingerprint: key.fingerprint,
          previousFingerprint: known?.fingerprint ?? null,
        },
        fields: [],
      },
      120_000,
      signal,
    );
    if (!decision.accepted) return false;
    signal?.throwIfAborted();
    if (decision.remember)
      this.repository.saveKnownHostKey(
        { host: host.hostname, port: host.port, ...key },
        known ? { version: known.version } : null,
      );
    return true;
  }

  private async keyboardInteractive(
    managed: ManagedConnection,
    host: Host,
    input: {
      name: string;
      instructions: string;
      prompts: Array<{ prompt: string; echo: boolean }>;
    },
    automaticPassword?: string,
  ) {
    managed.interactionAttempt += 1;
    if (
      automaticPassword &&
      input.prompts.length === 1 &&
      !input.prompts[0]!.echo &&
      /^(?:\s*|.*password.*)$/iu.test(input.prompts[0]!.prompt)
    )
      return [automaticPassword];
    const decision = await this.interactions.request(
      {
        kind: 'keyboardInteractive',
        connectionId: managed.metadata.id,
        severity: 'info',
        title: 'SSH keyboard-interactive authentication',
        detail: input.instructions.trim(),
        presentation: {
          kind: 'keyboardInteractive',
          username: host.username,
          hostname: host.hostname,
          port: host.port,
          challengeName: input.name.trim(),
          instructions: input.instructions.trim(),
          attempt: managed.interactionAttempt,
          promptCount: input.prompts.length,
        },
        fields: input.prompts.map((prompt, index) => ({
          id: String(index),
          label: prompt.prompt,
          secret: !prompt.echo,
        })),
      },
      120_000,
      managed.abort.signal,
    );
    if (!decision.accepted) return [];
    return input.prompts.map((_prompt, index) => decision.values[String(index)] ?? '');
  }

  list(): Connection[] {
    return [...this.connections.values()].map(({ metadata }) => ({ ...metadata }));
  }
  get(id: string): Connection {
    const managed = this.require(id);
    return { ...managed.metadata };
  }
  executionTarget(id: string) {
    const managed = this.connections.get(id);
    if (!managed) throw new ApplicationError('NOT_FOUND', 'Connection not found', 404);
    return {
      hostname: managed.host.hostname,
      port: managed.host.port,
      username: managed.host.username,
      generation: managed.executionGeneration,
    };
  }
  handle(id: string): SshConnectionHandle {
    const managed = this.require(id);
    if (managed.metadata.state !== 'ready' || !managed.handles.length)
      throw new ApplicationError('INVALID_STATE', 'SSH connection is not ready', 409);
    return managed.handles[managed.handles.length - 1]!.handle;
  }
  openSftp(id: string, signal?: AbortSignal): Promise<RemoteFileLease> {
    if (!this.accepting || !this.leaseSftp)
      return Promise.reject(
        new ApplicationError('CAPABILITY_UNAVAILABLE', 'SFTP is unavailable', 503),
      );
    if (
      this.pendingSftp >= 64 ||
      [...this.connections.values()].reduce((count, item) => count + item.sftpLeases.size, 0) +
        this.pendingSftp >=
        256
    )
      return Promise.reject(
        new ApplicationError('CAPACITY_EXCEEDED', 'SFTP channel capacity exceeded', 503),
      );
    let managed: ManagedConnection;
    try {
      managed = this.require(id);
    } catch (error) {
      return Promise.reject(error);
    }
    this.pendingSftp++;
    const opening = this.openSftpOwned(id, signal).finally(() => {
      this.pendingSftp--;
      managed.sftpOpening.delete(opening);
    });
    managed.sftpOpening.add(opening);
    return this.track(opening);
  }
  private pendingSftp = 0;
  private async openSftpOwned(id: string, signal?: AbortSignal): Promise<RemoteFileLease> {
    const managed = this.require(id);
    const lifetime = signal
      ? AbortSignal.any([signal, managed.abort.signal])
      : managed.abort.signal;
    lifetime.throwIfAborted();
    let native;
    try {
      native = await this.handle(id).openSftp(lifetime);
    } catch (error) {
      if (lifetime.aborted)
        throw new ApplicationError('REQUEST_CANCELED', 'SFTP opening was canceled', 409);
      throw error;
    }
    if (lifetime.aborted || managed.metadata.state !== 'ready') {
      try {
        await native.close();
      } catch {
        managed.sftpCleanupFailed = true;
        throw new ApplicationError(
          'CAPABILITY_UNAVAILABLE',
          'Late SFTP channel did not drain',
          503,
        );
      }
      throw new ApplicationError('REQUEST_CANCELED', 'SFTP opening was canceled', 409);
    }
    const lease = this.leaseSftp!(native, lifetime, () => managed.sftpLeases.delete(lease));
    managed.sftpLeases.add(lease);
    return lease;
  }
  async exec(
    id: string,
    input: { command: string; maxBytes?: number; signal?: AbortSignal },
  ): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
    if (
      !Number.isSafeInteger(input.maxBytes ?? 1024 * 1024) ||
      (input.maxBytes ?? 1024 * 1024) < 1 ||
      (input.maxBytes ?? 1024 * 1024) > 8 * 1024 * 1024 ||
      Buffer.byteLength(input.command) > 64 * 1024
    )
      throw new ApplicationError('VALIDATION_ERROR', 'Invalid SSH execution limits', 400);
    const managed = this.require(id);
    const signal = input.signal
      ? AbortSignal.any([input.signal, managed.abort.signal])
      : managed.abort.signal;
    return this.track(this.handle(id).exec({ ...input, signal }));
  }
  openTerminal(
    connectionId: string,
    input: {
      cols: number;
      rows: number;
      bookmarkId?: string;
      profileId?: string;
      term?: string;
      env?: Record<string, string>;
      directory?: string;
      appearance?: TerminalAppearance;
      behavior?: TerminalBehavior;
    },
  ): Promise<TerminalSession> {
    if (!this.accepting)
      return Promise.reject(
        new ApplicationError('CAPABILITY_UNAVAILABLE', 'Connections are closed', 503),
      );
    return this.track(this.openTerminalOwned(connectionId, input));
  }
  private async openTerminalOwned(
    connectionId: string,
    input: {
      cols: number;
      rows: number;
      bookmarkId?: string;
      profileId?: string;
      term?: string;
      env?: Record<string, string>;
      directory?: string;
      appearance?: TerminalAppearance;
      behavior?: TerminalBehavior;
    },
  ): Promise<TerminalSession> {
    const managed = this.require(connectionId);
    const handle = this.handle(connectionId);
    const shellIntegrationKind = await detectRemoteShell(handle, managed.abort.signal);
    managed.abort.signal.throwIfAborted();
    let channel;
    try {
      channel = await handle.openShell({
        cols: input.cols,
        rows: input.rows,
        term: input.term ?? DEFAULT_TERMINAL_TYPE,
        env: { ...managed.host.startup.environment, ...(input.env ?? {}) },
        ...(managed.host.x11.enabled
          ? { x11: { ...(managed.host.x11.display ? { display: managed.host.x11.display } : {}) } }
          : {}),
      });
    } catch (error) {
      if (managed.host.x11.enabled)
        throw new ApplicationError(
          'CAPABILITY_UNAVAILABLE',
          'X11 forwarding could not reach the configured local display or was rejected by the SSH server',
          503,
        );
      throw error;
    }
    const metadata: TerminalSession = {
      id: randomUUID(),
      kind: 'ssh',
      title: managed.host.name,
      state: 'ready',
      connectionId,
      ...(input.bookmarkId ? { bookmarkId: input.bookmarkId } : {}),
      ...(input.profileId ? { profileId: input.profileId } : {}),
      appearance: { ...(input.appearance ?? DEFAULT_TERMINAL_APPEARANCE) },
      behavior: { ...(input.behavior ?? DEFAULT_TERMINAL_BEHAVIOR) },
      createdAt: new Date().toISOString(),
    };
    if (managed.abort.signal.aborted) {
      await channel.close();
      throw new ApplicationError(
        'REQUEST_CANCELED',
        'Connection closed before terminal registration',
      );
    }
    let session: TerminalSession | undefined;
    const ownedChannel: TerminalChannel = {
      ...(channel.pid === undefined ? {} : { pid: channel.pid }),
      ...(channel.cwd === undefined ? {} : { cwd: channel.cwd }),
      ...(channel.shellIntegrationKind === undefined
        ? {}
        : { shellIntegrationKind: channel.shellIntegrationKind }),
      write: (data) => channel.write(data),
      resize: (cols, rows) => channel.resize(cols, rows),
      signal: (signal) => channel.signal(signal),
      onData: (listener) => channel.onData(listener),
      onExit: (listener) => channel.onExit(listener),
      pause: () => channel.pause(),
      resume: () => channel.resume(),
      close: async () => {
        await channel.close();
        if (session) managed.terminalIds.delete(session.id);
      },
    };
    try {
      session = this.terminals.registerExternal(metadata, ownedChannel, shellIntegrationKind);
    } catch (error) {
      await channel.close();
      throw error;
    }
    managed.terminalIds.add(session.id);
    const startupSteps = buildSshStartupSequence(
      {
        ...managed.host.startup,
        ...(input.directory ? { directory: input.directory } : {}),
        environment: { ...managed.host.startup.environment, ...(input.env ?? {}) },
      },
      shellIntegrationKind,
    );
    try {
      this.terminals.enqueueStartupSequence(session.id, startupSteps);
    } catch (error) {
      await this.terminals.close(session.id);
      managed.terminalIds.delete(session.id);
      throw error;
    }
    return session;
  }
  async retry(id: string): Promise<Connection> {
    const previous = this.require(id);
    const source = previous.source;
    // A retry replaces the transport, not the user's retained terminal tabs/output.
    // Disconnect drains each channel and relinquishes its transport lease before close.
    const drained = await Promise.allSettled(
      [...previous.terminalIds].map((terminalId) => this.terminals.disconnect(terminalId)),
    );
    if (drained.some((result) => result.status === 'rejected'))
      throw new ApplicationError('CAPABILITY_UNAVAILABLE', 'Terminal channels did not drain', 503);
    await this.close(id);
    return this.create(source);
  }
  cancelReconnect(id: string): Connection {
    const managed = this.require(id);
    if (managed.metadata.state !== 'reconnecting')
      throw new ApplicationError('INVALID_STATE', 'Connection is not waiting to reconnect', 409);
    managed.automaticReconnectCanceled = true;
    if (managed.reconnectTimer) clearTimeout(managed.reconnectTimer);
    managed.reconnectTimer = undefined;
    managed.nextReconnectAt = null;
    this.transition(managed, 'failed', 'RECONNECT_CANCELED');
    return { ...managed.metadata };
  }
  close(id: string): Promise<void> {
    const previous = this.closing.get(id);
    if (previous) return previous;
    const managed = this.connections.get(id);
    if (!managed) return Promise.resolve();
    const deferred = Promise.withResolvers<void>();
    this.closing.set(id, deferred.promise);
    void this.closeManaged(managed).then(
      () => {
        this.closing.delete(id);
        deferred.resolve();
      },
      (error) => {
        this.closing.delete(id);
        deferred.reject(error);
      },
    );
    return deferred.promise;
  }
  private async closeManaged(managed: ManagedConnection): Promise<void> {
    const id = managed.metadata.id;
    this.transition(managed, 'closing');
    if (managed.reconnectTimer) clearTimeout(managed.reconnectTimer);
    managed.reconnectTimer = undefined;
    managed.nextReconnectAt = null;
    managed.automaticReconnectCanceled = true;
    managed.abort.abort();
    this.interactions.cancelConnection(id);
    managed.pendingProxySocket?.destroy();
    managed.pendingProxySocket = undefined;
    if (managed.temporaryCredentialGrantId) {
      const grantId = managed.temporaryCredentialGrantId;
      delete managed.temporaryCredentialGrantId;
      await this.hostCapabilities?.revokeGrant(grantId).catch(() => undefined);
    }
    const childrenClosed = await Promise.allSettled([
      Promise.allSettled([...managed.connecting]),
      ...[...managed.terminalIds].map((terminalId) => this.terminals.close(terminalId)),
      ...[...managed.sftpLeases].map((lease) => lease.close()),
      this.closeHandles(managed),
      Promise.allSettled([...managed.sftpOpening]),
    ]);
    if (managed.sftpCleanupFailed || childrenClosed.some((result) => result.status === 'rejected'))
      throw new ApplicationError(
        'CAPABILITY_UNAVAILABLE',
        'Connection resources did not drain cleanly',
        503,
      );
    managed.terminalIds.clear();
    delete managed.temporarySecret;
    delete managed.temporaryPassphrase;
    delete managed.temporaryCertificate;
    for (const hop of managed.hops ?? []) delete hop.temporarySecret;
    delete managed.hops;
    this.transition(managed, 'closed');
    this.connections.delete(id);
  }
  async closeAll() {
    this.accepting = false;
    const closed = await Promise.allSettled(
      [...this.connections.keys()].map((id) => this.close(id)),
    );
    await Promise.allSettled([...this.pending]);
    if (closed.some((result) => result.status === 'rejected'))
      throw new ApplicationError(
        'CAPABILITY_UNAVAILABLE',
        'Connections did not drain cleanly',
        503,
      );
  }
  resourceCount() {
    return this.connections.size;
  }
  activeTaskCount(): number {
    return (
      [...this.connections.values()].filter(
        ({ metadata, sftpLeases, sftpOpening, sftpCleanupFailed }) =>
          (metadata.state !== 'failed' && metadata.state !== 'closed') ||
          sftpLeases.size > 0 ||
          sftpOpening.size > 0 ||
          sftpCleanupFailed,
      ).length + this.pending.size
    );
  }

  private async recover(managed: ManagedConnection, error: unknown): Promise<void> {
    if (
      managed.recovering ||
      managed.abort.signal.aborted ||
      !this.connections.has(managed.metadata.id)
    )
      return;
    managed.recovering = true;
    try {
      const policy = managed.host.connectionOptions.reconnectPolicy;
      const willReconnect =
        this.automaticReconnectEnabled(managed) && managed.reconnectAttempt < policy.maxAttempts;
      if (willReconnect) {
        managed.reconnectAttempt += 1;
        managed.nextReconnectAt = new Date(Date.now() + policy.delayMs).toISOString();
        this.transition(managed, 'reconnecting', classifyConnectionError(error));
      } else {
        managed.nextReconnectAt = null;
        this.transition(managed, 'failed', classifyConnectionError(error));
      }

      await Promise.all([
        this.closeHandles(managed),
        ...[...managed.sftpLeases].map((lease) => lease.close()),
      ]);
      if (
        !willReconnect ||
        managed.automaticReconnectCanceled ||
        managed.abort.signal.aborted ||
        !this.connections.has(managed.metadata.id)
      )
        return;
      managed.reconnectTimer = setTimeout(() => {
        managed.reconnectTimer = undefined;
        managed.nextReconnectAt = null;
        if (managed.abort.signal.aborted || !this.connections.has(managed.metadata.id)) return;
        if (!this.automaticReconnectEnabled(managed)) {
          this.transition(managed, 'failed', 'AUTO_RECONNECT_DISABLED');
          return;
        }
        this.transition(managed, 'resolving');
        this.startConnect(managed);
      }, policy.delayMs);
    } finally {
      managed.recovering = false;
    }
  }

  private automaticReconnectEnabled(managed: ManagedConnection): boolean {
    if (!managed.everReady || managed.automaticReconnectCanceled) return false;
    return (
      managed.host.connectionOptions.reconnectPolicy.mode === 'automatic' ||
      this.repository.getSettings().terminal.autoReconnectTerminal
    );
  }

  private async closeHandles(managed: ManagedConnection): Promise<void> {
    const handles = [...managed.handles].reverse();
    for (const item of handles) item.unsubscribe();
    // Every later hop is transported by a channel owned by the preceding hop.
    // Close from target back to the first hop and wait at each boundary so ssh2
    // never writes a channel-close packet after its parent protocol is gone.
    for (const item of handles) {
      await item.handle.close();
      const index = managed.handles.indexOf(item);
      if (index >= 0) managed.handles.splice(index, 1);
    }
  }

  private transition(managed: ManagedConnection, state: Connection['state'], errorCode?: string) {
    const metadata: Connection = {
      ...managed.metadata,
      state,
      reconnectAttempt: managed.reconnectAttempt,
      nextReconnectAt: managed.nextReconnectAt,
      updatedAt: new Date().toISOString(),
      ...(errorCode ? { errorCode } : { errorCode: undefined }),
    };
    managed.metadata = metadata;
    this.realtime.publish('connection.status', managed.metadata);
  }
  private require(id: string) {
    const managed = this.connections.get(id);
    if (!managed) throw new ApplicationError('NOT_FOUND', 'Connection not found', 404);
    return managed;
  }
  private requireHostCapabilities() {
    if (!this.hostCapabilities)
      throw new ApplicationError('CAPABILITY_UNAVAILABLE', 'Credential vault is unavailable', 503);
    return this.hostCapabilities;
  }

  private requireConnectionProfiles() {
    if (!this.profiles)
      throw new ApplicationError(
        'CAPABILITY_UNAVAILABLE',
        'Connection Profiles are unavailable',
        503,
      );
    return this.profiles;
  }
}

export function buildSshStartupSequence(
  startup: SshStartup,
  shell: ShellIntegrationKind,
): TerminalStartupStep[] {
  const defaults = {
    delayMs: 0,
    sendEnter: true,
    waitForOutput: false,
    settleIdleMs: 400,
    settleTimeoutMs: 3_000,
  } as const;
  const steps: TerminalStartupStep[] = [];
  const environment = Object.entries(startup.environment)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, value]) =>
      shell === 'fish'
        ? `set -gx ${name} ${quoteShellValue(value)}`
        : `export ${name}=${quoteShellValue(value)}`,
    );
  if (environment.length) steps.push({ text: environment.join('; '), ...defaults });
  steps.push(
    ...startup.loginScripts.map(({ command, ...options }) => ({ text: command, ...options })),
  );
  if (startup.directory)
    steps.push({ text: `cd -- ${quoteShellValue(startup.directory)}`, ...defaults });
  steps.push(
    ...startup.runScripts.map(({ command, ...options }) => ({ text: command, ...options })),
  );
  return steps;
}

function quoteShellValue(value: string): string {
  return `'${value.replace(/'/gu, `'"'"'`)}'`;
}

async function detectRemoteShell(
  handle: SshConnectionHandle,
  signal: AbortSignal,
): Promise<ShellIntegrationKind> {
  try {
    const result = await handle.exec({
      command: `printf '%s' "\${SHELL:-}"`,
      maxBytes: 256,
      signal: AbortSignal.any([signal, AbortSignal.timeout(3_000)]),
    });
    if (result.exitCode !== 0) return 'unsupported';
    return detectShellIntegrationKind(result.stdout, 'linux');
  } catch {
    // Shell probing is ancillary. The SSH terminal remains usable and the UI
    // reports command tracking as unavailable for this session.
    return 'unsupported';
  }
}

function classifyConnectionError(error: unknown) {
  if (error instanceof ApplicationError) return error.code;
  return 'SSH_CONNECTION_FAILED';
}
