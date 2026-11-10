import type {
  TerminalBackgroundMetadata,
  TerminalAssetReceipt,
  TerminalAssetDeleteReceipt,
} from '@axterm/plugin-api/terminals';
export interface AssetImportIdentity {
  readonly grantId: string;
  readonly generation: string;
}
/** The application owns IO/lifecycle; this owner adapter commits SQL facts, receipts and outbox. */
export interface TerminalAssetStore {
  list(): TerminalBackgroundMetadata[];
  get(id: string): TerminalBackgroundMetadata;
  lookupImport(key: string, input: AssetImportIdentity): TerminalAssetReceipt | undefined;
  commitImport(
    key: string,
    input: AssetImportIdentity,
    asset: TerminalBackgroundMetadata,
    chunks: readonly Uint8Array[],
  ): TerminalAssetReceipt;
  remove(
    key: string,
    id: string,
    version: number,
    generation: string,
    check: () => void,
  ): TerminalAssetDeleteReceipt;
  readChunk(id: string, index: number): Uint8Array | undefined;
}
