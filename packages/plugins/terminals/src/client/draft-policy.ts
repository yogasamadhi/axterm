const maximum = 16 * 1024;
/** Do not turn an AI insert action into Enter, control sequences or terminal protocol bytes. */
export function assertTerminalDraft(text: string, bracketedPaste: boolean): void {
  if (!text || text.length > maximum || new TextEncoder().encode(text).byteLength > maximum)
    throw new Error('TERMINAL_DRAFT_CAPACITY');
  for (const character of text) {
    const code = character.charCodeAt(0);
    if ((code < 32 && code !== 10 && code !== 13) || code === 127)
      throw new Error('TERMINAL_DRAFT_UNSAFE');
  }
  if (/[\r\n]/u.test(text) && !bracketedPaste) throw new Error('TERMINAL_DRAFT_UNSAFE');
}
