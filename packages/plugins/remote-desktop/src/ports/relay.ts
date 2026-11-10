import type { Duplex } from 'node:stream';
export interface RelaySocket {
  readonly readyState: number;
  readonly bufferedAmount: number;
  send(data: Uint8Array, options?: { binary?: boolean }): void;
  close(code?: number, reason?: string): void;
  on(event: 'message', listener: (data: Buffer, isBinary: boolean) => void): void;
  on(event: 'close' | 'error', listener: () => void): void;
  off(event: 'message', listener: (data: Buffer, isBinary: boolean) => void): void;
  off(event: 'close' | 'error', listener: () => void): void;
}
export interface RelayHandle {
  close(): Promise<void>;
}
export interface Relay {
  attach(input: {
    socket: RelaySocket;
    target: { host: string; port: number };
    timeoutMs: number;
    signal: AbortSignal;
    openTarget(signal: AbortSignal): Promise<Duplex>;
    onReady(): void;
    onClose(errorCode?: string): void;
  }): Promise<RelayHandle>;
}
