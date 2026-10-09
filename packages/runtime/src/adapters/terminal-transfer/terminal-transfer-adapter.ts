import type {
  TerminalTransferAdapter,
  TerminalTransferAdapterEvent,
  TerminalTransferAdapterListener,
  TerminalTransferProtocol,
} from '../../ports/terminal-transfer';
import { ZmodemManager } from './zmodem';
import { XmodemManager, XmodemSession } from './xmodem';
import { TrzszManager } from './trzsz';
import type { StageOwnershipWriter } from './owned-stage-journal';

interface ProtocolManager {
  handleData(id: string, data: Buffer, terminal: ProtocolTerminal, socket: ProtocolSocket): boolean;
  handleMessage(
    id: string,
    message: Record<string, unknown>,
    terminal: ProtocolTerminal,
    socket: ProtocolSocket,
  ): void;
  handleUserInput?(id: string, data: Buffer): void;
  destroySession(id: string): void | Promise<void>;
  isActive(id: string): boolean;
}

interface ProtocolTerminal {
  write(data: Uint8Array): void;
  writeRaw(data: Uint8Array): void;
  setNoDelay(enabled: boolean): void;
}

interface ProtocolSocket {
  s(message: unknown): void;
  send(data: Uint8Array): void;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : undefined;
}

function safeEvent(value: unknown): TerminalTransferAdapterEvent | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const source = value as Record<string, unknown>;
  if (typeof source.event !== 'string' || source.event.length > 100) return undefined;
  const leafName =
    typeof source.name === 'string'
      ? source.name.replaceAll('\\', '/').split('/').at(-1)
      : undefined;
  const name =
    leafName && leafName !== '.' && leafName !== '..'
      ? leafName.replace(/[\0]/g, '_').slice(0, 255)
      : undefined;
  const size = finiteNumber(source.size);
  const transferred = finiteNumber(source.transferred);
  const speed = finiteNumber(source.speed);
  const count = finiteNumber(source.count);
  return {
    event: source.event,
    ...(name ? { name } : {}),
    ...(size !== undefined ? { size } : {}),
    ...(transferred !== undefined ? { transferred } : {}),
    ...(speed !== undefined ? { speed } : {}),
    ...(count !== undefined ? { count } : {}),
    ...(typeof source.directory === 'boolean' ? { directory: source.directory } : {}),
    ...(source.errorCode === 'TRANSFER_DESTINATION_UNSUPPORTED'
      ? { errorCode: source.errorCode }
      : {}),
  };
}

/**
 * Runtime adapter around independently authored protocol/Grant boundaries.
 * Protocol messages are reduced to a path-free allowlist before crossing
 * into Application.
 */
export class RuntimeTerminalTransferAdapter implements TerminalTransferAdapter {
  private listener: TerminalTransferAdapterListener | undefined;
  private readonly managers: Record<TerminalTransferProtocol, ProtocolManager>;
  private readonly contexts = new Map<
    string,
    { terminal: ProtocolTerminal; socket: ProtocolSocket }
  >();
  private readonly pendingCleanup = new Set<Promise<void>>();
  private readonly cleanupFailures: unknown[] = [];

  constructor(
    managers?: Partial<Record<TerminalTransferProtocol, ProtocolManager>>,
    journal?: StageOwnershipWriter,
  ) {
    this.managers = {
      zmodem: managers?.zmodem ?? new ZmodemManager(journal),
      xmodem:
        managers?.xmodem ??
        new XmodemManager(
          (terminal, socket, onFinish) =>
            new XmodemSession(terminal, socket, onFinish, undefined, undefined, undefined, journal),
        ),
      trzsz: managers?.trzsz ?? new TrzszManager(journal),
    };
  }

  setListener(listener: TerminalTransferAdapterListener): void {
    this.listener = listener;
  }

  receive(terminalId: string, data: Uint8Array): boolean {
    const context = this.context(terminalId);
    const chunk = Buffer.from(data);
    try {
      for (const protocol of ['zmodem', 'trzsz', 'xmodem'] as const) {
        const manager = this.managers[protocol];
        if (manager.isActive(terminalId))
          return manager.handleData(terminalId, chunk, context.terminal, context.socket);
      }
      if (this.managers.zmodem.handleData(terminalId, chunk, context.terminal, context.socket))
        return true;
      if (this.managers.trzsz.handleData(terminalId, chunk, context.terminal, context.socket))
        return true;
      return this.managers.xmodem.handleData(terminalId, chunk, context.terminal, context.socket);
    } catch {
      this.listener?.onEvent(terminalId, this.activeProtocol(terminalId) ?? 'zmodem', {
        event: 'adapter-error',
      });
      this.close(terminalId);
      return true;
    }
  }

  observeInput(terminalId: string, data: Uint8Array): void {
    this.managers.zmodem.handleUserInput?.(terminalId, Buffer.from(data));
  }

  command(
    terminalId: string,
    protocol: TerminalTransferProtocol,
    command: Record<string, unknown>,
  ): void {
    const context = this.context(terminalId);
    this.managers[protocol].handleMessage(terminalId, command, context.terminal, context.socket);
  }

  close(terminalId: string): void {
    for (const manager of Object.values(this.managers)) {
      const cleanup = manager.destroySession(terminalId);
      if (!cleanup) continue;
      const settled = cleanup.catch((error: unknown) => {
        this.cleanupFailures.push(error);
      });
      this.pendingCleanup.add(settled);
      void settled.then(() => this.pendingCleanup.delete(settled));
    }
    this.contexts.delete(terminalId);
  }

  async closeAll(): Promise<void> {
    for (const id of [...this.contexts.keys()]) this.close(id);
    while (this.pendingCleanup.size > 0) await Promise.all(this.pendingCleanup);
    if (this.cleanupFailures.length > 0)
      throw new AggregateError(this.cleanupFailures.splice(0), 'Terminal transfer cleanup failed');
  }

  private activeProtocol(terminalId: string): TerminalTransferProtocol | undefined {
    return (['zmodem', 'trzsz', 'xmodem'] as const).find((protocol) =>
      this.managers[protocol].isActive(terminalId),
    );
  }

  private context(terminalId: string) {
    const existing = this.contexts.get(terminalId);
    if (existing) return existing;
    const terminal: ProtocolTerminal = {
      write: (data) => this.listener?.writeRaw(terminalId, data),
      writeRaw: (data) => this.listener?.writeRaw(terminalId, data),
      setNoDelay: () => {},
    };
    const socket: ProtocolSocket = {
      s: (message) => {
        const source = message as Record<string, unknown> | undefined;
        const protocol =
          source?.action === 'xmodem-event'
            ? 'xmodem'
            : source?.action === 'trzsz-event'
              ? 'trzsz'
              : 'zmodem';
        const event = safeEvent(message);
        if (event) this.listener?.onEvent(terminalId, protocol, event);
      },
      send: (data) => this.listener?.publishRawOutput(terminalId, data),
    };
    const context = { terminal, socket };
    this.contexts.set(terminalId, context);
    return context;
  }
}
