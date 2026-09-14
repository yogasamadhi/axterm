export const AI_COPY_CODE_LIMIT = 64 * 1024;
export const AI_TERMINAL_INSERT_LIMIT = 16 * 1024;

export function aiGeneratedCode(value: string): string | undefined {
  const fenced = /```(?:[A-Za-z0-9_.+-]+)?[ \t]*\r?\n([\s\S]*?)```/u.exec(value);
  const code = (fenced?.[1] ?? value).replace(/\r\n?/gu, '\n').trim();
  if (!code || code.length > AI_COPY_CODE_LIMIT) return undefined;
  return code;
}

export function aiTerminalInsertion(value: string): string | undefined {
  const code = aiGeneratedCode(value);
  if (!code) return undefined;
  const filtered = code
    .split('\n')
    .filter((line) => line.trim() && !line.trimStart().startsWith('#'))
    .join('\n');
  if (!filtered || filtered.length > AI_TERMINAL_INSERT_LIMIT) return undefined;
  return filtered;
}
