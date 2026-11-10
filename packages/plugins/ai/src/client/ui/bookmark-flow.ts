import type {
  CatalogClientActions,
  CatalogReceipt,
  CreateSshBookmarkInput,
} from '@axterm/plugin-api/catalog';
import type { AiRequestInput } from '@axterm/plugin-api/ai';
import { remoteErrorOf } from '@axterm/plugin-api';
import type { AiModel } from '../index.ts';
import { AiRunAdmissions, type AdmittedAiRun } from '../run-admissions.ts';
type BookmarkModel = Pick<AiModel, 'getSnapshot' | 'subscribe' | 'getRun'>;
import { parseAiBookmarkDraft } from './bookmark-draft.ts';
/** One dialog's finite readers and explicit commands; actual facts/IO keep their domain owners. */
export class AiBookmarkFlow {
  private readonly lifetime = new AbortController();
  private readonly tasks = new Set<Promise<unknown>>();
  private closing: Promise<void> | undefined;
  private owned: AdmittedAiRun | undefined;
  private saveRequest:
    { key: string; generation: string; input: CreateSshBookmarkInput; ifMatch: string } | undefined;
  private acceptedSave: CatalogReceipt | undefined;
  generation: string | undefined;
  constructor(
    readonly model: BookmarkModel,
    readonly catalog: CatalogClientActions,
    private readonly admissions: AiRunAdmissions,
  ) {}
  get saveUncertain(): boolean {
    return !!this.saveRequest;
  }
  currentTree() {
    const state = this.catalog.getSnapshot();
    if (state.status !== 'ready') throw new Error('AI_BOOKMARK_CATALOG_UNAVAILABLE');
    return state.baseline.bookmarks;
  }
  generate(input: Pick<AiRequestInput, 'modelId' | 'prompt'>) {
    const request = { modelId: input.modelId, prompt: input.prompt };
    return this.task(async () => {
      if (this.saveRequest) throw new Error('AI_BOOKMARK_SAVE_UNCERTAIN');
      const owned = await this.admissions.start({
        modelId: request.modelId,
        prompt: request.prompt,
        mode: 'chat',
        useCase: 'createBookmark',
        context: '',
        attachmentIds: [],
        includeConversationHistory: false,
      });
      this.owned = owned;
      this.generation = owned.generation;
      let completed = false;
      try {
        await this.finished(owned);
        this.lifetime.signal.throwIfAborted();
        this.assertGeneration(owned.generation);
        const run = await this.model.getRun(owned.run.id);
        this.lifetime.signal.throwIfAborted();
        this.assertGeneration(owned.generation);
        completed = ['succeeded', 'failed', 'canceled'].includes(run.state);
        if (run.state !== 'succeeded' || !run.result)
          throw new Error('AI_BOOKMARK_GENERATION_FAILED');
        return parseAiBookmarkDraft(run.result);
      } finally {
        if (!completed) await this.admissions.cancel(owned);
        if (this.owned === owned) this.owned = undefined;
      }
    });
  }
  save(input: CreateSshBookmarkInput): Promise<CatalogReceipt> {
    const snapshot = structuredClone(input);
    return this.task(async () => {
      if (!this.saveRequest) {
        const state = this.catalog.getSnapshot();
        if (state.status !== 'ready') throw new Error('AI_BOOKMARK_CATALOG_UNAVAILABLE');
        this.assertGeneration(state.baseline.generation);
        this.saveRequest = {
          key: crypto.randomUUID(),
          generation: state.baseline.generation,
          input: snapshot,
          ifMatch: state.baseline.bookmarks.etag,
        };
      }
      const request = this.saveRequest;
      this.assertGeneration(request.generation);
      try {
        this.acceptedSave ??= await this.catalog.createSshBookmark(
          request.key,
          request.input,
          request.ifMatch,
        );
      } catch (error) {
        const marked = remoteErrorOf(error);
        if (
          marked?.code === 'catalog/failure' &&
          [
            'invalid-input',
            'not-found',
            'capacity',
            'closed',
            'conflict',
            'stale',
            'precondition-required',
            'precondition-failed',
          ].includes(marked.details.reason)
        )
          this.saveRequest = undefined;
        throw error;
      }
      const receipt = this.acceptedSave;
      await this.observeCatalog(receipt.cursor, request.generation);
      this.saveRequest = undefined;
      this.acceptedSave = undefined;
      return receipt;
    });
  }
  close(): Promise<void> {
    if (this.closing) return this.closing;
    const done = Promise.withResolvers<void>();
    this.closing = done.promise;
    this.lifetime.abort();
    void (async () => {
      await Promise.allSettled([...this.tasks]);
      if (this.owned) {
        await this.admissions.cancel(this.owned);
        this.owned = undefined;
      }
      // Already submitted facts belong to Catalog. Closing never retries or rolls back a save.
      this.saveRequest = undefined;
      this.acceptedSave = undefined;
    })().then(done.resolve, done.reject);
    return this.closing;
  }
  private task<T>(apply: () => Promise<T>): Promise<T> {
    if (this.closing) return Promise.reject(new Error('AI_BOOKMARK_CLOSED'));
    if (this.tasks.size) return Promise.reject(new Error('AI_BOOKMARK_BUSY'));
    const task = Promise.resolve().then(() => {
      this.lifetime.signal.throwIfAborted();
      return apply();
    });
    this.tasks.add(task);
    void task.then(
      () => this.tasks.delete(task),
      () => this.tasks.delete(task),
    );
    return task;
  }
  private assertGeneration(generation: string): void {
    const state = this.model.getSnapshot();
    if (state.status !== 'ready' || state.baseline.generation !== generation)
      throw new Error('AI_BOOKMARK_RETIRED');
  }
  private finished(owned: AdmittedAiRun): Promise<void> {
    return this.observe(
      this.model.subscribe,
      () => {
        const state = this.model.getSnapshot();
        if (state.status === 'ready') {
          if (state.baseline.generation !== owned.generation)
            throw new Error('AI_BOOKMARK_RETIRED');
          const run = state.baseline.runs.find((row) => row.id === owned.run.id);
          return !!run && ['succeeded', 'failed', 'canceled'].includes(run.state);
        }
        if (state.status === 'error') throw new Error('AI_BOOKMARK_UNAVAILABLE');
        return false;
      },
      30_000,
    );
  }
  private observeCatalog(cursor: number, generation: string): Promise<void> {
    return this.observe(
      this.catalog.subscribe,
      () => {
        const state = this.catalog.getSnapshot();
        if (state.status === 'ready') {
          if (state.baseline.generation !== generation) throw new Error('AI_BOOKMARK_RETIRED');
          return state.baseline.cursor >= cursor;
        }
        return false;
      },
      10_000,
    );
  }
  private observe(
    subscribe: (fn: () => void) => () => void,
    check: () => boolean,
    ms: number,
  ): Promise<void> {
    this.lifetime.signal.throwIfAborted();
    return new Promise((resolve, reject) => {
      let stop = () => {},
        settled = false;
      const finish = (error?: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        stop();
        this.lifetime.signal.removeEventListener('abort', abort);
        if (error) reject(error);
        else resolve();
      };
      const abort = () => finish(new Error('AI_BOOKMARK_CANCELED'));
      const read = () => {
        try {
          if (check()) finish();
        } catch (error) {
          finish(error);
        }
      };
      const timer = setTimeout(() => finish(new Error('AI_BOOKMARK_TIMEOUT')), ms);
      try {
        stop = subscribe(read);
        this.lifetime.signal.addEventListener('abort', abort, { once: true });
        if (this.lifetime.signal.aborted) abort();
        else read();
      } catch (error) {
        finish(error);
      }
    });
  }
}
export class AiBookmarkLauncher {
  private state: {
    readonly flow: AiBookmarkFlow | undefined;
    readonly busy: boolean;
    readonly failed: boolean;
  } = { flow: undefined, busy: false, failed: false };
  private readonly listeners = new Set<() => void>();
  private readonly admissions: AiRunAdmissions;
  private closing: Promise<void> | undefined;
  private withdrawing: Promise<void> | undefined;
  constructor(
    private readonly model: AiModel,
    private readonly catalog: CatalogClientActions,
  ) {
    this.admissions = new AiRunAdmissions(model);
  }
  getSnapshot = () => this.state;
  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  };
  open(): void {
    if (this.closing || this.state.busy || this.state.flow) return;
    const ai = this.model.getSnapshot(),
      catalog = this.catalog.getSnapshot();
    if (
      ai.status !== 'ready' ||
      catalog.status !== 'ready' ||
      ai.baseline.generation !== catalog.baseline.generation
    ) {
      this.publish({ ...this.state, failed: true });
      return;
    }
    this.publish({
      flow: new AiBookmarkFlow(this.model, this.catalog, this.admissions),
      busy: false,
      failed: false,
    });
  }
  close(): Promise<void> {
    if (this.withdrawing) return this.withdrawing;
    const flow = this.state.flow;
    if (!flow) return Promise.resolve();
    this.publish({ ...this.state, busy: true });
    return (this.withdrawing = (async () => {
      let failed = false;
      try {
        await flow.close();
      } catch {
        failed = true;
      }
      this.publish({ flow: undefined, busy: false, failed });
    })().finally(() => {
      this.withdrawing = undefined;
    }));
  }
  retireGeneration(): void {
    const generation = this.state.flow?.generation;
    if (!generation) return;
    const ai = this.model.getSnapshot(),
      catalog = this.catalog.getSnapshot();
    if (
      (ai.status === 'ready' && ai.baseline.generation !== generation) ||
      (catalog.status === 'ready' && catalog.baseline.generation !== generation)
    )
      void this.close();
  }
  dispose(): Promise<void> {
    return (this.closing ??= (async () => {
      await this.close();
      await this.admissions.close();
      this.listeners.clear();
    })());
  }
  private publish(state: typeof this.state) {
    this.state = Object.freeze(state);
    for (const fn of [...this.listeners]) fn();
  }
}
