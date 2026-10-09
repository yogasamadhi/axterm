import type { AiSkill } from '@workspace/contracts';
import type { AxtermMessageKey } from '../../i18n/core';

export const aiSkillLabels: Record<AiSkill['useCase'], AxtermMessageKey> = {
  explainCommand: 'panels.explainCommand',
  explainOutput: 'panels.explainOutput',
  generateCommand: 'ai.generateCommandOrScript',
  diagnose: 'panels.diagnose',
};

export interface SkillMention {
  start: number;
  end: number;
  query: string;
}

/** Only a whitespace-delimited mention at the caret opens the skill picker. */
export function aiSkillMention(prompt: string, caret: number): SkillMention | undefined {
  const before = prompt.slice(0, caret);
  const match = /(?:^|\s)@([^\s@]*)$/u.exec(before);
  if (!match) return undefined;
  return { start: caret - match[1]!.length - 1, end: caret, query: match[1]! };
}

export function removeAiSkillMention(prompt: string, mention: SkillMention) {
  return prompt.slice(0, mention.start) + prompt.slice(mention.end);
}

/** Explicit aliases only; emails, unknown @words and ordinary prose are untouched. */
export function parseAiSkillPrompt(prompt: string, skills: readonly AiSkill[]) {
  const match = /^\s*@([a-z0-9-]+)(?=\s|$)\s*/iu.exec(prompt);
  const skill = skills.find((item) => item.id === match?.[1]?.toLowerCase());
  return { skill, prompt: skill && match ? prompt.slice(match[0].length) : prompt };
}
