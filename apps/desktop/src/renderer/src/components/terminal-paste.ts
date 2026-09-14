export const TERMINAL_PASTE_CONFIRM_THRESHOLD = 500;
export const TERMINAL_PASTE_MAX_CHARACTERS = 1024 * 1024;
export const TERMINAL_PASTE_MAX_BYTES = 1024 * 1024;
export const TERMINAL_PASTE_PREVIEW_CHARACTERS = 8 * 1024;

export interface TerminalPasteReview {
  characters: number;
  lines: number;
  preview: string;
  truncated: boolean;
  reason: 'long' | 'multiline' | 'long-multiline';
}

export type TerminalPasteAssessment =
  | { action: 'send' }
  | { action: 'confirm'; review: TerminalPasteReview }
  | { action: 'reject'; code: 'PASTE_TOO_LARGE' };

export function assessTerminalPaste(
  text: string,
  protectionEnabled = true,
): TerminalPasteAssessment {
  if (
    text.length > TERMINAL_PASTE_MAX_CHARACTERS ||
    new TextEncoder().encode(text).byteLength > TERMINAL_PASTE_MAX_BYTES
  ) {
    return {
      action: 'reject',
      code: 'PASTE_TOO_LARGE',
    };
  }
  const multiline = /[\r\n]/.test(text);
  const long = text.length > TERMINAL_PASTE_CONFIRM_THRESHOLD;
  if (!protectionEnabled || (!multiline && !long)) return { action: 'send' };
  return {
    action: 'confirm',
    review: {
      characters: text.length,
      lines: countTerminalPasteLines(text),
      preview: text.slice(0, TERMINAL_PASTE_PREVIEW_CHARACTERS),
      truncated: text.length > TERMINAL_PASTE_PREVIEW_CHARACTERS,
      reason: long && multiline ? 'long-multiline' : long ? 'long' : 'multiline',
    },
  };
}

export function normalizeTerminalPaste(
  text: string,
  kind: 'local' | 'ssh' | 'telnet' | 'serial',
  platform: 'win32' | 'darwin' | 'linux' | 'other',
): string {
  return platform === 'win32' && kind !== 'local' ? text.replace(/\r\n/g, '\n') : text;
}

export function terminalPlatformFromUserAgent(
  userAgent: string,
): 'win32' | 'darwin' | 'linux' | 'other' {
  if (/Windows/i.test(userAgent)) return 'win32';
  if (/Macintosh|Mac OS X/i.test(userAgent)) return 'darwin';
  if (/Linux/i.test(userAgent)) return 'linux';
  return 'other';
}

function countTerminalPasteLines(text: string): number {
  let lines = 1;
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === '\n') lines += 1;
    else if (text[index] === '\r') {
      lines += 1;
      if (text[index + 1] === '\n') index += 1;
    }
  }
  return lines;
}
