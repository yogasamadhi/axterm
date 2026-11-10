import type {
  CatalogQueries,
  ConnectionStreamInput,
  ConnectionStreamLease,
} from '@axterm/plugin-api/host';
export interface SessionServices {
  catalog: Pick<CatalogQueries, 'getBookmark' | 'getConnectionProfile'>;
  credential(ref: string, signal: AbortSignal): Promise<string>;
  openStream(input: ConnectionStreamInput, signal: AbortSignal): Promise<ConnectionStreamLease>;
}
