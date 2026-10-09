import { describe, expect, it } from 'vitest';
import {
  DEFAULT_TERMINAL_APPEARANCE,
  DEFAULT_TERMINAL_BEHAVIOR,
  DEFAULT_TERMINAL_TYPE,
  terminalBehaviorSchema,
  terminalProfileInputSchema,
  terminalProfilePatchSchema,
  terminalProfileSchema,
} from '../../packages/contracts/src';

describe('terminal profile contract', () => {
  it('normalizes legacy create input to explicit process and appearance defaults', () => {
    expect(terminalProfileInputSchema.parse({ name: 'Default' })).toEqual({
      name: 'Default',
      shell: null,
      shellArgs: [],
      cwd: null,
      loginShell: false,
      env: {},
      term: DEFAULT_TERMINAL_TYPE,
      lang: null,
      ...DEFAULT_TERMINAL_APPEARANCE,
      ...DEFAULT_TERMINAL_BEHAVIOR,
    });

    const persisted = terminalProfileSchema.parse({
      id: '45c05554-11e3-4f47-93cd-c9d0ed831a7a',
      name: 'Legacy profile',
      shell: null,
      cwd: null,
      fontSize: 14,
      createdAt: '2026-09-12T00:00:00.000Z',
      updatedAt: '2026-09-12T00:00:00.000Z',
      version: 1,
    });
    expect(persisted).toMatchObject({
      shellArgs: [],
      env: {},
      term: DEFAULT_TERMINAL_TYPE,
      lang: null,
      loginShell: false,
      ...DEFAULT_TERMINAL_APPEARANCE,
      ...DEFAULT_TERMINAL_BEHAVIOR,
      fontSize: 14,
    });
  });

  it('keeps PATCH sparse so editing one field cannot reset process options', () => {
    expect(terminalProfilePatchSchema.parse({ fontSize: 19 })).toEqual({ fontSize: 19 });
    expect(terminalProfilePatchSchema.parse({ osc52WritePolicy: 'allow' })).toEqual({
      osc52WritePolicy: 'allow',
    });
  });

  it('migrates saved clipboard-only behavior and bounds renderer resources', () => {
    expect(
      terminalBehaviorSchema.parse({
        pasteProtection: false,
        osc52Enabled: true,
        osc52ReadPolicy: 'allow',
        osc52WritePolicy: 'deny',
      }),
    ).toEqual({
      ...DEFAULT_TERMINAL_BEHAVIOR,
      pasteProtection: false,
      osc52Enabled: true,
      osc52ReadPolicy: 'allow',
    });

    expect(() => terminalProfileInputSchema.parse({ name: 'negative', scrollback: -1 })).toThrow();
    expect(() =>
      terminalProfileInputSchema.parse({ name: 'unbounded', scrollback: 100_001 }),
    ).toThrow();
    expect(() =>
      terminalProfileInputSchema.parse({ name: 'separator', wordSeparator: 'x'.repeat(257) }),
    ).toThrow();
    expect(() =>
      terminalProfileInputSchema.parse({ name: 'shift-enter', shiftEnterMode: 'x'.repeat(257) }),
    ).toThrow();
    expect(() =>
      terminalProfileInputSchema.parse({ name: 'backspace', backspaceMode: 'delete' }),
    ).toThrow();
    expect(() =>
      terminalProfileInputSchema.parse({ name: 'encoding', encoding: 'made-up-codepage' }),
    ).toThrow();
    expect(
      terminalProfileInputSchema.parse({
        name: 'GPU images',
        scrollback: 12_000,
        rendererPreference: 'webgl',
        unicodeVersion: '11',
        ligaturesEnabled: false,
        imageSequencesEnabled: true,
        wordSeparator: ' /',
        backspaceMode: '^H',
        shiftEnterMode: '\\r',
        encoding: 'gbk',
        displayRaw: true,
      }),
    ).toMatchObject({
      scrollback: 12_000,
      rendererPreference: 'webgl',
      unicodeVersion: '11',
      ligaturesEnabled: false,
      imageSequencesEnabled: true,
      wordSeparator: ' /',
      backspaceMode: '^H',
      shiftEnterMode: '\\r',
      encoding: 'gbk',
      displayRaw: true,
    });
  });

  it.each(['TERM', 'LANG', 'NODE_OPTIONS', 'SERVICE_TOKEN', 'DB_PASSWORD', 'API_KEY'])(
    'rejects reserved or secret-like persisted environment key %s',
    (name) => {
      expect(() =>
        terminalProfileInputSchema.parse({ name: 'unsafe', env: { [name]: 'value' } }),
      ).toThrow();
    },
  );

  it('accepts bounded non-sensitive environment, TERM and LANG fields', () => {
    expect(
      terminalProfileInputSchema.parse({
        name: 'Remote UTF-8',
        env: { EDITOR: 'vim', COLORTERM: 'truecolor' },
        term: 'screen-256color',
        lang: 'zh_CN.UTF-8',
      }),
    ).toMatchObject({
      env: { EDITOR: 'vim', COLORTERM: 'truecolor' },
      term: 'screen-256color',
      lang: 'zh_CN.UTF-8',
    });
  });
});
