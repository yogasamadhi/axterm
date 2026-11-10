import type {
  WorkspacePresentation,
  WorkspacePresentationReceipt,
} from '@axterm/plugin-api/configuration';
import { SettingsError } from './errors.ts';
import type {
  Settings,
  SettingsReceipt,
  UpdateSettingsInput,
} from '@axterm/plugin-api/configuration';
import type { StorageCommandJournal } from '@axterm/plugin-api/storage';
import type { SettingsStore, SettingsWork } from '../ports/settings.ts';
/** Owns the settings workflow; participating history services retain their write handles. */
export class SettingsApplication {
  constructor(
    private readonly store: SettingsStore,
    private readonly work: SettingsWork,
    private readonly commands: StorageCommandJournal,
    private readonly cursor: () => number,
  ) {}
  getSettings(): Settings {
    return this.store.getSettings();
  }
  saveWorkspacePresentation(
    key: string,
    recordKey: string,
    presentation: WorkspacePresentation,
    version: number,
    generation: string,
    importRevision: number,
  ): WorkspacePresentationReceipt {
    const input: UpdateSettingsInput = {
      workspace: {
        presentations: {
          [recordKey]: { version: version + 1, generation, lastCommandId: key, presentation },
        },
      },
    };
    return this.work.transaction(input, () =>
      this.commands.execute(
        key,
        'configuration/saveWorkspacePresentation',
        { recordKey, presentation, version, generation, importRevision },
        () => {
          this.work.validateReferences(input);
          const current = this.store.getSettings(),
            records = current.workspace.presentations ?? {},
            before = records[recordKey];
          if (current.workspace.importRevision !== importRevision)
            throw new SettingsError(
              'PRECONDITION_FAILED',
              'Workspace import requires restart',
              412,
            );
          if ((before?.version ?? 0) !== version)
            throw new SettingsError('PRECONDITION_FAILED', 'Workspace window changed', 412);
          const next = this.store.updateSettings(
            {
              workspace: {
                presentations: {
                  ...records,
                  [recordKey]: {
                    version: version + 1,
                    generation,
                    lastCommandId: key,
                    presentation,
                  },
                },
              },
            },
            '"v' + current.version + '"',
          );
          return { version: version + 1, settingsVersion: next.version, cursor: this.cursor() };
        },
      ),
    );
  }
  importSettings(key: string, input: UpdateSettingsInput, ifMatch: string): SettingsReceipt {
    return this.work.transaction(input, () =>
      this.commands.execute(
        key,
        'configuration/importSettings',
        { command: input, ifMatch },
        () => {
          this.work.validateReferences(input);
          const settings = this.store.applyImportedSettings(input, ifMatch);
          return { version: settings.version, cursor: this.cursor() };
        },
      ),
    );
  }
  updateSettings(
    key: string,
    input: UpdateSettingsInput,
    ifMatch: string | undefined,
  ): SettingsReceipt {
    return this.work.transaction(input, () =>
      this.commands.execute(
        key,
        'configuration/updateSettings',
        { command: input, ifMatch },
        () => {
          this.work.validateReferences(input);
          const settings = this.store.updateSettings(input, ifMatch);
          this.work.purgeHistory(input.privacy);
          return { version: settings.version, cursor: this.cursor() };
        },
      ),
    );
  }
}
