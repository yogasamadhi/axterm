import { aiBookmarkDraftSchema, type AiBookmarkDraft } from '@workspace/contracts';

const JSON_FENCE = /^\s*```(?:json)?\s*([\s\S]*?)\s*```\s*$/iu;

/** Parse an AI result without ever accepting unreviewed or secret-bearing keys. */
export function parseAiBookmarkDraft(value: string): AiBookmarkDraft {
  const candidate = value.match(JSON_FENCE)?.[1] ?? value;
  return aiBookmarkDraftSchema.parse(JSON.parse(candidate));
}
