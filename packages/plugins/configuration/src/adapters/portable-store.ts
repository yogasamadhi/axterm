import type { RelationalDomain } from '@axterm/plugin-api/storage';
import { PortableApplicationError } from '../application/portable-errors.ts';
import { DomainCommands } from '@axterm/infra-storage-domain';
import type { ImportMapping, PortableStore } from '../ports/portable.ts';
import type { AxtermConfigurationImportResult } from '@axterm/plugin-api/configuration-portable';
export class ConfigurationPortableStore implements PortableStore {
  private readonly commands: DomainCommands;
  constructor(
    private readonly domain: RelationalDomain,
    private readonly together: <T>(operation: () => T) => T,
  ) {
    this.commands = new DomainCommands(domain, 'axterm_configuration_command_receipts');
  }
  mappings(): ImportMapping[] {
    const count = this.domain.get<{ count: number }>(
      'SELECT COUNT(*) AS count FROM axterm_configuration_import_entries',
    )!.count;
    if (count > 100_000)
      throw new PortableApplicationError(
        'CAPACITY_EXCEEDED',
        'Configuration mapping capacity exceeded',
      );
    return this.domain.all<ImportMapping>(
      'SELECT kind,source_id,fingerprint,target_id FROM axterm_configuration_import_entries LIMIT 100001',
    );
  }
  remember(row: ImportMapping): void {
    this.domain.run(
      `INSERT INTO axterm_configuration_import_entries(kind,source_id,fingerprint,target_id,imported_at) VALUES (?,?,?,?,?)
      ON CONFLICT(kind,source_id) DO UPDATE SET fingerprint=excluded.fingerprint,target_id=excluded.target_id,imported_at=excluded.imported_at`,
      row.kind,
      row.source_id,
      row.fingerprint,
      row.target_id,
      new Date().toISOString(),
    );
  }
  imported(
    previewId: string,
    payload: { sha256: string; created: number; settings: 'applied' | 'preserved' },
  ): void {
    this.domain.appendEvent('configuration/imported', { previewId, ...payload });
  }
  transaction<T>(operation: () => T): T {
    return this.together(operation);
  }
  command(
    key: string,
    previewId: string,
    operation: () => AxtermConfigurationImportResult,
  ): AxtermConfigurationImportResult {
    return this.commands.execute(key, 'configuration/import', { previewId }, () => {
      const result = operation();
      const count = this.domain.get<{ count: number }>(
        'SELECT COUNT(*) AS count FROM axterm_configuration_import_entries',
      )!.count;
      if (count > 100_000)
        throw new PortableApplicationError(
          'CAPACITY_EXCEEDED',
          'Configuration mapping capacity exceeded',
        );
      return result;
    });
  }
}
