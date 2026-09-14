import { describe, expect, it } from 'vitest';
import {
  APP_LANGUAGES,
  DEFAULT_ACTIVITY_RAIL_ITEMS,
  DEFAULT_TERMINAL_SHORTCUT_BUTTONS,
  appLanguageSchema,
  settingsSchema,
  updateSettingsSchema,
} from '../../packages/contracts/src/index';

describe('settings contract', () => {
  it('accepts every supported application language and rejects unknown values', () => {
    expect(APP_LANGUAGES).toHaveLength(15);
    for (const language of APP_LANGUAGES) expect(appLanguageSchema.parse(language)).toBe(language);
    expect(() => appLanguageSchema.parse('en-GB')).toThrow();
    expect(updateSettingsSchema.parse({ appearance: { language: 'ja' } })).toEqual({
      appearance: { language: 'ja' },
    });
  });

  it('keeps workspace updates sparse instead of injecting persisted defaults', () => {
    expect(
      updateSettingsSchema.parse({
        workspace: { switchTabOnHover: true },
      }),
    ).toEqual({
      workspace: { switchTabOnHover: true },
    });
    expect(
      updateSettingsSchema.parse({
        workspace: { activityRailItems: ['widgets', 'bookmarks', 'quickConnect'] },
      }),
    ).toEqual({
      workspace: { activityRailItems: ['widgets', 'bookmarks', 'quickConnect'] },
    });
    expect(() =>
      updateSettingsSchema.parse({
        workspace: { activityRailItems: ['widgets', 'widgets'] },
      }),
    ).toThrow();
    expect(() => updateSettingsSchema.parse({ workspace: { activityRailItems: [] } })).toThrow();
  });

  it('validates sparse shortcut overrides and cross-action conflicts', () => {
    expect(
      updateSettingsSchema.parse({
        shortcuts: {
          bindings: {
            app_newTab: ['ctrl+shift+t'],
            terminal_search: [],
          },
        },
      }),
    ).toEqual({
      shortcuts: {
        bindings: {
          app_newTab: ['ctrl+shift+t'],
          terminal_search: [],
        },
      },
    });
    expect(() =>
      updateSettingsSchema.parse({
        shortcuts: {
          bindings: {
            app_newTab: ['ctrl+shift+t'],
            app_closeCurrentTab: ['ctrl+shift+t'],
          },
        },
      }),
    ).toThrow();
    expect(() =>
      updateSettingsSchema.parse({
        shortcuts: { bindings: { app_newTab: ['ctrl+ctrl+t'] } },
      }),
    ).toThrow();
  });

  it('backfills pinned shortcut-bar defaults and keeps terminal updates sparse', () => {
    const parsed = settingsSchema.parse({
      appearance: { theme: 'dark', language: 'zh-CN' },
      workspace: { restoreLayout: true, aiInspectorOpen: false },
      terminal: { autoReconnectTerminal: false, restoreTerminalSessionOnReload: false },
      version: 1,
    });
    expect(parsed.terminal.shortcutBarEnabled).toBe(true);
    expect(parsed.terminal.screenReaderMode).toBe(false);
    expect(parsed.workspace.activityRailItems).toEqual(DEFAULT_ACTIVITY_RAIL_ITEMS);
    expect(parsed.workspace.startupSessions).toEqual([]);
    expect(parsed.privacy.hideAddresses).toBe(false);
    expect(parsed.terminal.defaultProfileId).toBeNull();
    expect(parsed.terminal.commandSuggestionsEnabled).toBe(false);
    expect(parsed.terminal.dragDropBehavior).toBe('ask');
    expect(parsed.terminal.shortcutBarButtons).toEqual(DEFAULT_TERMINAL_SHORTCUT_BUTTONS);
    expect(parsed.fileManager).toEqual({
      showHiddenFiles: true,
      externalEditor: '',
      refreshOnFocus: false,
      followTerminalCwd: false,
      sshSplitView: false,
      remoteAddressBookmarks: [],
      columns: ['name', 'size', 'modifiedAt'],
      localSort: { property: 'modifiedAt', direction: 'desc' },
      remoteSort: { property: 'modifiedAt', direction: 'desc' },
    });
    expect(updateSettingsSchema.parse({ terminal: { shortcutBarEnabled: false } })).toEqual({
      terminal: { shortcutBarEnabled: false },
    });
    expect(updateSettingsSchema.parse({ terminal: { commandSuggestionsEnabled: true } })).toEqual({
      terminal: { commandSuggestionsEnabled: true },
    });
    expect(updateSettingsSchema.parse({ terminal: { dragDropBehavior: 'upload' } })).toEqual({
      terminal: { dragDropBehavior: 'upload' },
    });
    const defaultProfileId = '2f6ac217-1bc3-446f-857a-e1c1636558f3';
    expect(updateSettingsSchema.parse({ terminal: { defaultProfileId } })).toEqual({
      terminal: { defaultProfileId },
    });
    expect(updateSettingsSchema.parse({ terminal: { defaultProfileId: null } })).toEqual({
      terminal: { defaultProfileId: null },
    });
    expect(updateSettingsSchema.parse({ privacy: { hideAddresses: true } })).toEqual({
      privacy: { hideAddresses: true },
    });
  });

  it('validates Electerm-compatible startup, SFTP, editor and accessibility settings', () => {
    const first = '2f6ac217-1bc3-446f-857a-e1c1636558f3';
    const second = '4d38626d-241d-46fa-b7d8-7ea08b3fdf21';
    expect(
      updateSettingsSchema.parse({
        workspace: { startupSessions: [first, second] },
        terminal: { screenReaderMode: true },
        fileManager: {
          externalEditor: '  /Applications/Editor/bin/editor  ',
          refreshOnFocus: true,
          followTerminalCwd: true,
          sshSplitView: true,
        },
      }),
    ).toEqual({
      workspace: { startupSessions: [first, second] },
      terminal: { screenReaderMode: true },
      fileManager: {
        externalEditor: '/Applications/Editor/bin/editor',
        refreshOnFocus: true,
        followTerminalCwd: true,
        sshSplitView: true,
      },
    });
    expect(updateSettingsSchema.parse({ workspace: { startupSessions: first } })).toEqual({
      workspace: { startupSessions: first },
    });
    expect(() =>
      updateSettingsSchema.parse({ workspace: { startupSessions: ['not-an-id'] } }),
    ).toThrow();
    expect(() =>
      updateSettingsSchema.parse({
        workspace: { startupSessions: Array.from({ length: 21 }, () => first) },
      }),
    ).toThrow();
    expect(() =>
      updateSettingsSchema.parse({ fileManager: { externalEditor: 'x'.repeat(4_097) } }),
    ).toThrow();
  });

  it('validates sparse remote file-address bookmark updates', () => {
    const id = '4d38626d-241d-46fa-b7d8-7ea08b3fdf21';
    const hostId = '7cef64b6-6a80-47ee-b052-52988602806a';
    expect(
      updateSettingsSchema.parse({
        fileManager: {
          remoteAddressBookmarks: [{ id, hostId, path: '/var/log' }],
        },
      }),
    ).toEqual({
      fileManager: {
        remoteAddressBookmarks: [{ id, hostId, path: '/var/log' }],
      },
    });
    expect(() =>
      updateSettingsSchema.parse({
        fileManager: {
          remoteAddressBookmarks: [{ id, hostId: null, path: 'relative/path' }],
        },
      }),
    ).toThrow();
    expect(
      updateSettingsSchema.parse({
        fileManager: {
          columns: ['name', 'owner', 'mode'],
          localSort: { property: 'name', direction: 'asc' },
        },
      }),
    ).toEqual({
      fileManager: {
        columns: ['name', 'owner', 'mode'],
        localSort: { property: 'name', direction: 'asc' },
      },
    });
    expect(() =>
      updateSettingsSchema.parse({ fileManager: { columns: ['size', 'name'] } }),
    ).toThrow();
    expect(() =>
      updateSettingsSchema.parse({ fileManager: { columns: ['name', 'name'] } }),
    ).toThrow();
  });

  it('rejects duplicate, oversized or control-labelled shortcut buttons', () => {
    expect(() =>
      updateSettingsSchema.parse({
        terminal: {
          shortcutBarButtons: [
            { id: 'duplicate', label: 'One', data: '1' },
            { id: 'duplicate', label: 'Two', data: '2' },
          ],
        },
      }),
    ).toThrow();
    expect(() =>
      updateSettingsSchema.parse({
        terminal: { shortcutBarButtons: [{ id: 'bad', label: 'bad\nlabel', data: 'x' }] },
      }),
    ).toThrow();
    expect(() =>
      updateSettingsSchema.parse({
        terminal: { shortcutBarButtons: [{ id: 'large', label: 'Large', data: 'x'.repeat(65) }] },
      }),
    ).toThrow();
  });
});
