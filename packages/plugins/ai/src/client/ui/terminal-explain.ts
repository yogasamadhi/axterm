export const TERMINAL_AI_SELECTION_LIMIT = 16_000;

export interface TerminalExplainRequest {
  title: string;
  prompt: string;
  selectedText: string;
  truncated: boolean;
}

export function buildTerminalExplainRequest(
  selection: string,
  instruction: string,
): TerminalExplainRequest {
  const normalized = selection.replace(/\r\n?/gu, '\n').trim();
  const selectedText = normalized.slice(-TERMINAL_AI_SELECTION_LIMIT);
  const firstLine =
    selectedText
      .split('\n')
      .find((line) => line.trim())
      ?.trim() ?? '';
  return {
    title: firstLine.slice(0, 120) || instruction.slice(0, 120),
    prompt: `${instruction}\n\n---\n${selectedText}`,
    selectedText,
    truncated: selectedText.length < normalized.length,
  };
}
