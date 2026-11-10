import type { AiContextPreview, AiContextPreviewInput, AiRun } from '@axterm/plugin-api/ai';
interface Client {
  previewAiContext(input: AiContextPreviewInput, signal?: AbortSignal): Promise<AiContextPreview>;
  startAi(
    input: AiContextPreviewInput & { reviewReceipt?: string; reviewExpiresAt?: string },
  ): Promise<AiRun>;
  cancelAi(id: string): Promise<unknown>;
}
export interface ContextReviewState {
  readonly preview: AiContextPreview | undefined;
  readonly busy: boolean;
  readonly error: 'ai.reviewFailed' | 'ai.reviewChanged' | 'common.operationFailed' | undefined;
}
/** Review authority and accepted tasks belong to the Client owner, rather than React state. */
export class ContextReviewOwner {
  private state: ContextReviewState = Object.freeze({
    preview: undefined,
    busy: false,
    error: undefined,
  });
  private readonly listeners = new Set<() => void>();
  private controller: AbortController | undefined;
  private pending: Promise<void> | undefined;
  private active = true;
  private closing: Promise<void> | undefined;
  private readonly failedCancellation = new Set<string>();
  constructor(
    private readonly client: Client,
    private readonly retired: () => void = () => {},
  ) {}
  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => {
    if (this.listeners.size >= 64) throw new Error('AI_REVIEW_OBSERVER_CAPACITY');
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  dismiss = (): void => {
    this.controller?.abort();
    this.publish({ ...this.state, preview: undefined, error: undefined });
  };
  prepare = (
    input: (signal: AbortSignal, current: () => boolean) => Promise<AiContextPreviewInput>,
  ): Promise<void> =>
    this.run(async (controller, current) => {
      this.publish({ preview: undefined, busy: true, error: undefined });
      try {
        const request = await input(controller.signal, current);
        if (!current()) return;
        const preview = await this.client.previewAiContext(request, controller.signal);
        if (!current()) return;
        this.publish({ preview: freeze(structuredClone(preview)), busy: true, error: undefined });
      } catch {
        if (current()) this.publish({ ...this.state, error: 'ai.reviewFailed' });
      }
    });
  send = (committed: (run: AiRun, reviewed: AiContextPreview) => Promise<void>): Promise<void> => {
    if (!this.active || this.pending) return Promise.resolve();
    const reviewed = this.state.preview;
    if (!reviewed) return Promise.resolve();
    if (Date.parse(reviewed.reviewExpiresAt) <= Date.now()) {
      this.publish({ preview: undefined, busy: false, error: 'ai.reviewChanged' });
      return Promise.resolve();
    }
    return this.run(async (_controller, current) => {
      this.publish({ ...this.state, error: undefined });
      try {
        // Do not abort away an accepted Run identity; cancel a late result explicitly.
        const run = await this.client.startAi({
          ...reviewed.request,
          reviewReceipt: reviewed.reviewReceipt,
          reviewExpiresAt: reviewed.reviewExpiresAt,
        });
        if (!current()) {
          await this.cancelLate(run.id);
          return;
        }
        this.publish({ preview: undefined, busy: true, error: undefined });
        await committed(run, reviewed);
      } catch {
        if (current()) this.publish({ preview: undefined, busy: true, error: 'ai.reviewChanged' });
      }
    });
  };
  sendDirect = (
    input: (signal: AbortSignal) => Promise<AiContextPreviewInput>,
    committed: () => Promise<void>,
  ): Promise<void> =>
    this.run(async (controller, current) => {
      this.publish({ ...this.state, error: undefined });
      try {
        const request = await input(controller.signal);
        if (!current()) return;
        const run = await this.client.startAi(request);
        if (!current()) {
          await this.cancelLate(run.id);
          return;
        }
        await committed();
      } catch {
        if (current()) this.publish({ ...this.state, error: 'common.operationFailed' });
      }
    });
  resourceCount(): number {
    return (this.pending ? 1 : 0) + this.failedCancellation.size;
  }
  dispose(): Promise<void> {
    if (this.closing) return this.closing;
    const done = Promise.withResolvers<void>();
    this.closing = done.promise;
    this.active = false;
    this.controller?.abort();
    void (async () => {
      await this.pending;
      if (this.failedCancellation.size) throw new Error('AI_REVIEW_RUN_CANCELLATION_FAILED');
      this.publish({ preview: undefined, busy: false, error: undefined });
      this.listeners.clear();
      this.retired();
    })().then(done.resolve, done.reject);
    return this.closing;
  }
  private run(
    perform: (controller: AbortController, current: () => boolean) => Promise<void>,
  ): Promise<void> {
    if (!this.active || this.pending) return Promise.resolve();
    const controller = new AbortController();
    this.controller = controller;
    const current = () =>
      this.active && this.controller === controller && !controller.signal.aborted;
    const task = Promise.resolve()
      .then(() => (current() ? perform(controller, current) : undefined))
      .finally(() => {
        if (this.controller === controller) this.controller = undefined;
        this.pending = undefined;
        this.publish({ ...this.state, busy: false });
      });
    this.pending = task;
    this.publish({ ...this.state, busy: true });
    return task;
  }
  private async cancelLate(id: string): Promise<void> {
    this.failedCancellation.add(id);
    await this.client.cancelAi(id);
    this.failedCancellation.delete(id);
  }
  private publish(state: ContextReviewState): void {
    this.state = Object.freeze(state);
    for (const listener of this.listeners)
      try {
        listener();
      } catch {
        console.warn('AI_REVIEW_OBSERVER_FAILED');
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
