import { remoteErrorOf } from '@axterm/plugin-api';
import { shortcutBindingsSchema, type ShortcutBindings } from '@axterm/plugin-api/configuration';
import type { ConfigurationClientActions } from '@axterm/plugin-api/configuration';
type Configuration = Pick<
  ConfigurationClientActions,
  'getSnapshot' | 'subscribe' | 'setLegacyShortcutBindings'
>;
/** One immutable preference intent, including the exact key, version and Host generation. */
export class TerminalGestureCommands {
  private state = { busy: false, uncertain: false };
  private readonly listeners = new Set<() => void>();
  private readonly lifetime = new AbortController();
  private intent:
    { generation: string; key: string; etag: string; bindings: ShortcutBindings } | undefined;
  private pending: Promise<void> | undefined;
  private closing: Promise<void> | undefined;
  constructor(private readonly configuration: Configuration) {
    if (!configuration.setLegacyShortcutBindings)
      throw Error('TERMINAL_GESTURE_CONFIGURATION_CAPABILITY_MISSING');
  }
  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  save(input: ShortcutBindings): Promise<void> {
    if (this.closing || this.pending || this.intent) throw Error('TERMINAL_GESTURE_BUSY');
    const current = this.configuration.getSnapshot();
    if (current.status !== 'ready') throw Error('TERMINAL_GESTURE_NOT_READY');
    this.intent = {
      generation: current.baseline.generation,
      key: crypto.randomUUID(),
      etag: `"v${current.baseline.settings.version}"`,
      bindings: shortcutBindingsSchema.parse(input),
    };
    return this.run();
  }
  retry(): Promise<void> {
    if (this.closing || this.pending || !this.intent) throw Error('TERMINAL_GESTURE_NOT_UNCERTAIN');
    return this.run();
  }
  close(): Promise<void> {
    return (this.closing ??= (async () => {
      this.lifetime.abort();
      await this.pending?.catch(() => {});
      this.listeners.clear();
      const current = this.configuration.getSnapshot();
      if (
        this.intent &&
        !(current.status === 'ready' && current.baseline.generation !== this.intent.generation)
      )
        throw Error('TERMINAL_GESTURE_DRAIN_UNCERTAIN');
      this.intent = undefined;
    })());
  }
  private run(): Promise<void> {
    const intent = this.intent!;
    this.publish({ busy: true, uncertain: false });
    const task = Promise.resolve()
      .then(async () => {
        const current = this.configuration.getSnapshot();
        if (current.status !== 'ready') throw Error('TERMINAL_GESTURE_NOT_READY');
        if (current.baseline.generation !== intent.generation) {
          this.intent = undefined;
          throw Error('TERMINAL_GESTURE_RETIRED');
        }
        const receipt = await this.configuration.setLegacyShortcutBindings!(
          intent.key,
          intent.bindings,
          intent.etag,
          intent.generation,
        );
        await this.observed(receipt.cursor, intent.generation);
        this.intent = undefined;
        this.publish({ busy: false, uncertain: false });
      })
      .catch((error) => {
        const marked = remoteErrorOf(error),
          current = this.configuration.getSnapshot();
        const definite =
          marked?.code === 'configuration/failure' &&
          [
            'invalid-input',
            'closed',
            'conflict',
            'precondition-required',
            'precondition-failed',
            'receipt-expired',
            'capacity',
          ].includes(marked.details.reason);
        if (
          definite ||
          (current.status === 'ready' && current.baseline.generation !== intent.generation)
        )
          this.intent = undefined;
        this.publish({ busy: false, uncertain: !!this.intent });
        throw Error(
          this.intent ? 'TERMINAL_GESTURE_OUTCOME_UNCERTAIN' : 'TERMINAL_GESTURE_SAVE_FAILED',
        );
      });
    this.pending = task;
    const release = () => {
      if (this.pending === task) this.pending = undefined;
    };
    void task.then(release, release);
    return task;
  }
  private observed(cursor: number, generation: string): Promise<void> {
    return new Promise((resolve, reject) => {
      let off = () => {},
        done = false;
      const finish = (error?: Error) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        off();
        this.lifetime.signal.removeEventListener('abort', abort);
        if (error) reject(error);
        else resolve();
      };
      const check = () => {
        const current = this.configuration.getSnapshot();
        if (current.status === 'ready') {
          if (current.baseline.generation !== generation) finish(Error('TERMINAL_GESTURE_RETIRED'));
          else if (current.baseline.cursor >= cursor) finish();
        }
      };
      const abort = () => finish(Error('TERMINAL_GESTURE_CLOSED'));
      const timer = setTimeout(() => finish(Error('TERMINAL_GESTURE_OBSERVATION_TIMEOUT')), 10000);
      try {
        off = this.configuration.subscribe(check);
        check();
        if (done) return;
        this.lifetime.signal.addEventListener('abort', abort, { once: true });
        if (this.lifetime.signal.aborted) abort();
        else check();
      } catch {
        finish(Error('TERMINAL_GESTURE_NOT_READY'));
      }
    });
  }
  private publish(state: typeof this.state) {
    this.state = Object.freeze(state);
    for (const listener of [...this.listeners]) {
      try {
        listener();
      } catch {
        console.warn('TERMINAL_GESTURE_OBSERVER_FAILED');
      }
    }
  }
}
