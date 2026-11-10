import { AiDraftService } from './draft-service.ts';
import type { Context } from '@deepseek-ai/cordis';
import type { RemoteResult } from '@axterm/plugin-api';
import type * as Contract from '@axterm/plugin-api/ai';
import { RemoteStreamCarrierError, type RemoteStream } from '@axterm/infra-gateway/client';
import remote from '@axterm/plugin-ai/remote';
import { AiProjection } from './projection.ts';
import { AiRunModel } from './run-model.ts';
export { AiRunModel } from './run-model.ts';
export type { AiRunState } from './run-model.ts';
export type AiState =
  | { readonly status: 'connecting' }
  | {
      readonly status: 'ready';
      readonly baseline: Contract.AiBaseline;
      readonly detailRevision: number;
    }
  | { readonly status: 'error'; readonly message: string };
/** Business facts are owned here. Reconnect replaces metadata; accepted commands are never replayed. */
export class AiModel {
  private state: AiState = { status: 'connecting' };
  private readonly lifetime = new AbortController();
  private readonly listeners = new Set<() => void>();
  private readonly pending = new Set<Promise<unknown>>();
  private readonly providers = new Map<string, Contract.AiProvider>();
  private readonly runs = new Set<AiRunModel>();
  private openingRuns = 0;
  private stream: RemoteStream<Contract.AiUpdate>;
  private done: Promise<void>;
  private closing = false;
  private disposed = false;
  private closePromise: Promise<void> | undefined;
  private retrying: Promise<void> | undefined;
  private waiters = 0;
  constructor(private readonly ctx: Context) {
    this.stream = this.open();
    this.done = this.consume(this.stream);
  }
  getSnapshot = (): AiState => this.state;
  subscribe = (listener: () => void): (() => void) => {
    this.assertOpen();
    if (this.listeners.size >= 256) throw new Error('AI_MODEL_OBSERVER_CAPACITY');
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  createProvider(key: string, input: Contract.AiProviderInput) {
    const generation = this.generation();
    const snapshot = structuredClone(input);
    return this.fact(generation, () =>
      this.ctx.remote.ai.createProvider(key, generation, snapshot),
    );
  }
  updateProvider(
    key: string,
    id: string,
    input: Contract.AiProviderPatch,
    ifMatch: string | undefined,
  ) {
    const generation = this.generation();
    const snapshot = structuredClone(input);
    return this.fact(generation, () =>
      this.ctx.remote.ai.updateProvider(key, generation, id, snapshot, ifMatch),
    );
  }
  deleteProvider(key: string, id: string, ifMatch: string | undefined) {
    const generation = this.generation();
    return this.fact(generation, () =>
      this.ctx.remote.ai.deleteProvider(key, generation, id, ifMatch),
    );
  }
  createModel(key: string, input: Contract.AiModelInput) {
    const generation = this.generation();
    const snapshot = structuredClone(input);
    return this.fact(generation, () => this.ctx.remote.ai.createModel(key, generation, snapshot));
  }
  updateModel(key: string, id: string, input: Contract.AiModelPatch, ifMatch: string | undefined) {
    const generation = this.generation();
    const snapshot = structuredClone(input);
    return this.fact(generation, () =>
      this.ctx.remote.ai.updateModel(key, generation, id, snapshot, ifMatch),
    );
  }
  deleteModel(key: string, id: string, ifMatch: string | undefined) {
    const generation = this.generation();
    return this.fact(generation, () =>
      this.ctx.remote.ai.deleteModel(key, generation, id, ifMatch),
    );
  }
  createConversation(key: string, input: Contract.AiConversationInput) {
    const generation = this.generation();
    const snapshot = structuredClone(input);
    return this.fact(generation, () =>
      this.ctx.remote.ai.createConversation(key, generation, snapshot),
    );
  }
  updateConversation(
    key: string,
    id: string,
    input: Contract.AiConversationPatch,
    ifMatch: string | undefined,
  ) {
    const generation = this.generation();
    const snapshot = structuredClone(input);
    return this.fact(generation, () =>
      this.ctx.remote.ai.updateConversation(key, generation, id, snapshot, ifMatch),
    );
  }
  deleteConversation(key: string, id: string, ifMatch: string | undefined) {
    const generation = this.generation();
    return this.fact(generation, () =>
      this.ctx.remote.ai.deleteConversation(key, generation, id, ifMatch),
    );
  }
  drainRun(id: string, expectedGeneration: string): Promise<void> {
    return this.invoke(() => this.ctx.remote.ai.drainRun(expectedGeneration, id));
  }
  cancelRun(key: string, id: string, expectedGeneration?: string) {
    const generation = expectedGeneration ?? this.generation();
    return this.fact(generation, () => this.ctx.remote.ai.cancelRun(key, generation, id));
  }
  getRunCommandOutcome(generation: string, key: string): Promise<Contract.AiRunCommandOutcome> {
    return this.invoke(() => this.ctx.remote.ai.getRunCommandOutcome(generation, key));
  }
  startRun(
    key: string,
    input: Contract.AiRequestInput,
    signal?: AbortSignal,
  ): Promise<Contract.AiRun> {
    const generation = this.generation();
    const snapshot = structuredClone(input);
    return this.invoke(() =>
      this.ctx.remote.ai.startRun(key, generation, snapshot, this.signal(signal)),
    );
  }
  decideApproval(
    key: string,
    id: string,
    input: { decision: 'approve_once' | 'reject'; argsHash: string },
  ): Promise<Contract.AiRun> {
    const generation = this.generation();
    const snapshot = { ...input };
    return this.invoke(() => this.ctx.remote.ai.decideApproval(key, generation, id, snapshot));
  }
  previewContext(
    input: Contract.AiContextPreviewInput,
    signal?: AbortSignal,
  ): Promise<Contract.AiContextPreview> {
    this.generation();
    const snapshot = structuredClone(input);
    return this.invoke(() => this.ctx.remote.ai.previewContext(snapshot, this.signal(signal)));
  }
  prepareAttachment(grantId: string, signal?: AbortSignal): Promise<Contract.AiAttachmentPreview> {
    this.generation();
    return this.invoke(() => this.ctx.remote.ai.prepareAttachment(grantId, this.signal(signal)));
  }
  discardAttachment(id: string): Promise<void> {
    return this.invoke(() => this.ctx.remote.ai.discardAttachment(id));
  }
  testProvider(id: string, signal?: AbortSignal): Promise<Contract.AiProviderTestResult> {
    return this.invoke(() => this.ctx.remote.ai.testProvider(id, this.signal(signal)));
  }
  workspace(id: string): Promise<Contract.AiWorkspace> {
    return this.invoke(() => this.ctx.remote.ai.getWorkspace(id));
  }
  skills(): Promise<Contract.AiSkill[]> {
    return this.invoke(() => this.ctx.remote.ai.getSkills());
  }
  catalog(): Promise<Contract.PiCatalogProvider[]> {
    return this.invoke(() => this.ctx.remote.ai.getCatalog());
  }
  getConversation(id: string): Promise<Contract.AiConversation> {
    return this.invoke(() => this.ctx.remote.ai.getConversation(id));
  }
  getRun(id: string): Promise<Contract.AiRun> {
    return this.invoke(() => this.ctx.remote.ai.getRun(id));
  }
  getToolCall(id: string): Promise<Contract.AiToolCall> {
    return this.invoke(() => this.ctx.remote.ai.getToolCall(id));
  }
  openRun(id: string): Promise<AiRunModel> {
    const generation = this.generation();
    if (this.runs.size + this.openingRuns >= 8) throw new Error('AI_RUN_MODEL_CAPACITY');
    if (this.pending.size >= 32) throw new Error('AI_MODEL_COMMAND_CAPACITY');
    this.openingRuns++;
    return this.track(async () => {
      const run = await this.value(this.ctx.remote.ai.getRun(id));
      if (generation !== this.generation()) throw new Error('AI_MODEL_GENERATION_CHANGED');
      const model = new AiRunModel(this.ctx, run, generation, () => this.runs.delete(model));
      this.runs.add(model);
      return model;
    }).finally(() => {
      this.openingRuns--;
    });
  }
  getMessageWindow(
    id: string,
    query: Contract.AiMessageWindowQuery,
  ): Promise<Contract.AiMessageWindow> {
    const snapshot = { ...query };
    return this.invoke(() => this.ctx.remote.ai.getMessageWindow(id, snapshot));
  }
  getMessages(id: string, query: Contract.AiPageQuery): Promise<Contract.AiMessagePage> {
    const snapshot = { ...query };
    return this.invoke(() => this.ctx.remote.ai.getMessages(id, snapshot));
  }
  getTools(id: string, query: Contract.AiPageQuery): Promise<Contract.AiToolPage> {
    const snapshot = { ...query };
    return this.invoke(() => this.ctx.remote.ai.getTools(id, snapshot));
  }
  getLog(id: string, query: Contract.AiPageQuery): Promise<Contract.AiLogPage> {
    const snapshot = { ...query };
    return this.invoke(() => this.ctx.remote.ai.getLog(id, snapshot));
  }
  cachedProvider(id: string): Contract.AiProvider | undefined {
    return this.providers.get(id);
  }
  readProvider(id: string): Promise<Contract.AiProvider> {
    const generation = this.generation();
    return this.track(async () => {
      const value = await this.value(this.ctx.remote.ai.getProvider(id));
      if (generation !== this.generation()) throw new Error('AI_MODEL_GENERATION_CHANGED');
      this.providers.delete(id);
      this.providers.set(id, freeze(value));
      while (this.providers.size > 16) this.providers.delete(this.providers.keys().next().value!);
      if (this.state.status === 'ready')
        this.publish({ ...this.state, detailRevision: this.state.detailRevision + 1 });
      return value;
    });
  }
  retry(): Promise<void> {
    this.assertOpen();
    return (this.retrying ??= (async () => {
      await this.stream.dispose();
      await this.done;
      if (!this.closing) {
        this.stream = this.open();
        this.done = this.consume(this.stream);
      }
    })().finally(() => {
      this.retrying = undefined;
    }));
  }
  dispose(): Promise<void> {
    return (this.closePromise ??= this.close());
  }
  private async close(): Promise<void> {
    this.closing = true;
    this.lifetime.abort();
    await Promise.allSettled([...this.pending]);
    await Promise.all([...this.runs].map((run) => run.dispose()));
    await this.stream.dispose();
    await this.done;
    await this.retrying;
    this.providers.clear();
    this.listeners.clear();
    this.disposed = true;
  }
  private signal(signal?: AbortSignal): AbortSignal {
    return AbortSignal.any([this.lifetime.signal, ...(signal ? [signal] : [])]);
  }
  private generation(): string {
    this.assertOpen();
    if (this.state.status !== 'ready') throw new Error('AI_MODEL_NOT_READY');
    return this.state.baseline.generation;
  }
  private assertOpen(): void {
    if (this.closing || this.disposed) throw new Error('AI_MODEL_CLOSED');
  }
  private invoke<T>(apply: () => Promise<RemoteResult<T>>): Promise<T> {
    return this.track(async () => this.value(await apply()));
  }
  private async value<T>(result: RemoteResult<T> | Promise<RemoteResult<T>>): Promise<T> {
    const resolved = await result;
    if (!resolved.ok) throw resolved.error;
    return resolved.value;
  }
  private track<T>(apply: () => Promise<T>): Promise<T> {
    this.assertOpen();
    if (this.pending.size >= 32) throw new Error('AI_MODEL_COMMAND_CAPACITY');
    const task = Promise.resolve().then(() => {
      this.assertOpen();
      return apply();
    });
    this.pending.add(task);
    void task.then(
      () => this.pending.delete(task),
      () => this.pending.delete(task),
    );
    return task;
  }
  private fact(
    generation: string,
    apply: () => Promise<RemoteResult<Contract.AiReceipt>>,
  ): Promise<Contract.AiReceipt> {
    return this.track(async () => {
      const receipt = await this.value(apply());
      await this.observed(receipt.cursor, generation);
      return receipt;
    });
  }
  private observed(cursor: number, generation: string): Promise<void> {
    this.assertOpen();
    if (this.waiters >= 32) return Promise.reject(new Error('AI_MODEL_WAITER_CAPACITY'));
    this.waiters++;
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      let off = () => {};
      let timer: ReturnType<typeof setTimeout> | undefined;
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        off();
        this.lifetime.signal.removeEventListener('abort', abort);
        this.waiters--;
        if (error) reject(error);
        else resolve();
      };
      const check = () => {
        if (this.state.status === 'ready') {
          if (this.state.baseline.generation !== generation)
            finish(new Error('AI_MODEL_GENERATION_CHANGED'));
          else if (this.state.baseline.cursor >= cursor) finish();
        }
      };
      const abort = () => finish(new Error('AI_MODEL_CLOSED'));
      try {
        off = this.subscribe(check);
        timer = setTimeout(() => finish(new Error('AI_MODEL_FACTS_UNAVAILABLE')), 10000);
        this.lifetime.signal.addEventListener('abort', abort, { once: true });
        if (this.lifetime.signal.aborted) abort();
        else check();
      } catch (error) {
        finish(error instanceof Error ? error : new Error('AI_MODEL_FACTS_UNAVAILABLE'));
      }
    });
  }
  private open(): RemoteStream<Contract.AiUpdate> {
    return this.ctx.remote.$stream({
      name: 'ai.facts',
      open: (signal) => this.ctx.remote.ai.watchAi(signal),
      ended: () => new RemoteStreamCarrierError('AI generation ended'),
    });
  }
  private async consume(stream: RemoteStream<Contract.AiUpdate>): Promise<void> {
    const projection = new AiProjection();
    let generation = 0;
    try {
      for await (const item of stream) {
        if (generation !== item.generation) {
          generation = item.generation;
          projection.reset();
          this.providers.clear();
          this.publish({ status: 'connecting' });
        }
        const baseline = projection.accept(item.value);
        if (baseline) {
          for (const run of this.runs)
            if (run.generation !== baseline.generation) void run.dispose().catch(() => {});
          for (const [id, value] of this.providers)
            if (
              !baseline.providers.some(
                (provider) => provider.id === id && provider.version === value.version,
              )
            )
              this.providers.delete(id);
          this.publish({ status: 'ready', baseline, detailRevision: 0 });
          item.accept();
        }
      }
    } catch {
      if (!this.closing)
        this.publish({ status: 'error', message: 'AI information is unavailable' });
    } finally {
      projection.reset();
    }
  }
  private publish(state: AiState): void {
    if (this.closing || this.disposed) return;
    this.state = state;
    for (const listener of [...this.listeners])
      try {
        listener();
      } catch {
        console.warn('AI_MODEL_OBSERVER_FAILED');
      }
  }
}
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
declare module '@deepseek-ai/cordis' {
  interface Context {
    aiModel: AiModel;
  }
}
export const inject = ['typert', 'remote', 'connection'];
export async function apply(ctx: Context): Promise<void> {
  const unmount = await ctx.remote.$mount(remote);
  ctx.effect(() => unmount);
  await ctx.inject(['remote.ai'], (scope) => {
    const model = new AiModel(scope);
    scope.provide('aiModel', model);
    scope.effect(() => () => model.dispose());
    const themes = new AiDraftService(model);
    scope.provide('aiThemeUi', themes);
    scope.provide('aiCommandSuggestionsUi', themes);
    scope.effect(() => () => themes.close());
    scope.inject(
      ['workspaceUi', 'slots', 'locale', 'fileGrantActions', 'savedCredentialActions'],
      async (ui) => {
        const { installAiUi } = await import('./ui/index.tsx');
        if (ui.fiber.uid !== null) installAiUi(ui, model);
      },
    );
  });
}
