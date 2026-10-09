import type { CommandHistoryItem } from '@workspace/contracts';

export const TERMINAL_SUGGESTION_DEBOUNCE_MS = 80;
export const TERMINAL_SUGGESTION_MAX_PREFIX_LENGTH = 256;
export const TERMINAL_SUGGESTION_MAX_ITEMS = 50;
export const TERMINAL_SUGGESTION_AI_MAX_ITEMS = 5;
export const TERMINAL_SUGGESTION_CACHE_LIMIT = 32;

export type TerminalSuggestionSource = 'AI' | 'H' | 'B' | 'Q';

export interface TerminalCommandSuggestion {
  id: string;
  command: string;
  source: TerminalSuggestionSource;
  historyItem?: CommandHistoryItem | undefined;
}

export interface TerminalPromptInputSnapshot {
  value: string;
  cursor: number;
}

export interface TerminalSuggestionSources {
  ai?: readonly string[] | undefined;
  history?: readonly CommandHistoryItem[] | undefined;
  batch?: readonly string[] | undefined;
  quick?: readonly string[] | undefined;
}

/**
 * Tracks only input typed while trusted OSC 633 integration says a shell prompt
 * is active. Password and OTP prompts happen outside that state and are never
 * retained by this model.
 */
export class TerminalPromptInputModel {
  private characters: string[] = [];
  private cursor = 0;
  private promptActive = false;
  private known = false;

  openPrompt(): TerminalPromptInputSnapshot {
    this.characters = [];
    this.cursor = 0;
    this.promptActive = true;
    this.known = true;
    return this.snapshot()!;
  }

  closePrompt(): void {
    this.characters = [];
    this.cursor = 0;
    this.promptActive = false;
    this.known = false;
  }

  replace(value: string): TerminalPromptInputSnapshot | undefined {
    if (!this.promptActive || !isTrackableInput(value)) return undefined;
    const characters = [...value];
    if (characters.length > TERMINAL_SUGGESTION_MAX_PREFIX_LENGTH) {
      this.invalidate();
      return undefined;
    }
    this.characters = characters;
    this.cursor = characters.length;
    this.known = true;
    return this.snapshot();
  }

  snapshot(): TerminalPromptInputSnapshot | undefined {
    if (!this.promptActive || !this.known) return undefined;
    return { value: this.characters.join(''), cursor: this.cursor };
  }

  handleInput(data: string): TerminalPromptInputSnapshot | undefined {
    if (!this.promptActive || !this.known || !data) return undefined;
    if (data === '\r' || data === '\n') {
      this.closePrompt();
      return undefined;
    }
    if (data === '\u001b') return this.snapshot();
    if (data === '\u001b[D' || data === '\u001bOD') {
      this.cursor = Math.max(0, this.cursor - 1);
      return this.snapshot();
    }
    if (data === '\u001b[C' || data === '\u001bOC') {
      this.cursor = Math.min(this.characters.length, this.cursor + 1);
      return this.snapshot();
    }
    if (['\u001b[H', '\u001bOH', '\u0001'].includes(data)) {
      this.cursor = 0;
      return this.snapshot();
    }
    if (['\u001b[F', '\u001bOF', '\u0005'].includes(data)) {
      this.cursor = this.characters.length;
      return this.snapshot();
    }
    if (data === '\u007f' || data === '\b') {
      if (this.cursor > 0) {
        this.characters.splice(this.cursor - 1, 1);
        this.cursor -= 1;
      }
      return this.snapshot();
    }
    if (data === '\u001b[3~') {
      if (this.cursor < this.characters.length) this.characters.splice(this.cursor, 1);
      return this.snapshot();
    }
    if (data === '\u0015') {
      this.characters.splice(0, this.cursor);
      this.cursor = 0;
      return this.snapshot();
    }
    if (data === '\u000b') {
      this.characters.splice(this.cursor);
      return this.snapshot();
    }
    if (data === '\u0017') {
      while (this.cursor > 0 && /\s/u.test(this.characters[this.cursor - 1] ?? '')) {
        this.characters.splice(this.cursor - 1, 1);
        this.cursor -= 1;
      }
      while (this.cursor > 0 && !/\s/u.test(this.characters[this.cursor - 1] ?? '')) {
        this.characters.splice(this.cursor - 1, 1);
        this.cursor -= 1;
      }
      return this.snapshot();
    }

    const bracketedPasteStart = '\u001b[200~';
    const bracketedPasteEnd = '\u001b[201~';
    if (data.startsWith(bracketedPasteStart) && data.endsWith(bracketedPasteEnd))
      return this.insert(data.slice(bracketedPasteStart.length, -bracketedPasteEnd.length));
    if (!isTrackableInput(data)) {
      this.invalidate();
      return undefined;
    }
    return this.insert(data);
  }

  private insert(value: string): TerminalPromptInputSnapshot | undefined {
    if (!isTrackableInput(value)) {
      this.invalidate();
      return undefined;
    }
    const characters = [...value];
    if (this.characters.length + characters.length > TERMINAL_SUGGESTION_MAX_PREFIX_LENGTH) {
      this.invalidate();
      return undefined;
    }
    this.characters.splice(this.cursor, 0, ...characters);
    this.cursor += characters.length;
    return this.snapshot();
  }

  private invalidate(): void {
    this.characters = [];
    this.cursor = 0;
    this.known = false;
  }
}

export function rankTerminalCommandSuggestions(
  prefix: string,
  sources: TerminalSuggestionSources,
  reverse = false,
): TerminalCommandSuggestion[] {
  if (!isSuggestionPrefix(prefix)) return [];
  const seen = new Set<string>();
  const result: TerminalCommandSuggestion[] = [];
  const push = (
    command: string,
    source: TerminalSuggestionSource,
    historyItem?: CommandHistoryItem,
  ) => {
    if (
      result.length >= TERMINAL_SUGGESTION_MAX_ITEMS ||
      !isTrackableInput(command) ||
      !command.startsWith(prefix) ||
      seen.has(command)
    )
      return;
    seen.add(command);
    result.push({
      id: `${source}:${command}`,
      command,
      source,
      ...(historyItem ? { historyItem } : {}),
    });
  };

  for (const command of sources.ai ?? []) push(command, 'AI');
  for (const item of sources.history ?? []) push(item.command, 'H', item);
  for (const command of sources.batch ?? []) push(command, 'B');
  for (const command of sources.quick ?? []) push(command, 'Q');
  return reverse ? result.reverse() : result;
}

export function terminalSuggestionInsertion(
  input: TerminalPromptInputSnapshot,
  command: string,
): string | undefined {
  if (!command.startsWith(input.value) || input.cursor < 0) return undefined;
  const characters = [...input.value];
  if (input.cursor > characters.length) return undefined;
  const moveToEnd = '\u001b[C'.repeat(characters.length - input.cursor);
  return `${moveToEnd}${command.slice(input.value.length)}`;
}

export function parseAiCommandSuggestions(value: string, prefix: string): string[] {
  const normalized = value
    .trim()
    .replace(/^```(?:json)?\s*/iu, '')
    .replace(/\s*```$/u, '');
  let candidates: unknown;
  try {
    candidates = JSON.parse(normalized);
  } catch {
    candidates = normalized
      .split(/\r?\n/u)
      .map((line) => line.replace(/^\s*(?:[-*]|\d+[.)])\s*/u, '').trim())
      .filter(Boolean);
  }
  if (!Array.isArray(candidates)) return [];
  const seen = new Set<string>();
  const result: string[] = [];
  for (const candidate of candidates) {
    if (typeof candidate !== 'string') continue;
    const command = candidate.trim();
    if (
      !isTrackableInput(command) ||
      !command.startsWith(prefix) ||
      seen.has(command) ||
      result.length >= TERMINAL_SUGGESTION_AI_MAX_ITEMS
    )
      continue;
    seen.add(command);
    result.push(command);
  }
  return result;
}

export function setBoundedSuggestionCache<T>(map: Map<string, T>, key: string, value: T): void {
  map.delete(key);
  map.set(key, value);
  while (map.size > TERMINAL_SUGGESTION_CACHE_LIMIT) {
    const oldest = map.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    map.delete(oldest);
  }
}

function isSuggestionPrefix(value: string): boolean {
  return (
    !!value && value.length <= TERMINAL_SUGGESTION_MAX_PREFIX_LENGTH && value === value.trimStart()
  );
}

function isTrackableInput(value: string): boolean {
  if (!value) return false;
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code < 32 || code === 127) return false;
  }
  return true;
}
