import { describe, expect, it } from 'vitest';
import {
  MAX_PALETTE_RESULTS,
  MAX_PALETTE_USAGE,
  buildPaletteItems,
  paletteResults,
  rememberPaletteUsage,
  shortcutUnavailableReason,
  type PaletteInput,
  type PaletteUsage,
} from '../../apps/desktop/src/renderer/src/app/command-palette/palette-model';
import { SHORTCUT_ACTIONS } from '../../apps/desktop/src/renderer/src/app/shortcuts/shortcut-registry';
import { translateAxterm } from '../../apps/desktop/src/renderer/src/i18n/core';

function input(overrides: Partial<PaletteInput> = {}): PaletteInput {
  return {
    x: (key, variables) => translateAxterm('zh-CN', key, variables),
    platform: 'mac',
    bindings: {},
    context: {
      runtimeReady: true,
      activeTabKind: 'local',
      tabCount: 2,
      hasTerminalView: true,
      terminalConnected: true,
      hasSelection: false,
      sshConnected: false,
      hasSftpPath: false,
    },
    sections: [{ id: 'files', messageKey: 'app.fileTransfer' }],
    hosts: [{ id: 'app_newTab', name: 'Lab server', hostname: '127.0.0.1' }],
    sessions: [{ id: 'session-id', title: 'Existing terminal' }],
    workspaces: [{ id: 'workspace-id', name: 'Saved layout' }],
    ...overrides,
  };
}

describe('command palette model', () => {
  it('reuses executable shortcut definitions, overrides and unique typed intents', () => {
    const items = buildPaletteItems(input({ bindings: { app_newTab: ['meta+shift+n'] } }));
    const shortcuts = items.filter(({ intent }) => intent.kind === 'shortcut');
    expect(shortcuts).toHaveLength(SHORTCUT_ACTIONS.length - 1);
    expect(new Set(items.map(({ id }) => id)).size).toBe(items.length);
    expect(items.find(({ id }) => id === 'shortcut:app_newTab')).toMatchObject({
      label: translateAxterm('zh-CN', 'shortcuts.action.newLocalTerminal'),
      shortcuts: ['meta+shift+n'],
      intent: { kind: 'shortcut', action: 'app_newTab' },
    });
    expect(items.find(({ id }) => id === 'host:app_newTab')?.intent).toEqual({
      kind: 'host',
      id: 'app_newTab',
    });
    expect(items.find(({ id }) => id === 'session:session-id')?.intent).toEqual({
      kind: 'session',
      id: 'session-id',
    });
    expect(items.find(({ id }) => id === 'workspace:workspace-id')?.intent).toEqual({
      kind: 'workspace',
      id: 'workspace-id',
    });
    expect(items.find(({ id }) => id === 'section:files')?.intent).toEqual({
      kind: 'section',
      section: 'files',
    });
    expect(items.find(({ id }) => id === 'transfer-center')?.intent).toEqual({
      kind: 'transfer-center',
    });
  });

  it.each(['en', 'zh-CN', 'zh-TW', 'ja'] as const)(
    'searches and displays %s while keeping all language aliases',
    (language) => {
      const items = buildPaletteItems(
        input({ x: (key, variables) => translateAxterm(language, key, variables) }),
      );
      for (const searchLanguage of ['en', 'zh-CN', 'zh-TW', 'ja'] as const) {
        const query = translateAxterm(searchLanguage, 'shortcuts.action.newLocalTerminal');
        const results = paletteResults(items, query, []);
        expect(results.items).toHaveLength(1);
        expect(results.items[0]?.id).toBe('shortcut:app_newTab');
        expect(results.items[0]?.label).toBe(
          translateAxterm(language, 'shortcuts.action.newLocalTerminal'),
        );
      }
    },
  );

  it('normalizes Unicode width and whitespace, reports empty results and bounds visible results without hiding searchable hosts', () => {
    const hosts = Array.from({ length: 200 }, (_, index) => ({
      id: `host-${index}`,
      name: `Lab ${index}`,
      hostname: '127.0.0.1',
    }));
    const items = buildPaletteItems(input({ hosts }));
    expect(paletteResults(items, 'Ｎｅｗ　local terminal', []).items[0]?.id).toBe(
      'shortcut:app_newTab',
    );
    expect(paletteResults(items, 'no-such-action', []).total).toBe(0);
    expect(paletteResults(items, '', []).items).toHaveLength(MAX_PALETTE_RESULTS);
    expect(paletteResults(items, 'Lab 199', []).items[0]?.id).toBe('host:host-199');
  });

  it('keeps session-local usage bounded and ranks frequency then recency without duplicate items', () => {
    let usage: PaletteUsage[] = [];
    for (let index = 0; index < 201; index += 1)
      usage = rememberPaletteUsage(usage, `host:${index}`);
    expect(usage).toHaveLength(MAX_PALETTE_USAGE);
    expect(usage[0]?.id).toBe('host:151');
    expect(
      usage.every((entry) => Object.keys(entry).sort().join(',') === 'count,id,lastUsed'),
    ).toBe(true);
    usage = rememberPaletteUsage([], 'section:files');
    usage = rememberPaletteUsage(usage, 'section:files');
    usage = rememberPaletteUsage(usage, 'transfer-center');
    const results = paletteResults(buildPaletteItems(input()), '', usage);
    expect(results.items.slice(0, 2).map(({ id }) => id)).toEqual([
      'section:files',
      'transfer-center',
    ]);
    expect(results.items[0]?.group).toBe('recent');
    expect(results.items.filter(({ id }) => id === 'section:files')).toHaveLength(1);
    expect(JSON.stringify(usage)).not.toContain('Lab server');
    expect(JSON.stringify(usage)).not.toContain('127.0.0.1');
  });

  it('explains stale contexts and shares the same availability with shortcut dispatch', () => {
    const base = input();
    const absent = {
      ...base.context,
      activeTabKind: undefined,
      tabCount: 0,
      hasTerminalView: false,
    };
    expect(shortcutUnavailableReason('app_closeCurrentTab', absent)).toBe(
      'palette.requiresSession',
    );
    expect(shortcutUnavailableReason('terminal_search', absent)).toBe('palette.requiresSession');
    expect(shortcutUnavailableReason('terminal_copy', base.context)).toBe(
      'palette.requiresSelection',
    );
    expect(shortcutUnavailableReason('terminal_syncSftpPath', base.context)).toBe(
      'palette.requiresSsh',
    );
    expect(shortcutUnavailableReason('app_newTab', { ...base.context, runtimeReady: false })).toBe(
      'palette.runtimeUnavailable',
    );
    const items = buildPaletteItems({ ...base, context: absent });
    expect(items.find(({ id }) => id === 'shortcut:app_closeCurrentTab')?.unavailableReason).toBe(
      shortcutUnavailableReason('app_closeCurrentTab', absent),
    );
    const ssh = { ...base.context, activeTabKind: 'ssh', sshConnected: true };
    expect(shortcutUnavailableReason('terminal_syncSftpPath', ssh)).toBe('app.sftpPathUnavailable');
    expect(
      shortcutUnavailableReason('terminal_syncSftpPath', { ...ssh, hasSftpPath: true }),
    ).toBeUndefined();
  });

  it('preserves local buffer operations on a disconnected terminal and blocks sending input', () => {
    const context = {
      ...input().context,
      terminalConnected: false,
      runtimeReady: false,
      hasSelection: true,
    };
    expect(shortcutUnavailableReason('terminal_search', context)).toBeUndefined();
    expect(shortcutUnavailableReason('terminal_copy', context)).toBeUndefined();
    expect(shortcutUnavailableReason('terminal_pasteSelected', context)).toBe(
      'palette.runtimeUnavailable',
    );
    expect(shortcutUnavailableReason('terminal_paste', { ...context, runtimeReady: true })).toBe(
      'palette.requiresSession',
    );
  });
});
