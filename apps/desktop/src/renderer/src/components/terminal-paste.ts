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
  const platformNormalized =
    platform === 'win32' && kind !== 'local' ? text.replace(/\r\n/g, '\n') : text;
  if (kind !== 'local' && kind !== 'ssh') return platformNormalized;
  if (SQL_STATEMENT_START.test(platformNormalized))
    return foldSqlStatementLines(platformNormalized);
  return foldShellContinuationLines(platformNormalized);
}

export function foldShellContinuationLines(text: string): string {
  // Here-document bodies are data rather than shell syntax. A small continuation
  // recognizer cannot safely distinguish their delimiters, so leave the paste intact.
  if (/(?:^|[;&|()\s])<<-?\s*['"]?[A-Za-z_][A-Za-z0-9_]*['"]?/mu.test(text)) return text;
  const parts = text.split(/(\r\n|\r|\n)/u);
  if (parts.length === 1) return text;
  let folded = parts[0] ?? '';
  for (let index = 1; index < parts.length; index += 2) {
    const lineBreak = parts[index] ?? '';
    const nextLine = parts[index + 1] ?? '';
    const continuation = shellContinuationAtEnd(folded);
    const continuationTarget = nextLine.trimStart();
    const safeTarget = continuationTarget.length > 0 && !continuationTarget.startsWith('#');
    if (continuation && safeTarget) {
      folded = `${folded.trimEnd()} ${nextLine.trimStart()}`;
    } else {
      folded += `${lineBreak}${nextLine}`;
    }
  }
  return folded;
}

function shellContinuationAtEnd(text: string): boolean {
  const lineStart = Math.max(text.lastIndexOf('\n'), text.lastIndexOf('\r')) + 1;
  const line = text.slice(lineStart).trimEnd();
  if (!line) return false;
  let quote: "'" | '"' | undefined;
  let escaped = false;
  let comment = false;
  const outsideQuotes = new Array<boolean>(line.length).fill(false);
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index]!;
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === '\\' && quote !== "'") {
      outsideQuotes[index] = quote === undefined;
      escaped = true;
      continue;
    }
    if (character === "'" && quote !== '"') {
      quote = quote === "'" ? undefined : "'";
      continue;
    }
    if (character === '"' && quote !== "'") {
      quote = quote === '"' ? undefined : '"';
      continue;
    }
    if (
      character === '#' &&
      quote === undefined &&
      (index === 0 || /[\s;&|()]/u.test(line[index - 1]!))
    ) {
      comment = true;
      break;
    }
    outsideQuotes[index] = quote === undefined;
  }
  if (quote || comment) return false;
  for (const operator of ['&&', '||', '|&', '|']) {
    const start = line.length - operator.length;
    if (
      start >= 0 &&
      line.endsWith(operator) &&
      [...operator].every((_character, offset) => outsideQuotes[start + offset])
    )
      return true;
  }
  return false;
}

const SQL_STATEMENT_START =
  /^\s*(?:WITH(?:\s+RECURSIVE)?\b|SELECT\b|INSERT\s+INTO\b|UPDATE\b|DELETE\s+FROM\b|MERGE\s+INTO\b|CREATE\s+(?:OR\s+REPLACE\s+)?(?:TABLE|VIEW|INDEX|SCHEMA|DATABASE|TYPE|FUNCTION|PROCEDURE|TRIGGER|SEQUENCE)\b|ALTER\s+(?:TABLE|VIEW|INDEX|SCHEMA|DATABASE|TYPE|FUNCTION|PROCEDURE|TRIGGER|SEQUENCE)\b|DROP\s+(?:TABLE|VIEW|INDEX|SCHEMA|DATABASE|TYPE|FUNCTION|PROCEDURE|TRIGGER|SEQUENCE)\b|TRUNCATE(?:\s+TABLE)?\b|GRANT\b|REVOKE\b|COMMENT\s+ON\b|EXPLAIN\b|VACUUM\b)/iu;

export function foldSqlStatementLines(text: string): string {
  if (!/[\r\n]/u.test(text) || !SQL_STATEMENT_START.test(text) || !isFoldableSqlStatement(text))
    return text;
  return text
    .split(/\r\n|\r|\n/u)
    .map((line) => line.trim())
    .filter(Boolean)
    .join(' ');
}

function isFoldableSqlStatement(text: string): boolean {
  let quote: "'" | '"' | '`' | ']' | undefined;
  let parentheses = 0;
  let terminators = 0;
  let lastTerminator = -1;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index]!;
    if (character === '\r' || character === '\n') {
      if (quote) return false;
      continue;
    }
    if (quote) {
      const closing = quote;
      if (character === '\\') {
        if (text[index + 1] === '\r' || text[index + 1] === '\n') return false;
        index += 1;
        continue;
      }
      if (character !== closing) continue;
      if (text[index + 1] === closing) {
        index += 1;
        continue;
      }
      quote = undefined;
      continue;
    }
    if (
      (character === '-' && text[index + 1] === '-') ||
      (character === '/' && text[index + 1] === '*') ||
      (character === '#' && (index === 0 || /\s/u.test(text[index - 1]!)))
    )
      return false;
    if (character === "'" || character === '"' || character === '`') {
      quote = character;
      continue;
    }
    if (character === '[') {
      quote = ']';
      continue;
    }
    if (character === '$') {
      const delimiter = /^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/u.exec(text.slice(index))?.[0];
      if (delimiter) {
        const end = text.indexOf(delimiter, index + delimiter.length);
        if (end < 0 || /[\r\n]/u.test(text.slice(index + delimiter.length, end))) return false;
        index = end + delimiter.length - 1;
        continue;
      }
    }
    if (character === '(') parentheses += 1;
    else if (character === ')') {
      parentheses -= 1;
      if (parentheses < 0) return false;
    } else if (character === ';') {
      terminators += 1;
      lastTerminator = index;
    }
  }
  return (
    !quote &&
    parentheses === 0 &&
    terminators === 1 &&
    lastTerminator >= 0 &&
    text.slice(lastTerminator + 1).trim().length === 0
  );
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
