import { WidgetModel } from './widgets.ts';
import { installWidgetsUi } from './ui/widgets.tsx';
import { installAutomationUi } from './ui/index.tsx';
import { FileRenameModel } from './file-renames.ts';
export { FileRenameModel, RenameProjection } from './file-renames.ts';
export type { FileRenameState } from './file-renames.ts';
import type { Context } from '@deepseek-ai/cordis';
import type * as Contract from '@axterm/plugin-api/automation';
import { RemoteStreamCarrierError, type RemoteStream } from '@axterm/infra-gateway/client';
import remote from '@axterm/plugin-automation/remote';
import { AutomationProjection } from './projection.ts';
export type AutomationState =
  | { readonly status: 'connecting' }
  | { readonly status: 'ready'; readonly baseline: Contract.AutomationBaseline }
  | { readonly status: 'error'; readonly message: string };
/** Automation facts live here; trigger bytes and native work stay in their Host owners. */
export class AutomationModel {
  private state: AutomationState = { status: 'connecting' };
  private readonly listeners = new Set<() => void>();
  private stream: RemoteStream<Contract.AutomationUpdate>;
  private done: Promise<void>;
  private disposed = false;
  private readonly pending = new Set<Promise<unknown>>();
  private retrying: Promise<void> | undefined;
  constructor(private readonly ctx: Context) {
    this.stream = this.open();
    this.done = this.consume(this.stream);
  }
  getSnapshot = (): AutomationState => this.state;
  subscribe = (listener: () => void): (() => void) => {
    this.assertOpen();
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  retry(): Promise<void> {
    this.assertOpen();
    return (this.retrying ??= (async () => {
      await this.stream.dispose();
      await this.done;
      if (!this.disposed) {
        this.publish({ status: 'connecting' });
        this.stream = this.open();
        this.done = this.consume(this.stream);
      }
    })().finally(() => {
      this.retrying = undefined;
    }));
  }
  async dispose(): Promise<void> {
    this.disposed = true;
    this.lifetime.abort();
    await this.stream.dispose();
    await this.done;
    await this.retrying;
    await Promise.allSettled([...this.pending]);
    this.listeners.clear();
  }
  async createQuickCommandGroup(
    key: string,
    input: Contract.QuickCommandGroupInput,
    ifMatch: string | undefined,
  ): Promise<Contract.AutomationReceipt> {
    this.assertOpen();
    const result = await this.track(
      this.ctx.remote.automation.createQuickCommandGroup(key, input, ifMatch),
    );
    if (!result.ok) throw result.error;
    await this.observed(result.value.cursor);
    return result.value;
  }
  async updateQuickCommandGroup(
    key: string,
    id: string,
    input: Contract.QuickCommandGroupPatch,
    ifMatch: string | undefined,
  ): Promise<Contract.AutomationReceipt> {
    this.assertOpen();
    const result = await this.track(
      this.ctx.remote.automation.updateQuickCommandGroup(key, id, input, ifMatch),
    );
    if (!result.ok) throw result.error;
    await this.observed(result.value.cursor);
    return result.value;
  }
  async deleteQuickCommandGroup(
    key: string,
    id: string,
    ifMatch: string | undefined,
  ): Promise<Contract.AutomationReceipt> {
    this.assertOpen();
    const result = await this.track(
      this.ctx.remote.automation.deleteQuickCommandGroup(key, id, ifMatch),
    );
    if (!result.ok) throw result.error;
    await this.observed(result.value.cursor);
    return result.value;
  }
  async createQuickCommand(
    key: string,
    input: Contract.QuickCommandInput,
    ifMatch: string | undefined,
  ): Promise<Contract.AutomationReceipt> {
    this.assertOpen();
    const result = await this.track(
      this.ctx.remote.automation.createQuickCommand(key, input, ifMatch),
    );
    if (!result.ok) throw result.error;
    await this.observed(result.value.cursor);
    return result.value;
  }
  async updateQuickCommand(
    key: string,
    id: string,
    input: Contract.QuickCommandPatch,
    ifMatch: string | undefined,
  ): Promise<Contract.AutomationReceipt> {
    this.assertOpen();
    const result = await this.track(
      this.ctx.remote.automation.updateQuickCommand(key, id, input, ifMatch),
    );
    if (!result.ok) throw result.error;
    await this.observed(result.value.cursor);
    return result.value;
  }
  async deleteQuickCommand(
    key: string,
    id: string,
    ifMatch: string | undefined,
  ): Promise<Contract.AutomationReceipt> {
    this.assertOpen();
    const result = await this.track(
      this.ctx.remote.automation.deleteQuickCommand(key, id, ifMatch),
    );
    if (!result.ok) throw result.error;
    await this.observed(result.value.cursor);
    return result.value;
  }
  async moveQuickCommand(
    key: string,
    input: Contract.MoveQuickCommandTreeNodeInput,
    ifMatch: string | undefined,
  ): Promise<Contract.AutomationReceipt> {
    this.assertOpen();
    const result = await this.track(
      this.ctx.remote.automation.moveQuickCommand(key, input, ifMatch),
    );
    if (!result.ok) throw result.error;
    await this.observed(result.value.cursor);
    return result.value;
  }
  async createTrigger(
    key: string,
    input: Contract.TriggerRuleInput,
    ifMatch: string | undefined,
  ): Promise<Contract.AutomationReceipt> {
    this.assertOpen();
    const result = await this.track(this.ctx.remote.automation.createTrigger(key, input, ifMatch));
    if (!result.ok) throw result.error;
    await this.observed(result.value.cursor);
    return result.value;
  }
  async updateTrigger(
    key: string,
    id: string,
    input: Contract.TriggerRulePatch,
    ifMatch: string | undefined,
  ): Promise<Contract.AutomationReceipt> {
    this.assertOpen();
    const result = await this.track(
      this.ctx.remote.automation.updateTrigger(key, id, input, ifMatch),
    );
    if (!result.ok) throw result.error;
    await this.observed(result.value.cursor);
    return result.value;
  }
  async deleteTrigger(
    key: string,
    id: string,
    ifMatch: string | undefined,
  ): Promise<Contract.AutomationReceipt> {
    this.assertOpen();
    const result = await this.track(this.ctx.remote.automation.deleteTrigger(key, id, ifMatch));
    if (!result.ok) throw result.error;
    await this.observed(result.value.cursor);
    return result.value;
  }
  async replaceTriggers(
    key: string,
    input: Contract.TriggerRuleInput[],
    ifMatch: string | undefined,
  ): Promise<Contract.AutomationReceipt> {
    this.assertOpen();
    const result = await this.track(
      this.ctx.remote.automation.replaceTriggers(key, input, ifMatch),
    );
    if (!result.ok) throw result.error;
    await this.observed(result.value.cursor);
    return result.value;
  }
  async createBatchOperation(
    key: string,
    input: Contract.CreateBatchOperationInput,
  ): Promise<Contract.AutomationReceipt> {
    this.assertOpen();
    const result = await this.track(
      this.ctx.remote.automation.createBatchOperation(key, input, this.generation()),
    );
    if (!result.ok) throw result.error;
    await this.observed(result.value.cursor);
    return result.value;
  }
  async cancelBatchOperation(key: string, id: string): Promise<Contract.AutomationReceipt> {
    this.assertOpen();
    const result = await this.track(
      this.ctx.remote.automation.cancelBatchOperation(key, id, this.generation()),
    );
    if (!result.ok) throw result.error;
    await this.observed(result.value.cursor);
    return result.value;
  }
  async clearCompletedBatchOperations(
    key: string,
  ): Promise<Contract.AutomationReceipt & { cleared: number }> {
    this.assertOpen();
    const result = await this.track(
      this.ctx.remote.automation.clearCompletedBatchOperations(key, this.generation()),
    );
    if (!result.ok) throw result.error;
    await this.observed(result.value.cursor);
    return result.value;
  }
  private readonly lifetime = new AbortController();
  private waiters = 0;
  private observed(cursor: number): Promise<void> {
    this.assertOpen();
    if (!Number.isSafeInteger(cursor) || cursor < 0)
      return Promise.reject(new Error('AUTOMATION_CURSOR_INVALID'));
    const ready = () => this.state.status === 'ready' && this.state.baseline.cursor >= cursor;
    if (ready()) return Promise.resolve();
    if (this.waiters >= 64) return Promise.reject(new Error('AUTOMATION_WAIT_CAPACITY'));
    this.waiters++;
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const clean = () => {
        clearTimeout(timer);
        unsubscribe();
        this.lifetime.signal.removeEventListener('abort', abort);
        this.waiters--;
      };
      const update = () => {
        if (!settled && ready()) {
          settled = true;
          clean();
          resolve();
        }
      };
      const abort = () => {
        if (settled) return;
        settled = true;
        clean();
        reject(new Error('AUTOMATION_MODEL_CLOSED'));
      };
      const unsubscribe = this.subscribe(update);
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        clean();
        reject(new Error('AUTOMATION_FACTS_UNAVAILABLE'));
      }, 10000);
      this.lifetime.signal.addEventListener('abort', abort, { once: true });
      update();
    });
  }
  private generation(): string {
    this.assertOpen();
    const state = this.state;
    if (state.status !== 'ready') throw Error('AUTOMATION_NOT_READY');
    return state.baseline.generation;
  }
  private track<T>(task: Promise<T>): Promise<T> {
    this.pending.add(task);
    const done = () => this.pending.delete(task);
    void task.then(done, done);
    return task;
  }
  private assertOpen(): void {
    if (this.disposed) throw new Error('AUTOMATION_MODEL_CLOSED');
  }
  private open(): RemoteStream<Contract.AutomationUpdate> {
    return this.ctx.remote.$stream({
      name: 'automation.facts',
      open: (signal) => this.ctx.remote.automation.watchAutomation(signal),
      ended: () => new RemoteStreamCarrierError('Automation generation ended'),
    });
  }
  private async consume(stream: RemoteStream<Contract.AutomationUpdate>): Promise<void> {
    const projection = new AutomationProjection();
    let generation = 0;
    try {
      for await (const item of stream) {
        if (generation !== item.generation) {
          generation = item.generation;
          projection.reset();
          this.publish({ status: 'connecting' });
        }
        const baseline = projection.accept(item.value);
        if (baseline) {
          this.publish({ status: 'ready', baseline });
          item.accept();
        }
      }
    } catch {
      if (!this.disposed)
        this.publish({ status: 'error', message: 'Automation information is unavailable' });
    } finally {
      projection.reset();
    }
  }
  private publish(state: AutomationState): void {
    if (this.disposed) return;
    this.state = state;
    for (const listener of [...this.listeners]) {
      try {
        listener();
      } catch {
        console.warn('AUTOMATION_MODEL_OBSERVER_FAILED');
      }
    }
  }
}
declare module '@deepseek-ai/cordis' {
  interface Context {
    automationModel: AutomationModel;
  }
}
export const inject = ['typert', 'remote', 'connection'];
export async function apply(ctx: Context): Promise<void> {
  const unmount = await ctx.remote.$mount(remote);
  ctx.effect(() => unmount);
  await ctx.inject(['remote.automation'], (scope) => {
    const model = new AutomationModel(scope);
    scope.provide('automationModel', model);
    scope.inject(
      [
        'workspaceUi',
        'slots',
        'locale',
        'catalogActions',
        'terminalSessionsView',
        'terminalDraftUi',
        'terminalInputUi',
        'fileGrantActions',
      ],
      (ui) => installAutomationUi(ui, model),
    );
    const widgets = new WidgetModel(scope);
    scope.provide('widgetModel', widgets);
    scope.effect(() => () => widgets.dispose());
    scope.inject(
      [
        'slots',
        'locale',
        'fileGrantActions',
        'fileRenameModel',
        'savedCredentialActions',
        'desktopUi',
      ],
      (ui) => installWidgetsUi(ui, widgets),
    );
    const renames = new FileRenameModel(scope);
    scope.provide('fileRenameModel', renames);
    scope.effect(() => () => renames.dispose());
    scope.effect(() => () => model.dispose());
  });
}
