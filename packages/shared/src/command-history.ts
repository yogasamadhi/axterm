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

export function assessShellCommandLine(value: string): ShellCommandLineAssessment {
  if (!value) return { accepted: false, reason: 'empty' };
  if (value.length > SHELL_COMMAND_LINE_MAX_LENGTH) return { accepted: false, reason: 'tooLong' };
  if (value !== value.trim()) return { accepted: false, reason: 'whitespace' };
  if (/\r|\n/u.test(value)) return { accepted: false, reason: 'multiline' };
  if (containsAsciiControl(value)) return { accepted: false, reason: 'control' };
  return { accepted: true, command: value };
}

function containsAsciiControl(value: string): boolean {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code < 32 || code === 127) return true;
  }
  return false;
}

/** Drop the full line when it resembles an inline credential. */
export function isSensitiveCommandLine(command: string): boolean {
  const patterns = [
    /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----/iu,
    /\b(?:authorization|proxy-authorization)\s*:\s*(?:bearer|basic)\s+\S+/iu,
    /\b(?:[A-Z0-9_]*(?:SECRET|TOKEN|PASSWORD|PASSWD|PASSPHRASE|API_?KEY|ACCESS_?KEY|PRIVATE_?KEY|_KEY|CREDENTIAL)[A-Z0-9_]*)\s*(?:=|:)\s*[^\s]+/iu,
    /--(?:password|passwd|passphrase|secret|token|api[-_]?key|access[-_]?key)(?:=|\s+)\S+/iu,
    /\bsshpass\b/iu,
    /\bmysql\b[^\r\n]*\s-p\S+/iu,
    /\b(?:curl|wget)\b[^\r\n]*(?:\s-u|\s--user(?:=|\s+))\s*\S+/iu,
    /\bdocker\s+login\b[^\r\n]*(?:\s-p|\s--password(?:=|\s+))\s*\S+/iu,
    /\baws\s+configure\s+set\s+\S*(?:secret|token|password|key)\S*\s+\S+/iu,
    /\b(?:https?|socks5h?|postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis):\/\/[^\s/:@]+:[^\s/@]+@/iu,
  ];
  return patterns.some((pattern) => pattern.test(command));
}
