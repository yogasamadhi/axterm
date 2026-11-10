import { remoteErrorOf } from '@axterm/plugin-api';
export interface EditorOperationState {
  readonly busy: boolean;
  readonly uncertain: boolean;
}
/** Joins auxiliary reads/admissions; only durable fact commands have an identical explicit retry. */
export class EditorOperations {
  private state: EditorOperationState = { busy: false, uncertain: false };
  private readonly listeners = new Set<() => void>();
  private readonly lifetime = new AbortController();
  private pending: Promise<unknown> | undefined;
  private retained: { generation: string; invoke: () => Promise<unknown> } | undefined;
  private closing: Promise<void> | undefined;
  constructor(private readonly generation: () => string | undefined) {}
  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  admit<T>(invoke: (signal: AbortSignal) => Promise<T>): Promise<T> {
    return this.perform(() => invoke(this.lifetime.signal), false);
  }
  fact<T>(invoke: (key: string) => Promise<T>): Promise<T> {
    this.assertIdle();
    const generation = this.generation();
    if (!generation) throw new Error('EDITOR_NOT_READY');
    const key = crypto.randomUUID();
    this.retained = { generation, invoke: () => invoke(key) };
    return this.perform(this.retained.invoke, true) as Promise<T>;
  }
  async retry(): Promise<void> {
    if (this.closing || this.pending || !this.retained) throw new Error('EDITOR_NOT_UNCERTAIN');
    if (this.generation() !== this.retained.generation) {
      this.retained = undefined;
      this.publish({ busy: false, uncertain: false });
      return;
    }
    await this.perform(this.retained.invoke, true);
  }
  close(): Promise<void> {
    return (this.closing ??= (async () => {
      this.lifetime.abort();
      await this.pending?.catch(() => {});
      this.listeners.clear();
      if (this.retained && this.generation() === this.retained.generation)
        throw new Error('EDITOR_DRAIN_UNCERTAIN');
      this.retained = undefined;
    })());
  }
  private assertIdle() {
    if (this.closing || this.pending || this.retained) throw new Error('EDITOR_BUSY');
  }
  private perform<T>(invoke: () => Promise<T>, fact: boolean): Promise<T> {
    if (this.closing || this.pending || (!fact && this.retained)) throw new Error('EDITOR_BUSY');
    this.publish({ busy: true, uncertain: !!this.retained });
    const task = Promise.resolve()
      .then(invoke)
      .then(
        (result) => {
          if (fact) this.retained = undefined;
          return result;
        },
        (error) => {
          const marked = remoteErrorOf(error);
          if (
            fact &&
            marked?.code === 'connections/failure' &&
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
            this.retained = undefined;
          throw new Error('EDITOR_OPERATION_FAILED');
        },
      )
      .finally(() => {
        this.pending = undefined;
        this.publish({ busy: false, uncertain: !!this.retained });
      });
    this.pending = task;
    return task;
  }
  private publish(state: EditorOperationState) {
    this.state = state;
    if (!this.closing) for (const listener of this.listeners) listener();
  }
}
