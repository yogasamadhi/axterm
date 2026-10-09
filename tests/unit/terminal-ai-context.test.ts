import { describe, expect, it } from 'vitest';
import {
  buildTerminalExplainRequest,
  TERMINAL_AI_SELECTION_LIMIT,
} from '../../apps/desktop/src/renderer/src/app/terminal-ai-context';

describe('terminal AI context', () => {
  it('keeps recent output within the explicit selection limit and makes it inspectable', () => {
    const request = buildTerminalExplainRequest(
      `old-output\n${'x'.repeat(TERMINAL_AI_SELECTION_LIMIT)}`,
      'Explain this output.',
    );
    expect(request.truncated).toBe(true);
    expect(request.selectedText).toHaveLength(TERMINAL_AI_SELECTION_LIMIT);
    expect(request.selectedText).not.toContain('old-output');
    expect(request.prompt).toBe(`Explain this output.\n\n---\n${request.selectedText}`);
  });

  it('normalizes line endings and derives a bounded session title', () => {
    expect(
      buildTerminalExplainRequest('\r\n  ssh: connection refused\r\nretrying', 'Explain'),
    ).toEqual({
      title: 'ssh: connection refused',
      prompt: 'Explain\n\n---\nssh: connection refused\nretrying',
      selectedText: 'ssh: connection refused\nretrying',
      truncated: false,
    });
  });
});
