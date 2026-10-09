import { describe, expect, it } from 'vitest';
import { parseAiThemeDraft } from '../../apps/desktop/src/renderer/src/app/terminal-themes/ai-theme-draft';

const valid = {
  name: 'Accessible Ocean',
  terminal: {
    foreground: '#f2f7fa',
    background: '#101820',
    cursor: '#ffffff',
    cursorAccent: '#101820',
    selectionBackground: 'rgba(70, 140, 180, 0.45)',
    black: '#101820',
    red: '#ff6b6b',
    green: '#6bdb9a',
    yellow: '#ffd166',
    blue: '#63a4ff',
    magenta: '#c792ea',
    cyan: '#5eead4',
    white: '#dce7ec',
    brightBlack: '#536471',
    brightRed: '#ff8f8f',
    brightGreen: '#8ce8b2',
    brightYellow: '#ffe29a',
    brightBlue: '#8ebcff',
    brightMagenta: '#dab0f0',
    brightCyan: '#8af3e4',
    brightWhite: '#ffffff',
  },
  ui: {
    main: '#101820',
    'main-dark': '#0a1015',
    'main-light': '#1c2a34',
    text: '#f2f7fa',
    'text-light': '#ffffff',
    'text-dark': '#b7c7d0',
    'text-disabled': '#71818a',
    primary: '#4ea8de',
    info: '#63a4ff',
    success: '#6bdb9a',
    error: '#ff6b6b',
    warn: '#ffd166',
  },
} as const;

describe('AI terminal theme draft', () => {
  it('accepts an exact, accessible palette and optional JSON fence', () => {
    expect(parseAiThemeDraft(JSON.stringify(valid))).toEqual(valid);
    expect(parseAiThemeDraft(`\`\`\`json\n${JSON.stringify(valid)}\n\`\`\``)).toEqual(valid);
  });

  it('rejects missing, extra and malformed colors', () => {
    const { warn: _warn, ...missingUi } = valid.ui;
    expect(() => parseAiThemeDraft(JSON.stringify({ ...valid, ui: missingUi }))).toThrow();
    expect(() => parseAiThemeDraft(JSON.stringify({ ...valid, css: 'body{}' }))).toThrow();
    expect(() =>
      parseAiThemeDraft(
        JSON.stringify({ ...valid, terminal: { ...valid.terminal, red: 'javascript:red' } }),
      ),
    ).toThrow();
  });

  it('rejects unreadable terminal and interface pairs', () => {
    expect(() =>
      parseAiThemeDraft(
        JSON.stringify({
          ...valid,
          terminal: { ...valid.terminal, foreground: '#111111', background: '#101010' },
        }),
      ),
    ).toThrow(/contrast/u);
    expect(() =>
      parseAiThemeDraft(
        JSON.stringify({ ...valid, ui: { ...valid.ui, text: '#111111', main: '#101010' } }),
      ),
    ).toThrow(/contrast/u);
  });
});
