import type { TerminalBehavior } from '@workspace/contracts';

export interface TerminalOutputDecoder {
  readonly decoder: TextDecoder;
  readonly encoding: TerminalBehavior['encoding'];
  readonly fellBack: boolean;
}

export function createTerminalOutputDecoder(
  encoding: TerminalBehavior['encoding'],
): TerminalOutputDecoder {
  try {
    return { decoder: new TextDecoder(encoding), encoding, fellBack: false };
  } catch {
    return { decoder: new TextDecoder('utf-8'), encoding, fellBack: true };
  }
}

export function decodeTerminalOutput(
  state: TerminalOutputDecoder,
  data: Uint8Array,
  displayRaw: boolean,
): string {
  return formatTerminalOutput(state.decoder.decode(data, { stream: true }), displayRaw);
}

export function formatTerminalOutput(text: string, displayRaw: boolean): string {
  if (!displayRaw || text.includes('\u001bP')) return text;
  return text.replaceAll('\u001b', '\\033');
}
