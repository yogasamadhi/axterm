import { remoteErrorOf } from '@axterm/plugin-api';
import {
  terminalShortcutButtonsSchema,
  type TerminalShortcutButton,
} from '@axterm/plugin-api/terminals';
import type { ConfigurationClientActions } from '@axterm/plugin-api/configuration';
type Configuration = Pick<
  ConfigurationClientActions,
  'getSnapshot' | 'subscribe' | 'setTerminalShortcutBarButtons'
>;
/** One immutable preference intent, including the exact key, version and Host generation. */
export class TerminalKeyBarCommands {
  private state = { busy: false, uncertain: false };
  private readonly listeners = new Set<() => void>();
  private readonly lifetime = new AbortController();
  private intent:
    | { generation: string; key: string; etag: string; buttons: TerminalShortcutButton[] }
    | undefined;
  private pending: Promise<void> | undefined;
  private closing: Promise<void> | undefined;
  constructor(private readonly configuration: Configuration) {
    if (!configuration.setTerminalShortcutBarButtons)
      throw Error('TERMINAL_KEYBAR_CONFIGURATION_CAPABILITY_MISSING');
  }
  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  save(input: TerminalShortcutButton[]): Promise<void> {
    if (this.closing || this.pending || this.intent) throw Error('TERMINAL_KEYBAR_BUSY');
    const current = this.configuration.getSnapshot();
    if (current.status !== 'ready') throw Error('TERMINAL_KEYBAR_NOT_READY');
    this.intent = {
      generation: current.baseline.generation,
      key: crypto.randomUUID(),
      etag: `"v${current.baseline.settings.version}"`,
      buttons: terminalShortcutButtonsSchema.parse(input),
    };
    return this.run();
  }
  retry(): Promise<void> {
    if (this.closing || this.pending || !this.intent) throw Error('TERMINAL_KEYBAR_NOT_UNCERTAIN');
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
        throw Error('TERMINAL_KEYBAR_DRAIN_UNCERTAIN');
      this.intent = undefined;
    })());
  }
  private run(): Promise<void> {
    const intent = this.intent!;
    this.publish({ busy: true, uncertain: false });
    const task = Promise.resolve()
      .then(async () => {
        const current = this.configuration.getSnapshot();
        if (current.status !== 'ready') throw Error('TERMINAL_KEYBAR_NOT_READY');
        if (current.baseline.generation !== intent.generation) {
          this.intent = undefined;
          throw Error('TERMINAL_KEYBAR_RETIRED');
        }
        const receipt = await this.configuration.setTerminalShortcutBarButtons!(
          intent.key,
          intent.buttons,
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
          this.intent ? 'TERMINAL_KEYBAR_OUTCOME_UNCERTAIN' : 'TERMINAL_KEYBAR_SAVE_FAILED',
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
          if (current.baseline.generation !== generation) finish(Error('TERMINAL_KEYBAR_RETIRED'));
          else if (current.baseline.cursor >= cursor) finish();
        }
      };
      const abort = () => finish(Error('TERMINAL_KEYBAR_CLOSED'));
      const timer = setTimeout(() => finish(Error('TERMINAL_KEYBAR_OBSERVATION_TIMEOUT')), 10000);
      try {
        off = this.configuration.subscribe(check);
        check();
        if (done) return;
        this.lifetime.signal.addEventListener('abort', abort, { once: true });
        if (this.lifetime.signal.aborted) abort();
        else check();
      } catch {
        finish(Error('TERMINAL_KEYBAR_NOT_READY'));
      }
    });
  }
  private publish(state: typeof this.state) {
    this.state = Object.freeze(state);
    for (const listener of [...this.listeners]) {
      try {
        listener();
      } catch {
        console.warn('TERMINAL_KEYBAR_OBSERVER_FAILED');
      }
    }
  }
}
