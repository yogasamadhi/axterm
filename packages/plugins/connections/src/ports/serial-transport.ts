import type { SerialPortInfo } from '@axterm/plugin-api/connections';
import type { TerminalChannel } from '@axterm/plugin-api/host';

export interface SerialOpenInput {
  path: string;
  baudRate: number;
  dataBits: 5 | 6 | 7 | 8;
  stopBits: 1 | 1.5 | 2;
  parity: 'none' | 'even' | 'mark' | 'odd' | 'space';
  lock: boolean;
  rtscts: boolean;
  xon: boolean;
  xoff: boolean;
  xany: boolean;
  txLineEnding: '\r' | '\n' | '\r\n';
  rxLineEnding: 'none' | 'lf_to_crlf' | 'cr_to_crlf';
  closeSequence: string;
  closeSequenceDelayMs: number;
  signal?: AbortSignal;
}

export interface SerialTransport {
  resourceCount?(): number;
  close?(): Promise<void>;
  list(): Promise<SerialPortInfo[]>;
  open(input: SerialOpenInput): Promise<TerminalChannel>;
}
