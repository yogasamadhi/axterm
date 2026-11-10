import { remoteErrorOf } from '@axterm/plugin-api';
import {
  terminalTransferRecoveryRecordSchema,
  type TerminalTransferRecoveryRecord,
} from '@axterm/plugin-api/terminals';
import type { TerminalsModel } from './index.ts';
type State =
  | { readonly status: 'connecting' | 'error' }
  | {
      readonly status: 'ready';
      readonly records: readonly TerminalTransferRecoveryRecord[];
      readonly busy: boolean;
      readonly error: boolean;
      readonly uncertain: boolean;
    };
/** One authority-scoped accepted recovery snapshot; never reused after generation replacement. */
export class TerminalRecoveryModel {
  private state: State = { status: 'connecting' };
  private readonly listeners = new Set<() => void>();
  private readonly lifetime = new AbortController();
  private readonly pending = new Set<Promise<unknown>>();
  private intent: { key: string; id: string; action: 'remove' | 'forget' } | undefined;
  private closing: Promise<void> | undefined;
  constructor(
    private readonly model: TerminalsModel,
    readonly generation: string,
    readonly grantId: string,
  ) {}
  getSnapshot = () => this.state;
  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };
  load() {
    if (this.pending.size) return Promise.reject(Error('TERMINAL_RECOVERY_BUSY'));
    return this.track(
      (async () => {
        this.assert();
        const records = await this.model.reviewTransferRecovery(this.grantId, this.lifetime.signal);
        this.assert();
        this.accept(records);
      })().catch((error) => {
        if (!this.closing) {
          this.state = { status: 'error' };
          this.publish();
        }
        throw error;
      }),
    );
  }
  async change(id: string, action: 'remove' | 'forget') {
    this.assert();
    if (this.intent || (this.state.status === 'ready' && this.state.busy))
      return Promise.reject(Error('TERMINAL_RECOVERY_BUSY'));
    this.intent = { key: crypto.randomUUID(), id, action };
    return this.runIntent();
  }
  async retry() {
    this.assert();
    if (this.pending.size) return Promise.reject(Error('TERMINAL_RECOVERY_BUSY'));
    return this.intent ? this.runIntent() : this.load();
  }
  close() {
    const facts = this.model.getSnapshot();
    if (
      this.intent &&
      !this.pending.size &&
      !(facts.status === 'ready' && facts.baseline.generation !== this.generation)
    )
      return Promise.reject(Error('TERMINAL_RECOVERY_UNCERTAIN'));
    return (this.closing ??= (async () => {
      this.lifetime.abort();
      await Promise.allSettled([...this.pending]);
      const state = this.model.getSnapshot();
      this.state = { status: 'error' };
      this.publish();
      this.listeners.clear();
      if (
        this.intent &&
        !(state.status === 'ready' && state.baseline.generation !== this.generation)
      )
        throw Error('TERMINAL_RECOVERY_UNCERTAIN');
    })());
  }
  private runIntent() {
    const intent = this.intent!;
    if (this.state.status === 'ready') {
      this.state = { ...this.state, busy: true, error: false };
      this.publish();
    }
    return this.track(
      this.model
        .changeTransferRecovery(
          intent.key,
          intent.id,
          this.grantId,
          intent.action,
          this.lifetime.signal,
        )
        .then(
          (records) => {
            this.intent = undefined;
            if (!this.closing && !this.lifetime.signal.aborted) {
              try {
                this.accept(records);
              } catch (error) {
                this.state = { status: 'error' };
                this.publish();
                throw error;
              }
            }
          },
          (error) => {
            const marked = remoteErrorOf(error);
            if (marked?.code === 'terminals/failure' && marked.details.reason !== 'unavailable')
              this.intent = undefined;
            if (this.state.status === 'ready') {
              this.state = { ...this.state, busy: false, error: true, uncertain: !!this.intent };
              this.publish();
            }
            throw error;
          },
        ),
    );
  }
  private accept(records: TerminalTransferRecoveryRecord[]) {
    const accepted = terminalTransferRecoveryRecordSchema.array().max(64).parse(records);
    this.state = Object.freeze({
      status: 'ready',
      records: Object.freeze(accepted.map((value) => Object.freeze({ ...value }))),
      busy: false,
      error: false,
      uncertain: !!this.intent,
    });
    this.publish();
  }
  private assert() {
    const facts = this.model.getSnapshot();
    if (
      this.closing ||
      this.lifetime.signal.aborted ||
      facts.status !== 'ready' ||
      facts.baseline.generation !== this.generation
    )
      throw Error('TERMINAL_RECOVERY_RETIRED');
  }
  private track<T>(task: Promise<T>): Promise<T> {
    this.pending.add(task);
    void task.finally(() => this.pending.delete(task)).catch(() => {});
    return task;
  }
  private publish() {
    for (const fn of this.listeners)
      try {
        fn();
      } catch {
        console.warn('TERMINAL_RECOVERY_OBSERVER_FAILED');
      }
  }
}
