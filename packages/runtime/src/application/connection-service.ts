import { randomUUID } from 'node:crypto';
import type { Duplex, Readable } from 'node:stream';
import type {
  Connection,
  ConnectionProfile,
  CreateConnectionInput,
  Host,
  QuickConnectTarget,
  SshStartup,
  TerminalAppearance,
  TerminalBehavior,
  TerminalSession,
} from '@workspace/contracts';
import {
  createConnectionSchema,
  DEFAULT_TERMINAL_APPEARANCE,
  DEFAULT_TERMINAL_BEHAVIOR,
  DEFAULT_TERMINAL_TYPE,
} from '@workspace/contracts';
import type { HostCapabilityClient } from '../adapters/host-capability/client';
import type { ProductRepository } from '../adapters/sqlite/product-repository';
import type { SshConnectionHandle, SshHostKey, SshTransport } from '../ports/ssh-transport';
import type { TerminalService, TerminalStartupStep } from './terminal-service';
import type { InteractionService } from './interaction-service';
import type { RealtimeHub } from './realtime-hub';
import { ApplicationError } from './errors';
import type { ConnectionHistoryRecorder } from '../ports/connection-history';
import type { ProxyService } from './proxy-service';
import type { ShellIntegrationKind } from '../ports/terminal-channel';
import { detectShellIntegrationKind } from './shell-integration';
import type { ConnectionProfileService } from './connection-profile-service';

interface ManagedConnection {
  metadata: Connection;
  host: Host;
  source:
    | { hostId: string; connectionProfileId?: string }
    | { target: QuickConnectTarget; connectionProfileId?: string };
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
  constructor(
    private readonly repository: ProductRepository,
    private readonly transport: SshTransport,
    private readonly hostCapabilities: HostCapabilityClient | undefined,
    private readonly interactions: InteractionService,
    private readonly realtime: RealtimeHub,
    private readonly terminals: TerminalService,
    private readonly history?: ConnectionHistoryRecorder,
    private readonly proxies?: ProxyService,
    private readonly profiles?: Pick<ConnectionProfileService, 'get'>,
  ) {}

  create(input: CreateConnectionInput): Connection {
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
      metadata,
      host,
      source,
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
    };
    this.connections.set(metadata.id, managed);
    this.transition(managed, 'resolving');
    this.startConnect(managed);
    return { ...metadata };
  }

  private startConnect(managed: ManagedConnection): void {
    void this.connect(managed).catch((error) => this.recover(managed, error));
  }

  private async connect(managed: ManagedConnection): Promise<void> {
    managed.interactionAttempt = 0;
    if (managed.temporaryCredentialGrantId && !managed.temporarySecret) {
      const grantId = managed.temporaryCredentialGrantId;
      const hostCapabilities = this.requireHostCapabilities();
      try {
        managed.temporarySecret = (await hostCapabilities.readGrantedText(grantId)).content;
        delete managed.temporaryCredentialGrantId;
      } finally {
        await hostCapabilities.revokeGrant(grantId).catch(() => undefined);
      }
    }
    const host = managed.host;
    const chain = this.resolveChain(host);
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
        this.transition(managed, 'connecting');
        const credentials = await this.resolveCredentials(
          current,
          current.id === host.id ? managed.temporarySecret : undefined,
          current.id === host.id ? managed.temporaryPassphrase : undefined,
          current.id === host.id ? managed.temporaryCertificate : undefined,
          current.id === host.id ? managed.connectionProfile : undefined,
        );
        const { interactivePassword, ...transportCredentials } = credentials;
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
          verifyHostKey: (key) => this.verifyHostKey(managed.metadata.id, current, key),
          keyboardInteractive: (challenge) =>
            this.keyboardInteractive(managed, current, challenge, interactivePassword),
        });
        if (index === 0) managed.pendingProxySocket = undefined;
        if (managed.abort.signal.aborted || !this.connections.has(managed.metadata.id)) {
          await handle.close();
          throw managed.abort.signal.reason ?? new Error('SSH connection was closed');
        }
        const unsubscribe = handle.onClose((error) => {
          if (managed.metadata.state === 'ready') void this.recover(managed, error);
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

  private async verifyHostKey(connectionId: string, host: Host, key: SshHostKey): Promise<boolean> {
    const known = this.repository.getKnownHostKey(host.hostname, host.port);
    if (known?.publicKey === key.publicKey) return true;
    const changed = !!known;
    const decision = await this.interactions.request({
      kind: changed ? 'changedHostKey' : 'unknownHostKey',
      connectionId,
      severity: changed ? 'high' : 'warning',
      title: changed ? '远程主机密钥已改变' : '首次连接此主机',
      detail: changed
        ? [
            '警告：远程主机身份与已保存记录不一致。',
            `目标：${host.username}@${host.hostname}:${host.port}`,
            `算法：${key.algorithm}`,
            `已保存指纹：${known.fingerprint}`,
            `本次指纹：${key.fingerprint}`,
            '这可能表示服务器已重装，也可能表示连接被拦截。请通过可信渠道核对新指纹。',
          ].join('\n')
        : [
            '尚未保存此远程主机的身份。',
            `目标：${host.username}@${host.hostname}:${host.port}`,
            `算法：${key.algorithm}`,
            `SHA256 指纹：${key.fingerprint}`,
            '请通过可信渠道核对指纹后再连接。',
          ].join('\n'),
      fields: [],
    });
    if (!decision.accepted) return false;
    if (decision.remember)
      this.repository.saveKnownHostKey({ host: host.hostname, port: host.port, ...key });
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
    const decision = await this.interactions.request({
      kind: 'keyboardInteractive',
      connectionId: managed.metadata.id,
      severity: 'info',
      title: `${input.name || 'SSH 交互式认证'} · 挑战 ${managed.interactionAttempt}`,
      detail: [
        `${host.username}@${host.hostname}:${host.port}`,
        input.instructions.trim(),
        `服务端请求 ${input.prompts.length} 项应答；提交后若还有下一步，会继续显示新的挑战。`,
      ]
        .filter(Boolean)
        .join('\n'),
      fields: input.prompts.map((prompt, index) => ({
        id: String(index),
        label: prompt.prompt,
        secret: !prompt.echo,
      })),
    });
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
  handle(id: string): SshConnectionHandle {
    const managed = this.require(id);
    if (managed.metadata.state !== 'ready' || !managed.handles.length)
      throw new ApplicationError('INVALID_STATE', 'SSH connection is not ready', 409);
    return managed.handles[managed.handles.length - 1]!.handle;
  }
  async exec(
    id: string,
    input: { command: string; maxBytes?: number; signal?: AbortSignal },
  ): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
    return this.handle(id).exec(input);
  }
  async openTerminal(
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
    const shellIntegrationKind = await detectRemoteShell(handle);
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
    const session = this.terminals.registerExternal(metadata, channel, shellIntegrationKind);
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
      throw error;
    }
    return session;
  }
  async retry(id: string): Promise<Connection> {
    const previous = this.require(id);
    const source = previous.source;
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
  async close(id: string): Promise<void> {
    const managed = this.connections.get(id);
    if (!managed) return;
    this.transition(managed, 'closing');
    if (managed.reconnectTimer) clearTimeout(managed.reconnectTimer);
    managed.reconnectTimer = undefined;
    managed.nextReconnectAt = null;
    managed.automaticReconnectCanceled = true;
    managed.abort.abort();
    managed.pendingProxySocket?.destroy();
    managed.pendingProxySocket = undefined;
    if (managed.temporaryCredentialGrantId) {
      const grantId = managed.temporaryCredentialGrantId;
      delete managed.temporaryCredentialGrantId;
      await this.hostCapabilities?.revokeGrant(grantId).catch(() => undefined);
    }
    await this.closeHandles(managed);
    this.transition(managed, 'closed');
    this.connections.delete(id);
  }
  async closeAll() {
    await Promise.all([...this.connections.keys()].map((id) => this.close(id)));
  }
  resourceCount() {
    return this.connections.size;
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

      await this.closeHandles(managed);
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
    const handles = managed.handles.splice(0).reverse();
    for (const item of handles) item.unsubscribe();
    // Every later hop is transported by a channel owned by the preceding hop.
    // Close from target back to the first hop and wait at each boundary so ssh2
    // never writes a channel-close packet after its parent protocol is gone.
    for (const { handle } of handles) await handle.close().catch(() => undefined);
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

async function detectRemoteShell(handle: SshConnectionHandle): Promise<ShellIntegrationKind> {
  try {
    const result = await handle.exec({
      command: `printf '%s' "\${SHELL:-}"`,
      maxBytes: 256,
      signal: AbortSignal.timeout(3_000),
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
