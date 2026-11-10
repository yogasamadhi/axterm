import type {} from '@axterm/ui/shortcuts';
import { TerminalAssetsModel } from './assets.ts';
import type { Context } from '@deepseek-ai/cordis';
import type {
  CreateTerminalInput,
  TerminalBaseline,
  TerminalDelta,
  TerminalSession,
  TerminalCommandOutcome,
  TerminalTransferAction,
  StartTerminalRecordingInput,
  TerminalRecording,
} from '@axterm/plugin-api/terminals';
import { RemoteSnapshotStream, RemoteStreamCarrierError } from '@axterm/infra-gateway/client';
import remote from '@axterm/plugin-terminals/remote';
export { TerminalStream, type TerminalStreamOptions, type TerminalStreamIssue } from './stream.ts';
export type { TerminalOutputMetrics } from './terminal-output-consumer.ts';
export type TerminalsState =
  | { readonly status: 'connecting' }
  | { readonly status: 'ready'; readonly baseline: TerminalBaseline }
  | { readonly status: 'error'; readonly message: string };
function freezeSession(session: TerminalSession): TerminalSession {
  Object.freeze(session.appearance);
  Object.freeze(session.behavior);
  if (session.recording) Object.freeze(session.recording);
  if (session.transfer) Object.freeze(session.transfer);
  return Object.freeze(session);
}
/** A metadata projection and commands. Byte channels are separately owned by their renderer. */
export class TerminalsModel {
  private snapshot: TerminalsState = { status: 'connecting' };
  private readonly listeners = new Set<() => void>();
  private stream: RemoteSnapshotStream<TerminalBaseline, TerminalDelta>;
  private disposed = false;
  private retrying: Promise<void> | undefined;
  constructor(private readonly ctx: Context) {
    this.stream = this.open();
  }
  getSnapshot = (): TerminalsState => this.snapshot;
  subscribe = (listener: () => void): (() => void) => {
    if (this.disposed) throw new Error('TERMINALS_MODEL_CLOSED');
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  async create(
    input: CreateTerminalInput,
    key: string = crypto.randomUUID(),
  ): Promise<TerminalSession> {
    this.assertOpen();
    const state = this.getSnapshot();
    if (state.status !== 'ready') throw new Error('TERMINALS_MODEL_NOT_READY');
    const request = structuredClone(input);
    const result = await this.ctx.remote.terminals.createTerminal(
      state.baseline.generation,
      key,
      request,
    );
    if (!result.ok) throw result.error;
    return result.value;
  }
  async getCommandOutcome(generation: string, key: string): Promise<TerminalCommandOutcome> {
    this.assertOpen();
    const result = await this.ctx.remote.terminals.getTerminalCommandOutcome(generation, key);
    if (!result.ok) throw result.error;
    return result.value;
  }
  async startRecording(
    generation: string,
    key: string,
    id: string,
    input: StartTerminalRecordingInput,
  ): Promise<TerminalRecording> {
    this.assertOpen();
    const state = this.getSnapshot();
    if (state.status !== 'ready' || state.baseline.generation !== generation)
      throw Error('TERMINALS_MODEL_RETIRED');
    const result = await this.ctx.remote.terminals.startTerminalRecording(
      generation,
      key,
      id,
      structuredClone(input),
    );
    if (!result.ok) throw result.error;
    return result.value;
  }
  async stopRecording(generation: string, key: string, id: string): Promise<TerminalRecording> {
    this.assertOpen();
    const state = this.getSnapshot();
    if (state.status !== 'ready' || state.baseline.generation !== generation)
      throw Error('TERMINALS_MODEL_RETIRED');
    const result = await this.ctx.remote.terminals.stopTerminalRecording(generation, key, id);
    if (!result.ok) throw result.error;
    return result.value;
  }
  async getRecordingOutcome(generation: string, key: string): Promise<TerminalCommandOutcome> {
    this.assertOpen();
    const result = await this.ctx.remote.terminals.getTerminalRecordingOutcome(generation, key);
    if (!result.ok) throw result.error;
    return result.value;
  }
  async disconnect(key: string, id: string, generation: string): Promise<TerminalSession> {
    this.assertOpen();
    const state = this.getSnapshot();
    if (state.status !== 'ready' || state.baseline.generation !== generation)
      throw Error('TERMINALS_MODEL_RETIRED');
    const result = await this.ctx.remote.terminals.disconnectTerminal(generation, key, id);
    if (!result.ok) throw result.error;
    return result.value;
  }
  async close(id: string, expectedGeneration?: string): Promise<void> {
    this.assertOpen();
    const state = this.getSnapshot();
    const generation =
      expectedGeneration ?? (state.status === 'ready' ? state.baseline.generation : undefined);
    if (!generation) throw new Error('TERMINALS_MODEL_NOT_READY');
    const result = await this.ctx.remote.terminals.closeTerminal(generation, id);
    if (!result.ok) throw result.error;
  }
  async performTransfer(
    key: string,
    id: string,
    input: TerminalTransferAction,
    signal: AbortSignal,
  ) {
    this.assertOpen();
    const state = this.getSnapshot();
    if (state.status !== 'ready') throw Error('TERMINALS_MODEL_NOT_READY');
    const result = await this.ctx.remote.terminals.performTerminalTransfer(
      state.baseline.generation,
      key,
      id,
      input,
      signal,
    );
    if (!result.ok) throw result.error;
    return result.value;
  }
  async reviewTransferRecovery(grantId: string, signal: AbortSignal) {
    this.assertOpen();
    const state = this.getSnapshot();
    if (state.status !== 'ready') throw Error('TERMINALS_MODEL_NOT_READY');
    const result = await this.ctx.remote.terminals.reviewTerminalTransferRecovery(
      state.baseline.generation,
      grantId,
      signal,
    );
    if (!result.ok) throw result.error;
    return result.value;
  }
  async changeTransferRecovery(
    key: string,
    id: string,
    grantId: string,
    action: 'remove' | 'forget',
    signal: AbortSignal,
  ) {
    this.assertOpen();
    const state = this.getSnapshot();
    if (state.status !== 'ready') throw Error('TERMINALS_MODEL_NOT_READY');
    const result =
      action === 'remove'
        ? await this.ctx.remote.terminals.removeTerminalTransferStage(
            state.baseline.generation,
            key,
            id,
            grantId,
            signal,
          )
        : await this.ctx.remote.terminals.forgetTerminalTransferStage(
            state.baseline.generation,
            key,
            id,
            grantId,
            true,
            signal,
          );
    if (!result.ok) throw result.error;
    return result.value;
  }
  retry(): Promise<void> {
    this.assertOpen();
    return (this.retrying ??= (async () => {
      await this.stream.dispose();
      if (!this.disposed) {
        this.publish({ status: 'connecting' });
        this.stream = this.open();
      }
    })().finally(() => {
      this.retrying = undefined;
    }));
  }
  async dispose(): Promise<void> {
    this.disposed = true;
    await this.stream.dispose();
    await this.retrying;
    this.listeners.clear();
  }
  private assertOpen(): void {
    if (this.disposed) throw new Error('TERMINALS_MODEL_CLOSED');
  }
  private open(): RemoteSnapshotStream<TerminalBaseline, TerminalDelta> {
    const stream = new RemoteSnapshotStream<TerminalBaseline, TerminalDelta>(
      this.ctx.remote.$stream({
        name: 'terminals.metadata',
        open: (signal) => this.ctx.remote.terminals.watchTerminals(signal),
        ended: () => new RemoteStreamCarrierError('Terminal metadata generation ended'),
      }),
      {
        name: 'terminals.metadata',
        isSnapshot: (value): value is TerminalBaseline => value.type === 'baseline',
        replace: (baseline) =>
          this.publish({
            status: 'ready',
            baseline: Object.freeze({
              ...baseline,
              sessions: Object.freeze(baseline.sessions.map(freezeSession)),
            }),
          }),
        update: (delta) => {
          const current = this.snapshot;
          if (current.status !== 'ready' || delta.revision !== current.baseline.revision + 1)
            throw new Error('TERMINALS_METADATA_REVISION_INVALID');
          const sessions =
            delta.type === 'remove'
              ? current.baseline.sessions.filter((session) => session.id !== delta.id)
              : current.baseline.sessions.some((session) => session.id === delta.session.id)
                ? current.baseline.sessions.map((session) =>
                    session.id === delta.session.id ? freezeSession(delta.session) : session,
                  )
                : [...current.baseline.sessions, freezeSession(delta.session)];
          this.publish({
            status: 'ready',
            baseline: Object.freeze({
              ...current.baseline,
              revision: delta.revision,
              sessions: Object.freeze(sessions),
            }),
          });
        },
        failed: () =>
          this.publish({ status: 'error', message: 'Terminal information is unavailable' }),
      },
    );
    stream.start();
    return stream;
  }
  private publish(value: TerminalsState): void {
    if (this.disposed) return;
    this.snapshot = value;
    for (const listener of [...this.listeners]) {
      try {
        listener();
      } catch {
        console.warn('TERMINALS_MODEL_OBSERVER_FAILED');
      }
    }
  }
}
declare module '@deepseek-ai/cordis' {
  interface Context {
    terminalsModel: TerminalsModel;
  }
}
export const inject = ['typert', 'remote', 'connection'];
export async function apply(ctx: Context): Promise<void> {
  const unmount = await ctx.remote.$mount(remote);
  ctx.effect(() => unmount);
  await ctx.inject(['remote.terminals'], (scope) => {
    const model = new TerminalsModel(scope);
    scope.provide('terminalsModel', model);
    scope.provide('terminalSessionsView', {
      getSnapshot: model.getSnapshot,
      subscribe: model.subscribe,
      retry: () => model.retry(),
    });
    scope.inject(
      [
        'workspaceUi',
        'shortcuts',
        'slots',
        'connection',
        'locale',
        'configurationActions',
        'terminalFactsModel',
        'terminalAssetsModel',
        'desktopUi',
        'connectionActions',
        'fileGrantActions',
      ],
      async (ui) => {
        const { installTerminalUi } = await import('./ui.tsx');
        installTerminalUi(ui, model);
      },
    );
    scope.inject(
      ['workspaceUi', 'slots', 'locale', 'fileGrantActions', 'terminalViewUi'],
      async (ui) => {
        const { installTerminalTransferUi } = await import('./transfer-ui.tsx');
        if (ui.fiber.uid !== null) installTerminalTransferUi(ui, model);
      },
    );
    scope.effect(() => () => model.dispose());
    const assets = new TerminalAssetsModel(scope);
    scope.provide('terminalAssetsModel', assets);
    scope.effect(() => () => assets.dispose());
    const facts = new TerminalFactsModel(scope);
    scope.provide('terminalFactsModel', facts);
    scope.inject(['workspaceUi', 'slots', 'locale'], async (ui) => {
      const { installTerminalProfilesUi } = await import('./profiles/index.tsx');
      installTerminalProfilesUi(ui, facts);
      const { installTerminalHistoryUi } = await import('./history/index.tsx');
      if (ui.fiber.uid !== null) installTerminalHistoryUi(ui, facts);
    });
    scope.inject(
      [
        'workspaceUi',
        'slots',
        'locale',
        'configurationActions',
        'terminalVisualUi',
        'fileGrantActions',
      ],
      async (ui) => {
        const { installTerminalThemesUi } = await import('./themes/index.tsx');
        if (ui.fiber.uid !== null) installTerminalThemesUi(ui, facts, assets);
      },
    );
    scope.provide('terminalFactsView', {
      getSnapshot: facts.getSnapshot,
      subscribe: facts.subscribe,
      retry: () => facts.retry(),
    });
    scope.effect(() => () => facts.dispose());
  });
}
import { TerminalFactsModel } from './facts.ts';
export { TerminalFactsModel };
export type { TerminalFactsState } from './facts.ts';
