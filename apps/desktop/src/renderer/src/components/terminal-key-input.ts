import type { TerminalBehavior } from '@workspace/contracts';

export const TERMINAL_CTRL_C_DOUBLE_PRESS_MS = 500;

export function terminalCtrlCPress(
  previousPressAt: number | undefined,
  pressedAt: number,
  hasSelection: boolean,
): { action: 'copy' | 'interrupt'; nextPressAt: number | undefined } {
  if (
    previousPressAt !== undefined &&
    pressedAt >= previousPressAt &&
    pressedAt - previousPressAt <= TERMINAL_CTRL_C_DOUBLE_PRESS_MS
  )
    return { action: 'interrupt', nextPressAt: undefined };
  return { action: hasSelection ? 'copy' : 'interrupt', nextPressAt: pressedAt };
}

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
