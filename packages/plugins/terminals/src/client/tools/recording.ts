import { remoteErrorOf } from '@axterm/plugin-api';
import type { FileGrantActions } from '@axterm/plugin-api/files';
import type { StartTerminalRecordingInput } from '@axterm/plugin-api/terminals';
import type { TerminalsModel } from '../index.ts';
interface Intent {
  generation: string;
  key: string;
  id: string;
  operation: 'start' | 'stop';
  input?: StartTerminalRecordingInput;
  requested: boolean;
  pickerRequested?: boolean;
  stopKey?: string;
  stopped?: boolean;
}
/** Exact-key recording admissions and grant transfer; no automatic command replay. */
export class TerminalRecordingCommands {
  private readonly lifetime = new AbortController();
  private readonly intents = new Map<string, Intent>();
  private readonly pending = new Map<string, Promise<void>>();
  private readonly listeners = new Set<() => void>();
  private state: Readonly<{
    busy: readonly string[];
    uncertain: readonly string[];
    failed: boolean;
  }> = { busy: [], uncertain: [], failed: false };
  private closing: Promise<void> | undefined;
  constructor(
    private readonly model: Pick<
      TerminalsModel,
      'getSnapshot' | 'startRecording' | 'stopRecording' | 'getRecordingOutcome'
    >,
    private readonly grants: FileGrantActions,
  ) {
    if (!grants.createInGeneration) throw Error('TERMINAL_RECORDING_PICKER_CAPABILITY_MISSING');
  }
  getSnapshot = () => this.state;
  dismiss = () => this.publish(false);
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  run(id: string, includeRecent = false): Promise<void> {
    if (this.closing || this.pending.has(id) || this.intents.has(id) || this.pending.size >= 16)
      return Promise.reject(Error('TERMINAL_RECORDING_BUSY'));
    const state = this.model.getSnapshot();
    if (state.status !== 'ready') return Promise.reject(Error('TERMINAL_RECORDING_NOT_READY'));
    const session = state.baseline.sessions.find((session) => session.id === id);
    if (!session || session.state !== 'ready')
      return Promise.reject(Error('TERMINAL_RECORDING_RETIRED'));
    const intent: Intent = {
      generation: state.baseline.generation,
      key: crypto.randomUUID(),
      id,
      operation: session.recording?.state === 'active' && !includeRecent ? 'stop' : 'start',
      requested: false,
    };
    if (includeRecent && session.recording?.state === 'active')
      intent.stopKey = crypto.randomUUID();
    this.intents.set(id, intent);
    return this.start(intent, includeRecent, session.behavior.logTimestamps);
  }
  retry(id: string): Promise<void> {
    const intent = this.intents.get(id);
    if (this.closing || this.pending.has(id) || !intent)
      return Promise.reject(Error('TERMINAL_RECORDING_NOT_UNCERTAIN'));
    return this.start(intent, false, false);
  }
  private start(intent: Intent, includeRecent: boolean, timestamps: boolean): Promise<void> {
    const task = (async () => {
      try {
        this.assert(intent);
        this.lifetime.signal.throwIfAborted();
        if (intent.operation === 'start' && !intent.input) {
          if (intent.pickerRequested) throw Error('TERMINAL_RECORDING_PICKER_OUTCOME_UNCERTAIN');
          intent.pickerRequested = true;
          const grant = await this.grants.createInGeneration!(
            { kind: 'save-file' },
            intent.generation,
            this.lifetime.signal,
          );
          if (!grant) {
            this.intents.delete(intent.id);
            return;
          }
          intent.input = { grantId: grant.grantId, timestamps, includeRecent };
          this.assert(intent);
          this.lifetime.signal.throwIfAborted();
        }
        if (intent.stopKey && !intent.stopped) {
          intent.requested = true;
          await this.model.stopRecording(intent.generation, intent.stopKey, intent.id);
          intent.stopped = true;
          intent.requested = false;
          this.assert(intent);
          this.lifetime.signal.throwIfAborted();
        }
        intent.requested = true;
        const result =
          intent.operation === 'start'
            ? await this.model.startRecording(
                intent.generation,
                intent.key,
                intent.id,
                intent.input!,
              )
            : await this.model.stopRecording(intent.generation, intent.key, intent.id);
        if (result.terminalId !== intent.id) throw Error('TERMINAL_RECORDING_RECEIPT_MISMATCH');
        this.intents.delete(intent.id);
      } catch (error) {
        const reason = remoteErrorOf(error),
          current = this.model.getSnapshot();
        const definite =
          (reason?.code === 'terminals/failure' || reason?.code === 'files/failure') &&
          [
            'invalid-input',
            'not-found',
            'closed',
            'cancelled',
            'conflict',
            'stale',
            'forbidden',
            'capacity',
            'receipt-expired',
          ].includes(reason.details.reason);
        if (
          (!intent.requested && (!intent.pickerRequested || !!intent.input)) ||
          definite ||
          (current.status === 'ready' && current.baseline.generation !== intent.generation)
        ) {
          await this.release(intent);
          this.intents.delete(intent.id);
        }
        this.publish(true);
        throw error;
      }
    })();
    this.pending.set(intent.id, task);
    this.publish(false);
    const done = () => {
      if (this.pending.get(intent.id) === task) this.pending.delete(intent.id);
      this.publish();
    };
    void task.then(done, done);
    return task;
  }
  close(): Promise<void> {
    return (this.closing ??= (async () => {
      this.lifetime.abort();
      await Promise.allSettled([...this.pending.values()]);
      const results = await Promise.allSettled(
        [...this.intents.values()].map(async (intent) => {
          const state = this.model.getSnapshot();
          if (state.status === 'ready' && state.baseline.generation !== intent.generation) {
            this.intents.delete(intent.id);
            return;
          }
          if (!intent.requested) {
            if (intent.pickerRequested && !intent.input)
              throw Error('TERMINAL_RECORDING_PICKER_OUTCOME_UNCERTAIN');
            await this.release(intent);
            this.intents.delete(intent.id);
            return;
          }
          const outcome = await this.model.getRecordingOutcome(
            intent.generation,
            intent.stopKey && !intent.stopped ? intent.stopKey : intent.key,
          );
          if (outcome.status === 'accepted' && outcome.id === intent.id) {
            if (intent.stopKey && !intent.stopped) await this.release(intent);
            this.intents.delete(intent.id);
          } else if (outcome.status === 'missing') {
            await this.release(intent);
            this.intents.delete(intent.id);
          }
        }),
      );
      this.listeners.clear();
      if (this.intents.size || results.some((result) => result.status === 'rejected'))
        throw Error('TERMINAL_RECORDING_DRAIN_UNCERTAIN');
    })());
  }
  private assert(intent: Intent): void {
    const state = this.model.getSnapshot();
    if (state.status !== 'ready' || state.baseline.generation !== intent.generation)
      throw Error('TERMINAL_RECORDING_RETIRED');
  }
  private async release(intent: Intent): Promise<void> {
    if (!intent.input) return;
    const state = this.model.getSnapshot();
    if (state.status === 'ready' && state.baseline.generation === intent.generation) {
      if (!this.grants.revokeInGeneration)
        throw Error('TERMINAL_RECORDING_GRANT_CAPABILITY_MISSING');
      await this.grants.revokeInGeneration(intent.input.grantId, intent.generation);
    } else if (state.status !== 'ready') throw Error('TERMINAL_RECORDING_GRANT_DRAIN_UNCERTAIN');
  }
  private publish(failed = this.state.failed): void {
    this.state = Object.freeze({
      busy: Object.freeze([...this.pending.keys()]),
      uncertain: Object.freeze([...this.intents.keys()].filter((id) => !this.pending.has(id))),
      failed,
    });
    for (const listener of [...this.listeners]) {
      try {
        listener();
      } catch {
        console.warn('TERMINAL_RECORDING_OBSERVER_FAILED');
      }
    }
  }
}
