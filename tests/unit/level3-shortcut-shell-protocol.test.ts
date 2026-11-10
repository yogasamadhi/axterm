import { describe, expect, it } from 'vitest';
import {
  initialShortcutConfig,
  parseKeyboardRequest,
  parseWindowPresentationState,
  type ShortcutCommandId,
} from '@axterm/plugin-api/shortcuts';
const generation = crypto.randomUUID();
describe('closed native keyboard protocol', () => {
  it('accepts transient catalog configuration and only closed window presentation operations', () => {
    const request = {
      type: 'configure',
      generation,
      definitions: [
        {
          id: 'test.one' as ShortcutCommandId,
          defaults: { 'desktop:macos': { code: 'KeyQ', modifiers: ['alt'] } },
        },
      ],
      snapshot: { ...initialShortcutConfig(), status: 'ready' },
    };
    expect(parseKeyboardRequest(request).type).toBe('configure');
    expect(parseKeyboardRequest({ type: 'window', generation, action: 'fullscreen' })).toEqual({
      type: 'window',
      generation,
      action: 'fullscreen',
    });
    for (const value of [
      { ...request, method: 'ssh.connect' },
      { ...request, generation: 'retired' },
      { ...request, snapshot: { ...request.snapshot, token: 'secret' } },
      { ...request, definitions: Array(513).fill(request.definitions[0]) },
      { type: 'window', generation, action: 'workspace.exec' },
      { type: 'window', generation, action: 'zoom-in' },
      { type: 'clear', path: '/tmp' },
      { type: 'recording', active: 1 },
      { type: 'close', revision: 'old' },
    ])
      expect(() => parseKeyboardRequest(value)).toThrow();
  });
  it('keeps browser/platform defaults separate and rejects unknown or future document fields', () => {
    const snapshot = { ...initialShortcutConfig(), status: 'ready' };
    for (const document of [
      { schemaVersion: 3, profiles: {} },
      { schemaVersion: 2, profiles: {}, extra: true },
      {
        schemaVersion: 2,
        profiles: { 'desktop:macos': { 'test.one': { code: 'KeyA', modifiers: [], run: 'exec' } } },
      },
    ])
      expect(() =>
        parseKeyboardRequest({
          type: 'configure',
          generation,
          definitions: [],
          snapshot: { ...snapshot, document },
        }),
      ).toThrow();
  });
});

it('keeps the selected preload public import closed to keyboard contracts', async () => {
  const { inspectLevel3Source } = await import('../../scripts/level3-architecture.mjs');
  const owner = {
    name: '@axterm/desktop',
    dependencies: { '@axterm/plugin-api': 'workspace:*' },
  };
  expect(
    inspectLevel3Source(
      'apps/desktop/src/shell/preload.ts',
      "import { parseKeyboardRequest } from '@axterm/plugin-api/shortcuts';",
      owner,
      'shell',
    ),
  ).toEqual([]);
  for (const name of [
    '@axterm/plugin-api',
    '@axterm/plugin-api/files',
    '@axterm/plugin-terminals',
    'node:fs',
  ])
    expect(
      inspectLevel3Source('apps/desktop/src/shell/preload.ts', `import '${name}'`, owner, 'shell')
        .length,
    ).toBeGreaterThan(0);
});
it('validates both directions of the closed native presentation protocol', () => {
  const generation = crypto.randomUUID();
  expect(parseKeyboardRequest({ type: 'window-state', generation })).toEqual({
    type: 'window-state',
    generation,
  });
  for (const action of ['minimize', 'toggle-maximize'])
    expect(parseKeyboardRequest({ type: 'window', generation, action })).toEqual({
      type: 'window',
      generation,
      action,
    });
  expect(() =>
    parseKeyboardRequest({ type: 'window-state', generation, windowId: 'foreign' }),
  ).toThrow();
  const state = {
    minimized: false,
    maximized: false,
    fullScreen: true,
    focused: true,
    visible: true,
    canMinimize: true,
    canMaximize: true,
    canClose: true,
  };
  expect(parseWindowPresentationState(state)).toEqual(state);
  for (const invalid of [
    { ...state, token: 'secret' },
    { ...state, canClose: 1 },
    { fullScreen: true },
    null,
  ])
    expect(() => parseWindowPresentationState(invalid)).toThrow();
});
