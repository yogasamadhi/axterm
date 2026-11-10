import { remoteErrorOf } from '@axterm/plugin-api';
import {
  idSchema,
  terminalThemeInputSchema,
  terminalVisualSettingsSchema,
  type TerminalTheme,
  type TerminalThemeInput,
  type TerminalVisualSettings,
} from '@axterm/plugin-api/terminals';
import type { ConfigurationClientActions } from '@axterm/plugin-api/configuration';
import type { TerminalFactsModel } from '../facts.ts';
interface Result {
  readonly kind: 'save' | 'clone' | 'delete' | 'apply';
  readonly id?: string;
  readonly visual?: TerminalVisualSettings;
}
interface State {
  readonly busy: boolean;
  readonly uncertain: boolean;
  readonly failed: boolean;
  readonly completed: number;
  readonly result?: Result;
}
type Facts = Pick<
  TerminalFactsModel,
  | 'getSnapshot'
  | 'subscribe'
  | 'createTerminalTheme'
  | 'cloneTerminalTheme'
  | 'updateTerminalTheme'
  | 'deleteTerminalTheme'
>;
/** One immutable, generation-fenced write intent. Only its owner's model supplies accepted facts. */
export class TerminalThemeCommands {
  private state: State = { busy: false, uncertain: false, failed: false, completed: 0 };
  private readonly listeners = new Set<() => void>();
  private readonly lifetime = new AbortController();
  private retained:
    | { generation: string; invoke: () => Promise<Result>; settle?: (accepted: boolean) => void }
    | undefined;
  private pending: Promise<void> | undefined;
  private closing: Promise<void> | undefined;
  constructor(
    private readonly facts: Facts,
    private readonly configuration: ConfigurationClientActions,
    private readonly protectApplication?: (
      visual: TerminalVisualSettings,
    ) => (accepted: boolean) => void,
  ) {}
  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  save(input: TerminalThemeInput, current?: TerminalTheme) {
    const request = terminalThemeInputSchema.parse(input),
      id = current?.id,
      etag = current ? `"v${current.version}"` : undefined,
      generation = this.generation();
    return this.command(generation, async (key) => {
      const receipt = id
        ? await this.facts.updateTerminalTheme(key, id, request, etag, generation)
        : await this.facts.createTerminalTheme(key, request, generation);
      await this.observed(this.facts, receipt.cursor, generation);
      return { kind: 'save', id: idSchema.parse(receipt.ids[0]) };
    });
  }
  clone(current: TerminalTheme) {
    const id = current.id,
      generation = this.generation();
    return this.command(generation, async (key) => {
      const receipt = await this.facts.cloneTerminalTheme(key, id, undefined, generation);
      await this.observed(this.facts, receipt.cursor, generation);
      return { kind: 'clone', id: idSchema.parse(receipt.ids[0]) };
    });
  }
  remove(current: TerminalTheme) {
    const id = current.id,
      etag = `"v${current.version}"`,
      generation = this.generation();
    return this.command(generation, async (key) => {
      const receipt = await this.facts.deleteTerminalTheme(key, id, etag, generation);
      await this.observed(this.facts, receipt.cursor, generation);
      return { kind: 'delete', id };
    });
  }
  apply(input: TerminalVisualSettings) {
    const visual = terminalVisualSettingsSchema.parse(input),
      generation = this.generation(),
      settings = this.configuration.getSnapshot();
    if (
      settings.status !== 'ready' ||
      settings.baseline.generation !== generation ||
      !this.configuration.setTerminalVisual
    )
      throw Error('TERMINAL_THEME_SETTINGS_NOT_READY');
    const etag = `"v${settings.baseline.settings.version}"`;
    const settle = this.protectApplication?.(visual);
    try {
      return this.command(
        generation,
        async (key) => {
          const receipt = await this.configuration.setTerminalVisual!(
            key,
            visual,
            etag,
            generation,
          );
          await this.observed(this.configuration, receipt.cursor, generation);
          return { kind: 'apply', visual };
        },
        settle,
      );
    } catch (error) {
      settle?.(false);
      throw error;
    }
  }
  retry() {
    if (!this.retained || this.pending || this.closing) throw Error('TERMINAL_THEME_NOT_UNCERTAIN');
    return this.run();
  }
  close(): Promise<void> {
    return (this.closing ??= (async () => {
      this.lifetime.abort();
      await this.pending;
      this.listeners.clear();
      if (this.retained) {
        const state = this.facts.getSnapshot();
        if (state.status !== 'ready' || state.baseline.generation === this.retained.generation)
          throw Error('TERMINAL_THEME_DRAIN_UNCERTAIN');
        this.retained = undefined;
      }
    })());
  }
  private generation() {
    const state = this.facts.getSnapshot();
    if (state.status !== 'ready') throw Error('TERMINAL_THEME_NOT_READY');
    return state.baseline.generation;
  }
  private command(
    generation: string,
    invoke: (key: string) => Promise<Result>,
    settle?: (accepted: boolean) => void,
  ) {
    if (this.closing || this.pending || this.retained) throw Error('TERMINAL_THEME_BUSY');
    const key = crypto.randomUUID();
    this.retained = { generation, invoke: () => invoke(key), ...(settle ? { settle } : {}) };
    return this.run();
  }
  private run(): Promise<void> {
    const intent = this.retained!;
    if (this.generation() !== intent.generation) {
      intent.settle?.(false);
      this.retained = undefined;
      this.publish({ ...this.state, busy: false, uncertain: false, failed: true });
      return Promise.resolve();
    }
    this.publish({ ...this.state, busy: true, uncertain: false, failed: false });
    const task = Promise.resolve()
      .then(async () => {
        if (this.generation() !== intent.generation)
          throw Error('TERMINAL_THEME_GENERATION_CHANGED');
        const result = await intent.invoke();
        if (this.generation() !== intent.generation)
          throw Error('TERMINAL_THEME_GENERATION_CHANGED');
        return result;
      })
      .then(
        (result) => {
          intent.settle?.(true);
          this.retained = undefined;
          this.publish({
            busy: false,
            uncertain: false,
            failed: false,
            completed: this.state.completed + 1,
            result,
          });
        },
        (error) => {
          const marked = remoteErrorOf(error),
            current = this.facts.getSnapshot();
          const retired =
            current.status === 'ready' && current.baseline.generation !== intent.generation;
          const definite =
            (marked?.code === 'terminals/failure' || marked?.code === 'configuration/failure') &&
            [
              'invalid-input',
              'not-found',
              'closed',
              'capacity',
              'conflict',
              'stale',
              'precondition-required',
              'precondition-failed',
              'receipt-expired',
            ].includes(marked.details.reason);
          if (retired || definite) {
            intent.settle?.(false);
            this.retained = undefined;
          }
          this.publish({ ...this.state, busy: false, uncertain: !!this.retained, failed: true });
        },
      );
    this.pending = task;
    void task.finally(() => {
      if (this.pending === task) this.pending = undefined;
    });
    return task;
  }
  private observed(
    source: Pick<ConfigurationClientActions, 'getSnapshot' | 'subscribe'> | Facts,
    cursor: number,
    generation: string,
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      let off = () => {},
        settled = false;
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        off();
        this.lifetime.signal.removeEventListener('abort', abort);
        if (error) reject(error);
        else resolve();
      };
      const check = () => {
        const state = source.getSnapshot();
        if (state.status === 'ready') {
          if (state.baseline.generation !== generation)
            finish(Error('TERMINAL_THEME_GENERATION_CHANGED'));
          else if (state.baseline.cursor >= cursor) finish();
        }
      };
      const abort = () => finish(Error('TERMINAL_THEME_CLOSED'));
      const timer = setTimeout(() => finish(Error('TERMINAL_THEME_OBSERVATION_TIMEOUT')), 10000);
      off = source.subscribe(check);
      this.lifetime.signal.addEventListener('abort', abort, { once: true });
      if (this.lifetime.signal.aborted) abort();
      else check();
    });
  }
  private publish(state: State) {
    this.state = Object.freeze(state);
    for (const listener of [...this.listeners]) {
      try {
        listener();
      } catch {
        console.warn('TERMINAL_THEME_OBSERVER_FAILED');
      }
    }
  }
}
