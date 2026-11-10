import { aiTerminalThemeDraftSchema } from '@axterm/plugin-api/ai';
import type { TerminalThemeInput } from '@axterm/plugin-api/terminals';
const JSON_FENCE = /^\s*```(?:json)?\s*([\s\S]*?)\s*```\s*$/iu;
/** The Host validates the complete visible palette before publishing a draft. */
export function parseAiThemeDraft(value: string): TerminalThemeInput {
  const candidate = value.match(JSON_FENCE)?.[1] ?? value;
  return aiTerminalThemeDraftSchema.parse(JSON.parse(candidate));
}
