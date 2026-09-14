import type { TerminalBehavior } from '@workspace/contracts';

/** Match Electerm's configured Backspace/Shift+Backspace pair exactly. */
export function terminalBackspaceSequence(
  mode: TerminalBehavior['backspaceMode'],
  shifted: boolean,
): string {
  const preferred = mode === '^?' ? 0x7f : 0x08;
  const alternate = preferred === 0x7f ? 0x08 : 0x7f;
  return String.fromCharCode(shifted ? alternate : preferred);
}

/** Decode only the four escape forms supported by the pinned Electerm baseline. */
export function terminalShiftEnterSequence(source: string): string {
  const input = source || '\\n';
  let output = '';
  for (let index = 0; index < input.length; index += 1) {
    const current = input[index];
    if (current !== '\\' || index + 1 >= input.length) {
      output += current;
      continue;
    }
    const next = input[index + 1];
    if (next === 'n') output += '\n';
    else if (next === 'r') output += '\r';
    else if (next === 't') output += '\t';
    else if (next === '\\') output += '\\';
    else output += `\\${next}`;
    index += 1;
  }
  return output;
}
