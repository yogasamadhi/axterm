import { describe, expect, it } from 'vitest';
import {
  DEFAULT_TERMINAL_BACKGROUND,
  DEFAULT_TERMINAL_THEME_ID,
  settingsSchema,
  terminalBackgroundSchema,
  terminalVisualSettingsSchema,
} from './resources';

describe('terminal visual contracts', () => {
  it('backfills the stable terminal theme and empty background for persisted settings', () => {
    const settings = settingsSchema.parse({
      appearance: { theme: 'system', language: 'zh-CN' },
      workspace: { restoreLayout: false, aiInspectorOpen: false },
      terminal: {},
      version: 1,
    });

    expect(settings.terminal.visual).toEqual({
      themeId: DEFAULT_TERMINAL_THEME_ID,
      background: DEFAULT_TERMINAL_BACKGROUND,
    });
  });

  it('accepts bounded text backgrounds and rejects mismatched asset references', () => {
    expect(
      terminalVisualSettingsSchema.parse({
        background: {
          ...DEFAULT_TERMINAL_BACKGROUND,
          kind: 'text',
          text: 'Axterm',
          opacity: 0.4,
        },
      }),
    ).toMatchObject({ themeId: DEFAULT_TERMINAL_THEME_ID, background: { kind: 'text' } });

    expect(
      terminalBackgroundSchema.safeParse({
        ...DEFAULT_TERMINAL_BACKGROUND,
        kind: 'image',
        assetId: null,
      }).success,
    ).toBe(false);
    expect(
      terminalBackgroundSchema.safeParse({
        ...DEFAULT_TERMINAL_BACKGROUND,
        kind: 'none',
        assetId: '00000000-0000-4000-8000-000000000002',
      }).success,
    ).toBe(false);
    expect(
      terminalBackgroundSchema.safeParse({
        ...DEFAULT_TERMINAL_BACKGROUND,
        kind: 'text',
        text: ' ',
      }).success,
    ).toBe(false);
  });
});
