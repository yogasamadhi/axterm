import { describe, expect, it } from 'vitest';
import {
  parseWindowPreferencesDraft,
  toWindowPreferencesDraft,
} from '../../apps/desktop/src/renderer/src/app/window-preferences-model';

describe('window preferences panel model', () => {
  it('maps persisted preferences into editable text without losing numeric precision', () => {
    expect(
      toWindowPreferencesDraft({
        titleBarStyle: 'system',
        opacity: 0.65,
        zoomFactor: 1.25,
        bounds: { x: -1200, y: 40, width: 1100, height: 720 },
        globalHotkey: 'Control+2',
        allowMultiInstance: true,
        confirmBeforeExit: true,
      }),
    ).toEqual({
      titleBarStyle: 'system',
      opacity: '0.65',
      zoomFactor: '1.25',
      allowMultiInstance: true,
      confirmBeforeExit: true,
    });
  });

  it('normalizes valid boundary values into the typed preference patch', () => {
    expect(
      parseWindowPreferencesDraft({
        titleBarStyle: 'custom',
        opacity: '0',
        zoomFactor: '8',
        allowMultiInstance: true,
        confirmBeforeExit: false,
      }),
    ).toEqual({
      ok: true,
      value: {
        titleBarStyle: 'custom',
        opacity: 0,
        zoomFactor: 8,
        allowMultiInstance: true,
        confirmBeforeExit: false,
      },
    });
    expect(
      parseWindowPreferencesDraft({
        titleBarStyle: 'system',
        opacity: ' 1 ',
        zoomFactor: '0.5',
        allowMultiInstance: false,
        confirmBeforeExit: true,
      }),
    ).toEqual({
      ok: true,
      value: {
        titleBarStyle: 'system',
        opacity: 1,
        zoomFactor: 0.5,
        allowMultiInstance: false,
        confirmBeforeExit: true,
      },
    });
  });

  it('rejects empty, non-finite and out-of-contract numeric values with field-specific codes', () => {
    expect(
      parseWindowPreferencesDraft({
        titleBarStyle: 'custom',
        opacity: '',
        zoomFactor: '1',
        allowMultiInstance: false,
        confirmBeforeExit: false,
      }),
    ).toEqual({ ok: false, code: 'invalidOpacity' });
    expect(
      parseWindowPreferencesDraft({
        titleBarStyle: 'custom',
        opacity: '0.5',
        zoomFactor: 'Infinity',
        allowMultiInstance: false,
        confirmBeforeExit: false,
      }),
    ).toEqual({ ok: false, code: 'invalidZoomFactor' });
    expect(
      parseWindowPreferencesDraft({
        titleBarStyle: 'custom',
        opacity: '-0.01',
        zoomFactor: '1',
        allowMultiInstance: false,
        confirmBeforeExit: false,
      }),
    ).toMatchObject({ ok: false });
    expect(
      parseWindowPreferencesDraft({
        titleBarStyle: 'custom',
        opacity: '0.5',
        zoomFactor: '8.01',
        allowMultiInstance: false,
        confirmBeforeExit: false,
      }),
    ).toMatchObject({ ok: false });
  });
});
