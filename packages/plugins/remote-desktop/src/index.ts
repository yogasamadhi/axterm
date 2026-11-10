import { WebSessions } from './application/web-sessions.ts';
import { WebSessionObservation } from './application/web-observation.ts';
import { ProtocolAssets } from './adapters/protocol-assets.ts';
import { Remote, RemoteError, remoteErrorOf, TypertRemoteService } from '@axterm/plugin-api';
import type {} from '@axterm/plugin-api/host';
import type {} from '@axterm/infra-credentials';
import type { Context } from '@deepseek-ai/cordis';
import { ZodError, z } from 'zod';
import { encodeOpaqueCredentialRef } from '@axterm/infra-credentials';
import * as Contract from '@axterm/plugin-api/remote-desktop';
import { RemoteDesktopSessions, failure } from './application/sessions.ts';
import { RemoteDesktopObservation } from './application/observation.ts';
import { NodeRdpRelay } from './adapters/rdp-relay.ts';
import { BinaryRelay } from './adapters/binary-relay.ts';
import { RemoteDesktopBinaryStream } from './adapters/binary-stream.ts';
import { RuntimeCommands, RuntimeCommandError } from './adapters/runtime-commands.ts';
declare module '@deepseek-ai/cordis' {
  interface Context {
    remoteDesktopController: RemoteDesktopController;
  }
}
export class RemoteDesktopController extends TypertRemoteService {
  private readonly lifetime = new AbortController();
  private readonly protocolAssets: ProtocolAssets;
  private readonly commands: RuntimeCommands;
  private readonly observation: RemoteDesktopObservation;
  private readonly webCommands: RuntimeCommands<Contract.WebSession>;
  private webFollowers = 0;
  private readonly carriers = new Set<RemoteDesktopBinaryStream>();
  private closing?: Promise<void>;
  resourceSnapshot(): Readonly<Record<string, number>> {
    return Object.freeze({
      ...this.sessions.resourceSnapshot(),
      webSessions: this.webSessions.resourceCount(),
      webSessionFollowers: this.webFollowers,
    });
  }
  constructor(
    ctx: Context,
    private readonly sessions: RemoteDesktopSessions,
    private readonly webSessions = new WebSessions(ctx.catalog, ctx.get('nativeWebViews')),
  ) {
    super(ctx, 'remoteDesktopController', { namespace: 'remoteDesktop' });
    this.protocolAssets = new ProtocolAssets(ctx);
    this.webCommands = new RuntimeCommands((id) => this.webSessions.get(id));
    this.commands = new RuntimeCommands((id) => sessions.get(id));
    this.observation = new RemoteDesktopObservation(sessions, ctx.runtimeIdentity.generation);
    ctx.inject(['webServer', 'connection', 'remoteAccess'], (web) => {
      const carrier = new RemoteDesktopBinaryStream(web, sessions);
      this.carriers.add(carrier);
      web.effect(() => async () => {
        await carrier.dispose();
        this.carriers.delete(carrier);
      });
    });
    ctx.effect(() => () => this.close());
    ctx.desktopTaskInspection.register('remote-desktop', {
      inspect: (signal) => {
        signal.throwIfAborted();
        return { active: sessions.resourceCount() > 0 || this.webSessions.resourceCount() > 0 };
      },
      dispose: () => this.close(),
    });
  }
  @Remote({
    resources: {
      bookmark: (_key: string, input: Contract.CreateRemoteDesktopSession) => input.bookmarkId,
    },
  })
  async createSession(
    key: string,
    input: Contract.CreateRemoteDesktopSession,
    generation: string,
    signal: AbortSignal,
  ): Promise<Contract.RemoteDesktopSession> {
    if (generation !== this.ctx.runtimeIdentity.generation)
      return Promise.reject(failure('conflict'));
    return this.run(() =>
      this.commands.execute(
        key,
        'create',
        Contract.createRemoteDesktopSessionSchema.parse(input),
        () =>
          this.sessions.create(
            input,
            AbortSignal.any([this.lifetime.signal, ...(signal ? [signal] : [])]),
            (id) => this.commands.bindResource(key, id),
          ),
      ),
    );
  }
  @Remote({
    resources: { bookmark: (_key: string, input: Contract.CreateWebSession) => input.bookmarkId },
  })
  async createWebSession(
    key: string,
    input: Contract.CreateWebSession,
    generation: string,
    signal: AbortSignal,
  ): Promise<Contract.WebSession> {
    this.checkGeneration(generation);
    const request = Contract.createWebSessionSchema.parse(input);
    return this.run(() =>
      this.webCommands.execute(key, 'create', request, () =>
        this.webSessions.create(request, AbortSignal.any([signal, this.lifetime.signal]), (id) =>
          this.webCommands.bindResource(key, id),
        ),
      ),
    );
  }
  @Remote getWebCommandOutcome(
    generation: string,
    key: string,
  ): Contract.RemoteDesktopCommandOutcome {
    this.checkGeneration(generation);
    return this.runOutcome(() => this.webCommands.outcome(z.uuid().parse(key)));
  }
  @Remote async listWebSessions(windowId: string): Promise<Contract.WebSession[]> {
    return this.run(() => this.webSessions.list(z.uuid().parse(windowId)));
  }
  @Remote async getWebSession(id: string, windowId: string): Promise<Contract.WebSession> {
    return this.run(() => this.webSessions.get(z.uuid().parse(id), z.uuid().parse(windowId)));
  }
  @Remote async presentWebSession(
    id: string,
    windowId: string,
    input: Contract.NativeWebViewPresentation,
    generation: string,
    signal: AbortSignal,
  ): Promise<Contract.WebSession> {
    this.checkGeneration(generation);
    return this.run(() =>
      this.webSessions.present(
        z.uuid().parse(id),
        z.uuid().parse(windowId),
        Contract.nativeWebViewPresentationSchema.parse(input),
        signal,
      ),
    );
  }
  @Remote async performWebSessionAction(
    id: string,
    windowId: string,
    input: Contract.NativeWebViewAction,
    generation: string,
    signal: AbortSignal,
  ): Promise<Contract.WebSession> {
    this.checkGeneration(generation);
    return this.run(() =>
      this.webSessions.perform(
        z.uuid().parse(id),
        z.uuid().parse(windowId),
        Contract.nativeWebViewActionSchema.parse(input),
        signal,
      ),
    );
  }
  @Remote async answerWebSessionAuthentication(
    id: string,
    windowId: string,
    input: Contract.NativeWebViewAuthResponse,
    generation: string,
    signal: AbortSignal,
  ): Promise<Contract.WebSession> {
    this.checkGeneration(generation);
    return this.run(() =>
      this.webSessions.authenticate(
        z.uuid().parse(id),
        z.uuid().parse(windowId),
        Contract.nativeWebViewAuthResponseSchema.parse(input),
        signal,
      ),
    );
  }
  @Remote async closeWebSession(
    id: string,
    windowId: string,
    generation: string,
  ): Promise<{ closed: true }> {
    this.checkGeneration(generation);
    return this.run(async () => {
      await this.webSessions.closeSession(z.uuid().parse(id), z.uuid().parse(windowId));
      return { closed: true };
    });
  }
  @Remote({ mode: 'stream' }) async *watchWebSessions(
    windowId: string,
    signal: AbortSignal,
  ): AsyncIterable<Contract.WebSessionUpdate> {
    if (this.lifetime.signal.aborted) throw failure('closed');
    if (this.webFollowers >= 64) throw failure('capacity');
    const observation = new WebSessionObservation(
      this.webSessions,
      z.uuid().parse(windowId),
      this.ctx.runtimeIdentity.generation,
    );
    this.webFollowers++;
    try {
      yield* observation.watch(AbortSignal.any([signal, this.lifetime.signal]));
    } finally {
      this.webFollowers--;
      observation.dispose();
    }
  }
  private checkGeneration(generation: string): void {
    if (generation !== this.ctx.runtimeIdentity.generation) throw failure('conflict');
  }
  @Remote getProtocolAssets(): Contract.RemoteDesktopProtocolAssets {
    if (this.lifetime.signal.aborted) throw failure('closed');
    return this.protocolAssets.descriptor;
  }
  @Remote getCommandOutcome(generation: string, key: string): Contract.RemoteDesktopCommandOutcome {
    if (generation !== this.ctx.runtimeIdentity.generation) throw failure('conflict');
    return this.runOutcome(() => this.commands.outcome(z.uuid().parse(key)));
  }
  private runOutcome<T>(read: () => T): T {
    if (this.lifetime.signal.aborted) throw failure('closed');
    try {
      return read();
    } catch (error) {
      if (error instanceof RuntimeCommandError) throw failure(error.reason);
      if (error instanceof ZodError) throw failure('invalid-input');
      throw failure('unavailable');
    }
  }
  @Remote async listSessions(): Promise<Contract.RemoteDesktopSession[]> {
    return this.run(() => this.sessions.list());
  }
  @Remote({ resources: { remoteDesktopSession: (id: string) => id } })
  async getSession(id: string): Promise<Contract.RemoteDesktopSession> {
    return this.run(() => this.sessions.get(z.uuid().parse(id)));
  }
  @Remote({ resources: { remoteDesktopSession: (id: string) => id } })
  async resizeSession(
    id: string,
    width: number,
    height: number,
  ): Promise<Contract.RemoteDesktopSession> {
    return this.run(() => this.sessions.resize(z.uuid().parse(id), width, height));
  }
  @Remote({ resources: { remoteDesktopSession: (id: string) => id } })
  async closeSession(id: string, generation: string): Promise<{ closed: true }> {
    if (generation !== this.ctx.runtimeIdentity.generation)
      return Promise.reject(failure('conflict'));
    return this.run(async () => {
      await this.sessions.closeSession(z.uuid().parse(id));
      return { closed: true as const };
    });
  }
  @Remote({ mode: 'stream' }) watchSessions(
    signal: AbortSignal,
  ): AsyncIterable<Contract.RemoteDesktopUpdate> {
    if (this.lifetime.signal.aborted) throw failure('closed');
    return this.observation.watch(AbortSignal.any([signal, this.lifetime.signal]));
  }
  close(): Promise<void> {
    return (this.closing ??= (async () => {
      this.lifetime.abort();
      this.commands.stop();
      this.webCommands.stop();
      this.observation.dispose();
      for (const carrier of this.carriers) carrier.stopAdmission();
      await Promise.all([this.sessions.close(), this.webSessions.close()]);
      await Promise.all([this.commands.dispose(), this.webCommands.dispose()]);
      await Promise.all([...this.carriers].map((carrier) => carrier.dispose()));
    })());
  }
  private async run<T>(operation: () => T | Promise<T>): Promise<T> {
    if (this.lifetime.signal.aborted) throw failure('closed');
    try {
      return await operation();
    } catch (error) {
      const remote = remoteErrorOf(error);
      if (remote?.code === 'remoteDesktop/failure') throw remote;
      if (error instanceof RuntimeCommandError) throw failure(error.reason);
      if (error instanceof ZodError) throw failure('invalid-input');
      throw failure('unavailable');
    }
  }
}
export const inject = [
  'runtimeIdentity',
  'catalog',
  'connections',
  'credentials',
  'desktopTaskInspection',
];
export function apply(ctx: Context): void {
  const sessions = new RemoteDesktopSessions(
    {
      catalog: ctx.catalog,
      credential: async (ref, signal) => {
        signal.throwIfAborted();
        const result = await ctx.credentials.resolve(encodeOpaqueCredentialRef(ref));
        signal.throwIfAborted();
        if (!result)
          throw new RemoteError('remoteDesktop/failure', 'The saved credential is unavailable', {
            reason: 'unavailable',
          });
        return result.value;
      },
      openStream: (input, signal) => ctx.connections.openStream(input, signal),
    },
    { rdp: new NodeRdpRelay(), vnc: new BinaryRelay('VNC'), spice: new BinaryRelay('SPICE') },
  );
  ctx.effect(() => () => sessions.close());
  new RemoteDesktopController(ctx, sessions);
}
