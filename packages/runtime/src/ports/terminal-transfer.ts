export type TerminalTransferProtocol = 'zmodem' | 'xmodem' | 'trzsz';

export interface TerminalTransferAdapterEvent {
  event: string;
  name?: string;
  size?: number;
  transferred?: number;
  speed?: number;
  count?: number;
  directory?: boolean;
}

export interface TerminalTransferAdapterListener {
  onEvent(
    terminalId: string,
    protocol: TerminalTransferProtocol,
    event: TerminalTransferAdapterEvent,
  ): void;
  writeRaw(terminalId: string, data: Uint8Array): void;
  publishRawOutput(terminalId: string, data: Uint8Array): void;
}

export interface TerminalTransferAdapter {
  setListener(listener: TerminalTransferAdapterListener): void;
  receive(terminalId: string, data: Uint8Array): boolean;
  observeInput(terminalId: string, data: Uint8Array): void;
  command(
    terminalId: string,
    protocol: TerminalTransferProtocol,
    command: Record<string, unknown>,
  ): void;
  close(terminalId: string): void;
  closeAll(): void;
}
