import type { Duplex } from 'node:stream';

export interface SpiceRelaySocket {
  readonly readyState: number;
  readonly bufferedAmount: number;
  send(data: Uint8Array, options?: { binary?: boolean }): void;
  close(code?: number, reason?: string): void;
  on(event: 'message', listener: (data: Buffer, isBinary: boolean) => void): void;
  on(event: 'close' | 'error', listener: () => void): void;
  off(event: 'message', listener: (data: Buffer, isBinary: boolean) => void): void;
  off(event: 'close' | 'error', listener: () => void): void;
}

export interface SpiceRelayHandle {
  close(): void;
}

export interface SpiceRelay {
  attach(input: {
    socket: SpiceRelaySocket;
    signal: AbortSignal;
    openTarget(signal: AbortSignal): Promise<Duplex>;
    onReady(): void;
    onClose(errorCode?: string): void;
  }): Promise<SpiceRelayHandle>;
}
