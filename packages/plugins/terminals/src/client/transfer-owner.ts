import { TerminalRecoveryModel } from './transfer-recovery.ts';
import { remoteErrorOf } from '@axterm/plugin-api';
import type { FileGrantActions } from '@axterm/plugin-api/files';
import type { TerminalTransferAction, TerminalTransferState } from '@axterm/plugin-api/terminals';
import type { TerminalsModel } from './index.ts';
interface Selection {
  id: string;
  generation: string;
  phase: 'selecting' | 'admitting' | 'accepted' | 'uncertain';
  grant?: string;
  key: string;
  action?: TerminalTransferAction;
  runId?: string;
  incoming?: true;
  release?: Promise<void>;
}
const terminal = (state: TerminalTransferState) =>
  ['completed', 'failed', 'canceled'].includes(state.state);
/** Private UI authorities and exact command intents. Business facts remain in TerminalsModel. */
export class TerminalTransferUiOwner {
  private readonly selections = new Map<string, Selection>();
  private readonly seen = new Set<string>();
  private readonly pending = new Set<Promise<unknown>>();
  private readonly listeners = new Set<() => void>();
  private readonly lifetime = new AbortController();
  private readonly off: () => void;
  private recovery: TerminalRecoveryModel | undefined;
  private reviewing = false;
  private state: {
    error: boolean;
    busy: readonly string[];
    uncertain: readonly string[];
    recovery?: TerminalRecoveryModel;
  } = {
    error: false,
    busy: [],
    uncertain: [],
  };
  private closing: Promise<void> | undefined;
  private generation: string | undefined;
  constructor(
    private readonly model: TerminalsModel,
    private readonly grants: FileGrantActions,
  ) {
    this.off = model.subscribe(() => this.observe());
    this.observe();
  }
  getSnapshot = () => this.state;
  subscribe = (fn: () => void) => {
    if (this.closing) throw Error('TERMINAL_TRANSFER_UI_CLOSED');
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };
  start(id: string, direction: 'upload' | 'download') {
    return this.select(id, direction);
  }
  retry(id: string) {
    const value = this.selections.get(id);
    if (!value || value.phase !== 'uncertain' || !value.action || this.closing)
      return Promise.reject(Error('TERMINAL_TRANSFER_UI_NOT_RETRYABLE'));
    return this.track(this.admit(value));
  }
  cancel(id: string) {
    if (this.closing) return Promise.reject(Error('TERMINAL_TRANSFER_UI_CLOSED'));
    const state = this.model.getSnapshot();
    if (state.status !== 'ready') return Promise.reject(Error('TERMINAL_TRANSFER_UI_NOT_READY'));
    let value = this.selections.get(id);
    if (value && value.phase !== 'accepted')
      return Promise.reject(Error('TERMINAL_TRANSFER_UI_BUSY'));
    const runId =
      value?.runId ?? state.baseline.sessions.find((session) => session.id === id)?.transfer?.runId;
    if (!value) {
      if (this.selections.size >= 4) return Promise.reject(Error('TERMINAL_TRANSFER_UI_BUSY'));
      value = {
        id,
        generation: state.baseline.generation,
        phase: 'admitting',
        key: crypto.randomUUID(),
        ...(runId ? { runId } : {}),
      };
      this.selections.set(id, value);
    }
    value.key = crypto.randomUUID();
    value.action = { action: 'cancel', ...(runId ? { runId } : {}) };
    return this.track(this.admit(value));
  }
  reviewRecovery() {
    if (this.closing || this.reviewing || this.recovery)
      return Promise.reject(Error('TERMINAL_RECOVERY_BUSY'));
    const facts = this.model.getSnapshot();
    if (facts.status !== 'ready') return Promise.reject(Error('TERMINAL_TRANSFER_UI_NOT_READY'));
    const generation = facts.baseline.generation;
    this.reviewing = true;
    return this.track(
      (async () => {
        let grant: string | undefined;
        try {
          const selected = await this.choose({ kind: 'open-directory' }, generation);
          grant = selected?.grantId;
          if (!grant) return;
          const current = this.model.getSnapshot();
          if (current.status === 'ready' && current.baseline.generation !== generation)
            throw Error('TERMINAL_TRANSFER_GENERATION_CHANGED');
          if (this.closing) {
            await this.revoke(grant, generation);
            return;
          }
          const model = (this.recovery = new TerminalRecoveryModel(this.model, generation, grant));
          this.publish(false);
          await model.load();
        } catch (error) {
          if (grant && !this.recovery) {
            try {
              await this.revoke(grant, generation);
            } catch {
              this.recovery = new TerminalRecoveryModel(this.model, generation, grant);
            }
          }
          this.publish(true);
          throw error;
        } finally {
          this.reviewing = false;
        }
      })(),
    );
  }
  closeRecovery() {
    return this.track(
      this.releaseRecovery().catch((error) => {
        this.publish(true);
        throw error;
      }),
    );
  }
  private async releaseRecovery() {
    const model = this.recovery;
    if (!model) return;
    await model.close();
    await this.revoke(model.grantId, model.generation);
    if (this.recovery === model) this.recovery = undefined;
    this.publish(this.state.error);
  }
  dismiss() {
    this.publish(false);
  }
  close() {
    return (this.closing ??= (async () => {
      this.lifetime.abort();
      this.off();
      const recoveryClose = this.recovery?.close();
      void recoveryClose?.catch(() => {});
      await Promise.allSettled([...this.pending]);
      const errors = [];
      for (const value of this.selections.values()) {
        if (this.retired(value)) {
          errors.push(Error('TERMINAL_TRANSFER_GENERATION_CHANGED'));
          continue;
        }
        try {
          if (value.phase === 'uncertain') throw Error('TERMINAL_TRANSFER_UI_UNCERTAIN');
          if (value.phase === 'accepted' || value.incoming) {
            try {
              await this.model.performTransfer(
                crypto.randomUUID(),
                value.id,
                { action: 'cancel', ...(value.runId ? { runId: value.runId } : {}) },
                new AbortController().signal,
              );
            } catch (error) {
              const marked = remoteErrorOf(error);
              if (
                !value.runId ||
                marked?.code !== 'terminals/failure' ||
                !['invalid-input', 'not-found'].includes(marked.details.reason)
              )
                throw error;
              // A validated, run-scoped cancel can reject only a missing/retired run before IO.
            }
          }
          await this.release(value);
        } catch (error) {
          errors.push(error);
        }
      }
      try {
        await this.releaseRecovery();
      } catch (error) {
        errors.push(error);
      }
      this.listeners.clear();
      if (errors.length || this.selections.size) throw Error('TERMINAL_TRANSFER_UI_UNDRAINED');
    })());
  }
  private select(
    id: string,
    direction: 'upload' | 'download',
    incoming?: TerminalTransferState,
  ): Promise<void> {
    if (this.closing || this.selections.has(id) || this.selections.size >= 4)
      return Promise.reject(Error('TERMINAL_TRANSFER_UI_BUSY'));
    const state = this.model.getSnapshot();
    if (state.status !== 'ready') return Promise.reject(Error('TERMINAL_TRANSFER_UI_NOT_READY'));
    const value: Selection = {
      id,
      generation: state.baseline.generation,
      phase: 'selecting',
      key: crypto.randomUUID(),
      ...(incoming?.runId ? { runId: incoming.runId, incoming: true as const } : {}),
    };
    this.selections.set(id, value);
    this.publish(false);
    return this.track(
      (async () => {
        try {
          const grant = await this.choose(
            { kind: direction === 'upload' ? 'open-file' : 'open-directory' },
            value.generation,
          );
          if (grant) value.grant = grant.grantId;
          if (this.retired(value)) throw Error('TERMINAL_TRANSFER_GENERATION_CHANGED');
          if (this.closing || this.lifetime.signal.aborted) {
            if (!incoming) await this.release(value);
            return;
          }
          if (!grant) {
            if (incoming) {
              value.action = { action: 'cancel', runId: incoming.runId! };
              await this.admit(value);
            } else await this.release(value);
            return;
          }
          value.action = incoming
            ? {
                action: 'provide-selection',
                runId: incoming.runId!,
                protocol: incoming.protocol === 'trzsz' ? 'trzsz' : 'zmodem',
                grantId: grant.grantId,
              }
            : {
                action: 'start',
                protocol: 'xmodem',
                direction,
                grantId: grant.grantId,
                ...(direction === 'download' ? { fileName: 'xmodem-download.bin' } : {}),
              };
          await this.admit(value);
        } catch (error) {
          if (!value.action) {
            if (incoming && !this.closing && !this.retired(value)) {
              value.action = { action: 'cancel', runId: incoming.runId! };
              try {
                await this.admit(value);
              } catch {
                /* Exact cancel intent is retained if uncertain. */
              }
            }
            if (value.phase !== 'uncertain' && !(this.closing && incoming))
              await this.release(value);
          }
          this.publish(true);
          throw error;
        }
      })(),
    );
  }
  private async admit(value: Selection) {
    if (this.retired(value)) throw Error('TERMINAL_TRANSFER_GENERATION_CHANGED');
    const facts = this.model.getSnapshot();
    if (facts.status !== 'ready' || facts.baseline.generation !== value.generation)
      throw Error('TERMINAL_TRANSFER_UI_NOT_READY');
    value.phase = 'admitting';
    this.publish(false);
    try {
      const accepted = await this.model.performTransfer(
        value.key,
        value.id,
        value.action!,
        this.lifetime.signal,
      );
      if (!accepted.runId) throw Error('TERMINAL_TRANSFER_RUN_ID_REQUIRED');
      value.runId = accepted.runId;
      value.phase = 'accepted';
      if (terminal(accepted)) await this.release(value);
      else this.observe();
    } catch (error) {
      const marked = remoteErrorOf(error);
      if (marked?.code === 'terminals/failure' && marked.details.reason !== 'unavailable')
        await this.release(value);
      else value.phase = 'uncertain';
      this.publish(true);
      throw error;
    }
    this.publish(false);
  }
  private observe() {
    const state = this.model.getSnapshot();
    if (state.status !== 'ready' || this.closing) return;
    if (this.generation !== state.baseline.generation) {
      this.generation = state.baseline.generation;
      this.seen.clear();
    }
    if (this.recovery && this.recovery.generation !== state.baseline.generation)
      void this.track(this.releaseRecovery()).catch(() => this.publish(true));
    for (const value of this.selections.values()) {
      if (this.retired(value)) {
        this.publish(true);
        continue;
      }
      if (value.phase !== 'accepted') continue;
      const current = state.baseline.sessions.find((session) => session.id === value.id);
      if (
        !current ||
        (current.transfer && current.transfer.runId === value.runId && terminal(current.transfer))
      )
        void this.track(this.release(value)).catch(() => this.publish(true));
    }
    for (const session of state.baseline.sessions) {
      const transfer = session.transfer;
      if (
        !transfer?.runId ||
        transfer.protocol === 'xmodem' ||
        transfer.state !== 'waiting-selection' ||
        this.selections.has(session.id) ||
        this.seen.has(transfer.runId)
      )
        continue;
      if (this.seen.size >= 256) {
        this.publish(true);
        break;
      }
      this.seen.add(transfer.runId);
      void this.select(session.id, transfer.direction, transfer).catch(() => this.publish(true));
    }
    this.publish(this.state.error);
  }
  private retired(value: Selection) {
    const state = this.model.getSnapshot();
    return state.status === 'ready' && state.baseline.generation !== value.generation;
  }
  private choose(input: Parameters<FileGrantActions['create']>[0], generation: string) {
    if (!this.grants.createInGeneration || !this.grants.revokeInGeneration)
      throw Error('TERMINAL_TRANSFER_GRANT_FENCING_UNAVAILABLE');
    return this.grants.createInGeneration(input, generation, this.lifetime.signal);
  }
  private async revoke(id: string, generation: string) {
    const state = this.model.getSnapshot();
    if (state.status === 'ready' && state.baseline.generation !== generation)
      throw Error('TERMINAL_TRANSFER_GENERATION_CHANGED');
    if (!this.grants.revokeInGeneration) throw Error('TERMINAL_TRANSFER_GRANT_FENCING_UNAVAILABLE');
    try {
      await this.grants.revokeInGeneration(id, generation);
    } catch (error) {
      const marked = remoteErrorOf(error),
        current = this.model.getSnapshot();
      if (
        marked?.code !== 'files/failure' ||
        marked.details.reason !== 'not-found' ||
        current.status !== 'ready' ||
        current.baseline.generation !== generation
      )
        throw error;
    }
  }
  private release(value: Selection) {
    return (value.release ??= (async () => {
      if (value.grant) await this.revoke(value.grant, value.generation);
      else if (this.retired(value)) throw Error('TERMINAL_TRANSFER_GENERATION_CHANGED');
      if (this.selections.get(value.id) === value) this.selections.delete(value.id);
      this.publish(this.state.error);
    })().finally(() => {
      delete value.release;
    }));
  }
  private track<T>(task: Promise<T>): Promise<T> {
    this.pending.add(task);
    void task.finally(() => this.pending.delete(task)).catch(() => {});
    return task;
  }
  private publish(error: boolean) {
    this.state = Object.freeze({
      error,
      busy: Object.freeze(
        [...this.selections.values()]
          .filter((v) => ['selecting', 'admitting'].includes(v.phase))
          .map((v) => v.id),
      ),
      ...(this.recovery ? { recovery: this.recovery } : {}),
      uncertain: Object.freeze(
        [...this.selections.values()].filter((v) => v.phase === 'uncertain').map((v) => v.id),
      ),
    });
    for (const fn of this.listeners)
      try {
        fn();
      } catch {
        console.warn('TERMINAL_TRANSFER_UI_OBSERVER_FAILED');
      }
  }
}
