import type {
  TerminalTransferAdapter,
  TerminalTransferAdapterEvent,
  TerminalTransferAdapterListener,
  TerminalTransferProtocol,
} from '../../ports/terminal-transfer';
import zmodemImport from './electerm/zmodem.cjs';
import xmodemImport from './electerm/xmodem.cjs';
import trzszImport from './electerm/trzsz.cjs';
import { TrzszTransfer } from 'trzsz2';

interface VendorManager {
  handleData(id: string, data: Buffer, terminal: VendorTerminal, socket: VendorSocket): boolean;
  handleMessage(
    id: string,
    message: Record<string, unknown>,
    terminal: VendorTerminal,
    socket: VendorSocket,
  ): void;
  handleUserInput?(id: string, data: Buffer): void;
  destroySession(id: string): void;
  isActive(id: string): boolean;
}

interface VendorTerminal {
  write(data: Uint8Array): void;
  writeRaw(data: Uint8Array): void;
  setNoDelay(enabled: boolean): void;
}

interface VendorSocket {
  s(message: unknown): void;
  send(data: Uint8Array): void;
}

type VendorConstructor = new () => VendorManager;
type VendorModule = Record<string, unknown>;

function moduleValue(value: unknown): VendorModule {
  const module = value as VendorModule & { default?: unknown };
  return (
    module.default && typeof module.default === 'object' ? module.default : module
  ) as VendorModule;
}

function managerConstructor(module: unknown, name: string): VendorConstructor {
  const candidate = moduleValue(module)[name];
  if (typeof candidate !== 'function') throw new Error(`${name} is unavailable`);
  return candidate as VendorConstructor;
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
  };
}

/**
 * Runtime adapter around the protocol engines adapted from Electerm 5.5.0.
 * Vendor messages are reduced to a path-free allowlist before crossing into Application.
 */
export class ElectermTerminalTransferAdapter implements TerminalTransferAdapter {
  private listener: TerminalTransferAdapterListener | undefined;
  private readonly managers: Record<TerminalTransferProtocol, VendorManager>;
  private readonly contexts = new Map<string, { terminal: VendorTerminal; socket: VendorSocket }>();

  constructor(managers?: Partial<Record<TerminalTransferProtocol, VendorManager>>) {
    const trzszModule = moduleValue(trzszImport);
    const configureTrzszTransfer = trzszModule.configureTrzszTransfer;
    if (typeof configureTrzszTransfer !== 'function')
      throw new Error('TRZSZ protocol configuration is unavailable');
    (configureTrzszTransfer as (implementation: typeof TrzszTransfer) => void)(TrzszTransfer);
    const ZmodemManager = managerConstructor(zmodemImport, 'ZmodemManager');
    const XmodemManager = managerConstructor(xmodemImport, 'XmodemManager');
    const TrzszManager = managerConstructor(trzszImport, 'TrzszManager');
    this.managers = {
      zmodem: managers?.zmodem ?? new ZmodemManager(),
      xmodem: managers?.xmodem ?? new XmodemManager(),
      trzsz: managers?.trzsz ?? new TrzszManager(),
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
    for (const manager of Object.values(this.managers)) manager.destroySession(terminalId);
    this.contexts.delete(terminalId);
  }

  closeAll(): void {
    for (const id of [...this.contexts.keys()]) this.close(id);
  }

  private activeProtocol(terminalId: string): TerminalTransferProtocol | undefined {
    return (['zmodem', 'trzsz', 'xmodem'] as const).find((protocol) =>
      this.managers[protocol].isActive(terminalId),
    );
  }

  private context(terminalId: string) {
    const existing = this.contexts.get(terminalId);
    if (existing) return existing;
    const terminal: VendorTerminal = {
      write: (data) => this.listener?.writeRaw(terminalId, data),
      writeRaw: (data) => this.listener?.writeRaw(terminalId, data),
      setNoDelay: () => {},
    };
    const socket: VendorSocket = {
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
