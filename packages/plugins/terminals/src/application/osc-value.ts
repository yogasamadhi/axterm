export const SHELL_COMMAND_LINE_MAX_LENGTH = 4_096;

export type ShellCommandLineAssessment =
  | { accepted: true; command: string }
  | { accepted: false; reason: 'empty' | 'whitespace' | 'multiline' | 'control' | 'tooLong' };

/**
 * OSC 633 values escape semicolons as `\\x3b` and backslashes as `\\\\`.
 * Decoding is capped before expansion so hostile terminal output cannot grow an
 * unbounded intermediate string in the Renderer.
 */
export function deserializeOsc633Value(value: string): string | undefined {
  if (value.length > SHELL_COMMAND_LINE_MAX_LENGTH * 4) return undefined;
  let decoded = '';
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index]!;
    if (character !== '\\') {
      decoded += character;
    } else if (value[index + 1] === '\\') {
      decoded += '\\';
      index += 1;
    } else if (
      value[index + 1] === 'x' &&
      /^[0-9a-fA-F]{2}$/u.test(value.slice(index + 2, index + 4))
    ) {
      decoded += String.fromCharCode(Number.parseInt(value.slice(index + 2, index + 4), 16));
      index += 3;
    } else {
      return undefined;
    }
    if (decoded.length > SHELL_COMMAND_LINE_MAX_LENGTH) return undefined;
  }
  return decoded;
}
