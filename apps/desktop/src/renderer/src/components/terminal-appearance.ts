import { DEFAULT_TERMINAL_APPEARANCE, type TerminalAppearance } from '@workspace/contracts';

export function resolveTerminalAppearance(
  appearance: TerminalAppearance | undefined,
): TerminalAppearance {
  return { ...DEFAULT_TERMINAL_APPEARANCE, ...appearance };
}
