import { remoteErrorOf } from '@axterm/plugin-api';
import type { TransferClientActions } from '@axterm/plugin-api/transfers';
interface Command {
  readonly row: string;
  readonly key: string;
  readonly generation: string;
  readonly perform: (key: string) => Promise<unknown>;
  state: 'running' | 'uncertain';
}
/** Private, bounded command intents; no cached transfer facts or automatic replay. */
export class TransferUiCommands {
  private readonly commands = new Map<string, Command>();
  private readonly pending = new Set<Promise<unknown>>();
  private readonly listeners = new Set<() => void>();
  private state: readonly { row: string; key: string; state: Command['state'] }[] = [];
  private closing: Promise<void> | undefined;
  private readonly off: () => void;
  constructor(private readonly model: TransferClientActions) {
    this.off = model.subscribe(() => {
      const facts = model.getSnapshot();
      if (facts.status !== 'ready') return;
      let changed = false;
      for (const [row, command] of this.commands) {
        if (command.generation !== facts.baseline.generation) {
          this.commands.delete(row);
          changed = true;
        }
      }
      if (changed) this.publish();
    });
  }
  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => {
    if (this.closing) throw Error('TRANSFERS_UI_CLOSED');
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  run(row: string, perform: Command['perform']): Promise<unknown> {
    if (this.closing) return Promise.reject(Error('TRANSFERS_UI_CLOSED'));
    if (this.commands.has(row) || this.commands.size >= 16)
      return Promise.reject(Error('TRANSFERS_UI_COMMAND_PENDING'));
    const facts = this.model.getSnapshot();
    if (facts.status !== 'ready') return Promise.reject(Error('TRANSFERS_UI_NOT_READY'));
    const command: Command = {
      row,
      key: crypto.randomUUID(),
      generation: facts.baseline.generation,
      perform,
      state: 'running',
    };
    this.commands.set(row, command);
    this.publish();
    return this.execute(command);
  }
  retry(row: string): Promise<unknown> {
    const command = this.commands.get(row);
    if (this.closing || command?.state !== 'uncertain')
      return Promise.reject(Error('TRANSFERS_UI_NOT_RETRYABLE'));
    command.state = 'running';
    this.publish();
    return this.execute(command);
  }
  close(): Promise<void> {
    return (this.closing ??= (async () => {
      this.off();
      await Promise.allSettled([...this.pending]);
      const facts = this.model.getSnapshot();
      for (const [row, command] of this.commands)
        if (facts.status === 'ready' && command.generation !== facts.baseline.generation)
          this.commands.delete(row);
      this.listeners.clear();
      if (this.commands.size) throw Error('TRANSFERS_UI_UNDRAINED');
    })());
  }
  private execute(command: Command) {
    const task = Promise.resolve()
      .then(() => {
        const facts = this.model.getSnapshot();
        if (facts.status !== 'ready') throw Error('TRANSFERS_UI_NOT_READY');
        if (facts.baseline.generation !== command.generation) {
          if (this.commands.get(command.row) === command) this.commands.delete(command.row);
          throw Error('TRANSFERS_UI_GENERATION_RETIRED');
        }
        return command.perform(command.key);
      })
      .then(
        (value) => {
          if (this.commands.get(command.row) === command) this.commands.delete(command.row);
          this.publish();
          return value;
        },
        (error) => {
          const marked = remoteErrorOf(error);
          if (marked?.code === 'transfers/failure' && marked.details.reason !== 'unavailable') {
            if (this.commands.get(command.row) === command) this.commands.delete(command.row);
          } else command.state = 'uncertain';
          this.publish();
          throw error;
        },
      );
    this.pending.add(task);
    void task.finally(() => this.pending.delete(task)).catch(() => {});
    return task;
  }
  private publish() {
    this.state = Object.freeze(
      [...this.commands.values()].map(({ row, key, state }) => Object.freeze({ row, key, state })),
    );
    for (const listener of this.listeners) {
      try {
        listener();
      } catch {
        console.warn('TRANSFERS_UI_OBSERVER_FAILED');
      }
    }
  }
}
