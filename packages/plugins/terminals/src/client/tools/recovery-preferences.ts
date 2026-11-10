import { remoteErrorOf } from '@axterm/plugin-api';
import { updateSettingsSchema, type Settings } from '@axterm/plugin-api/configuration';
type TerminalRecoveryPreferences = Partial<
  Pick<
    Settings['terminal'],
    | 'autoReconnectTerminal'
    | 'restoreTerminalSessionOnReload'
    | 'shortcutBarEnabled'
    | 'commandSuggestionsEnabled'
    | 'dragDropBehavior'
  >
>;
const monitorSchema = updateSettingsSchema.shape.terminal
  .unwrap()
  .pick({
    autoReconnectTerminal: true,
    restoreTerminalSessionOnReload: true,
    shortcutBarEnabled: true,
    commandSuggestionsEnabled: true,
    dragDropBehavior: true,
  })
  .strict();
import type { ConfigurationClientActions } from '@axterm/plugin-api/configuration';
type Configuration = Pick<
  ConfigurationClientActions,
  'getSnapshot' | 'subscribe' | 'setTerminalRecoveryPreferences'
>;
/** One immutable preference intent, including the exact key, version and Host generation. */
export class TerminalRecoveryCommands {
  private state = { busy: false, uncertain: false };
  private readonly listeners = new Set<() => void>();
  private readonly lifetime = new AbortController();
  private intent:
    | { generation: string; key: string; etag: string; preferences: TerminalRecoveryPreferences }
    | undefined;
  private pending: Promise<void> | undefined;
  private closing: Promise<void> | undefined;
  constructor(private readonly configuration: Configuration) {
    if (!configuration.setTerminalRecoveryPreferences)
      throw Error('TERMINAL_RECOVERY_CONFIGURATION_CAPABILITY_MISSING');
  }
  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  save(input: TerminalRecoveryPreferences): Promise<void> {
    if (this.closing || this.pending || this.intent)
      return Promise.reject(Error('TERMINAL_RECOVERY_BUSY'));
    const current = this.configuration.getSnapshot();
    if (current.status !== 'ready') return Promise.reject(Error('TERMINAL_RECOVERY_NOT_READY'));
    const parsed = monitorSchema.parse(input);
    const preferences: TerminalRecoveryPreferences = {
      ...(parsed.autoReconnectTerminal === undefined
        ? {}
        : { autoReconnectTerminal: parsed.autoReconnectTerminal }),
      ...(parsed.restoreTerminalSessionOnReload === undefined
        ? {}
        : { restoreTerminalSessionOnReload: parsed.restoreTerminalSessionOnReload }),
      ...(parsed.shortcutBarEnabled === undefined
        ? {}
        : { shortcutBarEnabled: parsed.shortcutBarEnabled }),
      ...(parsed.commandSuggestionsEnabled === undefined
        ? {}
        : { commandSuggestionsEnabled: parsed.commandSuggestionsEnabled }),
      ...(parsed.dragDropBehavior === undefined
        ? {}
        : { dragDropBehavior: parsed.dragDropBehavior }),
    };
    this.intent = {
      generation: current.baseline.generation,
      key: crypto.randomUUID(),
      etag: `"v${current.baseline.settings.version}"`,
      preferences,
    };
    return this.run();
  }
  retry(): Promise<void> {
    if (this.closing || this.pending || !this.intent)
      throw Error('TERMINAL_RECOVERY_NOT_UNCERTAIN');
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
        throw Error('TERMINAL_RECOVERY_DRAIN_UNCERTAIN');
      this.intent = undefined;
    })());
  }
  private run(): Promise<void> {
    const intent = this.intent!;
    this.publish({ busy: true, uncertain: false });
    const task = Promise.resolve()
      .then(async () => {
        const current = this.configuration.getSnapshot();
        if (current.status !== 'ready') throw Error('TERMINAL_RECOVERY_NOT_READY');
        if (current.baseline.generation !== intent.generation) {
          this.intent = undefined;
          throw Error('TERMINAL_RECOVERY_RETIRED');
        }
        const receipt = await this.configuration.setTerminalRecoveryPreferences!(
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
          this.intent ? 'TERMINAL_RECOVERY_OUTCOME_UNCERTAIN' : 'TERMINAL_RECOVERY_SAVE_FAILED',
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
          if (current.baseline.generation !== generation)
            finish(Error('TERMINAL_RECOVERY_RETIRED'));
          else if (current.baseline.cursor >= cursor) finish();
        }
      };
      const abort = () => finish(Error('TERMINAL_RECOVERY_CLOSED'));
      const timer = setTimeout(() => finish(Error('TERMINAL_RECOVERY_OBSERVATION_TIMEOUT')), 10000);
      try {
        off = this.configuration.subscribe(check);
        check();
        if (done) return;
        this.lifetime.signal.addEventListener('abort', abort, { once: true });
        if (this.lifetime.signal.aborted) abort();
        else check();
      } catch {
        finish(Error('TERMINAL_RECOVERY_NOT_READY'));
      }
    });
  }
  private publish(state: typeof this.state) {
    this.state = Object.freeze(state);
    for (const listener of [...this.listeners]) {
      try {
        listener();
      } catch {
        console.warn('TERMINAL_RECOVERY_OBSERVER_FAILED');
      }
    }
  }
}
