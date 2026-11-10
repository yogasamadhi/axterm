import {
  settingsSchema,
  updateSettingsSchema,
  type Settings,
  type UpdateSettingsInput,
} from '@axterm/plugin-api/configuration';
import type { RelationalDomain } from '@axterm/plugin-api/storage';
import { SettingsError, versionFromEtag } from '../application/errors.ts';
export class SettingsRepository {
  constructor(private readonly database: RelationalDomain) {}
  getSettings(): Settings {
    const rows = this.database.all<{ section: string; payload: string; version: number }>(
      'SELECT section, payload, version FROM app_settings',
    );
    const appearance = rows.find((row) => row.section === 'appearance');
    const workspace = rows.find((row) => row.section === 'workspace');
    const privacy = rows.find((row) => row.section === 'privacy');
    const network = rows.find((row) => row.section === 'network');
    const shortcuts = rows.find((row) => row.section === 'shortcuts');
    const terminal = rows.find((row) => row.section === 'terminal');
    const fileManager = rows.find((row) => row.section === 'fileManager');
    const monitor = rows.find((row) => row.section === 'monitor');
    return settingsSchema.parse({
      appearance: appearance
        ? JSON.parse(appearance.payload)
        : { theme: 'dark', language: 'zh-CN' },
      workspace: workspace
        ? JSON.parse(workspace.payload)
        : {
            restoreLayout: false,
            aiInspectorOpen: false,
            namedWorkspaces: [],
            activeWorkspaceId: null,
            startupSessions: [],
            showTabNumber: true,
            switchTabOnHover: false,
            activityRailItems: [
              'newBookmark',
              'quickConnect',
              'bookmarks',
              'terminalThemes',
              'setting',
              'settingSync',
              'widgets',
            ],
          },
      privacy: privacy
        ? JSON.parse(privacy.payload)
        : {
            connectionHistoryEnabled: true,
            commandHistoryEnabled: false,
            hideAddresses: false,
          },
      network: network ? JSON.parse(network.payload) : { proxy: { mode: 'direct' } },
      shortcuts: shortcuts ? JSON.parse(shortcuts.payload) : { bindings: {} },
      terminal: terminal
        ? JSON.parse(terminal.payload)
        : {
            defaultProfileId: null,
            screenReaderMode: false,
            autoReconnectTerminal: false,
            restoreTerminalSessionOnReload: false,
            commandSuggestionsEnabled: false,
            dragDropBehavior: 'ask',
          },
      fileManager: fileManager
        ? JSON.parse(fileManager.payload)
        : {
            showHiddenFiles: true,
            externalEditor: '',
            refreshOnFocus: false,
            followTerminalCwd: false,
            sshSplitView: false,
            remoteAddressBookmarks: [],
            columns: ['name', 'size', 'modifiedAt'],
            localSort: { property: 'modifiedAt', direction: 'desc' },
            remoteSort: { property: 'modifiedAt', direction: 'desc' },
          },
      monitor: monitor
        ? JSON.parse(monitor.payload)
        : {
            terminalInformationItems: [
              'sysinfo',
              'uptime',
              'cpu',
              'memory',
              'activities',
              'network',
              'disks',
            ],
            remoteMonitorBarEnabled: false,
            remoteMonitorBarItems: [
              'hostname',
              'cpu',
              'cpuHistory',
              'memory',
              'upload',
              'download',
              'uptime',
              'users',
              'disks',
            ],
          },
      version: Math.max(
        appearance?.version ?? 1,
        workspace?.version ?? 1,
        privacy?.version ?? 1,
        network?.version ?? 1,
        shortcuts?.version ?? 1,
        terminal?.version ?? 1,
        fileManager?.version ?? 1,
        monitor?.version ?? 1,
      ),
    });
  }

  applyImportedSettings(input: UpdateSettingsInput, ifMatch: string): Settings {
    return this.writeSettings(input, ifMatch, true);
  }
  updateSettings(input: UpdateSettingsInput, ifMatch: string | undefined): Settings {
    return this.writeSettings(input, ifMatch, false);
  }
  private writeSettings(
    input: UpdateSettingsInput,
    ifMatch: string | undefined,
    imported: boolean,
  ): Settings {
    const command = updateSettingsSchema.parse(input);
    const current = this.getSettings();
    if (current.version !== versionFromEtag(ifMatch))
      throw new SettingsError('PRECONDITION_FAILED', 'Settings changed', 412);
    if (imported && current.workspace.importRevision >= Number.MAX_SAFE_INTEGER - 1)
      throw new SettingsError('PRECONDITION_FAILED', 'Import revision capacity exceeded', 412);
    const next: Settings = {
      appearance: {
        theme: command.appearance?.theme ?? current.appearance.theme,
        language: command.appearance?.language ?? current.appearance.language,
      },
      workspace: {
        importRevision: current.workspace.importRevision + (imported ? 1 : 0),
        restoreLayout: command.workspace?.restoreLayout ?? current.workspace.restoreLayout,
        aiInspectorOpen: command.workspace?.aiInspectorOpen ?? current.workspace.aiInspectorOpen,
        namedWorkspaces: command.workspace?.namedWorkspaces ?? current.workspace.namedWorkspaces,
        activeWorkspaceId:
          command.workspace?.activeWorkspaceId === undefined
            ? current.workspace.activeWorkspaceId
            : command.workspace.activeWorkspaceId,
        startupSessions: command.workspace?.startupSessions ?? current.workspace.startupSessions,
        showTabNumber: command.workspace?.showTabNumber ?? current.workspace.showTabNumber,
        switchTabOnHover: command.workspace?.switchTabOnHover ?? current.workspace.switchTabOnHover,
        activityRailItems:
          command.workspace?.activityRailItems ?? current.workspace.activityRailItems,
        ...(!imported &&
        command.workspace?.presentations === undefined &&
        current.workspace.presentations === undefined
          ? {}
          : {
              presentations: imported
                ? {}
                : (command.workspace?.presentations ?? current.workspace.presentations!),
            }),
        ...(command.workspace?.layout === undefined && current.workspace.layout === undefined
          ? {}
          : { layout: command.workspace?.layout ?? current.workspace.layout! }),
      },
      privacy: {
        connectionHistoryEnabled:
          command.privacy?.connectionHistoryEnabled ?? current.privacy.connectionHistoryEnabled,
        commandHistoryEnabled:
          command.privacy?.commandHistoryEnabled ?? current.privacy.commandHistoryEnabled,
        hideAddresses: command.privacy?.hideAddresses ?? current.privacy.hideAddresses,
      },
      network: {
        proxy: command.network?.proxy ?? current.network.proxy,
      },
      shortcuts: {
        bindings: command.resetTerminalGestures
          ? Object.fromEntries(
              Object.entries(command.shortcuts?.bindings ?? current.shortcuts.bindings).filter(
                ([key]) => key !== 'terminal_zoominTerminal' && key !== 'terminal_zoomoutTerminal',
              ),
            )
          : (command.shortcuts?.bindings ?? current.shortcuts.bindings),
        ...((command.shortcuts?.document ?? current.shortcuts.document) === undefined
          ? {}
          : { document: command.shortcuts?.document ?? current.shortcuts.document! }),
      },
      terminal: {
        defaultProfileId:
          command.terminal?.defaultProfileId === undefined
            ? current.terminal.defaultProfileId
            : command.terminal.defaultProfileId,
        screenReaderMode: command.terminal?.screenReaderMode ?? current.terminal.screenReaderMode,
        autoReconnectTerminal:
          command.terminal?.autoReconnectTerminal ?? current.terminal.autoReconnectTerminal,
        restoreTerminalSessionOnReload:
          command.terminal?.restoreTerminalSessionOnReload ??
          current.terminal.restoreTerminalSessionOnReload,
        commandSuggestionsEnabled:
          command.terminal?.commandSuggestionsEnabled ?? current.terminal.commandSuggestionsEnabled,
        dragDropBehavior: command.terminal?.dragDropBehavior ?? current.terminal.dragDropBehavior,
        shortcutBarEnabled:
          command.terminal?.shortcutBarEnabled ?? current.terminal.shortcutBarEnabled,
        shortcutBarButtons:
          command.terminal?.shortcutBarButtons ?? current.terminal.shortcutBarButtons,
        visual: command.terminal?.visual ?? current.terminal.visual,
      },
      fileManager: {
        showHiddenFiles:
          command.fileManager?.showHiddenFiles ?? current.fileManager.showHiddenFiles,
        externalEditor: command.fileManager?.externalEditor ?? current.fileManager.externalEditor,
        refreshOnFocus: command.fileManager?.refreshOnFocus ?? current.fileManager.refreshOnFocus,
        followTerminalCwd:
          command.fileManager?.followTerminalCwd ?? current.fileManager.followTerminalCwd,
        sshSplitView: command.fileManager?.sshSplitView ?? current.fileManager.sshSplitView,
        remoteAddressBookmarks:
          command.fileManager?.remoteAddressBookmarks ?? current.fileManager.remoteAddressBookmarks,
        columns: command.fileManager?.columns ?? current.fileManager.columns,
        localSort: command.fileManager?.localSort ?? current.fileManager.localSort,
        remoteSort: command.fileManager?.remoteSort ?? current.fileManager.remoteSort,
      },
      monitor: {
        terminalInformationItems:
          command.monitor?.terminalInformationItems ?? current.monitor.terminalInformationItems,
        remoteMonitorBarEnabled:
          command.monitor?.remoteMonitorBarEnabled ?? current.monitor.remoteMonitorBarEnabled,
        remoteMonitorBarItems:
          command.monitor?.remoteMonitorBarItems ?? current.monitor.remoteMonitorBarItems,
      },
      version: current.version + 1,
    };
    const now = new Date().toISOString();
    this.database.transaction(() => {
      for (const section of [
        'appearance',
        'workspace',
        'privacy',
        'network',
        'shortcuts',
        'terminal',
        'fileManager',
        'monitor',
      ] as const)
        this.database.run(
          `INSERT INTO app_settings(section, payload, version, updated_at) VALUES (?, ?, ?, ?)
           ON CONFLICT(section) DO UPDATE SET payload=excluded.payload, version=excluded.version, updated_at=excluded.updated_at`,
          section,
          JSON.stringify(next[section]),
          next.version,
          now,
        );

      this.database.appendEvent('settings.updated', { entityId: 'settings', payload: next });
    });
    return next;
  }
}
