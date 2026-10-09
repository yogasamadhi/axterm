import { describe, expect, it } from 'vitest';
import { aiRequestSchema, type AiSkill } from '../../packages/contracts/src';
import {
  aiSkillMention,
  parseAiSkillPrompt,
  removeAiSkillMention,
} from '../../apps/desktop/src/renderer/src/app/ai/ai-skills';

const skills: AiSkill[] = [
  { id: 'explain-command', useCase: 'explainCommand', description: 'Explain commands' },
];
describe('assistant mention adapter and safe request mode', () => {
  it('finds the caret mention without treating emails or earlier prose as a query', () => {
    expect(aiSkillMention('foo @explain suffix', 12)).toEqual({
      start: 4,
      end: 12,
      query: 'explain',
    });
    expect(
      removeAiSkillMention('foo @explain suffix', { start: 4, end: 12, query: 'explain' }),
    ).toBe('foo  suffix');
    expect(aiSkillMention('@解释', 3)?.query).toBe('解释');
    expect(aiSkillMention('user@example.com', 16)).toBeUndefined();
    expect(aiSkillMention('say @skill more', 15)).toBeUndefined();
  });
  it('recognizes explicit known aliases and preserves unknown mentions and email text', () => {
    expect(parseAiSkillPrompt('@explain-command ls -la', skills)).toMatchObject({
      skill: skills[0],
      prompt: 'ls -la',
    });
    for (const prompt of [
      'user@example.com',
      '@unknown ls',
      'explain @explain-command',
      '@explain-command-suffix ls',
    ])
      expect(parseAiSkillPrompt(prompt, skills)).toEqual({ skill: undefined, prompt });
  });
  it('defaults old requests to chat and validates the two supported modes', () => {
    const input = {
      modelId: '91ee1f4a-1f1b-4bb4-9a63-a53298f50c6e',
      useCase: 'chat',
      prompt: 'hello',
    };
    expect(aiRequestSchema.parse(input).mode).toBe('chat');
    expect(aiRequestSchema.parse({ ...input, mode: 'work' }).mode).toBe('work');
    expect(aiRequestSchema.safeParse({ ...input, mode: 'agent' }).success).toBe(false);
  });
});
