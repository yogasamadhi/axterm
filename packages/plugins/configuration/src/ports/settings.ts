import type { Settings, UpdateSettingsInput } from '@axterm/plugin-api/configuration';
export interface SettingsStore {
  getSettings(): Settings;
  applyImportedSettings(input: UpdateSettingsInput, ifMatch: string): Settings;
  updateSettings(input: UpdateSettingsInput, ifMatch: string | undefined): Settings;
}
export interface SettingsWork {
  transaction<T>(input: UpdateSettingsInput | undefined, operation: () => T): T;
  validateReferences(input: UpdateSettingsInput): void;
  purgeHistory(privacy: UpdateSettingsInput['privacy']): void;
}
