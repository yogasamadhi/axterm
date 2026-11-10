import { remoteErrorOf } from '@axterm/plugin-api';
import type { CreateTerminalInput } from '@axterm/plugin-api/terminals';
import type { TerminalsModel } from './index.ts';
type Model = Pick<
  TerminalsModel,
  'create' | 'close' | 'getCommandOutcome' | 'getSnapshot' | 'subscribe'
>;
/** Owns admission through an actual visible session or completed rollback, without a replay queue. */
export class TerminalWorkspaceAdmissions {
  private readonly lifetime = new AbortController();
  private readonly pending = new Set<Promise<string>>();
  private readonly rollback = new Map<string, string>();
  private readonly uncertain = new Map<string, string>();
  private closing: Promise<void> | undefined;
  constructor(
    private readonly model: Model,
    private readonly activateView: (id: string, title?: string) => void,
  ) {}
  open(
    input: CreateTerminalInput,
    signal?: AbortSignal,
    title?: string,
    prepareView?: (id: string) => void,
    activate = true,
  ): Promise<string> {
    if (title !== undefined && (!title.trim() || title.length > 256 || /[\r\n\0]/u.test(title)))
      return Promise.reject(Error('TERMINAL_TITLE_INVALID'));
    if (this.closing) return Promise.reject(new Error('TERMINAL_WORKSPACE_CLOSED'));
    if (this.pending.size + this.rollback.size + this.uncertain.size >= 8)
      return Promise.reject(new Error('TERMINAL_WORKSPACE_CAPACITY'));
    const initial = this.model.getSnapshot();
    if (initial.status !== 'ready')
      return Promise.reject(new Error('TERMINAL_WORKSPACE_UNAVAILABLE'));
    const generation = initial.baseline.generation;
    const request = structuredClone(input);
    const key = crypto.randomUUID();
    const owned = AbortSignal.any([this.lifetime.signal, ...(signal ? [signal] : [])]);
    const task = Promise.resolve().then(async () => {
      owned.throwIfAborted();
      const current = this.model.getSnapshot();
      if (current.status !== 'ready' || current.baseline.generation !== generation)
        throw new Error('TERMINAL_WORKSPACE_RETIRED');
      let session;
      try {
        session = await this.model.create(request, key);
      } catch (error) {
        const marked = remoteErrorOf(error);
        const definite =
          marked?.code === 'terminals/failure' &&
          [
            'invalid-input',
            'not-found',
            'capacity',
            'closed',
            'cancelled',
            'conflict',
            'stale',
            'forbidden',
            'precondition-required',
            'precondition-failed',
          ].includes(marked.details.reason);
        if (!definite) {
          this.uncertain.set(key, generation);
          try {
            await this.resolveUncertain(key, generation);
          } catch {
            /* Retain ownership until actual outcome and cleanup are known. */
          }
        }
        throw error;
      }
      this.rollback.set(session.id, generation);
      try {
        prepareView?.(session.id);
        await this.observed(session.id, generation, owned);
        owned.throwIfAborted();
        if (activate) {
          if (title === undefined) this.activateView(session.id);
          else this.activateView(session.id, title);
        }
        this.rollback.delete(session.id);
        return session.id;
      } catch (error) {
        await this.release(session.id, generation);
        throw error;
      }
    });
    this.pending.add(task);
    void task.then(
      () => this.pending.delete(task),
      () => this.pending.delete(task),
    );
    return task;
  }
  activate(id: string): void {
    if (this.closing) throw new Error('TERMINAL_WORKSPACE_CLOSED');
    const current = this.model.getSnapshot();
    if (
      current.status !== 'ready' ||
      !current.baseline.sessions.some((session) => session.id === id)
    )
      throw new Error('TERMINAL_WORKSPACE_UNAVAILABLE');
    this.activateView(id);
  }
  dispose(): Promise<void> {
    if (this.closing) return this.closing;
    const completion = Promise.withResolvers<void>();
    this.closing = completion.promise;
    this.lifetime.abort();
    void (async () => {
      await Promise.allSettled([...this.pending]);
      await Promise.allSettled(
        [...this.rollback].map(([id, generation]) => this.release(id, generation)),
      );
      await Promise.allSettled(
        [...this.uncertain].map(([key, generation]) => this.resolveUncertain(key, generation)),
      );
      if (this.rollback.size || this.uncertain.size)
        throw new Error('TERMINAL_WORKSPACE_DRAIN_FAILED');
    })().then(completion.resolve, completion.reject);
    return this.closing;
  }
  private async resolveUncertain(key: string, generation: string): Promise<void> {
    const current = this.model.getSnapshot();
    if (current.status !== 'ready') throw new Error('TERMINAL_WORKSPACE_UNAVAILABLE');
    if (current.baseline.generation !== generation) {
      this.uncertain.delete(key);
      return;
    }
    const result = await this.model.getCommandOutcome(generation, key);
    if (result.status !== 'accepted') throw new Error('TERMINAL_WORKSPACE_OUTCOME_UNCERTAIN');
    await this.model.close(result.id, generation);
    this.uncertain.delete(key);
  }
  private async release(id: string, generation: string): Promise<void> {
    const current = this.model.getSnapshot();
    if (current.status !== 'ready') throw new Error('TERMINAL_WORKSPACE_UNAVAILABLE');
    // A replaced Host owns retirement of the old generation. Never send an old close into it.
    if (current.baseline.generation === generation) await this.model.close(id, generation);
    this.rollback.delete(id);
  }
  private observed(id: string, generation: string, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    return new Promise((resolve, reject) => {
      let off = () => {};
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        off();
        signal.removeEventListener('abort', abort);
        if (error) reject(error);
        else resolve();
      };
      const abort = () => finish(new Error('TERMINAL_WORKSPACE_CANCELED'));
      const check = () => {
        const state = this.model.getSnapshot();
        if (state.status === 'ready') {
          if (state.baseline.generation !== generation)
            finish(new Error('TERMINAL_WORKSPACE_RETIRED'));
          else if (state.baseline.sessions.some((session) => session.id === id)) finish();
        }
      };
      try {
        off = this.model.subscribe(check);
        if (settled) {
          off();
          return;
        }
        timer = setTimeout(() => finish(new Error('TERMINAL_WORKSPACE_FACTS_UNAVAILABLE')), 10000);
        signal.addEventListener('abort', abort, { once: true });
        if (signal.aborted) abort();
        else check();
      } catch (error) {
        finish(error instanceof Error ? error : new Error('TERMINAL_WORKSPACE_UNAVAILABLE'));
      }
    });
  }
}
