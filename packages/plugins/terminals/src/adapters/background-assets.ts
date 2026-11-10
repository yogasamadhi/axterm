import { DomainCommands } from '@axterm/infra-storage-domain';
import { RemoteError } from '@axterm/plugin-api';
import type { RelationalDomain } from '@axterm/plugin-api/storage';
import {
  TERMINAL_ASSETS_MAX_COUNT,
  terminalBackgroundMetadataSchema,
  type TerminalBackgroundMetadata,
  type TerminalAssetReceipt,
  type TerminalAssetDeleteReceipt,
} from '@axterm/plugin-api/terminals';
import type { AssetImportIdentity, TerminalAssetStore } from '../ports/background-assets.ts';
interface Row {
  id: string;
  mime_type: string;
  bytes: number;
  sha256: string;
  version: number;
  created_at: string;
}
const failure = (reason: 'capacity' | 'not-found' | 'precondition-failed') =>
  new RemoteError('terminals/failure', 'The background asset operation failed', { reason });
export class StoredTerminalAssets implements TerminalAssetStore {
  private readonly journal: DomainCommands;
  constructor(
    private readonly domain: RelationalDomain,
    private readonly transaction: <T>(operation: () => T) => T,
  ) {
    this.journal = new DomainCommands(domain, 'axterm_terminal_asset_receipts');
  }
  list(): TerminalBackgroundMetadata[] {
    const rows = this.domain.all<Row>(
      'SELECT id,mime_type,bytes,sha256,version,created_at FROM terminal_background_assets ORDER BY created_at,id LIMIT 257',
    );
    if (rows.length > TERMINAL_ASSETS_MAX_COUNT) throw failure('capacity');
    return rows.map((row) => this.metadata(row));
  }
  get(id: string): TerminalBackgroundMetadata {
    const row = this.domain.get<Row>(
      'SELECT id,mime_type,bytes,sha256,version,created_at FROM terminal_background_assets WHERE id=?',
      id,
    );
    if (!row) throw failure('not-found');
    return this.metadata(row);
  }
  lookupImport(key: string, input: AssetImportIdentity): TerminalAssetReceipt | undefined {
    return this.domain.transaction(() =>
      this.journal.lookup<TerminalAssetReceipt>(key, 'terminal-assets.import', input),
    );
  }
  commitImport(
    key: string,
    input: AssetImportIdentity,
    asset: TerminalBackgroundMetadata,
    chunks: readonly Uint8Array[],
  ): TerminalAssetReceipt {
    return this.domain.transaction(() =>
      this.journal.execute(key, 'terminal-assets.import', input, () => {
        const quota = this.domain.get<{ count: number; bytes: number }>(
          'SELECT count(*) AS count,coalesce(sum(bytes),0) AS bytes FROM terminal_background_assets',
        )!;
        if (
          quota.count >= TERMINAL_ASSETS_MAX_COUNT ||
          quota.bytes + asset.bytes > 512 * 1024 * 1024
        )
          throw failure('capacity');
        this.domain.run(
          'INSERT INTO terminal_background_assets (id,mime_type,bytes,sha256,version,created_at) VALUES (?,?,?,?,?,?)',
          asset.id,
          asset.mimeType,
          asset.bytes,
          asset.sha256,
          asset.version,
          asset.createdAt,
        );
        chunks.forEach((chunk, index) =>
          this.domain.run(
            'INSERT INTO terminal_background_asset_chunks (asset_id,chunk_index,content) VALUES (?,?,?)',
            asset.id,
            index,
            chunk,
          ),
        );
        const cursor = this.domain.appendEvent('terminal.background-created', {
          id: asset.id,
          asset,
        });
        return { asset, cursor };
      }),
    );
  }
  remove(
    key: string,
    id: string,
    version: number,
    generation: string,
    check: () => void,
  ): TerminalAssetDeleteReceipt {
    return this.transaction(() =>
      this.journal.execute(key, 'terminal-assets.delete', { id, version, generation }, () => {
        if (this.get(id).version !== version) throw failure('precondition-failed');
        check();
        this.domain.run('DELETE FROM terminal_background_asset_chunks WHERE asset_id=?', id);
        this.domain.run('DELETE FROM terminal_background_assets WHERE id=?', id);
        const cursor = this.domain.appendEvent('terminal.background-deleted', { id });
        return { id, cursor };
      }),
    );
  }
  readChunk(id: string, index: number): Uint8Array | undefined {
    return this.domain.get<{ content: Uint8Array }>(
      'SELECT content FROM terminal_background_asset_chunks WHERE asset_id=? AND chunk_index=?',
      id,
      index,
    )?.content;
  }
  private metadata(row: Row): TerminalBackgroundMetadata {
    return terminalBackgroundMetadataSchema.parse({
      id: row.id,
      mimeType: row.mime_type,
      bytes: row.bytes,
      sha256: row.sha256,
      version: row.version,
      createdAt: row.created_at,
    });
  }
}
