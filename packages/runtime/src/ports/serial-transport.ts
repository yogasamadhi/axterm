import type { SerialPortInfo } from '@workspace/contracts';
import type { TerminalChannel } from './terminal-channel';

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
  list(): Promise<SerialPortInfo[]>;
  open(input: SerialOpenInput): Promise<TerminalChannel>;
}
