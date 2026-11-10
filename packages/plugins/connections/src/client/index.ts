import type { Context } from '@deepseek-ai/cordis';
import type * as Contract from '@axterm/plugin-api/connections';
import { RemoteStreamCarrierError, type RemoteStream } from '@axterm/infra-gateway/client';
import remote from '@axterm/plugin-connections/remote';
import { ConnectionsProjection } from './projection.ts';
export type ConnectionsState =
  | { readonly status: 'connecting' }
  | { readonly status: 'ready'; readonly baseline: Contract.ConnectionsBaseline }
  | { readonly status: 'error'; readonly message: string };
/** Owns connection/challenge metadata; answers and terminal bytes never become snapshots. */
export class ConnectionsModel {
  private state: ConnectionsState = { status: 'connecting' };
  private readonly listeners = new Set<() => void>();
  private stream: RemoteStream<Contract.ConnectionsUpdate>;
  private done: Promise<void>;
  private disposed = false;
  private readonly lifetime = new AbortController();
  private retrying: Promise<void> | undefined;
  constructor(private readonly ctx: Context) {
    this.stream = this.open();
    this.done = this.consume(this.stream);
  }
  getSnapshot = (): ConnectionsState => this.state;
  subscribe = (listener: () => void): (() => void) => {
    this.assertOpen();
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  async createTunnelProfile(
    key: string,
    input: Contract.TunnelProfileInput,
  ): Promise<Contract.ConnectionFactReceipt> {
    this.assertOpen();
    const result = await this.ctx.remote.connections.createTunnelProfile(key, input);
    if (!result.ok) throw result.error;
    return result.value;
  }
  async updateTunnelProfile(
    key: string,
    id: string,
    input: Contract.TunnelProfilePatch,
    ifMatch: string | undefined,
  ): Promise<Contract.ConnectionFactReceipt> {
    this.assertOpen();
    const result = await this.ctx.remote.connections.updateTunnelProfile(key, id, input, ifMatch);
    if (!result.ok) throw result.error;
    return result.value;
  }
  async deleteTunnelProfile(
    key: string,
    id: string,
    ifMatch: string | undefined,
  ): Promise<Contract.ConnectionFactReceipt> {
    this.assertOpen();
    const result = await this.ctx.remote.connections.deleteTunnelProfile(key, id, ifMatch);
    if (!result.ok) throw result.error;
    return result.value;
  }
  async getTunnelCommandOutcome(
    generation: string,
    key: string,
  ): Promise<Contract.ConnectionCommandOutcome | { readonly status: 'rejected' }> {
    this.assertOpen();
    const result = await this.ctx.remote.connections.getTunnelCommandOutcome(generation, key);
    if (!result.ok) throw result.error;
    return result.value;
  }
  async listTunnelProfiles(): Promise<Contract.TunnelProfile[]> {
    this.assertOpen();
    const result = await this.ctx.remote.connections.listTunnelProfiles();
    if (!result.ok) throw result.error;
    return result.value;
  }
  async listTunnels(): Promise<Contract.Tunnel[]> {
    this.assertOpen();
    const result = await this.ctx.remote.connections.listTunnels();
    if (!result.ok) throw result.error;
    return result.value;
  }
  async startTunnel(
    key: string,
    input: Contract.StartTunnelInput,
    signal?: AbortSignal,
  ): Promise<Contract.Tunnel> {
    this.assertOpen();
    const result = await this.ctx.remote.connections.startTunnel(key, input, this.signal(signal));
    if (!result.ok) throw result.error;
    return result.value;
  }
  async stopTunnel(id: string): Promise<void> {
    this.assertOpen();
    const result = await this.ctx.remote.connections.stopTunnel(id);
    if (!result.ok) throw result.error;
  }
  async listSerialPorts(): Promise<Contract.SerialPortInfo[]> {
    this.assertOpen();
    const result = await this.ctx.remote.connections.listSerialPorts();
    if (!result.ok) throw result.error;
    return result.value;
  }
  async createConnection(
    key: string,
    input: Contract.CreateConnectionInput,
  ): Promise<Contract.Connection> {
    this.assertOpen();
    const state = this.getSnapshot();
    if (state.status !== 'ready') throw new Error('CONNECTIONS_MODEL_NOT_READY');
    const request = structuredClone(input);
    const result = await this.ctx.remote.connections.createConnection(
      key,
      state.baseline.generation,
      request,
    );
    if (!result.ok) throw result.error;
    return result.value;
  }
  async getFtpConnectionCommandOutcome(
    generation: string,
    key: string,
  ): Promise<Contract.FtpConnectionCommandOutcome> {
    this.assertOpen();
    const result = await this.ctx.remote.connections.getFtpConnectionCommandOutcome(
      generation,
      key,
    );
    if (!result.ok) throw result.error;
    return result.value;
  }
  async createFtpConnection(
    key: string,
    input: Contract.CreateFtpConnectionInput,
    signal?: AbortSignal,
  ): Promise<Contract.FtpConnection> {
    this.assertOpen();
    const result = await this.ctx.remote.connections.createFtpConnection(
      key,
      input,
      this.signal(signal),
    );
    if (!result.ok) throw result.error;
    return result.value;
  }
  async listFtpConnections(): Promise<Contract.FtpConnection[]> {
    this.assertOpen();
    const result = await this.ctx.remote.connections.listFtpConnections();
    if (!result.ok) throw result.error;
    return result.value;
  }
  async getFtpConnection(id: string): Promise<Contract.FtpConnection> {
    this.assertOpen();
    const result = await this.ctx.remote.connections.getFtpConnection(id);
    if (!result.ok) throw result.error;
    return result.value;
  }
  async closeFtpConnection(id: string): Promise<void> {
    this.assertOpen();
    const result = await this.ctx.remote.connections.closeFtpConnection(id);
    if (!result.ok) throw result.error;
  }
  private signal(signal?: AbortSignal): AbortSignal {
    return signal ? AbortSignal.any([signal, this.lifetime.signal]) : this.lifetime.signal;
  }
  async getConnectionCommandOutcome(
    generation: string,
    key: string,
  ): Promise<Contract.ConnectionCommandOutcome> {
    this.assertOpen();
    const result = await this.ctx.remote.connections.getConnectionCommandOutcome(generation, key);
    if (!result.ok) throw result.error;
    return result.value;
  }
  async reconnectConnectionHistory(
    key: string,
    id: string,
    input: Contract.ReconnectConnectionHistoryInput,
    ifMatch: string | undefined,
  ): Promise<Contract.Connection> {
    this.assertOpen();
    const state = this.getSnapshot();
    if (state.status !== 'ready') throw new Error('CONNECTIONS_BASELINE_REQUIRED');
    const result = await this.ctx.remote.connections.reconnectConnectionHistory(
      key,
      state.baseline.generation,
      id,
      structuredClone(input),
      ifMatch,
    );
    if (!result.ok) throw result.error;
    return result.value;
  }
  async closeConnection(id: string, expectedGeneration?: string): Promise<void> {
    this.assertOpen();
    const state = this.getSnapshot();
    const generation =
      expectedGeneration ?? (state.status === 'ready' ? state.baseline.generation : undefined);
    if (!generation) throw new Error('CONNECTIONS_BASELINE_REQUIRED');
    const result = await this.ctx.remote.connections.closeConnection(generation, id);
    if (!result.ok) throw result.error;
  }
  async retryConnection(key: string, id: string): Promise<Contract.Connection> {
    this.assertOpen();
    const result = await this.ctx.remote.connections.retryConnection(key, id);
    if (!result.ok) throw result.error;
    return result.value;
  }
  async cancelReconnect(id: string): Promise<Contract.Connection> {
    this.assertOpen();
    const result = await this.ctx.remote.connections.cancelConnectionReconnect(id);
    if (!result.ok) throw result.error;
    return result.value;
  }
  async respondInteraction(
    id: string,
    input: Contract.ConnectionInteractionResponseInput,
  ): Promise<void> {
    this.assertOpen();
    const result = await this.ctx.remote.connections.respondInteraction(id, input);
    if (!result.ok) throw result.error;
  }
  async sshAgentStatus(input: Contract.SshAgentProbeInput): Promise<Contract.SshAgentStatus> {
    this.assertOpen();
    const result = await this.ctx.remote.connections.sshAgentStatus(input);
    if (!result.ok) throw result.error;
    return result.value;
  }
  async deleteKnownHostKey(
    key: string,
    id: string,
    ifMatch: string,
  ): Promise<Contract.ConnectionFactReceipt> {
    this.assertOpen();
    const state = this.state;
    if (state.status !== 'ready') throw Error('CONNECTIONS_NOT_READY');
    const result = await this.ctx.remote.connections.deleteKnownHostKey(
      key,
      state.baseline.generation,
      id,
      ifMatch,
    );
    if (!result.ok) throw result.error;
    return result.value;
  }
  async listKnownHostKeys(): Promise<Contract.KnownHostKey[]> {
    this.assertOpen();
    const result = await this.ctx.remote.connections.listKnownHostKeys();
    if (!result.ok) throw result.error;
    return result.value;
  }
  async testProxy(
    input: Contract.ProxyTestRequest,
    signal?: AbortSignal,
  ): Promise<Contract.ProxyTestResult> {
    this.assertOpen();
    const result = await this.ctx.remote.connections.testProxy(input, this.signal(signal));
    if (!result.ok) throw result.error;
    return result.value;
  }
  retry(): Promise<void> {
    this.assertOpen();
    return (this.retrying ??= (async () => {
      await this.stream.dispose();
      await this.done;
      if (!this.disposed) {
        this.stream = this.open();
        this.done = this.consume(this.stream);
      }
    })().finally(() => {
      this.retrying = undefined;
    }));
  }
  async dispose(): Promise<void> {
    this.disposed = true;
    this.lifetime.abort();
    await this.stream.dispose();
    await this.done;
    await this.retrying;
    this.listeners.clear();
  }
  private assertOpen(): void {
    if (this.disposed) throw new Error('CONNECTIONS_MODEL_CLOSED');
  }
  private open(): RemoteStream<Contract.ConnectionsUpdate> {
    return this.ctx.remote.$stream({
      name: 'connections.facts',
      open: (signal) => this.ctx.remote.connections.watchConnections(signal),
      ended: () => new RemoteStreamCarrierError('Connections generation ended'),
    });
  }
  private async consume(stream: RemoteStream<Contract.ConnectionsUpdate>): Promise<void> {
    const projection = new ConnectionsProjection();
    let generation = 0;
    try {
      for await (const item of stream) {
        if (generation !== item.generation) {
          generation = item.generation;
          projection.reset();
        }
        const baseline = projection.accept(item.value);
        if (baseline) {
          this.publish({ status: 'ready', baseline });
          item.accept();
        }
      }
    } catch {
      if (!this.disposed)
        this.publish({ status: 'error', message: 'Connection information is unavailable' });
    } finally {
      projection.reset();
    }
  }
  private publish(state: ConnectionsState): void {
    if (this.disposed) return;
    this.state = state;
    for (const listener of [...this.listeners]) {
      try {
        listener();
      } catch {
        console.warn('CONNECTIONS_MODEL_OBSERVER_FAILED');
      }
    }
  }
}
declare module '@deepseek-ai/cordis' {
  interface Context {
    connectionsModel: ConnectionsModel;
  }
}
export const inject = ['typert', 'remote', 'connection'];
export async function apply(ctx: Context): Promise<void> {
  const unmount = await ctx.remote.$mount(remote);
  ctx.effect(() => unmount);
  await ctx.inject(['remote.connections'], (scope) => {
    const model = new ConnectionsModel(scope);
    scope.provide('connectionsModel', model);
    scope.provide('connectionActions', {
      getFtpCommandOutcome: (generation, key) =>
        model.getFtpConnectionCommandOutcome(generation, key),
      createFtpConnection: (key, input, signal) => model.createFtpConnection(key, input, signal),
      listFtpConnections: () => model.listFtpConnections(),
      getFtpConnection: (id) => model.getFtpConnection(id),
      closeFtpConnection: (id) => model.closeFtpConnection(id),
      getSnapshot: model.getSnapshot,
      getCommandOutcome: (generation, key) => model.getConnectionCommandOutcome(generation, key),
      subscribe: model.subscribe,
      retry: () => model.retry(),
      create: (key, input) => model.createConnection(key, input),
      reconnectHistory: (key, id, input, ifMatch) =>
        model.reconnectConnectionHistory(key, id, input, ifMatch),
      close: (id) => model.closeConnection(id),
      retryConnection: (key, id) => model.retryConnection(key, id),
      cancelReconnect: (id) => model.cancelReconnect(id),
      listSerialPorts: () => model.listSerialPorts(),
      sshAgentStatus: (input) => model.sshAgentStatus(input),
      testProxy: (input, signal) => model.testProxy(input, signal),
      getTunnelCommandOutcome: (generation, key) => model.getTunnelCommandOutcome(generation, key),
      listTunnelProfiles: () => model.listTunnelProfiles(),
      createTunnelProfile: (key, input) => model.createTunnelProfile(key, input),
      updateTunnelProfile: (key, id, input, ifMatch) =>
        model.updateTunnelProfile(key, id, input, ifMatch),
      deleteTunnelProfile: (key, id, ifMatch) => model.deleteTunnelProfile(key, id, ifMatch),
      startTunnel: (key, input, signal) => model.startTunnel(key, input, signal),
      stopTunnel: (id) => model.stopTunnel(id),
    });
    scope.effect(() => () => model.dispose());
    scope.inject(['workspaceUi', 'slots', 'locale'], async (ui) => {
      const { installConnectionUi } = await import('./ui/index.tsx');
      if (ui.fiber.uid !== null) installConnectionUi(ui, model);
    });
  });
}
