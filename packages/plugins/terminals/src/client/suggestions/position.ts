import type { Terminal } from '@xterm/xterm';
import type { TerminalCommandSuggestionsState } from './panel.tsx';
export function terminalCommandSuggestionPosition(
  terminal: Terminal,
  surface: HTMLElement,
): { position: TerminalCommandSuggestionsState['position']; reverse: boolean } | undefined {
  const terminalElement = terminal.element;
  if (!terminalElement || terminal.cols < 1 || terminal.rows < 1) return undefined;
  const terminalBounds = terminalElement.getBoundingClientRect();
  const surfaceBounds = surface.getBoundingClientRect();
  if (terminalBounds.width < 2 || terminalBounds.height < 2 || surfaceBounds.width < 2)
    return undefined;
  const cellWidth = terminalBounds.width / terminal.cols;
  const cellHeight = terminalBounds.height / terminal.rows;
  const cursorLeft = terminalBounds.left + terminal.buffer.active.cursorX * cellWidth;
  const cursorBottom = terminalBounds.top + (terminal.buffer.active.cursorY + 1) * cellHeight;
  const reverse = cursorBottom > surfaceBounds.top + surfaceBounds.height / 2;
  const position: TerminalCommandSuggestionsState['position'] = {};
  if (cursorLeft > surfaceBounds.left + surfaceBounds.width / 2)
    position.right = Math.max(8, surfaceBounds.right - cursorLeft);
  else position.left = Math.max(8, cursorLeft - surfaceBounds.left);
  if (reverse)
    position.bottom = Math.max(8, surfaceBounds.bottom - cursorBottom + cellHeight * 1.5);
  else position.top = Math.max(8, cursorBottom - surfaceBounds.top + cellHeight);
  return { position, reverse };
}
