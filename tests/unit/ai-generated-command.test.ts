import { describe, expect, it } from 'vitest';
import {
  AI_COPY_CODE_LIMIT,
  AI_TERMINAL_INSERT_LIMIT,
  aiGeneratedCode,
  aiTerminalInsertion,
} from '../../apps/desktop/src/renderer/src/app/ai-generated-command';

describe('AI generated command review', () => {
  it('extracts a fenced script for copy and preserves meaningful indentation', () => {
    const response =
      'Use this script:\n```bash\n# reviewed first\nif true; then\n  echo ready\nfi\n```';
    expect(aiGeneratedCode(response)).toBe('# reviewed first\nif true; then\n  echo ready\nfi');
    expect(aiTerminalInsertion(response)).toBe('if true; then\n  echo ready\nfi');
  });

  it('accepts plain command output and rejects oversized copy or insertion', () => {
    expect(aiGeneratedCode('  git status  ')).toBe('git status');
    expect(aiTerminalInsertion('# comment only')).toBeUndefined();
    expect(aiGeneratedCode('x'.repeat(AI_COPY_CODE_LIMIT + 1))).toBeUndefined();
    expect(aiTerminalInsertion('x'.repeat(AI_TERMINAL_INSERT_LIMIT + 1))).toBeUndefined();
  });
});
