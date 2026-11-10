import { z } from 'zod';
import type { AiTerminalExplanationUi } from '@axterm/ui/workspace';
import type { AiModel } from '../index.ts';
import type { TerminalAiDraft } from './panel-actions.ts';
import { buildTerminalExplainRequest } from './terminal-explain.ts';
const inputSchema = z
  .object({
    terminalId: z.uuid(),
    generation: z.uuid(),
    selection: z
      .string()
      .min(1)
      .max(1024 * 1024),
  })
  .strict();
interface ExplanationDraft extends TerminalAiDraft {
  readonly terminalId: string;
  readonly generation: string;
  readonly modelId: string;
}
interface Job {
  readonly terminalId: string;
  readonly generation: string;
  readonly modelId: string;
  readonly controller: AbortController;
  published: boolean;
}
/** One explicit read/preview at a time. No Run is admitted; only the Host-redacted prompt becomes UI state. */
export class TerminalExplanationOwner implements AiTerminalExplanationUi {
  private readonly lifetime = new AbortController();
  private readonly listeners = new Set<() => void>();
  private readonly stop: () => void;
  private draft: Readonly<ExplanationDraft> | undefined;
  private job: Job | undefined;
  private pending: Promise<'opened'> | undefined;
  private closing: Promise<void> | undefined;
  constructor(
    private readonly model: Pick<AiModel, 'getSnapshot' | 'subscribe' | 'previewContext'>,
    private readonly target: (id: string, requireActive: boolean) => boolean,
    private readonly instruction: () => string,
    private readonly show: (id: string) => void,
  ) {
    this.stop = model.subscribe(this.refresh);
  }
  getSnapshot = () => this.draft;
  subscribe = (listener: () => void) => {
    if (this.lifetime.signal.aborted || this.listeners.size >= 64)
      throw Error('AI_EXPLANATION_UNAVAILABLE');
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  refresh = () => {
    const state = this.model.getSnapshot();
    if (
      this.job &&
      (state.status !== 'ready' ||
        state.baseline.generation !== this.job.generation ||
        !state.baseline.models.some((m) => m.id === this.job!.modelId) ||
        !this.target(this.job.terminalId, !this.job.published))
    )
      this.job.controller.abort();
    if (
      this.draft &&
      (state.status !== 'ready' ||
        state.baseline.generation !== this.draft.generation ||
        !state.baseline.models.some((m) => m.id === this.draft!.modelId) ||
        !this.target(this.draft.terminalId, false))
    )
      this.publish(undefined);
  };
  open(
    input: Parameters<AiTerminalExplanationUi['open']>[0],
    caller?: AbortSignal,
  ): ReturnType<AiTerminalExplanationUi['open']> {
    try {
      this.lifetime.signal.throwIfAborted();
      caller?.throwIfAborted();
      const request = inputSchema.parse(input),
        state = this.model.getSnapshot();
      if (
        this.pending ||
        state.status !== 'ready' ||
        state.baseline.generation !== request.generation ||
        !this.target(request.terminalId, true)
      )
        throw Error('AI_EXPLANATION_UNAVAILABLE');
      const model = state.baseline.models[0];
      if (!model) return Promise.resolve('unconfigured');
      const prepared = buildTerminalExplainRequest(request.selection, this.instruction());
      if (!prepared.selectedText) throw Error('AI_EXPLANATION_SELECTION_EMPTY');
      const job: Job = {
        terminalId: request.terminalId,
        generation: request.generation,
        modelId: model.id,
        controller: new AbortController(),
        published: false,
      };
      this.job = job;
      const signal = AbortSignal.any([
        this.lifetime.signal,
        job.controller.signal,
        ...(caller ? [caller] : []),
      ]);
      const assert = () => {
        signal.throwIfAborted();
        const state = this.model.getSnapshot();
        if (
          state.status !== 'ready' ||
          state.baseline.generation !== job.generation ||
          !state.baseline.models.some((m) => m.id === job.modelId) ||
          !this.target(job.terminalId, true)
        )
          throw Error('AI_EXPLANATION_RETIRED');
      };
      const task = Promise.resolve().then(async (): Promise<'opened'> => {
        assert();
        const preview = await this.model.previewContext(
          {
            modelId: job.modelId,
            useCase: 'explainOutput',
            prompt: prepared.prompt,
            context: '',
            includeConversationHistory: false,
            terminalId: job.terminalId,
          },
          signal,
        );
        assert();
        if (typeof preview.prompt !== 'string' || !preview.prompt || preview.prompt.length > 16_384)
          throw Error('AI_EXPLANATION_PREVIEW_INVALID');
        job.published = true;
        this.publish(
          Object.freeze({
            nonce: crypto.randomUUID(),
            terminalId: job.terminalId,
            generation: job.generation,
            modelId: job.modelId,
            prompt: preview.prompt,
          }),
        );
        try {
          this.show(job.terminalId);
        } catch (error) {
          this.publish(undefined);
          throw error;
        }
        return 'opened';
      });
      this.pending = task;
      const settled = () => {
        if (this.pending === task) this.pending = undefined;
        if (this.job === job) this.job = undefined;
      };
      void task.then(settled, settled);
      return task;
    } catch (error) {
      return Promise.reject(error);
    }
  }
  consume(nonce: string): void {
    if (this.draft?.nonce === nonce) this.publish(undefined);
  }
  resourceCount(): number {
    return (this.pending ? 1 : 0) + this.listeners.size;
  }
  dispose(): Promise<void> {
    if (this.closing) return this.closing;
    this.lifetime.abort();
    this.job?.controller.abort();
    this.stop();
    this.draft = undefined;
    this.listeners.clear();
    return (this.closing = Promise.resolve(this.pending).then(
      () => {},
      () => {},
    ));
  }
  private publish(draft: Readonly<ExplanationDraft> | undefined) {
    if (this.lifetime.signal.aborted) return;
    this.draft = draft;
    for (const listener of [...this.listeners]) listener();
  }
}
