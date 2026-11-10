import { randomUUID } from 'node:crypto';
import { remoteErrorOf } from '@axterm/plugin-api';
import {
  terminalTransferStateSchema,
  type TerminalTransferAction,
  type TerminalTransferState,
  type TerminalTransferProtocol,
} from '@axterm/plugin-api/terminals';
import type { TerminalService, TerminalDataInterceptor } from './terminal-service.ts';
import type {
  TerminalTransferAdapter,
  TerminalTransferAdapterEvent,
  TerminalTransferAdapterListener,
} from '../ports/terminal-transfer.ts';
import type {
  TerminalTransferStage,
  TerminalTransferStaging,
} from '../ports/terminal-transfer-staging.ts';
import { ApplicationError } from './errors.ts';
interface Owned {
  state: TerminalTransferState;
  abort: AbortController;
  stage?: TerminalTransferStage;
  preparing?: Promise<TerminalTransferStage>;
  ending?: Promise<void>;
  off?: () => void;
  timer?: ReturnType<typeof setTimeout>;
  lastProgress: number;
  completedBytes: number;
  waitingBytes: number;
  completedProtocol?: boolean;
}
const active = (state: TerminalTransferState) =>
  ['waiting-selection', 'waiting-peer', 'transferring'].includes(state.state);
/** Single terminal interceptor; only compact, bounded metadata enters the Client model. */
export class TerminalTransfers implements TerminalDataInterceptor, TerminalTransferAdapterListener {
  private readonly sessions = new Map<string, Owned>();
  private readonly pending = new Set<Promise<unknown>>();
  private closedOwner = false;
  private closing: Promise<void> | undefined;
  constructor(
    private readonly terminals: Pick<
      TerminalService,
      'get' | 'writeRaw' | 'publishRawOutput' | 'setTransferState'
    >,
    private readonly adapter: TerminalTransferAdapter,
    private readonly staging: TerminalTransferStaging,
  ) {
    adapter.setListener(this);
  }
  get(id: string): TerminalTransferState | null {
    const terminal = this.terminals.get(id);
    return this.sessions.get(id)?.state ?? terminal.transfer ?? null;
  }
  perform(id: string, action: TerminalTransferAction): Promise<TerminalTransferState> {
    if (this.closedOwner) return Promise.reject(this.invalid());
    this.terminals.get(id);
    const task = this.performOwned(id, action);
    this.pending.add(task);
    void task.finally(() => this.pending.delete(task)).catch(() => {});
    return task;
  }
  private async performOwned(id: string, action: TerminalTransferAction) {
    let value = this.sessions.get(id);
    if (action.action === 'cancel') {
      if (action.runId && action.runId !== value?.state.runId) throw this.invalid();
      if (!value) throw this.invalid();
      if (!active(value.state) && !value.ending) return value.state;
      value.abort.abort();
      await this.finish(id, value, 'canceled');
      return value.state;
    }
    if (action.action === 'start') {
      if (value && (active(value.state) || value.ending)) throw this.invalid();
      value = this.create(id, 'xmodem', action.direction, 'waiting-selection');
    } else if (
      !value ||
      value.state.state !== 'waiting-selection' ||
      value.state.protocol !== action.protocol ||
      value.state.runId !== action.runId ||
      value.preparing
    )
      throw this.invalid();
    const owned = value;
    this.clearTimer(owned);
    this.update(id, owned, { ...owned.state, state: 'waiting-peer' });
    const preparing = this.staging.prepare(
      action.grantId,
      owned.state.direction,
      owned.state.protocol,
      owned.abort.signal,
    );
    owned.preparing = preparing;
    try {
      const stage = await preparing;
      owned.stage = stage;
      if (this.closedOwner || owned.abort.signal.aborted || this.sessions.get(id) !== owned) {
        await this.finish(id, owned, 'canceled');
        throw this.invalid();
      }
      const aborted = () => {
        void this.finish(id, owned, 'failed').catch(() => {});
      };
      owned.off = () => stage.signal.removeEventListener('abort', aborted);
      stage.signal.addEventListener('abort', aborted, { once: true });
      if (stage.signal.aborted) {
        await this.finish(id, owned, 'failed');
        throw this.invalid();
      }
      if (action.action === 'start')
        this.adapter.command(id, 'xmodem', {
          event: owned.state.direction === 'upload' ? 'start-send' : 'start-receive',
        });
      if (stage.kind === 'file')
        this.adapter.command(id, owned.state.protocol, {
          event: 'send-files',
          files: [{ path: stage.path, name: stage.name, size: stage.size }],
        });
      else
        this.adapter.command(id, owned.state.protocol, {
          event: 'set-save-path',
          path: stage.path,
          ...(action.action === 'start' && action.fileName ? { name: action.fileName } : {}),
        });
      return owned.state;
    } catch (error) {
      await this.finish(id, owned, 'failed');
      throw error;
    }
  }
  receive(id: string, data: Uint8Array): boolean {
    if (this.closedOwner) return false;
    const waiting = this.sessions.get(id);
    if (
      waiting &&
      (waiting.state.state === 'waiting-selection' || (waiting.preparing && !waiting.stage))
    ) {
      waiting.waitingBytes += data.byteLength;
      if (waiting.waitingBytes > 4 * 1024 * 1024) {
        waiting.state = { ...waiting.state, errorCode: 'SELECTION_BUFFER_LIMIT' };
        void this.finish(id, waiting, 'failed').catch(() => {});
        return true;
      }
    }
    return this.adapter.receive(id, data);
  }
  observeInput(id: string, data: Uint8Array) {
    if (!this.closedOwner) this.adapter.observeInput(id, data);
  }
  closed(id: string) {
    const value = this.sessions.get(id);
    if (value) {
      if (!value.completedProtocol) value.abort.abort();
      void this.finish(id, value, value.completedProtocol ? 'completed' : 'canceled').then(
        () => {
          if (this.sessions.get(id) === value) this.sessions.delete(id);
        },
        () => {},
      );
    } else this.adapter.close(id);
  }
  async closeTerminal(id: string) {
    const value = this.sessions.get(id);
    if (value) {
      value.abort.abort();
      await this.finish(id, value, 'canceled');
      this.sessions.delete(id);
    } else await this.adapter.drain(id);
  }
  writeRaw(id: string, data: Uint8Array) {
    this.terminals.writeRaw(id, data);
  }
  publishRawOutput(id: string, data: Uint8Array) {
    this.terminals.publishRawOutput(id, data);
  }
  onEvent(id: string, protocol: TerminalTransferProtocol, event: TerminalTransferAdapterEvent) {
    if (this.closedOwner) return;
    const value = this.sessions.get(id);
    if (event.event === 'receive-start' || event.event === 'send-start') {
      if (value?.ending) return;
      if (protocol === 'xmodem' && value?.state.protocol === protocol) return;
      if (value && active(value.state)) return;
      this.create(
        id,
        protocol,
        event.event === 'receive-start' ? 'download' : 'upload',
        'waiting-selection',
      );
      return;
    }
    if (!value || value.state.protocol !== protocol || value.ending || !active(value.state)) return;
    if (
      ['adapter-error', 'session-error', 'session-timeout', 'transfer-error'].includes(event.event)
    ) {
      value.state = { ...value.state, errorCode: event.errorCode ?? 'TRANSFER_FAILED' };
      void this.finish(id, value, 'failed').catch(() => {});
      return;
    }
    if (
      event.event === 'session-complete' ||
      (protocol === 'xmodem' && event.event === 'file-complete')
    ) {
      void this.finish(id, value, 'completed').catch(() => {});
      return;
    }
    if (event.event === 'session-end') {
      void this.finish(id, value, 'canceled').catch(() => {});
      return;
    }
    if (event.event === 'file-start' && event.name) {
      try {
        value.stage?.recordName?.(event.name);
      } catch {
        value.state = { ...value.state, errorCode: 'TRANSFER_METADATA_FAILED' };
        void this.finish(id, value, 'failed').catch(() => {});
        return;
      }
    }
    if (event.event === 'file-complete')
      value.completedBytes += event.size ?? value.state.totalBytes ?? 0;
    if (value.completedBytes + (event.transferred ?? 0) > 4 * 1024 ** 3) {
      value.state = { ...value.state, errorCode: 'TRANSFER_LIMIT' };
      void this.finish(id, value, 'failed').catch(() => {});
      return;
    }
    if (event.event === 'progress' && Date.now() - value.lastProgress < 100) return;
    value.lastProgress = Date.now();
    if (
      ['progress', 'file-start', 'file-size', 'file-count', 'file-complete'].includes(event.event)
    )
      this.update(id, value, {
        ...value.state,
        state: 'transferring',
        ...(event.name ? { fileName: event.name } : {}),
        ...(event.size !== undefined ? { totalBytes: event.size } : {}),
        ...(event.transferred !== undefined ? { transferredBytes: event.transferred } : {}),
        ...(event.speed !== undefined ? { speedBytesPerSecond: event.speed } : {}),
        ...(event.count !== undefined ? { fileCount: event.count } : {}),
      });
  }
  resourceSnapshot(): Readonly<Record<string, number>> {
    return Object.freeze({
      terminalTransfers: [...this.sessions.values()].filter(
        (value) => active(value.state) || value.ending,
      ).length,
      terminalTransferResources: this.resourceCount(),
    });
  }
  resourceCount() {
    return (
      this.pending.size +
      this.staging.resourceCount() +
      this.adapter.resourceCount() +
      [...this.sessions.values()].filter((v) => active(v.state) || v.ending).length
    );
  }
  closeAll() {
    return (this.closing ??= (async () => {
      this.closedOwner = true;
      for (const value of this.sessions.values()) {
        value.abort.abort();
        this.clearTimer(value);
      }
      const settled = await Promise.allSettled(
        [...this.sessions].map(([id, value]) => this.finish(id, value, 'canceled')),
      );
      await Promise.allSettled([...this.pending]);
      await this.adapter.closeAll();
      await this.staging.close();
      if (settled.some((r) => r.status === 'rejected')) throw Error('TERMINAL_TRANSFERS_UNDRAINED');
      this.sessions.clear();
    })());
  }
  private create(
    id: string,
    protocol: TerminalTransferProtocol,
    direction: 'upload' | 'download',
    state: TerminalTransferState['state'],
  ) {
    if (this.sessions.size >= 256 && !this.sessions.has(id)) throw this.invalid();
    const value: Owned = {
      state: {
        terminalId: id,
        runId: randomUUID(),
        protocol,
        direction,
        state,
        selection: direction === 'download' ? 'directory' : 'file',
        updatedAt: new Date().toISOString(),
      },
      abort: new AbortController(),
      lastProgress: 0,
      completedBytes: 0,
      waitingBytes: 0,
    };
    this.sessions.set(id, value);
    this.update(id, value, value.state);
    value.timer = setTimeout(() => {
      value.state = { ...value.state, errorCode: 'SELECTION_TIMEOUT' };
      void this.finish(id, value, 'failed').catch(() => {});
    }, 60000);
    value.timer.unref();
    return value;
  }
  private finish(
    id: string,
    value: Owned,
    state: 'completed' | 'failed' | 'canceled',
  ): Promise<void> {
    if (state === 'completed') value.completedProtocol = true;
    return (value.ending ??= (async () => {
      this.clearTimer(value);
      value.off?.();
      // Let a manager finish its current event callback before joining its actual IO.
      await Promise.resolve();
      let target = state;
      try {
        await this.adapter.drain(id);
      } catch (error) {
        this.update(id, value, {
          ...value.state,
          state: 'failed',
          errorCode: 'TRANSFER_CLEANUP_FAILED',
        });
        throw error;
      }
      const stage = value.stage ?? (await value.preparing?.catch(() => undefined));
      if (stage) {
        value.stage = stage;
        try {
          if (state === 'completed') {
            stage.signal.throwIfAborted();
            await stage.publish();
          }
        } catch (error) {
          target = value.abort.signal.aborted ? 'canceled' : 'failed';
          const failure = remoteErrorOf(error);
          value.state = {
            ...value.state,
            errorCode:
              failure?.code === 'files/failure' &&
              failure.details.reason === 'unsupported-destination'
                ? 'TRANSFER_DESTINATION_UNSUPPORTED'
                : 'TRANSFER_PUBLICATION_FAILED',
          };
        }
        try {
          await stage.close();
        } catch (error) {
          this.update(id, value, {
            ...value.state,
            state: 'failed',
            errorCode: 'TRANSFER_CLEANUP_FAILED',
          });
          throw error;
        }
      }
      delete value.stage;
      delete value.preparing;
      delete value.ending;
      this.update(id, value, {
        ...value.state,
        state: target,
        ...(target === 'completed' && value.state.totalBytes !== undefined
          ? { transferredBytes: value.state.totalBytes }
          : {}),
      });
    })());
  }
  private clearTimer(value: Owned) {
    if (value.timer) clearTimeout(value.timer);
    delete value.timer;
  }
  private update(id: string, value: Owned, state: TerminalTransferState) {
    value.state = terminalTransferStateSchema.parse({
      ...state,
      updatedAt: new Date().toISOString(),
    });
    this.terminals.setTransferState(id, value.state);
  }
  private invalid() {
    return new ApplicationError('INVALID_STATE', 'Terminal transfer is unavailable', 409);
  }
}
