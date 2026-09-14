import { stat } from 'node:fs/promises';
import { basename } from 'node:path';
import {
  terminalTransferStateSchema,
  type TerminalTransferAction,
  type TerminalTransferProtocol,
  type TerminalTransferState,
} from '@workspace/contracts';
import type { TerminalDataInterceptor, TerminalService } from './terminal-service';
import type {
  TerminalTransferAdapter,
  TerminalTransferAdapterEvent,
  TerminalTransferAdapterListener,
} from '../ports/terminal-transfer';
import { ApplicationError } from './errors';

export interface ResolvedTerminalTransferGrant {
  path: string;
  name: string;
  kind: 'file' | 'directory' | 'save-target';
  permissions: Array<'read' | 'write'>;
}

const FAILURE_EVENTS = new Set([
  'adapter-error',
  'session-error',
  'session-timeout',
  'transfer-error',
]);
const WAITING_SELECTION_MAX_BYTES = 4 * 1024 * 1024;
const WAITING_SELECTION_TIMEOUT_MS = 60_000;

export class TerminalTransferService
  implements TerminalDataInterceptor, TerminalTransferAdapterListener
{
  private readonly states = new Map<string, TerminalTransferState>();
  private readonly waitingBytes = new Map<string, number>();
  private readonly selectionTimers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(
    private readonly terminals: TerminalService,
    private readonly adapter: TerminalTransferAdapter,
  ) {
    adapter.setListener(this);
  }

  get(terminalId: string): TerminalTransferState | null {
    this.terminals.get(terminalId);
    const state = this.states.get(terminalId);
    return state ? { ...state } : null;
  }

  async perform(
    terminalId: string,
    action: TerminalTransferAction,
    grant?: ResolvedTerminalTransferGrant,
  ): Promise<TerminalTransferState> {
    this.terminals.get(terminalId);
    if (action.action === 'cancel') {
      const current = this.states.get(terminalId);
      if (!current)
        throw new ApplicationError('INVALID_STATE', 'No terminal transfer is active', 409);
      this.update(terminalId, { ...current, state: 'canceled' });
      this.adapter.command(terminalId, current.protocol, { event: 'cancel' });
      return this.requiredState(terminalId);
    }
    if (!grant) throw new ApplicationError('VALIDATION_ERROR', 'A file grant is required', 400);

    if (action.action === 'start') {
      this.assertNoActiveTransfer(terminalId);
      if (action.direction === 'upload') {
        await this.assertReadableFile(grant);
        this.update(terminalId, {
          terminalId,
          protocol: 'xmodem',
          direction: 'upload',
          state: 'waiting-peer',
          selection: 'file',
          fileName: grant.name,
          updatedAt: new Date().toISOString(),
        });
        this.adapter.command(terminalId, 'xmodem', { event: 'start-send' });
        const metadata = await stat(grant.path);
        this.adapter.command(terminalId, 'xmodem', {
          event: 'send-files',
          files: [{ path: grant.path, name: grant.name, size: metadata.size }],
        });
      } else {
        this.assertWritableDirectory(grant);
        this.update(terminalId, {
          terminalId,
          protocol: 'xmodem',
          direction: 'download',
          state: 'waiting-peer',
          selection: 'directory',
          ...(action.fileName ? { fileName: action.fileName } : {}),
          updatedAt: new Date().toISOString(),
        });
        this.adapter.command(terminalId, 'xmodem', { event: 'start-receive' });
        this.adapter.command(terminalId, 'xmodem', {
          event: 'set-save-path',
          path: grant.path,
          ...(action.fileName ? { name: action.fileName } : {}),
        });
      }
      return this.requiredState(terminalId);
    }

    const current = this.states.get(terminalId);
    if (!current || current.state !== 'waiting-selection' || current.protocol !== action.protocol)
      throw new ApplicationError(
        'INVALID_STATE',
        'The transfer is not waiting for this selection',
        409,
      );
    this.update(terminalId, { ...current, state: 'waiting-peer' });
    if (current.direction === 'download') {
      this.assertWritableDirectory(grant);
      this.adapter.command(terminalId, current.protocol, {
        event: 'set-save-path',
        path: grant.path,
      });
    } else {
      await this.assertReadableFile(grant);
      const metadata = await stat(grant.path);
      this.adapter.command(terminalId, current.protocol, {
        event: 'send-files',
        files: [
          {
            path: grant.path,
            name: basename(grant.path),
            size: metadata.size,
            modifyTime: metadata.mtimeMs,
          },
        ],
      });
    }
    return this.requiredState(terminalId);
  }

  receive(terminalId: string, data: Uint8Array): boolean {
    if (this.states.get(terminalId)?.state === 'waiting-selection') {
      const bytes = (this.waitingBytes.get(terminalId) ?? 0) + data.byteLength;
      this.waitingBytes.set(terminalId, bytes);
      if (bytes > WAITING_SELECTION_MAX_BYTES) {
        const current = this.states.get(terminalId)!;
        this.adapter.command(terminalId, current.protocol, { event: 'cancel' });
        this.update(terminalId, {
          ...current,
          state: 'failed',
          errorCode: 'SELECTION_BUFFER_LIMIT',
        });
        return true;
      }
    }
    return this.adapter.receive(terminalId, data);
  }

  observeInput(terminalId: string, data: Uint8Array): void {
    this.adapter.observeInput(terminalId, data);
  }

  closed(terminalId: string): void {
    this.clearSelectionTimer(terminalId);
    this.adapter.close(terminalId);
    this.states.delete(terminalId);
    this.waitingBytes.delete(terminalId);
  }

  writeRaw(terminalId: string, data: Uint8Array): void {
    this.terminals.writeRaw(terminalId, data);
  }

  publishRawOutput(terminalId: string, data: Uint8Array): void {
    this.terminals.publishRawOutput(terminalId, data);
  }

  onEvent(
    terminalId: string,
    protocol: TerminalTransferProtocol,
    event: TerminalTransferAdapterEvent,
  ): void {
    const current = this.states.get(terminalId);
    if (event.event === 'receive-start' || event.event === 'send-start') {
      const direction = event.event === 'receive-start' ? 'download' : 'upload';
      if (protocol === 'xmodem' && current?.protocol === protocol) {
        this.update(terminalId, { ...current, direction, state: 'waiting-peer' });
      } else {
        this.update(terminalId, {
          terminalId,
          protocol,
          direction,
          state: 'waiting-selection',
          selection: direction === 'download' || event.directory ? 'directory' : 'file',
          updatedAt: new Date().toISOString(),
        });
      }
      return;
    }
    if (!current || current.protocol !== protocol) return;
    if (FAILURE_EVENTS.has(event.event)) {
      this.update(terminalId, {
        ...current,
        state: 'failed',
        errorCode: event.event.replaceAll('-', '_').toUpperCase(),
      });
      return;
    }
    if (event.event === 'file-count') {
      this.update(terminalId, { ...current, fileCount: event.count ?? 0 });
      return;
    }
    if (event.event === 'file-start' || event.event === 'file-size') {
      this.update(terminalId, {
        ...current,
        state: 'transferring',
        ...(event.name ? { fileName: event.name } : {}),
        ...(event.size !== undefined ? { totalBytes: event.size } : {}),
        transferredBytes: 0,
      });
      return;
    }
    if (event.event === 'progress') {
      this.update(terminalId, {
        ...current,
        state: 'transferring',
        ...(event.name ? { fileName: event.name } : {}),
        ...(event.size !== undefined ? { totalBytes: event.size } : {}),
        ...(event.transferred !== undefined ? { transferredBytes: event.transferred } : {}),
        ...(event.speed !== undefined ? { speedBytesPerSecond: event.speed } : {}),
      });
      return;
    }
    if (event.event === 'file-complete' || event.event === 'session-complete') {
      this.update(terminalId, {
        ...current,
        state: 'completed',
        ...(event.name ? { fileName: event.name } : {}),
        ...(current.totalBytes !== undefined ? { transferredBytes: current.totalBytes } : {}),
      });
      return;
    }
    if (
      event.event === 'session-end' &&
      !['completed', 'failed', 'canceled'].includes(current.state)
    )
      this.update(terminalId, { ...current, state: 'canceled' });
  }

  closeAll(): void {
    for (const terminalId of this.selectionTimers.keys()) this.clearSelectionTimer(terminalId);
    this.adapter.closeAll();
    this.states.clear();
    this.waitingBytes.clear();
  }

  resourceCount(): number {
    return [...this.states.values()].filter((state) =>
      ['waiting-selection', 'waiting-peer', 'transferring'].includes(state.state),
    ).length;
  }

  private update(terminalId: string, state: TerminalTransferState): void {
    const parsed = terminalTransferStateSchema.parse({
      ...state,
      updatedAt: new Date().toISOString(),
    });
    this.states.set(terminalId, parsed);
    if (parsed.state === 'waiting-selection') {
      this.waitingBytes.set(terminalId, 0);
      this.clearSelectionTimer(terminalId);
      const timer = setTimeout(() => {
        const current = this.states.get(terminalId);
        if (!current || current.state !== 'waiting-selection') return;
        this.adapter.command(terminalId, current.protocol, { event: 'cancel' });
        this.update(terminalId, {
          ...current,
          state: 'failed',
          errorCode: 'SELECTION_TIMEOUT',
        });
      }, WAITING_SELECTION_TIMEOUT_MS);
      timer.unref();
      this.selectionTimers.set(terminalId, timer);
    } else {
      this.clearSelectionTimer(terminalId);
      this.waitingBytes.delete(terminalId);
    }
    this.terminals.sendServerControl(terminalId, { type: 'transfer', transfer: parsed });
  }

  private clearSelectionTimer(terminalId: string): void {
    const timer = this.selectionTimers.get(terminalId);
    if (timer) clearTimeout(timer);
    this.selectionTimers.delete(terminalId);
  }

  private requiredState(terminalId: string): TerminalTransferState {
    const state = this.states.get(terminalId);
    if (!state) throw new ApplicationError('INVALID_STATE', 'Transfer state is unavailable', 409);
    return { ...state };
  }

  private assertNoActiveTransfer(terminalId: string): void {
    const current = this.states.get(terminalId);
    if (current && ['waiting-selection', 'waiting-peer', 'transferring'].includes(current.state))
      throw new ApplicationError('INVALID_STATE', 'A terminal transfer is already active', 409);
  }

  private async assertReadableFile(grant: ResolvedTerminalTransferGrant): Promise<void> {
    if (grant.kind !== 'file' || !grant.permissions.includes('read'))
      throw new ApplicationError('VALIDATION_ERROR', 'A readable file grant is required', 400);
    const metadata = await stat(grant.path).catch(() => undefined);
    if (!metadata?.isFile())
      throw new ApplicationError(
        'VALIDATION_ERROR',
        'The selected transfer source is not a file',
        400,
      );
  }

  private assertWritableDirectory(grant: ResolvedTerminalTransferGrant): void {
    if (grant.kind !== 'directory' || !grant.permissions.includes('write'))
      throw new ApplicationError('VALIDATION_ERROR', 'A writable directory grant is required', 400);
  }
}
