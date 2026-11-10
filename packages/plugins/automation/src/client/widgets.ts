import type {} from '@axterm/plugin-automation/remote';
import type { Context } from '@deepseek-ai/cordis';
import { RemoteStreamCarrierError, type RemoteStream } from '@axterm/infra-gateway/client';
import * as C from '@axterm/plugin-api/automation';
export class WidgetOutcomeUnknown extends Error {
  constructor() {
    super('WIDGET_OUTCOME_UNKNOWN');
  }
}
export type WidgetState =
  | {
      readonly status: 'connecting' | 'error';
      readonly uncertain?: { key: string; generation: string };
    }
  | {
      readonly status: 'ready';
      readonly baseline: C.WidgetFacts;
      readonly uncertain?: { key: string; generation: string };
    };
/** Baseline replacement owns all resource facts; retries never resend a secret-bearing start. */
export class WidgetModel {
  private state: WidgetState = { status: 'connecting' };
  private readonly listeners = new Set<() => void>();
  private closed = false;
  private readonly pending = new Set<Promise<unknown>>();
  private stream: RemoteStream<C.WidgetUpdate>;
  private done: Promise<void>;
  private retrying: Promise<void> | undefined;
  constructor(private readonly ctx: Context) {
    this.stream = this.open();
    this.done = this.consume();
  }
  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => {
    if (this.closed) throw Error('WIDGET_CLOSED');
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  generation(): string {
    if (this.closed || this.state.status !== 'ready') throw Error('WIDGET_NOT_READY');
    return this.state.baseline.generation;
  }
  private publish(state: WidgetState) {
    if (this.closed) return;
    this.state = state;
    for (const listener of [...this.listeners]) {
      try {
        listener();
      } catch {
        console.warn('WIDGET_OBSERVER_FAILED');
      }
    }
  }
  private track<T>(task: Promise<T>): Promise<T> {
    this.pending.add(task);
    void task.then(
      () => this.pending.delete(task),
      () => this.pending.delete(task),
    );
    return task;
  }
  private open() {
    return this.ctx.remote.$stream({
      name: 'automation.widgets',
      open: (signal) => this.ctx.remote.automation.watchWidgets(signal),
      ended: () => new RemoteStreamCarrierError('Widget generation ended'),
    });
  }
  private async consume() {
    let generation = 0,
      cursor = -1;
    try {
      for await (const item of this.stream) {
        if (generation !== item.generation) {
          generation = item.generation;
          cursor = -1;
          this.publish({
            status: 'connecting',
            ...(this.state.uncertain ? { uncertain: this.state.uncertain } : {}),
          });
        }
        const { type, ...raw } = item.value;
        const facts = C.widgetFactsSchema.parse(raw);
        if (
          (cursor < 0 && type !== 'baseline') ||
          (cursor >= 0 && type !== 'replace') ||
          facts.cursor < cursor
        )
          throw Error('WIDGET_INVALID_BASELINE');
        cursor = facts.cursor;
        this.publish({
          status: 'ready',
          baseline: freeze(facts),
          ...(this.state.uncertain?.generation === facts.generation
            ? { uncertain: this.state.uncertain }
            : {}),
        });
        item.accept();
      }
    } catch {
      this.publish({
        status: 'error',
        ...(this.state.uncertain ? { uncertain: this.state.uncertain } : {}),
      });
    }
  }
  private invoke(
    run: (
      key: string,
      generation: string,
    ) => ReturnType<Context['remote']['automation']['stopWidgetInstance']>,
    resourceControl = false,
  ): Promise<C.WidgetInstance> {
    const generation = this.generation(),
      key = crypto.randomUUID();
    if ((!resourceControl && this.state.uncertain) || this.pending.size >= 32)
      throw Error('WIDGET_OUTCOME_REQUIRED');
    return this.track(
      (async () => {
        let result;
        try {
          result = await run(key, generation);
        } catch {
          this.publish({ ...this.state, uncertain: { key, generation } });
          throw new WidgetOutcomeUnknown();
        }
        if (!result.ok) throw result.error;
        if (result.value.reason === 'uncertain') {
          this.publish({ ...this.state, uncertain: { key, generation } });
          throw new WidgetOutcomeUnknown();
        }
        if (result.value.status !== 'completed' || !result.value.instance)
          throw Error('WIDGET_OPERATION_FAILED');
        return result.value.instance;
      })(),
    );
  }
  startFile = (input: C.StartLocalFileServerInput) =>
    this.invoke((key, generation) =>
      this.ctx.remote.automation.startLocalFileServerWidget(key, generation, input),
    );
  startFtp = (input: C.StartLocalFtpServerInput) =>
    this.invoke((key, generation) =>
      this.ctx.remote.automation.startLocalFtpServerWidget(key, generation, input),
    );
  startSsh = (input: C.StartLocalSshServerInput) =>
    this.invoke((key, generation) =>
      this.ctx.remote.automation.startLocalSshServerWidget(key, generation, input),
    );
  startMcp = (input: C.StartMcpServerInput) =>
    this.invoke((key, generation) =>
      this.ctx.remote.automation.startMcpServerWidget(key, generation, input),
    );
  rename = (id: string, input: C.RenameWidgetInstanceInput) =>
    this.invoke((key, generation) =>
      this.ctx.remote.automation.renameWidgetInstance(key, generation, id, input),
    );
  stop = (id: string) =>
    this.invoke(
      (key, generation) => this.ctx.remote.automation.stopWidgetInstance(key, generation, id),
      true,
    );
  checkOutcome(): Promise<void> {
    const uncertain = this.state.uncertain;
    if (!uncertain) return Promise.resolve();
    return this.track(
      (async () => {
        const result = await this.ctx.remote.automation.getWidgetCommandOutcome(
          uncertain.key,
          uncertain.generation,
        );
        if (!result.ok) throw result.error;
        if (result.value.status !== 'pending' && result.value.reason !== 'uncertain') {
          const { uncertain: _previous, ...state } = this.state;
          this.publish(state);
        }
      })(),
    );
  }
  retry(): Promise<void> {
    if (this.closed) throw Error('WIDGET_CLOSED');
    return (this.retrying ??= (async () => {
      try {
        await this.stream.dispose();
        await this.done;
        if (this.closed) return;
        this.stream = this.open();
        this.done = this.consume();
      } finally {
        this.retrying = undefined;
      }
    })());
  }
  async dispose(): Promise<void> {
    this.closed = true;
    await this.stream.dispose();
    await this.done;
    await this.retrying;
    await Promise.allSettled([...this.pending]);
    this.listeners.clear();
  }
}
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
declare module '@deepseek-ai/cordis' {
  interface Context {
    widgetModel: WidgetModel;
  }
}
