import type { TerminalBehavior } from '@workspace/contracts';

export const TERMINAL_CTRL_C_DOUBLE_PRESS_MS = 500;

/** Keep preedit keys in the browser without bypassing xterm's text commit path. */
export function installTerminalCompositionGuard(textarea: EventTarget | undefined): {
  handleKey: (
    event: Pick<KeyboardEvent, 'type' | 'key' | 'code' | 'keyCode' | 'isComposing'>,
  ) => boolean | undefined;
  dispose: () => void;
} {
  let composing = false;
  let composingKey: string | undefined;
  const start = () => {
    composing = true;
  };
  const end = () => {
    composing = false;
  };
  const reset = () => {
    composing = false;
    composingKey = undefined;
  };
  textarea?.addEventListener('compositionstart', start);
  textarea?.addEventListener('compositionend', end);
  textarea?.addEventListener('blur', reset);
  return {
    handleKey(event) {
      const key = event.code || event.key;
      const ownsKey = composing || event.isComposing;
      const completingKey = event.type !== 'keydown' && composingKey === key;
      if (event.type === 'keydown') composingKey = ownsKey ? key : undefined;
      else if (event.type === 'keyup' && composingKey === key) composingKey = undefined;
      // Returning false stops xterm key encoding. Do not prevent the browser's
      // default action: it must still edit preedit text and select candidates.
      if (ownsKey || completingKey) return false;
      // With no active composition, let xterm handle legacy Process events,
      // including direct punctuation/emoji input from the IME. Skip our keys.
      if (event.keyCode === 229) return true;
      return undefined;
    },
    dispose() {
      textarea?.removeEventListener('compositionstart', start);
      textarea?.removeEventListener('compositionend', end);
      textarea?.removeEventListener('blur', reset);
      reset();
    },
  };
}

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

/** Emit the configured Backspace/Shift+Backspace control-byte pair. */
export function terminalBackspaceSequence(
  mode: TerminalBehavior['backspaceMode'],
  shifted: boolean,
): string {
  const preferred = mode === '^?' ? 0x7f : 0x08;
  const alternate = preferred === 0x7f ? 0x08 : 0x7f;
  return String.fromCharCode(shifted ? alternate : preferred);
}

/** Decode the four escaped control forms accepted by the terminal setting. */
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
