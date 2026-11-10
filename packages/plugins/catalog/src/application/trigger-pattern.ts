import type { Bookmark } from '@axterm/plugin-api/catalog';
type TriggerRule = Bookmark['triggers'][number];
export function validateTriggerPattern(rule: Pick<TriggerRule, 'match'>): void {
  if (rule.match.type !== 'regex') return;
  try {
    new RegExp(rule.match.value);
  } catch {
    throw new Error('Trigger regular expression is invalid');
  }
  if (
    /\\[1-9]/u.test(rule.match.value) ||
    /\(\?<[=!]/u.test(rule.match.value) ||
    /\([^)]*(?:\*|\+|\{\d+(?:,\d*)?\})[^)]*\)(?:\*|\+|\{\d+(?:,\d*)?\})/u.test(rule.match.value) ||
    /(?:\*|\+|\{\d+(?:,\d*)?\})[^)]{0,32}(?:\*|\+|\{\d+(?:,\d*)?\})/u.test(rule.match.value)
  )
    throw new Error('Trigger regular expression uses an unsafe construct');
}
