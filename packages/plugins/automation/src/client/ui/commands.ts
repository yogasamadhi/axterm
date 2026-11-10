import {
  BatchFileError,
  parseCommandLineBatchOperation,
  type BatchFileMessageKey,
} from './batch-file.ts';
import { remoteErrorOf } from '@axterm/plugin-api';
import * as Contract from '@axterm/plugin-api/automation';
import type { FileGrantActions } from '@axterm/plugin-api/files';
import type { WorkspaceUi, AutomationWorkspaceSection } from '@axterm/ui/workspace';
import type { AutomationModel } from '../index.ts';
interface Intent {
  readonly generation: string;
  readonly apply: () => Promise<unknown>;
}
/** One immutable fact intent, explicitly retried with its original key and preconditions. */
export class AutomationUiCommands {
  private readonly lifetime = new AbortController();
  private readonly listeners = new Set<() => void>();
  private retained: Intent | undefined;
  private pending: Promise<unknown> | undefined;
  private readonly grants = new Map<string, { generation: string; owner: FileGrantActions }>();
  private readonly jobs = new Set<Promise<unknown>>();
  private closing: Promise<void> | undefined;
  private snapshot = {
    busy: false,
    uncertain: false,
    cleanup: false,
    fileError: undefined as BatchFileMessageKey | undefined,
    notice: undefined as { kind: 'notify' | 'limit'; name: string } | undefined,
    section: 'quick-commands' as AutomationWorkspaceSection,
  };
  constructor(
    private readonly model: AutomationModel,
    private readonly workspace: WorkspaceUi,
    private readonly files: FileGrantActions,
  ) {}
  getSnapshot = () => this.snapshot;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  notify(kind: 'notify' | 'limit', name = ''): void {
    this.publish({ notice: { kind, name: name.slice(0, 100) } });
  }
  dismissNotice(): void {
    this.publish({ notice: undefined, fileError: undefined });
  }
  open(section: AutomationWorkspaceSection = 'quick-commands'): void {
    this.publish({ section });
    this.workspace.selectSection('commands');
  }
  generation(): string {
    const state = this.model.getSnapshot();
    if (this.lifetime.signal.aborted || state.status !== 'ready')
      throw Error('AUTOMATION_NOT_READY');
    return state.baseline.generation;
  }
  private facts() {
    const state = this.model.getSnapshot();
    if (state.status !== 'ready') throw Error('AUTOMATION_NOT_READY');
    return state.baseline;
  }
  private command<T>(apply: (key: string) => Promise<T>): Promise<T> {
    if (this.pending || this.retained || this.grants.size) throw Error('AUTOMATION_INTENT_PENDING');
    const key = crypto.randomUUID(),
      intent = { generation: this.generation(), apply: () => apply(key) };
    return this.execute(intent) as Promise<T>;
  }
  private execute(intent: Intent): Promise<unknown> {
    if (this.pending) throw Error('AUTOMATION_INTENT_PENDING');
    if (this.generation() !== intent.generation) {
      this.retained = undefined;
      this.publish({ uncertain: false });
      throw Error('AUTOMATION_GENERATION_RETIRED');
    }
    this.publish({ busy: true });
    const task = Promise.resolve()
      .then(async () => {
        if (this.generation() !== intent.generation) throw Error('AUTOMATION_GENERATION_RETIRED');
        try {
          const value = await intent.apply();
          if (this.generation() !== intent.generation) throw Error('AUTOMATION_GENERATION_RETIRED');
          this.retained = undefined;
          this.publish({ uncertain: false });
          return value;
        } catch (error) {
          const marked = remoteErrorOf(error);
          if (
            this.model.getSnapshot().status !== 'ready' ||
            this.generation() === intent.generation
          ) {
            if (
              !marked ||
              marked.code !== 'automation/failure' ||
              !['invalid-input', 'not-found', 'conflict', 'capacity'].includes(
                marked.details.reason,
              )
            ) {
              this.retained = intent;
              this.publish({ uncertain: true });
            }
          }
          throw error;
        }
      })
      .finally(() => {
        this.pending = undefined;
        this.publish({ busy: false });
      });
    this.pending = task;
    return task;
  }
  retry(): Promise<unknown> {
    if (!this.retained) throw Error('AUTOMATION_NO_RETAINED_INTENT');
    return this.execute(this.retained);
  }
  createQuickCommandGroup(
    current: Contract.QuickCommandTree,
    input: Contract.QuickCommandGroupInput,
  ) {
    const value = structuredClone(input),
      etag = current.etag;
    return this.command(async (key) => {
      await this.model.createQuickCommandGroup(key, value, etag);
      return this.facts().quickCommands;
    });
  }
  updateQuickCommandGroup(
    current: Contract.QuickCommandTree,
    id: string,
    input: Contract.QuickCommandGroupPatch,
  ) {
    const value = structuredClone(input),
      etag = current.etag;
    return this.command(async (key) => {
      await this.model.updateQuickCommandGroup(key, id, value, etag);
      return this.facts().quickCommands;
    });
  }
  deleteQuickCommandGroup(current: Contract.QuickCommandTree, id: string) {
    const etag = current.etag;
    return this.command(async (key) => {
      await this.model.deleteQuickCommandGroup(key, id, etag);
      return this.facts().quickCommands;
    });
  }
  createQuickCommand(current: Contract.QuickCommandTree, input: Contract.QuickCommandInput) {
    const value = structuredClone(input),
      etag = current.etag;
    return this.command(async (key) => {
      await this.model.createQuickCommand(key, value, etag);
      return this.facts().quickCommands;
    });
  }
  updateQuickCommand(
    current: Contract.QuickCommandTree,
    id: string,
    input: Contract.QuickCommandPatch,
  ) {
    const value = structuredClone(input),
      etag = current.etag;
    return this.command(async (key) => {
      await this.model.updateQuickCommand(key, id, value, etag);
      return this.facts().quickCommands;
    });
  }
  deleteQuickCommand(current: Contract.QuickCommandTree, id: string) {
    const etag = current.etag;
    return this.command(async (key) => {
      await this.model.deleteQuickCommand(key, id, etag);
      return this.facts().quickCommands;
    });
  }
  moveQuickCommandTreeNode(
    current: Contract.QuickCommandTree,
    input: Contract.MoveQuickCommandTreeNodeInput,
  ) {
    const value = structuredClone(input),
      etag = current.etag;
    return this.command(async (key) => {
      await this.model.moveQuickCommand(key, value, etag);
      return this.facts().quickCommands;
    });
  }
  createTrigger(current: Contract.TriggerCollection, input: Contract.TriggerRuleInput) {
    const value = structuredClone(input),
      etag = current.etag;
    return this.command(async (key) => {
      await this.model.createTrigger(key, value, etag);
      return this.facts().triggers;
    });
  }
  updateTrigger(current: Contract.TriggerCollection, id: string, input: Contract.TriggerRulePatch) {
    const value = structuredClone(input),
      etag = current.etag;
    return this.command(async (key) => {
      await this.model.updateTrigger(key, id, value, etag);
      return this.facts().triggers;
    });
  }
  deleteTrigger(current: Contract.TriggerCollection, id: string) {
    const etag = current.etag;
    return this.command(async (key) => {
      await this.model.deleteTrigger(key, id, etag);
      return this.facts().triggers;
    });
  }
  replaceTriggers(current: Contract.TriggerCollection, input: Contract.TriggerRuleInput[]) {
    const value = Contract.replaceTriggersSchema.parse(input),
      etag = current.etag;
    return this.command(async (key) => {
      await this.model.replaceTriggers(key, value, etag);
      return this.facts().triggers;
    });
  }
  createBatchOperation(input: Contract.CreateBatchOperationInput) {
    const value = Contract.createBatchOperationSchema.parse(input);
    return this.command(async (key) => {
      const receipt = await this.model.createBatchOperation(key, value);
      const batch = this.facts().batches.find((item) => item.id === receipt.ids[0]);
      if (!batch) throw Error('AUTOMATION_BATCH_FACT_MISSING');
      return batch;
    });
  }
  cancelBatchOperation(id: string) {
    return this.command(async (key) => {
      await this.model.cancelBatchOperation(key, id);
    });
  }
  clearBatchOperations() {
    return this.command(async (key) => {
      await this.model.clearCompletedBatchOperations(key);
    });
  }
  runBatchGrant(id: string, generation: string, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    this.lifetime.signal.throwIfAborted();
    if (this.jobs.size || this.grants.size || this.pending || this.retained)
      throw Error('AUTOMATION_INTENT_PENDING');
    const owner = this.files;
    this.publish({ fileError: undefined });
    this.open('batch-operations');
    this.grants.set(id, { generation, owner });
    const task = Promise.resolve().then(async () => {
      let failure: unknown,
        failed = false;
      try {
        const owned = AbortSignal.any([this.lifetime.signal, ...(signal ? [signal] : [])]);
        await this.waitReady(generation, owned);
        if (!owner.readInGeneration) throw Error('AUTOMATION_FILE_UNAVAILABLE');
        const text = await owner.readInGeneration(id, 2 * 1024 * 1024, generation, owned);
        if (this.generation() !== generation) throw Error('AUTOMATION_GENERATION_RETIRED');
        owned.throwIfAborted();
        const input = parseCommandLineBatchOperation(text.content);
        await this.releaseGrant(id);
        owned.throwIfAborted();
        await this.createBatchOperation(input);
      } catch (error) {
        failed = true;
        failure = error;
        if (error instanceof BatchFileError && !this.lifetime.signal.aborted)
          this.publish({ fileError: error.key });
      }
      try {
        await this.releaseGrant(id);
      } catch (error) {
        this.publish({ cleanup: true });
        throw error;
      }
      if (failed) throw failure;
    });
    this.jobs.add(task);
    void task.then(
      () => this.jobs.delete(task),
      () => this.jobs.delete(task),
    );
    return task;
  }
  private waitReady(generation: string, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    return new Promise((resolve, reject) => {
      let off = () => {},
        done = false;
      const finish = (error?: Error) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        off();
        signal.removeEventListener('abort', abort);
        if (error) reject(error);
        else resolve();
      };
      const check = () => {
        const state = this.model.getSnapshot();
        if (state.status === 'error') finish(Error('AUTOMATION_NOT_READY'));
        else if (state.status === 'ready')
          finish(
            state.baseline.generation === generation
              ? undefined
              : Error('AUTOMATION_GENERATION_RETIRED'),
          );
      };
      const abort = () => finish(Error('AUTOMATION_ADMISSION_CANCELLED')),
        timer = setTimeout(() => finish(Error('AUTOMATION_BASELINE_TIMEOUT')), 10000);
      try {
        off = this.model.subscribe(check);
        signal.addEventListener('abort', abort, { once: true });
        if (signal.aborted) abort();
        else check();
      } catch {
        finish(Error('AUTOMATION_NOT_READY'));
      }
    });
  }

  async retryCleanup(): Promise<void> {
    for (const id of this.grants.keys()) await this.releaseGrant(id);
  }
  private async releaseGrant(id: string): Promise<void> {
    const record = this.grants.get(id);
    if (!record) return;
    const state = this.model.getSnapshot();
    if (state.status === 'ready' && state.baseline.generation !== record.generation)
      throw Error('AUTOMATION_GRANT_UNCERTAIN');
    if (!record.owner.revokeInGeneration) throw Error('AUTOMATION_GRANT_FENCING_UNAVAILABLE');
    try {
      await record.owner.revokeInGeneration(id, record.generation);
    } catch (error) {
      const marked = remoteErrorOf(error),
        current = this.model.getSnapshot();
      if (
        marked?.code !== 'files/failure' ||
        marked.details.reason !== 'not-found' ||
        current.status !== 'ready' ||
        current.baseline.generation !== record.generation
      )
        throw error;
    }
    this.grants.delete(id);
    this.publish({ cleanup: this.grants.size > 0 });
  }
  close(): Promise<void> {
    return (this.closing ??= (async () => {
      this.lifetime.abort();
      await Promise.allSettled([...this.jobs, ...(this.pending ? [this.pending] : [])]);
      await this.retryCleanup();
      this.retained = undefined;
      this.listeners.clear();
    })().catch((error) => {
      this.publish({ cleanup: this.grants.size > 0 });
      throw error;
    }));
  }
  private publish(patch: Partial<typeof this.snapshot>): void {
    this.snapshot = Object.freeze({ ...this.snapshot, ...patch });
    for (const listener of this.listeners) {
      try {
        listener();
      } catch {
        console.warn('AUTOMATION_UI_OBSERVER_FAILED');
      }
    }
  }
}
