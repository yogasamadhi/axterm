import { aiTerminalThemeDraftSchema, type TerminalThemeInput } from '@workspace/contracts';

const JSON_FENCE = /^\s*```(?:json)?\s*([\s\S]*?)\s*```\s*$/iu;

export function parseAiThemeDraft(value: string): TerminalThemeInput {
  const candidate = value.match(JSON_FENCE)?.[1] ?? value;
  return aiTerminalThemeDraftSchema.parse(JSON.parse(candidate));
}
