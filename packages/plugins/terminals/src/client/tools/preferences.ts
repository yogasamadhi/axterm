import { remoteErrorOf } from '@axterm/plugin-api';
import { updateSettingsSchema, type Settings } from '@axterm/plugin-api/configuration';
type MonitorPreferences = Settings['monitor'];
const monitorSchema = updateSettingsSchema.shape.monitor.unwrap().required();
import type { ConfigurationClientActions } from '@axterm/plugin-api/configuration';
type Configuration = Pick<
  ConfigurationClientActions,
  'getSnapshot' | 'subscribe' | 'setMonitorPreferences'
>;
/** One immutable preference intent, including the exact key, version and Host generation. */
export class TerminalMonitorCommands {
  private state = { busy: false, uncertain: false };
  private readonly listeners = new Set<() => void>();
  private readonly lifetime = new AbortController();
  private intent:
    { generation: string; key: string; etag: string; preferences: MonitorPreferences } | undefined;
  private pending: Promise<void> | undefined;
  private closing: Promise<void> | undefined;
  constructor(private readonly configuration: Configuration) {
    if (!configuration.setMonitorPreferences)
      throw Error('TERMINAL_MONITOR_CONFIGURATION_CAPABILITY_MISSING');
  }
  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  save(input: MonitorPreferences): Promise<void> {
    if (this.closing || this.pending || this.intent)
      return Promise.reject(Error('TERMINAL_MONITOR_BUSY'));
    const current = this.configuration.getSnapshot();
    if (current.status !== 'ready') return Promise.reject(Error('TERMINAL_MONITOR_NOT_READY'));
    this.intent = {
      generation: current.baseline.generation,
      key: crypto.randomUUID(),
      etag: `"v${current.baseline.settings.version}"`,
      preferences: monitorSchema.parse(input),
    };
    return this.run();
  }
  retry(): Promise<void> {
    if (this.closing || this.pending || !this.intent) throw Error('TERMINAL_MONITOR_NOT_UNCERTAIN');
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
        throw Error('TERMINAL_MONITOR_DRAIN_UNCERTAIN');
      this.intent = undefined;
    })());
  }
  private run(): Promise<void> {
    const intent = this.intent!;
    this.publish({ busy: true, uncertain: false });
    const task = Promise.resolve()
      .then(async () => {
        const current = this.configuration.getSnapshot();
        if (current.status !== 'ready') throw Error('TERMINAL_MONITOR_NOT_READY');
        if (current.baseline.generation !== intent.generation) {
          this.intent = undefined;
          throw Error('TERMINAL_MONITOR_RETIRED');
        }
        const receipt = await this.configuration.setMonitorPreferences!(
          intent.key,
          intent.preferences,
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
          this.intent ? 'TERMINAL_MONITOR_OUTCOME_UNCERTAIN' : 'TERMINAL_MONITOR_SAVE_FAILED',
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
          if (current.baseline.generation !== generation) finish(Error('TERMINAL_MONITOR_RETIRED'));
          else if (current.baseline.cursor >= cursor) finish();
        }
      };
      const abort = () => finish(Error('TERMINAL_MONITOR_CLOSED'));
      const timer = setTimeout(() => finish(Error('TERMINAL_MONITOR_OBSERVATION_TIMEOUT')), 10000);
      try {
        off = this.configuration.subscribe(check);
        check();
        if (done) return;
        this.lifetime.signal.addEventListener('abort', abort, { once: true });
        if (this.lifetime.signal.aborted) abort();
        else check();
      } catch {
        finish(Error('TERMINAL_MONITOR_NOT_READY'));
      }
    });
  }
  private publish(state: typeof this.state) {
    this.state = Object.freeze(state);
    for (const listener of [...this.listeners]) {
      try {
        listener();
      } catch {
        console.warn('TERMINAL_MONITOR_OBSERVER_FAILED');
      }
    }
  }
}
