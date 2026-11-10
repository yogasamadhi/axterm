import type {
  WorkspacePresentation,
  WorkspacePresentationBinding,
  WorkspacePresentationReceipt,
} from './workspace-presentation.ts';
export * from './workspace-presentation.ts';
import type { ClientFactsView } from './types.ts';
import type { Settings, UpdateSettingsInput } from './schemas/resources.ts';
export {
  settingsSchema,
  updateSettingsSchema,
  workspaceLayoutSchema,
  namedWorkspaceSchema,
  persistedTerminalTabSchema,
} from './schemas/resources.ts';
export type NamedWorkspace = Settings['workspace']['namedWorkspaces'][number];
export type WorkspaceLayout = NamedWorkspace['layout'];
export type PersistedTerminalTab = WorkspaceLayout['tabs'][number];
export type { Settings, UpdateSettingsInput } from './schemas/resources.ts';
export * from './schemas/shortcuts.ts';
export type ConfigurationFailureReason =
  | 'invalid-input'
  | 'precondition-required'
  | 'precondition-failed'
  | 'conflict'
  | 'unavailable'
  | 'closed'
  | 'capacity'
  | 'receipt-expired'
  | 'internal';
export interface SettingsReceipt {
  readonly version: number;
  readonly cursor: number;
}
export const SETTINGS_CHUNK_CHARACTERS = 16_384;
export const SETTINGS_MAX_SNAPSHOT_BYTES = 64 * 1024 * 1024;
export type SettingsUpdate =
  | {
      readonly type: 'begin';
      readonly mode: 'baseline' | 'replace';
      readonly generation: string;
      readonly cursor: number;
    }
  | {
      readonly type: 'chunk';
      readonly offset: number;
      readonly text: string;
      readonly final: boolean;
    }
  | { readonly type: 'commit'; readonly cursor: number };
export interface SettingsBaseline {
  readonly generation: string;
  readonly cursor: number;
  readonly settings: Settings;
}
declare module './types.ts' {
  interface RemoteErrorDetailsMap {
    'configuration/failure': { readonly reason: ConfigurationFailureReason };
  }
}

/** Selected Client capability: accepted facts and the Configuration-owned recording command. */
export interface ConfigurationClientActions extends ClientFactsView<SettingsBaseline> {
  setWorkspacePreferences?(
    key: string,
    input: NonNullable<UpdateSettingsInput['workspace']>,
    ifMatch: string,
    generation: string,
  ): Promise<SettingsReceipt>;
  bindWorkspacePresentation?(slot: string): Promise<WorkspacePresentationBinding>;
  saveWorkspacePresentation?(
    key: string,
    slot: string,
    input: WorkspacePresentation,
    version: number,
    generation: string,
    importRevision: number,
  ): Promise<WorkspacePresentationReceipt>;
  setNetworkProxy(
    key: string,
    proxy: Settings['network']['proxy'],
    ifMatch: string,
  ): Promise<SettingsReceipt>;
  setFileManagerPreferences(
    key: string,
    input: NonNullable<UpdateSettingsInput['fileManager']>,
    ifMatch: string,
  ): Promise<SettingsReceipt>;
  setDefaultTerminalProfile(
    key: string,
    id: string | null,
    ifMatch: string,
  ): Promise<SettingsReceipt>;
  setTerminalRecoveryPreferences?(
    key: string,
    input: TerminalRecoveryPreferences,
    ifMatch: string,
    generation: string,
  ): Promise<SettingsReceipt>;
  setLegacyShortcutBindings?(
    key: string,
    bindings: Settings['shortcuts']['bindings'],
    ifMatch: string,
    generation: string,
  ): Promise<SettingsReceipt>;
  setMonitorPreferences?(
    key: string,
    input: Settings['monitor'],
    ifMatch: string,
    generation: string,
  ): Promise<SettingsReceipt>;
  setTerminalShortcutBarButtons?(
    key: string,
    buttons: Settings['terminal']['shortcutBarButtons'],
    ifMatch: string,
    generation: string,
  ): Promise<SettingsReceipt>;
  setTerminalVisual?(
    key: string,
    visual: Settings['terminal']['visual'],
    ifMatch: string,
    generation: string,
  ): Promise<SettingsReceipt>;
  setCommandHistoryEnabled?(
    key: string,
    enabled: boolean,
    ifMatch: string,
  ): Promise<SettingsReceipt>;
  setConnectionHistoryEnabled(
    key: string,
    enabled: boolean,
    ifMatch: string,
  ): Promise<SettingsReceipt>;
}
declare module '@deepseek-ai/cordis' {
  interface Context {
    configurationActions: ConfigurationClientActions;
  }
}

export type { TerminalVisualSettings } from './schemas/terminal-visual.ts';

export type TerminalRecoveryPreferences = Partial<
  Pick<
    Settings['terminal'],
    | 'autoReconnectTerminal'
    | 'restoreTerminalSessionOnReload'
    | 'shortcutBarEnabled'
    | 'commandSuggestionsEnabled'
    | 'dragDropBehavior'
  >
>;

export interface LegalDocumentDescriptor {
  readonly id: string;
  readonly name: string;
  readonly bytes: number;
  readonly sha256: string;
}
export interface LegalDocumentsBaseline {
  readonly generation: string;
  readonly documents: readonly LegalDocumentDescriptor[];
}
export interface LegalDocumentChunk {
  readonly offset: number;
  readonly text: string;
}
