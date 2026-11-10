import type { TerminalBehavior } from '@axterm/plugin-api/terminals';

export interface TerminalOutputDecoder {
  readonly decoder: TextDecoder;
  readonly encoding: TerminalBehavior['encoding'];
  readonly fellBack: boolean;
  asciiFastPath: boolean;
  initialized: boolean;
}

export function createTerminalOutputDecoder(
  encoding: TerminalBehavior['encoding'],
): TerminalOutputDecoder {
  try {
    return {
      decoder: new TextDecoder(encoding),
      encoding,
      fellBack: false,
      asciiFastPath: encoding === 'utf-8',
      initialized: false,
    };
  } catch {
    return {
      decoder: new TextDecoder('utf-8'),
      encoding,
      fellBack: true,
      asciiFastPath: false,
      initialized: false,
    };
  }
}

export function decodeTerminalOutput(
  state: TerminalOutputDecoder,
  data: Uint8Array,
  displayRaw: boolean,
): string | Uint8Array {
  if (state.asciiFastPath) {
    if (displayRaw) state.asciiFastPath = false;
    else {
      for (let index = 0; index < data.length; index++) {
        if (data[index]! >= 0x80) {
          state.asciiFastPath = false;
          break;
        }
      }
      if (state.asciiFastPath && state.initialized) return data;
    }
  }
  // Advance the real decoder on the first frame, including its BOM state.
  // Once Unicode/raw display is seen, never mix a pending TextDecoder sequence
  // with byte writes; xterm has previously received only complete ASCII bytes.
  state.initialized ||= data.byteLength > 0;
  return formatTerminalOutput(state.decoder.decode(data, { stream: true }), displayRaw);
}

export function formatTerminalOutput(text: string, displayRaw: boolean): string {
  if (!displayRaw || text.includes('\u001bP')) return text;
  return text.replaceAll('\u001b', '\\033');
}
