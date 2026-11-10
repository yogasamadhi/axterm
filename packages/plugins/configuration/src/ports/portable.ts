import type { Host, HostGroup, CreateHostInput } from '@axterm/plugin-api/catalog';
import type { Settings, UpdateSettingsInput } from '@axterm/plugin-api/configuration';
import type {
  TerminalProfile,
  TerminalProfileInput,
  TerminalTheme,
  TerminalThemeInput,
} from '@axterm/plugin-api/terminals';
import type { TunnelProfile, TunnelProfileInput } from '@axterm/plugin-api/connections';
import type {
  CatalogConfigurationImport,
  AutomationConfigurationImport,
} from '@axterm/plugin-api/host';
import type { AxtermConfigurationImportResult } from '@axterm/plugin-api/configuration-portable';
export type ImportCollection =
  | 'hostGroups'
  | 'hosts'
  | 'bookmarkGroups'
  | 'bookmarks'
  | 'connectionProfiles'
  | 'terminalProfiles'
  | 'tunnelProfiles'
  | 'quickCommandGroups'
  | 'quickCommands'
  | 'terminalThemes'
  | 'triggers';
export interface ImportMapping {
  kind: ImportCollection;
  source_id: string;
  fingerprint: string;
  target_id: string;
}
export interface PortableStore {
  mappings(): ImportMapping[];
  remember(mapping: ImportMapping): void;
  imported(
    previewId: string,
    payload: { sha256: string; created: number; settings: 'applied' | 'preserved' },
  ): void;
  transaction<T>(operation: () => T): T;
  command(
    key: string,
    previewId: string,
    operation: () => AxtermConfigurationImportResult,
  ): AxtermConfigurationImportResult;
}
export interface PortableFacts {
  listHostGroups(): readonly HostGroup[];
  listHosts(): readonly Host[];
  createHostGroup: CatalogConfigurationImport['hosts']['createHostGroup'];
  createHost(input: CreateHostInput): Host;
  listTerminalProfiles(): TerminalProfile[];
  createTerminalProfile(input: TerminalProfileInput): TerminalProfile;
  listTunnelProfiles(): TunnelProfile[];
  createTunnelProfile(input: TunnelProfileInput): TunnelProfile;
  getSettings(): Settings;
  updateSettings(input: UpdateSettingsInput, ifMatch: string): void;
}
export interface PortableThemes {
  list(): TerminalTheme[];
  create(input: TerminalThemeInput): TerminalTheme;
}
export type PortableBookmarks = CatalogConfigurationImport['bookmarks'];
export type PortableProfiles = CatalogConfigurationImport['profiles'];
export type PortableQuickCommands = AutomationConfigurationImport['quickCommands'];
export type PortableTriggers = AutomationConfigurationImport['triggers'];
export interface PortableFiles {
  read(grantId: string, signal?: AbortSignal): Promise<Uint8Array>;
  write(grantId: string, contents: Uint8Array, signal?: AbortSignal): Promise<void>;
}
