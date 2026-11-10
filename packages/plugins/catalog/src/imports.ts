import { createHash, randomUUID } from 'node:crypto';
import type {
  CatalogImportReceipt,
  CatalogImportChunk,
  PreviewSshConfigImportInput,
  CommitSshConfigImportInput,
} from '@axterm/plugin-api/catalog';
import type { StorageCommandJournal } from '@axterm/plugin-api/storage';
import type { UnitOfWork } from './ports/unit-of-work.ts';
import type { CatalogSql } from './ports/catalog-sql.ts';
import type { ConfigSources } from './ports/config-sources.ts';
import type { HostImportService } from './application/host-import-service.ts';
import { ApplicationError } from './application/errors.ts';

/** Catalog's report and receipt commit with its facts, independently of transport lifetime. */
export class CatalogImports {
  private readonly lifetime = new AbortController();
  private readonly streams = new Set<AsyncGenerator<CatalogImportChunk>>();
  private closed = false;
  private closing: Promise<void> | undefined;
  constructor(
    private readonly imports: HostImportService,
    private readonly sources: ConfigSources,
    private readonly work: UnitOfWork,
    private readonly commands: StorageCommandJournal,
    private readonly storage: CatalogSql,
    private readonly cursor: () => number,
  ) {}
  preview(
    input: PreviewSshConfigImportInput,
    signal: AbortSignal,
  ): AsyncGenerator<CatalogImportChunk> {
    return this.stream(signal, async (joined) =>
      JSON.stringify(await this.imports.preview(input, joined)),
    );
  }
  commit(
    key: string,
    input: CommitSshConfigImportInput,
    treeIfMatch: string | undefined,
  ): CatalogImportReceipt {
    this.assertOpen();
    const receipt = this.work.transaction(() =>
      this.commands.execute(
        key,
        'catalog/commitSshConfigImport',
        {
          payloadHash: createHash('sha256')
            .update(JSON.stringify({ input, treeIfMatch }))
            .digest('hex'),
        },
        () => {
          const result = this.imports.commitPreview(input, treeIfMatch);
          const text = JSON.stringify(result);
          if (Buffer.byteLength(text) > 64 * 1024 * 1024)
            throw new ApplicationError(
              'CAPACITY_EXCEEDED',
              'SSH import report exceeds its bounded budget',
            );
          const reportId = randomUUID();
          this.storage.run(
            'INSERT INTO axterm_catalog_import_reports(report_id,result_json,created_at) VALUES (?,?,?)',
            reportId,
            text,
            new Date().toISOString(),
          );
          this.storage.run(
            'DELETE FROM axterm_catalog_import_reports WHERE rowid IN (SELECT rowid FROM axterm_catalog_import_reports ORDER BY rowid DESC LIMIT -1 OFFSET 8)',
          );
          return {
            ids: [
              ...result.createdHosts.map((item) => item.id),
              ...result.createdBookmarks.map((item) => item.id),
            ],
            cursor: this.cursor(),
            treeRevision: result.tree.revision,
            reportId,
            summary: result.summary,
          };
        },
      ),
    );
    this.imports.consumePreview(input.previewId);
    return receipt;
  }
  report(id: string, signal: AbortSignal): AsyncGenerator<CatalogImportChunk> {
    return this.stream(signal, async () => {
      const record = this.storage.get<{ result_json: string }>(
        'SELECT result_json FROM axterm_catalog_import_reports WHERE report_id=?',
        id,
      );
      if (!record) throw new ApplicationError('NOT_FOUND', 'SSH import report expired');
      return record.result_json;
    });
  }
  private assertOpen(): void {
    if (this.closed)
      throw new ApplicationError('CAPABILITY_UNAVAILABLE', 'SSH config import is closed');
  }
  private stream(
    signal: AbortSignal,
    read: (signal: AbortSignal) => Promise<string>,
  ): AsyncGenerator<CatalogImportChunk> {
    const joined = AbortSignal.any([signal, this.lifetime.signal]);
    const generator = async function* (this: CatalogImports): AsyncGenerator<CatalogImportChunk> {
      this.assertOpen();
      joined.throwIfAborted();
      if (this.streams.size >= 4)
        throw new ApplicationError('CAPACITY_EXCEEDED', 'Too many import streams');
      this.streams.add(result);
      try {
        const text = await read(joined);
        for (let offset = 0; offset < text.length; offset += 16_384) {
          joined.throwIfAborted();
          yield {
            offset,
            text: text.slice(offset, offset + 16_384),
            final: offset + 16_384 >= text.length,
          };
        }
      } finally {
        this.streams.delete(result);
      }
    };
    const result = generator.call(this);
    return result;
  }
  dispose(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    this.lifetime.abort();
    return (this.closing = (async () => {
      const results = await Promise.allSettled(
        [...this.streams].map((stream) => stream.return(undefined)),
      );
      await this.sources.dispose();
      this.imports.clear();
      const errors = results.flatMap((result) =>
        result.status === 'rejected' ? [result.reason] : [],
      );
      if (errors.length) throw new AggregateError(errors, 'CATALOG_IMPORT_STREAM_DRAIN_FAILED');
    })());
  }
}
