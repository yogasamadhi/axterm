import { remoteErrorOf } from '@axterm/plugin-api';
import type { UpdaterAction } from '@axterm/plugin-api/desktop';
interface Intent {
  generation: string;
  key: string;
  action: UpdaterAction;
  running: boolean;
}
/** At most one normal action and one cancellation; uncertain commands retain their exact key. */
export class DesktopUpdateCommands {
  private readonly intents = new Map<'action' | 'cancel', Intent>();
  private readonly pending = new Set<Promise<void>>();
  private readonly lifetime = new AbortController();
  private readonly listeners = new Set<() => void>();
  private state = { busy: false, uncertain: false };
  private closing: Promise<void> | undefined;
  constructor(
    private readonly generation: () => string | undefined,
    private readonly send: (
      generation: string,
      key: string,
      action: UpdaterAction,
      signal: AbortSignal,
    ) => Promise<unknown>,
  ) {}
  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  perform(action: UpdaterAction): Promise<void> {
    const lane = action === 'cancel' ? 'cancel' : 'action';
    if (this.closing || this.intents.has(lane)) throw Error('DESKTOP_UPDATE_BUSY');
    const generation = this.generation();
    if (!generation) throw Error('DESKTOP_UPDATE_NOT_READY');
    const intent = { generation, key: crypto.randomUUID(), action, running: false };
    this.intents.set(lane, intent);
    return this.run(lane, intent);
  }
  async retry(): Promise<void> {
    if (this.closing || this.pending.size || !this.intents.size)
      throw Error('DESKTOP_UPDATE_NOT_UNCERTAIN');
    for (const [lane, intent] of this.intents) await this.run(lane, intent);
  }
  private run(lane: 'action' | 'cancel', intent: Intent): Promise<void> {
    intent.running = true;
    this.publish();
    const task = Promise.resolve()
      .then(async () => {
        const current = this.generation();
        if (current !== intent.generation) {
          if (current) this.intents.delete(lane);
          throw Error('DESKTOP_UPDATE_RETIRED');
        }
        await this.send(intent.generation, intent.key, intent.action, this.lifetime.signal);
        this.intents.delete(lane);
      })
      .catch((error) => {
        const marked = remoteErrorOf(error);
        if (
          marked?.code === 'desktop/failure' &&
          ['invalid-input', 'stale', 'closed', 'capacity', 'unavailable'].includes(
            marked.details.reason,
          )
        )
          this.intents.delete(lane);
        throw Error(
          this.intents.has(lane) ? 'DESKTOP_UPDATE_OUTCOME_UNCERTAIN' : 'DESKTOP_UPDATE_FAILED',
        );
      })
      .finally(() => {
        intent.running = false;
        this.publish();
      });
    this.pending.add(task);
    const release = () => this.pending.delete(task);
    void task.then(release, release);
    return task;
  }
  private publish(): void {
    this.state = {
      busy: [...this.intents.values()].some((intent) => intent.running),
      uncertain: [...this.intents.values()].some((intent) => !intent.running),
    };
    if (this.closing) return;
    for (const listener of [...this.listeners]) {
      try {
        listener();
      } catch {
        console.warn('DESKTOP_UPDATE_OBSERVER_FAILED');
      }
    }
  }
  close(): Promise<void> {
    return (this.closing ??= (async () => {
      this.lifetime.abort();
      await Promise.allSettled([...this.pending]);
      this.listeners.clear();
      const generation = this.generation();
      if (
        [...this.intents.values()].some((intent) => !generation || intent.generation === generation)
      )
        throw Error('DESKTOP_UPDATE_OUTCOME_UNCERTAIN');
      this.intents.clear();
    })());
  }
}
