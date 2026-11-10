import { remoteErrorOf } from '@axterm/plugin-api';
import type { AiRequestInput, AiRun } from '@axterm/plugin-api/ai';
import type { AiModel } from './index.ts';
type Model = Pick<
  AiModel,
  'getSnapshot' | 'startRun' | 'getRun' | 'getRunCommandOutcome' | 'cancelRun'
>;
export interface AdmittedAiRun {
  readonly run: AiRun;
  readonly generation: string;
}
/** Own the admission identity; successful handoff leaves actual execution with the Host AI owner. */
export class AiRunAdmissions {
  private readonly pending = new Set<Promise<AdmittedAiRun>>();
  private readonly cleanup = new Set<Promise<void>>();
  private readonly uncertain = new Map<string, string>();
  private readonly rollback = new Map<string, string>();
  private closing: Promise<void> | undefined;
  constructor(private readonly model: Model) {}
  /** A failed admission remains owned; another UI request must not silently resubmit it. */
  hasUnresolvedAdmissions(generation: string): boolean {
    const state = this.model.getSnapshot();
    if (state.status === 'ready' && state.baseline.generation === generation) {
      for (const [key, captured] of this.uncertain)
        if (captured !== generation) this.uncertain.delete(key);
      for (const [id, captured] of this.rollback)
        if (captured !== generation) this.rollback.delete(id);
    }
    return this.uncertain.size > 0 || this.rollback.size > 0;
  }
  start(input: AiRequestInput): Promise<AdmittedAiRun> {
    if (this.closing) return Promise.reject(new Error('AI_RUN_ADMISSION_CLOSED'));
    if (this.pending.size + this.uncertain.size + this.rollback.size >= 8)
      return Promise.reject(new Error('AI_RUN_ADMISSION_CAPACITY'));
    const initial = this.model.getSnapshot();
    if (initial.status !== 'ready')
      return Promise.reject(new Error('AI_RUN_ADMISSION_UNAVAILABLE'));
    const generation = initial.baseline.generation,
      key = crypto.randomUUID(),
      request = structuredClone(input);
    const task = Promise.resolve().then(async () => {
      if (this.closing) throw new Error('AI_RUN_ADMISSION_CLOSED');
      const current = this.model.getSnapshot();
      if (current.status !== 'ready' || current.baseline.generation !== generation)
        throw new Error('AI_RUN_ADMISSION_RETIRED');
      let run: AiRun;
      try {
        run = await this.model.startRun(key, request);
      } catch (error) {
        const marked = remoteErrorOf(error);
        const definite =
          marked?.code === 'ai/failure' &&
          [
            'invalid-input',
            'not-found',
            'capacity',
            'closed',
            'cancelled',
            'conflict',
            'stale',
            'precondition-required',
            'precondition-failed',
          ].includes(marked.details.reason);
        if (definite) throw error;
        this.uncertain.set(key, generation);
        const result = await this.model.getRunCommandOutcome(generation, key);
        if (result.status !== 'accepted') throw error;
        this.rollback.set(result.id, generation);
        this.uncertain.delete(key);
        run = await this.model.getRun(result.id);
      }
      this.rollback.set(run.id, generation);
      if (this.closing) {
        await this.release(run.id, generation);
        throw new Error('AI_RUN_ADMISSION_CLOSED');
      }
      const accepted = this.model.getSnapshot();
      if (accepted.status !== 'ready' || accepted.baseline.generation !== generation) {
        await this.release(run.id, generation);
        throw new Error('AI_RUN_ADMISSION_RETIRED');
      }
      this.rollback.delete(run.id);
      return { run, generation };
    });
    this.pending.add(task);
    void task.then(
      () => this.pending.delete(task),
      () => this.pending.delete(task),
    );
    return task;
  }
  cancel(owned: AdmittedAiRun): Promise<void> {
    this.rollback.set(owned.run.id, owned.generation);
    const task = this.release(owned.run.id, owned.generation);
    this.cleanup.add(task);
    void task.then(
      () => this.cleanup.delete(task),
      () => this.cleanup.delete(task),
    );
    return task;
  }
  close(): Promise<void> {
    if (this.closing) return this.closing;
    const done = Promise.withResolvers<void>();
    this.closing = done.promise;
    void (async () => {
      await Promise.allSettled([...this.pending]);
      await Promise.allSettled([...this.cleanup]);
      await Promise.allSettled(
        [...this.uncertain].map(async ([key, generation]) => {
          const current = this.model.getSnapshot();
          if (current.status === 'ready' && current.baseline.generation !== generation) {
            this.uncertain.delete(key);
            return;
          }
          const outcome = await this.model.getRunCommandOutcome(generation, key);
          if (outcome.status !== 'accepted') throw new Error('AI_RUN_ADMISSION_OUTCOME_UNCERTAIN');
          this.rollback.set(outcome.id, generation);
          this.uncertain.delete(key);
        }),
      );
      await Promise.allSettled(
        [...this.rollback].map(([id, generation]) => this.release(id, generation)),
      );
      if (this.uncertain.size || this.rollback.size)
        throw new Error('AI_RUN_ADMISSION_DRAIN_FAILED');
    })().then(done.resolve, done.reject);
    return this.closing;
  }
  private async release(id: string, generation: string): Promise<void> {
    const state = this.model.getSnapshot();
    if (state.status === 'ready' && state.baseline.generation !== generation) {
      this.rollback.delete(id);
      return;
    }
    await this.model.cancelRun(crypto.randomUUID(), id, generation);
    this.rollback.delete(id);
  }
}
