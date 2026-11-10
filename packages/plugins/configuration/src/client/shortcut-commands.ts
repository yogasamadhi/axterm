import type { Settings } from '@axterm/plugin-api/configuration';
import { remoteErrorOf } from '@axterm/plugin-api';
import { shortcutDocumentSchema } from '@axterm/plugin-api/configuration';
import type { SettingsModel } from './index.ts';
type Configuration = Pick<SettingsModel, 'getSnapshot' | 'subscribe' | 'setShortcutDocument'>;
/** One immutable preference intent, including the exact key, version and Host generation. */
export class ShortcutDocumentCommands {
  private state = { busy: false, uncertain: false };
  private readonly listeners = new Set<() => void>();
  private readonly lifetime = new AbortController();
  private intent:
    | {
        generation: string;
        key: string;
        etag: string;
        document: NonNullable<Settings['shortcuts']['document']>;
        resetTerminalGestures: boolean;
      }
    | undefined;
  private pending: Promise<void> | undefined;
  private closing: Promise<void> | undefined;
  constructor(private readonly configuration: Configuration) {
    if (!configuration.setShortcutDocument)
      throw Error('SHORTCUT_DOCUMENT_CONFIGURATION_CAPABILITY_MISSING');
  }
  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  save(
    input: NonNullable<Settings['shortcuts']['document']>,
    resetTerminalGestures = false,
  ): Promise<void> {
    if (this.closing || this.pending || this.intent) throw Error('SHORTCUT_DOCUMENT_BUSY');
    const current = this.configuration.getSnapshot();
    if (current.status !== 'ready') throw Error('SHORTCUT_DOCUMENT_NOT_READY');
    this.intent = {
      generation: current.baseline.generation,
      key: crypto.randomUUID(),
      etag: `"v${current.baseline.settings.version}"`,
      document: shortcutDocumentSchema.parse(input),
      resetTerminalGestures,
    };
    return this.run();
  }
  writeRaw(raw: string, generation: string, resetTerminalGestures = false): Promise<void> {
    const current = this.configuration.getSnapshot();
    if (current.status !== 'ready' || current.baseline.generation !== generation)
      throw Error('SHORTCUT_DOCUMENT_RETIRED');
    const value = shortcutDocumentSchema.parse(JSON.parse(raw));
    if (this.intent) {
      if (
        this.intent.generation !== generation ||
        this.intent.resetTerminalGestures !== resetTerminalGestures ||
        JSON.stringify(this.intent.document) !== JSON.stringify(value)
      )
        throw Error('SHORTCUT_DOCUMENT_OUTCOME_UNCERTAIN');
      return this.retry();
    }
    return this.save(value, resetTerminalGestures);
  }
  retry(): Promise<void> {
    if (this.closing || this.pending || !this.intent)
      throw Error('SHORTCUT_DOCUMENT_NOT_UNCERTAIN');
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
        throw Error('SHORTCUT_DOCUMENT_DRAIN_UNCERTAIN');
      this.intent = undefined;
    })());
  }
  private run(): Promise<void> {
    const intent = this.intent!;
    this.publish({ busy: true, uncertain: false });
    const task = Promise.resolve()
      .then(async () => {
        const current = this.configuration.getSnapshot();
        if (current.status !== 'ready') throw Error('SHORTCUT_DOCUMENT_NOT_READY');
        if (current.baseline.generation !== intent.generation) {
          this.intent = undefined;
          throw Error('SHORTCUT_DOCUMENT_RETIRED');
        }
        const receipt = await this.configuration.setShortcutDocument!(
          intent.key,
          intent.document,
          intent.etag,
          intent.generation,
          intent.resetTerminalGestures,
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
          this.intent ? 'SHORTCUT_DOCUMENT_OUTCOME_UNCERTAIN' : 'SHORTCUT_DOCUMENT_SAVE_FAILED',
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
            finish(Error('SHORTCUT_DOCUMENT_RETIRED'));
          else if (current.baseline.cursor >= cursor) finish();
        }
      };
      const abort = () => finish(Error('SHORTCUT_DOCUMENT_CLOSED'));
      const timer = setTimeout(() => finish(Error('SHORTCUT_DOCUMENT_OBSERVATION_TIMEOUT')), 10000);
      try {
        off = this.configuration.subscribe(check);
        check();
        if (done) return;
        this.lifetime.signal.addEventListener('abort', abort, { once: true });
        if (this.lifetime.signal.aborted) abort();
        else check();
      } catch {
        finish(Error('SHORTCUT_DOCUMENT_NOT_READY'));
      }
    });
  }
  private publish(state: typeof this.state) {
    this.state = Object.freeze(state);
    for (const listener of [...this.listeners]) {
      try {
        listener();
      } catch {
        console.warn('SHORTCUT_DOCUMENT_OBSERVER_FAILED');
      }
    }
  }
}
