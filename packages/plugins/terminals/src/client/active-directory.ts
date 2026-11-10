/** Retained Axterm bounded OSC decoder; hints are transient and never execution authority. */
const SHELL_COMMAND_LINE_MAX_LENGTH = 4096;
function deserializeOsc633Value(value: string): string | undefined {
  if (value.length > SHELL_COMMAND_LINE_MAX_LENGTH * 4) return undefined;
  let decoded = '';
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index]!;
    if (character.charCodeAt(0) !== 92) {
      decoded += character;
    } else if (value.charCodeAt(index + 1) === 92) {
      decoded += String.fromCharCode(92);
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

export function directoryFromOsc633(value: string): string | undefined {
  const path = deserializeOsc633Value(value);
  return path?.startsWith('/') &&
    !Array.from(path).some(
      (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
    )
    ? path
    : undefined;
}
