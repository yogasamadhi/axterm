import type {
  ConnectionHistoryPage,
  ConnectionHistoryItem,
  ConnectionHistoryPageQuery,
  ConnectionHistoryState,
  ClearConnectionHistoryResult,
  DeleteConnectionHistoryResult,
} from '@axterm/plugin-api/catalog';
export interface CatalogHistory {
  get(id: string): ConnectionHistoryItem;
  assertVersion(id: string, ifMatch: string | undefined): ConnectionHistoryItem;
  linkHost(id: string, hostId: string, ifMatch: string | undefined): ConnectionHistoryItem;
  list(query: ConnectionHistoryPageQuery): ConnectionHistoryPage;
  state(): ConnectionHistoryState;
  delete(id: string, ifMatch: string | undefined): DeleteConnectionHistoryResult;
  clear(ifMatch: string | undefined): ClearConnectionHistoryResult;
}
