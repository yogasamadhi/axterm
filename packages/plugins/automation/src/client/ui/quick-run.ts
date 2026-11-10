import type { TerminalSessionsView } from '@axterm/plugin-api/terminals';
import type { TerminalDraftUi, TerminalInputUi, WorkspaceUi } from '@axterm/ui/workspace';
import {
  expandQuickCommandTemplates,
  terminalSafeQuickCommandInsertion,
} from './quick-command-model.ts';
export interface RunnableSteps {
  readonly steps: readonly { command: string; delayMs: number }[];
  readonly inputOnly: boolean;
}
/** An explicit user run owns one exact renderer and generation; inputs are never replayed. */
export class QuickCommandRunner {
  private readonly lifetime = new AbortController();
  private readonly pending = new Set<Promise<void>>();
  private closing: Promise<void> | undefined;
  constructor(
    private readonly terminals: TerminalSessionsView,
    private readonly workspace: WorkspaceUi,
    private readonly input: TerminalInputUi,
    private readonly drafts: TerminalDraftUi,
    private readonly clipboard: () => Promise<string>,
  ) {}
  run(id: string, command: RunnableSteps, signal?: AbortSignal): Promise<void> {
    return this.perform(id, command, false, signal);
  }
  insert(id: string, command: RunnableSteps, signal?: AbortSignal): Promise<void> {
    return this.perform(id, command, true, signal);
  }
  private perform(
    id: string,
    command: RunnableSteps,
    insert: boolean,
    signal?: AbortSignal,
  ): Promise<void> {
    signal?.throwIfAborted();
    if (this.lifetime.signal.aborted || this.pending.size) throw Error('QUICK_COMMAND_BUSY');
    const state = this.terminals.getSnapshot();
    if (state.status !== 'ready' || !state.baseline.sessions.some((value) => value.id === id))
      throw Error('QUICK_COMMAND_TARGET_UNAVAILABLE');
    const generation = state.baseline.generation,
      request = structuredClone(command),
      retired = new AbortController(),
      owned = AbortSignal.any([this.lifetime.signal, retired.signal, ...(signal ? [signal] : [])]);
    if (
      !request.steps.length ||
      request.steps.length > 32 ||
      request.steps.some(
        (value) => !Number.isInteger(value.delayMs) || value.delayMs < 0 || value.delayMs > 65535,
      )
    )
      throw Error('QUICK_COMMAND_INVALID');
    const check = () => {
      const current = this.terminals.getSnapshot();
      if (
        current.status !== 'ready' ||
        current.baseline.generation !== generation ||
        !current.baseline.sessions.some((value) => value.id === id) ||
        this.workspace.getSnapshot().activeTabId !== id
      )
        retired.abort();
    };
    const offFacts = this.terminals.subscribe(check),
      offWorkspace = this.workspace.subscribe(check);
    check();
    const task = (async () => {
      try {
        owned.throwIfAborted();
        const steps = await expandQuickCommandTemplates(request.steps, async () => {
          const value = await this.clipboard();
          if (new TextEncoder().encode(value).byteLength > 64 * 1024)
            throw Error('QUICK_COMMAND_CLIPBOARD_LIMIT');
          return value;
        });
        owned.throwIfAborted();
        if (
          steps.reduce((size, value) => size + new TextEncoder().encode(value).byteLength, 0) >
          256 * 1024
        )
          throw Error('QUICK_COMMAND_INPUT_LIMIT');
        if (insert) {
          await this.drafts.insertDraft(id, terminalSafeQuickCommandInsertion(steps), owned);
          return;
        }
        for (let index = 0; index < steps.length; index++) {
          await delay(request.steps[index]!.delayMs, owned);
          check();
          owned.throwIfAborted();
          await this.input.sendInput(id, steps[index]! + (request.inputOnly ? '' : '\r'), owned);
        }
      } finally {
        offFacts();
        offWorkspace();
      }
    })();
    this.pending.add(task);
    const done = () => this.pending.delete(task);
    void task.then(done, done);
    return task;
  }
  close(): Promise<void> {
    return (this.closing ??= (async () => {
      this.lifetime.abort();
      await Promise.allSettled([...this.pending]);
    })());
  }
}
function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted();
    const abort = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      reject(Error('QUICK_COMMAND_CANCELLED'));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', abort);
      resolve();
    }, ms);
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
  });
}
