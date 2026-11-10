import { TargetStreams } from './adapters/target-streams.ts';
import {
  Remote,
  RemoteError,
  remoteErrorOf,
  TypertRemoteService,
  StorageCommandError,
} from '@axterm/plugin-api';
import type {} from '@axterm/plugin-api/host';
import type { Context } from '@deepseek-ai/cordis';
import { ZodError } from 'zod';
import * as Contract from '@axterm/plugin-api/connections';
import { idSchema } from '@axterm/plugin-api/catalog';
import { productDomains } from '@axterm/data-schema';
import { KnownHosts } from './adapters/known-hosts.ts';
import { ConnectionCredentials } from './adapters/credentials.ts';
import { RuntimeCommands, RuntimeCommandError } from './adapters/runtime-commands.ts';
import { Ssh2Transport } from './adapters/ssh2/ssh2-transport.ts';
import { TcpProxyConnector } from './adapters/proxy/tcp-proxy-connector.ts';
import { StdioProxyCommandRunner } from './adapters/proxy-command/stdio-proxy-command-runner.ts';
import { OwnedFileLease } from './adapters/file-lease.ts';
import { FtpConnectionService } from './application/ftp-connection-service.ts';
import { BasicFtpAdapter } from './adapters/ftp/basic-ftp-adapter.ts';
import { Tunnels } from './application/tunnels.ts';
import { NativeTunnels } from './adapters/tunnels.ts';
import { OwnedTunnelProfiles } from './adapters/tunnel-profiles.ts';
import { PlainTerminals } from './application/plain-terminals.ts';
import { NodeSerialAdapter } from './adapters/serial/node-serial-adapter.ts';
import { NodeTelnetAdapter } from './adapters/telnet/node-telnet-adapter.ts';
import { remoteFileTargetSchema } from '@axterm/plugin-api/files';
import { ConnectionService } from './application/connection-service.ts';
import { InteractionService } from './application/interaction-service.ts';
import { ProxyService } from './application/proxy-service.ts';
import { ApplicationError } from './application/errors.ts';
import { ConnectionObservation } from './observation.ts';
export const inject = [
  'storage',
  'storageDomain',
  'runtimeIdentity',
  'catalog',
  'catalogReferences',
  'catalogConnectionHistory',
  'configuration',
  'credentials',
  'terminals',
  'desktopTaskInspection',
];
declare module '@deepseek-ai/cordis' {
  interface Context {
    connectionsController: ConnectionsController;
  }
}

export class ConnectionsController extends TypertRemoteService {
  private open = true;
  private readonly lifetime = new AbortController();
  private readonly pending = new Set<Promise<unknown>>();
  private closing: Promise<void> | undefined;
  constructor(
    ctx: Context,
    private readonly app: ConnectionService,
    private readonly ftp: FtpConnectionService,
    private readonly ftpCommands: RuntimeCommands<Contract.FtpConnection>,
    private readonly interactions: InteractionService,
    private readonly known: KnownHosts,
    private readonly commands: RuntimeCommands,
    private readonly observation: ConnectionObservation,
    private readonly transport: Ssh2Transport,
    private readonly proxies: ProxyService,
    private readonly plain: PlainTerminals,
    private readonly tunnelProfiles: OwnedTunnelProfiles,
    private readonly tunnels: Tunnels,
    private readonly tunnelCommands: RuntimeCommands<Contract.Tunnel>,
  ) {
    super(ctx, 'connectionsController', { namespace: 'connections' });
    ctx.effect(() => () => this.dispose());
  }
  @Remote listTunnelProfiles(): Contract.TunnelProfile[] {
    return this.call(() => this.tunnelProfiles.list());
  }
  @Remote createTunnelProfile(
    key: string,
    input: Contract.TunnelProfileInput,
  ): Contract.ConnectionFactReceipt {
    return this.call(() =>
      this.tunnelProfiles.create(key, Contract.tunnelProfileInputSchema.parse(input)),
    );
  }
  @Remote({ resources: { tunnelProfile: (_key: string, id: string) => id } }) updateTunnelProfile(
    key: string,
    id: string,
    input: Contract.TunnelProfilePatch,
    ifMatch: string | undefined,
  ): Contract.ConnectionFactReceipt {
    return this.call(() =>
      this.tunnelProfiles.update(
        key,
        idSchema.parse(id),
        Contract.tunnelProfilePatchSchema.parse(input),
        ifMatch,
      ),
    );
  }
  @Remote({ resources: { tunnelProfile: (_key: string, id: string) => id } }) deleteTunnelProfile(
    key: string,
    id: string,
    ifMatch: string | undefined,
  ): Contract.ConnectionFactReceipt {
    return this.call(() => this.tunnelProfiles.remove(key, idSchema.parse(id), ifMatch));
  }
  @Remote listTunnels(): Contract.Tunnel[] {
    return this.call(() => this.tunnels.list());
  }
  @Remote async startTunnel(
    key: string,
    input: Contract.StartTunnelInput,
    signal: AbortSignal,
  ): Promise<Contract.Tunnel> {
    return this.perform(() => {
      const request = Contract.startTunnelSchema.parse(input);
      return this.tunnelCommands.execute(key, 'create', request, () =>
        this.tunnels.start(request, AbortSignal.any([signal, this.lifetime.signal]), (id) =>
          this.tunnelCommands.bindResource(key, id),
        ),
      );
    });
  }
  @Remote getTunnelCommandOutcome(
    generation: string,
    key: string,
  ): Contract.ConnectionCommandOutcome | { readonly status: 'rejected' } {
    return this.call(() => {
      if (generation !== this.ctx.runtimeIdentity.generation)
        throw new RemoteError('connections/failure', 'Tunnel generation changed', {
          reason: 'stale',
        });
      return this.tunnelCommands.boundResourceOutcome(idSchema.parse(key));
    });
  }
  @Remote({ resources: { tunnel: (id: string) => id } }) async stopTunnel(
    id: string,
  ): Promise<{ closed: true }> {
    return this.perform(async () => {
      await this.tunnels.stop(idSchema.parse(id));
      return { closed: true };
    });
  }
  @Remote async listSerialPorts(): Promise<Contract.SerialPortInfo[]> {
    return this.perform(async () =>
      (await this.plain.listPorts()).map((value) => Contract.serialPortInfoSchema.parse(value)),
    );
  }
  openBookmarkTerminal(
    input: Contract.OpenBookmarkTerminalInput,
    signal?: AbortSignal,
  ): Promise<Contract.TerminalSession> {
    return this.perform(() =>
      this.plain.open(
        Contract.openBookmarkTerminalSchema.parse(input),
        AbortSignal.any([this.lifetime.signal, ...(signal ? [signal] : [])]),
      ),
    );
  }
  @Remote listConnections(): Contract.Connection[] {
    return this.call(() => this.app.list());
  }
  @Remote({ resources: { connection: (id: string) => id } }) getConnection(
    id: string,
  ): Contract.Connection {
    return this.call(() => this.app.get(idSchema.parse(id)));
  }
  @Remote async createConnection(
    key: string,
    generation: string,
    input: Contract.CreateConnectionInput,
  ): Promise<Contract.Connection> {
    return this.perform(async () => {
      if (generation !== this.ctx.runtimeIdentity.generation)
        throw new RemoteError('connections/failure', 'Connection generation changed', {
          reason: 'stale',
        });
      const command = Contract.createConnectionSchema.parse(input);
      return this.commands.execute(key, 'create', command, () => this.app.create(command));
    });
  }
  @Remote getConnectionCommandOutcome(
    generation: string,
    key: string,
  ): Contract.ConnectionCommandOutcome {
    return this.call(() => {
      if (generation !== this.ctx.runtimeIdentity.generation)
        throw new RemoteError('connections/failure', 'Connection generation changed', {
          reason: 'stale',
        });
      return this.commands.outcome(idSchema.parse(key));
    });
  }
  @Remote({
    resources: { connectionHistory: (_key: string, _generation: string, id: string) => id },
  })
  reconnectConnectionHistory(
    key: string,
    generation: string,
    id: string,
    input: Contract.ReconnectConnectionHistoryInput,
    ifMatch: string | undefined,
  ): Promise<Contract.Connection> {
    return this.perform(() => {
      if (generation !== this.ctx.runtimeIdentity.generation)
        throw new RemoteError('connections/failure', 'Connection generation changed', {
          reason: 'stale',
        });
      const historyId = idSchema.parse(id);
      const command = Contract.reconnectConnectionHistorySchema.parse(input);
      return this.commands.execute(
        key,
        'reconnect-history',
        { id: historyId, input: command, ifMatch },
        () => {
          const item = this.ctx.catalog.getConnectionHistoryItem(historyId, ifMatch);
          let target: Contract.CreateConnectionInput;
          if (item.hostId) {
            this.ctx.catalog.getHost(item.hostId);
            const profile = this.ctx.catalog
              .getBookmarkTree()
              .bookmarks.find((bookmark) => bookmark.hostId === item.hostId)?.connectionProfileId;
            target = { hostId: item.hostId, ...(profile ? { connectionProfileId: profile } : {}) };
          } else {
            if (item.jumpHostId)
              throw new ApplicationError('CONFLICT', 'History requires a saved jump-host target');
            target = {
              target: {
                name: item.name,
                hostname: item.hostname,
                port: item.port,
                username: item.username,
                authType: item.authType,
                connectionOptions: item.connectionOptions,
              },
            };
          }
          return this.app.create(Contract.createConnectionSchema.parse({ ...target, ...command }));
        },
      );
    });
  }
  @Remote({ resources: { connection: (_generation: string, id: string) => id } })
  async closeConnection(generation: string, id: string): Promise<{ closed: true }> {
    return this.perform(async () => {
      if (generation !== this.ctx.runtimeIdentity.generation)
        throw new RemoteError('connections/failure', 'Connection generation changed', {
          reason: 'stale',
        });
      const connectionId = idSchema.parse(id);
      await this.app.close(connectionId);
      await this.tunnels.connectionClosed(connectionId);
      return { closed: true };
    });
  }
  @Remote({ resources: { connection: (key: string, id: string) => id } }) async retryConnection(
    key: string,
    id: string,
  ): Promise<Contract.Connection> {
    return this.perform(() => {
      const connectionId = idSchema.parse(id);
      return this.commands.execute(key, 'retry', { id: connectionId }, () =>
        this.app.retry(connectionId),
      );
    });
  }
  @Remote({ resources: { connection: (id: string) => id } }) cancelConnectionReconnect(
    id: string,
  ): Contract.Connection {
    return this.call(() => this.app.cancelReconnect(idSchema.parse(id)));
  }
  @Remote listFtpConnections(): Contract.FtpConnection[] {
    return this.call(() => this.ftp.list());
  }
  @Remote({ resources: { connection: (id: string) => id } }) getFtpConnection(
    id: string,
  ): Contract.FtpConnection {
    return this.call(() => this.ftp.get(idSchema.parse(id)));
  }
  @Remote getFtpConnectionCommandOutcome(
    generation: string,
    key: string,
  ): Contract.FtpConnectionCommandOutcome {
    return this.call(() => {
      if (generation !== this.ctx.runtimeIdentity.generation)
        throw new RemoteError('connections/failure', 'FTP generation changed', { reason: 'stale' });
      return this.ftpCommands.boundResourceOutcome(idSchema.parse(key));
    });
  }
  @Remote async createFtpConnection(
    key: string,
    input: Contract.CreateFtpConnectionInput,
    signal: AbortSignal,
  ): Promise<Contract.FtpConnection> {
    return this.perform(() => {
      const parsed = Contract.createFtpConnectionSchema.parse(input);
      return this.ftpCommands.execute(key, 'create', parsed, () =>
        this.ftp.create(parsed.bookmarkId, AbortSignal.any([signal, this.lifetime.signal]), (id) =>
          this.ftpCommands.bindResource(key, id),
        ),
      );
    });
  }
  @Remote({ resources: { connection: (id: string) => id } }) async closeFtpConnection(
    id: string,
  ): Promise<{ closed: true }> {
    return this.perform(async () => {
      await this.ftp.close(idSchema.parse(id));
      return { closed: true };
    });
  }
  @Remote listInteractions(): Contract.Interaction[] {
    return this.call(() => this.interactions.list());
  }
  @Remote({ resources: { connectionInteraction: (id: string) => id } }) respondInteraction(
    id: string,
    input: Contract.ConnectionInteractionResponseInput,
  ): { resolved: true } {
    return this.call(() => {
      this.interactions.respond(
        idSchema.parse(id),
        Contract.connectionInteractionResponseSchema.parse(input),
      );
      return { resolved: true };
    });
  }
  @Remote({ resources: { knownHostKey: (_key: string, _generation: string, id: string) => id } })
  deleteKnownHostKey(
    key: string,
    generation: string,
    id: string,
    ifMatch: string | undefined,
  ): Contract.ConnectionFactReceipt {
    return this.call(() => {
      if (generation !== this.ctx.runtimeIdentity.generation)
        throw new RemoteError('connections/failure', 'Known host generation changed', {
          reason: 'stale',
        });
      return this.known.remove(key, idSchema.parse(id), ifMatch);
    });
  }
  @Remote listKnownHostKeys(): Contract.KnownHostKey[] {
    return this.call(() => this.known.list());
  }
  @Remote async sshAgentStatus(
    input: Contract.SshAgentProbeInput,
  ): Promise<Contract.SshAgentStatus> {
    return this.perform(() =>
      this.transport.agentStatus(Contract.sshAgentProbeInputSchema.parse(input).path ?? undefined),
    );
  }
  @Remote async testProxy(
    input: Contract.ProxyTestRequest,
    signal: AbortSignal,
  ): Promise<Contract.ProxyTestResult> {
    return this.perform(() =>
      this.proxies.test(
        Contract.proxyTestRequestSchema.parse(input),
        AbortSignal.any([signal, this.lifetime.signal]),
      ),
    );
  }
  @Remote({ mode: 'stream' }) watchConnections(
    signal: AbortSignal,
  ): AsyncIterable<Contract.ConnectionsUpdate> {
    return this.call(() => this.observation.watch(signal));
  }
  resourceSnapshot(): Readonly<Record<string, number>> {
    return Object.freeze({
      connections: this.app.resourceCount(),
      connectionWork: this.app.activeTaskCount(),
      ftpConnections: this.ftp.resourceCount(),
      interactions: this.interactions.resourceCount(),
      ...this.tunnels.resourceSnapshot(),
      connectionFollowers: this.observation.resourceCount(),
      connectionRequests: this.pending.size,
    });
  }
  activeTaskCount(): number {
    return (
      this.tunnels.resourceCount() +
      this.plain.resourceCount() +
      this.app.activeTaskCount() +
      this.ftp.activeTaskCount() +
      this.pending.size +
      this.interactions.resourceCount()
    );
  }
  dispose(): Promise<void> {
    return (this.closing ??= (async () => {
      this.open = false;
      this.commands.stop();
      this.ftpCommands.stop();
      this.tunnelCommands.stop();
      this.lifetime.abort();
      const observation = this.observation.dispose();
      const closed = this.app.closeAll();
      this.interactions.close();
      const results = await Promise.allSettled([
        observation,
        closed,
        this.ftp.closeAll(),
        this.plain.close(),
        this.tunnels.close(),
      ]);
      await Promise.allSettled([...this.pending]);
      await Promise.all([
        this.commands.dispose(),
        this.ftpCommands.dispose(),
        this.tunnelCommands.dispose(),
      ]);
      if (results.some((result) => result.status === 'rejected'))
        throw new Error('CONNECTION_DRAIN_FAILED');
    })());
  }
  private assertOpen(): void {
    if (!this.open)
      throw new RemoteError('connections/failure', 'Connections are closed', { reason: 'closed' });
  }
  private call<T>(apply: () => T): T {
    this.assertOpen();
    try {
      return apply();
    } catch (error) {
      throw this.failure(error);
    }
  }
  private async perform<T>(apply: () => Promise<T>): Promise<T> {
    this.assertOpen();
    if (this.pending.size >= 128)
      throw new RemoteError('connections/failure', 'Connection request capacity exceeded', {
        reason: 'capacity',
      });
    const task = Promise.resolve().then(() => {
      this.assertOpen();
      return apply();
    });
    this.pending.add(task);
    try {
      return await task;
    } catch (error) {
      throw this.failure(error);
    } finally {
      this.pending.delete(task);
    }
  }
  private failure(error: unknown): RemoteError<'connections/failure'> {
    return mapConnectionFailure(error);
  }
}

export async function apply(ctx: Context): Promise<void> {
  const opening = ctx.storage.domain.open(productDomains.connections);
  ctx.effect(() => async () => {
    await (await opening.catch(() => undefined))?.close();
  });
  const domain = await opening;
  const known = new KnownHosts(domain);
  const tunnelProfiles = new OwnedTunnelProfiles(
    domain,
    (id) => ctx.catalog.getHost(id),
    (operation) =>
      ctx.storage.domain.transaction([domain.participant, ctx.catalog.participant], operation),
  );
  const observation: ConnectionObservation = new ConnectionObservation(
    ctx,
    domain,
    known,
    () => app.list(),
    () => interactions.list(),
    () => ftp.list(),
    () => tunnelProfiles.list(),
    () => tunnels.list(),
  );
  ctx.effect(() => () => observation.dispose());
  const interactions: InteractionService = new InteractionService(observation);
  const credentials = new ConnectionCredentials(ctx);
  const repository = {
    getHost: (id: string) => ctx.catalog.getHost(id),
    getSettings: () => ctx.configuration.getSettings(),
    getKnownHostKey: known.get.bind(known),
    saveKnownHostKey: known.save.bind(known),
  };
  const transport = new Ssh2Transport();
  const proxies = new ProxyService(
    repository,
    new TcpProxyConnector(),
    credentials,
    new StdioProxyCommandRunner(),
  );
  const app: ConnectionService = new ConnectionService(
    repository,
    transport,
    credentials,
    interactions,
    observation,
    ctx.terminals,
    { recordSuccessful: (input) => ctx.catalogConnectionHistory.recordSuccessful(input) },
    proxies,
    { get: (id) => ctx.catalog.getConnectionProfile(id) },
    (native, signal, released) => new OwnedFileLease(native, signal, released),
  );
  const ftp = new FtpConnectionService(
    ctx.catalog,
    credentials,
    new BasicFtpAdapter(),
    (native, signal, released) => new OwnedFileLease(native, signal, released),
    () => observation.ftpChanged(),
  );
  const ftpCommands = new RuntimeCommands((id) => ftp.get(id), true);
  const commands = new RuntimeCommands((id) => app.get(id));
  const plain = new PlainTerminals(
    ctx.catalog,
    credentials,
    new NodeSerialAdapter(),
    new NodeTelnetAdapter(),
    ctx.terminals,
  );
  ctx.effect(() => () => plain.close());
  const tunnels = new Tunnels(
    tunnelProfiles,
    (id) => app.get(id),
    new NativeTunnels({ handle: (id) => app.handle(id), close: (id) => app.close(id) }),
    { changed: () => observation.tunnelsChanged() },
  );
  ctx.effect(() => () => tunnels.close());
  const tunnelCommands = new RuntimeCommands<Contract.Tunnel>((id) => tunnels.get(id), true);
  const controller = new ConnectionsController(
    ctx,
    app,
    ftp,
    ftpCommands,
    interactions,
    known,
    commands,
    observation,
    transport,
    proxies,
    plain,
    tunnelProfiles,
    tunnels,
    tunnelCommands,
  );
  ctx.catalogReferences.register('@axterm/plugin-connections', {
    participant: domain.participant,
    retainedBy: (id) => known.retainedBy(id),
  });
  ctx.desktopTaskInspection.register('connections', {
    inspect: (signal) => {
      signal.throwIfAborted();
      return { active: controller.activeTaskCount() > 0 };
    },
    dispose: () => controller.dispose(),
  });
  const targetStreams = new TargetStreams(app, proxies);
  ctx.effect(() => () => targetStreams.close());
  ctx.desktopTaskInspection.register('connections.streams', {
    inspect: (signal) => {
      signal.throwIfAborted();
      return { active: targetStreams.resourceCount() > 0 };
    },
    dispose: () => targetStreams.close(),
  });
  ctx.provide('connections', {
    participant: domain.participant,
    openStream: (input, signal) => targetStreams.open(input, signal),
    createTunnelProfile: (key, input) => controller.createTunnelProfile(key, input),
    updateTunnelProfile: (key, id, input, ifMatch) =>
      controller.updateTunnelProfile(key, id, input, ifMatch),
    deleteTunnelProfile: (key, id, ifMatch) => controller.deleteTunnelProfile(key, id, ifMatch),
    startTunnel: (key, input, signal) =>
      controller.startTunnel(key, input, signal ?? new AbortController().signal),
    stopTunnel: async (id) => {
      await controller.stopTunnel(id);
    },
    listTunnels: () => controller.listTunnels(),
    listTunnelProfiles: () => controller.listTunnelProfiles(),
    listSerialPorts: () => controller.listSerialPorts(),
    openBookmarkTerminal: (input, signal) => controller.openBookmarkTerminal(input, signal),
    create: (key, input) => controller.createConnection(key, ctx.runtimeIdentity.generation, input),
    list: () => controller.listConnections(),
    get: (id) => controller.getConnection(id),
    executionTarget: (id) => {
      controller.getConnection(idSchema.parse(id));
      try {
        return app.executionTarget(id);
      } catch (error) {
        throw mapConnectionFailure(error);
      }
    },
    close: async (id) => {
      await controller.closeConnection(ctx.runtimeIdentity.generation, id);
    },
    openTerminal: async (id, input) => {
      try {
        if (input.bookmarkId) {
          const bookmark = ctx.catalog.getBookmark(input.bookmarkId);
          if (bookmark.protocol !== 'ssh' || bookmark.hostId !== app.get(id).hostId)
            throw new ApplicationError(
              'CONFLICT',
              'The SSH bookmark does not match the connection',
            );
        }
        return await app.openTerminal(id, input);
      } catch (error) {
        throw mapConnectionFailure(error);
      }
    },
    getFtp: (id) => controller.getFtpConnection(id),
    closeFtp: async (id) => {
      await controller.closeFtpConnection(id);
    },
    createFtp: (key, input, signal) =>
      controller.createFtpConnection(key, input, signal ?? new AbortController().signal),
    openFiles: async (target, signal) => {
      try {
        const selected = remoteFileTargetSchema.parse(target);
        return selected.protocol === 'sftp'
          ? await app.openSftp(selected.connectionId, signal)
          : await ftp.openFiles(selected.connectionId, signal);
      } catch (error) {
        throw mapConnectionFailure(error);
      }
    },
    exec: async (id, input) => {
      try {
        return await app.exec(id, input);
      } catch (error) {
        throw mapConnectionFailure(error);
      }
    },
  });
}

function mapConnectionFailure(error: unknown): RemoteError<'connections/failure'> {
  const marked = remoteErrorOf(error);
  if (marked?.code === 'connections/failure') return marked as RemoteError<'connections/failure'>;
  if (marked?.code === 'catalog/failure')
    return new RemoteError('connections/failure', 'The connection reference is unavailable', {
      reason: marked.details.reason,
    });
  let reason: Contract.ConnectionFailureReason = 'unavailable';
  if (error instanceof StorageCommandError)
    reason =
      error.code === 'conflict'
        ? 'conflict'
        : error.code === 'receipt-expired'
          ? 'receipt-expired'
          : error.code === 'invalid-input'
            ? 'invalid-input'
            : 'unavailable';
  else if (error instanceof RuntimeCommandError) reason = error.reason;
  else if (error instanceof ZodError) reason = 'invalid-input';
  else if (error instanceof ApplicationError) {
    const reasons: Record<string, Contract.ConnectionFailureReason> = {
      NOT_FOUND: 'not-found',
      VALIDATION_ERROR: 'invalid-input',
      CAPACITY_EXCEEDED: 'capacity',
      PRECONDITION_FAILED: 'precondition-failed',
      PRECONDITION_REQUIRED: 'precondition-required',
      REQUEST_CANCELED: 'cancelled',
      CONFLICT: 'conflict',
    };
    reason = reasons[error.code] ?? 'unavailable';
  }
  return new RemoteError('connections/failure', 'The connection operation failed', { reason });
}
