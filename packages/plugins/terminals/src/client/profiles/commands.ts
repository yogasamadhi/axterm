import { remoteErrorOf } from '@axterm/plugin-api';
import {
  terminalProfileInputSchema,
  type TerminalProfile,
  type TerminalProfileInput,
} from '@axterm/plugin-api/terminals';
import type { ConfigurationClientActions } from '@axterm/plugin-api/configuration';
import type { TerminalFactsModel } from '../facts.ts';
interface CommandState {
  readonly busy: boolean;
  readonly uncertain: boolean;
  readonly failed: boolean;
  readonly completed: number;
}
type Facts = Pick<
  TerminalFactsModel,
  'getSnapshot' | 'createTerminalProfile' | 'updateTerminalProfile' | 'deleteTerminalProfile'
>;
/** Terminal facts and Configuration preferences keep separate owners and captured preconditions. */
export class TerminalProfileCommands {
  private state: CommandState = { busy: false, uncertain: false, failed: false, completed: 0 };
  private readonly listeners = new Set<() => void>();
  private retained: { generation: string; invoke: () => Promise<unknown> } | undefined;
  private pending: Promise<void> | undefined;
  private closing: Promise<void> | undefined;
  constructor(
    private readonly model: Facts,
    private readonly configuration: ConfigurationClientActions,
  ) {}
  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  save(input: TerminalProfileInput, current?: TerminalProfile) {
    const request = terminalProfileInputSchema.parse(input);
    const id = current?.id,
      version = current?.version;
    return this.fact((key) =>
      id
        ? this.model.updateTerminalProfile(key, id, request, `"v${version}"`)
        : this.model.createTerminalProfile(key, request),
    );
  }
  remove(current: TerminalProfile) {
    const id = current.id,
      version = current.version;
    return this.fact((key) => this.model.deleteTerminalProfile(key, id, `"v${version}"`));
  }
  setDefault(id: string | null) {
    const facts = this.model.getSnapshot(),
      settings = this.configuration.getSnapshot();
    if (
      facts.status !== 'ready' ||
      settings.status !== 'ready' ||
      facts.baseline.generation !== settings.baseline.generation
    )
      throw new Error('TERMINAL_PROFILE_SETTINGS_NOT_READY');
    if (id !== null && !facts.baseline.profiles.some((profile) => profile.id === id))
      throw new Error('TERMINAL_PROFILE_MISSING');
    const version = settings.baseline.settings.version;
    return this.fact((key) =>
      this.configuration.setDefaultTerminalProfile(key, id, `"v${version}"`),
    );
  }
  retry() {
    if (this.closing || this.pending || !this.retained)
      throw new Error('TERMINAL_PROFILE_NOT_UNCERTAIN');
    return this.run();
  }
  close(): Promise<void> {
    return (this.closing ??= (async () => {
      await this.pending;
      this.listeners.clear();
      const facts = this.model.getSnapshot();
      if (
        this.retained &&
        (facts.status !== 'ready' || facts.baseline.generation === this.retained.generation)
      )
        throw new Error('TERMINAL_PROFILE_DRAIN_UNCERTAIN');
      this.retained = undefined;
    })());
  }
  private fact(invoke: (key: string) => Promise<unknown>) {
    if (this.closing || this.pending || this.retained) throw new Error('TERMINAL_PROFILE_BUSY');
    const facts = this.model.getSnapshot();
    if (facts.status !== 'ready') throw new Error('TERMINAL_PROFILE_NOT_READY');
    const key = crypto.randomUUID();
    this.retained = { generation: facts.baseline.generation, invoke: () => invoke(key) };
    return this.run();
  }
  private run() {
    const retained = this.retained!;
    const facts = this.model.getSnapshot();
    if (facts.status === 'ready' && facts.baseline.generation !== retained.generation) {
      this.retained = undefined;
      this.publish({ ...this.state, busy: false, uncertain: false, failed: true });
      return Promise.resolve();
    }
    if (facts.status !== 'ready') {
      this.publish({ ...this.state, uncertain: true });
      return Promise.resolve();
    }
    this.publish({ ...this.state, busy: true, failed: false });
    const task = Promise.resolve()
      .then(async () => {
        const current = this.model.getSnapshot();
        if (current.status !== 'ready') throw new Error('TERMINAL_PROFILE_NOT_READY');
        if (current.baseline.generation !== retained.generation) {
          this.retained = undefined;
          throw new Error('TERMINAL_PROFILE_GENERATION_CHANGED');
        }
        await retained.invoke();
        const after = this.model.getSnapshot();
        if (after.status === 'ready' && after.baseline.generation !== retained.generation) {
          this.retained = undefined;
          throw new Error('TERMINAL_PROFILE_GENERATION_CHANGED');
        }
      })
      .then(
        () => {
          this.retained = undefined;
          this.publish({
            busy: false,
            uncertain: false,
            failed: false,
            completed: this.state.completed + 1,
          });
        },
        (error) => {
          const marked = remoteErrorOf(error);
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
            ].includes(marked.details.reason);
          if (definite) this.retained = undefined;
          this.publish({ ...this.state, busy: false, uncertain: !!this.retained, failed: true });
        },
      );
    this.pending = task;
    void task
      .finally(() => {
        if (this.pending === task) this.pending = undefined;
      })
      .catch(() => {});
    return task;
  }
  private publish(state: CommandState) {
    this.state = Object.freeze(state);
    if (!this.closing)
      for (const listener of this.listeners) {
        try {
          listener();
        } catch {
          console.warn('TERMINAL_PROFILE_UI_OBSERVER_FAILED');
        }
      }
  }
}
