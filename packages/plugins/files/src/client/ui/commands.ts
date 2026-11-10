import { remoteErrorOf, RemoteError } from '@axterm/plugin-api';
import type { FileOperationReceipt } from '@axterm/plugin-api/files';
import type { FileGrantsModel } from '../index.ts';
interface Job {
  readonly id: string;
  readonly generation: string;
  readonly kind: 'file' | 'command';
  readonly invoke: () => Promise<unknown>;
  state: 'running' | 'uncertain';
}
/** Payloads live only in bounded private closures. Retry always uses the captured key and intent. */
export class FilesUiCommands {
  private readonly jobs = new Map<string, Job>();
  private readonly pending = new Set<Promise<unknown>>();
  private readonly listeners = new Set<() => void>();
  private state: readonly { id: string; state: Job['state'] }[] = [];
  private closing: Promise<void> | undefined;
  constructor(
    private readonly model: FileGrantsModel,
    private readonly signal: AbortSignal,
  ) {}
  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  file(
    perform: (key: string, signal: AbortSignal) => Promise<FileOperationReceipt>,
  ): Promise<FileOperationReceipt> {
    return this.admit('file', perform);
  }
  command<T>(perform: (key: string, signal: AbortSignal) => Promise<T>): Promise<T> {
    return this.admit('command', perform);
  }
  private admit<T>(
    kind: Job['kind'],
    perform: (key: string, signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    if (this.closing || this.signal.aborted) return Promise.reject(Error('FILES_COMMANDS_CLOSED'));
    if (this.jobs.size >= 16 || [...this.jobs.values()].some((job) => job.state === 'uncertain'))
      return Promise.reject(Error('FILES_COMMAND_RESULT_UNCERTAIN'));
    const facts = this.model.getSnapshot();
    if (facts.status !== 'ready') return Promise.reject(Error('FILES_NOT_READY'));
    const id = crypto.randomUUID(),
      generation = facts.baseline.generation;
    const invoke = async () => {
      const current = this.model.getSnapshot();
      if (
        this.signal.aborted ||
        current.status !== 'ready' ||
        current.baseline.generation !== generation
      )
        throw new RemoteError('files/failure', 'File command retired before admission', {
          reason: 'stale',
        });
      return perform(id, this.signal);
    };
    const job: Job = { id, generation, kind, invoke, state: 'running' };
    this.jobs.set(id, job);
    this.publish();
    return this.execute(job) as Promise<T>;
  }
  async retry(id: string): Promise<unknown> {
    const job = this.jobs.get(id);
    if (!job || job.state !== 'uncertain' || this.closing)
      throw Error('FILES_COMMAND_NOT_RETRYABLE');
    if (job.kind === 'file') {
      const outcome = await this.model.getFileOperationOutcome(id);
      if (outcome.status === 'completed') {
        this.jobs.delete(id);
        this.publish();
        return outcome.receipt;
      }
      if (outcome.status === 'running') throw Error('FILES_COMMAND_STILL_RUNNING');
      if (outcome.status !== 'missing') {
        this.jobs.delete(id);
        this.publish();
        throw Error('FILES_COMMAND_FINISHED_WITHOUT_SUCCESS');
      }
    }
    job.state = 'running';
    this.publish();
    return this.execute(job);
  }
  async close(): Promise<void> {
    return (this.closing ??= (async () => {
      await Promise.allSettled([...this.pending]);
      for (const job of this.jobs.values()) {
        const facts = this.model.getSnapshot();
        if (facts.status === 'ready' && facts.baseline.generation !== job.generation) {
          this.jobs.delete(job.id);
          continue;
        }
        if (job.kind === 'file') {
          const result = await this.model.getFileOperationOutcome(job.id);
          if (['completed', 'failed', 'interrupted', 'expired'].includes(result.status)) {
            this.jobs.delete(job.id);
            continue;
          }
        }
      }
      this.listeners.clear();
      if (this.jobs.size) throw Error('FILES_COMMANDS_UNDRAINED');
    })());
  }
  private execute(job: Job): Promise<unknown> {
    const task = Promise.resolve()
      .then(job.invoke)
      .then(
        (value) => {
          this.jobs.delete(job.id);
          this.publish();
          return value;
        },
        (error) => {
          const marked = remoteErrorOf(error);
          if (marked && !(marked.code === 'files/failure' && marked.details.reason === 'uncertain'))
            this.jobs.delete(job.id);
          else job.state = 'uncertain';
          this.publish();
          throw error;
        },
      );
    this.pending.add(task);
    void task.finally(() => this.pending.delete(task)).catch(() => {});
    return task;
  }
  private publish() {
    this.state = Object.freeze(
      [...this.jobs.values()].map(({ id, state }) => Object.freeze({ id, state })),
    );
    for (const listener of this.listeners) {
      try {
        listener();
      } catch {
        console.warn('FILES_COMMAND_OBSERVER_FAILED');
      }
    }
  }
}
