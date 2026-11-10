import { RemoteError } from '@axterm/plugin-api';
import type { RelationalDomain } from '@axterm/plugin-api/storage';
import { DomainCommands } from '@axterm/infra-storage-domain';
import {
  DEFAULT_DESKTOP_WINDOW_PREFERENCES,
  desktopWindowPreferenceRecordSchema,
  desktopWindowPreferencesSchema,
  desktopWindowPreferencesPatchSchema,
} from '@axterm/plugin-api/desktop';
import type {
  DesktopWindowPreferenceRecord,
  DesktopWindowPreferencesPatch,
  DesktopWindowReceipt,
} from '@axterm/plugin-api/desktop';
/** Desktop owns only these two new tables; existing metadata/SQL histories stay intact. */
export class DesktopPreferencesStore {
  private readonly commands: DomainCommands;
  constructor(readonly domain: RelationalDomain) {
    this.commands = new DomainCommands(domain, 'axterm_desktop_command_receipts');
  }
  read(): DesktopWindowPreferenceRecord {
    const row = this.domain.get<{ version: number; document_json: string }>(
      "SELECT version,document_json FROM axterm_desktop_preferences WHERE id='desktop'",
    );
    return desktopWindowPreferenceRecordSchema.parse(
      row
        ? { version: row.version, preferences: JSON.parse(row.document_json) }
        : { version: 0, preferences: DEFAULT_DESKTOP_WINDOW_PREFERENCES },
    );
  }
  update(
    key: string,
    patch: DesktopWindowPreferencesPatch,
    version: number,
    generation: string,
  ): DesktopWindowReceipt {
    const checked = desktopWindowPreferencesPatchSchema.parse(patch);
    return this.commands.execute(
      key,
      'desktop/updatePreferences',
      { patch: checked, version, generation },
      () => {
        const current = this.read();
        if (current.version !== version || current.version >= Number.MAX_SAFE_INTEGER)
          throw new RemoteError('desktop/failure', 'Desktop preferences changed', {
            reason: 'stale',
          });
        const defined = Object.fromEntries(
          Object.entries(checked).filter(([, value]) => value !== undefined),
        );
        const preferences = desktopWindowPreferencesSchema.parse({
          ...current.preferences,
          ...defined,
        });
        const next = version + 1;
        this.domain.run(
          "INSERT INTO axterm_desktop_preferences(id,version,document_json) VALUES('desktop',?,?) ON CONFLICT(id) DO UPDATE SET version=excluded.version,document_json=excluded.document_json",
          next,
          JSON.stringify(preferences),
        );
        const cursor = this.domain.appendEvent('desktop/preferences-changed', { version: next });
        return { version: next, cursor };
      },
    );
  }
}
