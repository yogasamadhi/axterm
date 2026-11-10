import type {
  Host,
  HostGroup,
  Bookmark,
  BookmarkTree,
  ConnectionProfile,
  ConnectionHistoryItem,
  CreateHostGroupInput,
  CreateHostInput,
  CreateBookmarkGroupInput,
  CreateBookmarkInput,
  ConnectionProfileInput,
} from '../catalog.ts';
import type { RelationalParticipant } from '../storage.ts';
export interface CatalogQueries {
  readonly participant: RelationalParticipant;
  readonly configurationImport?: CatalogConfigurationImport;
  listHosts(): readonly Host[];
  getHost(id: string): Host;
  getConnectionHistoryItem(id: string, ifMatch: string | undefined): ConnectionHistoryItem;
  listHostGroups(): readonly HostGroup[];
  getBookmarkTree(): BookmarkTree;
  getBookmark(id: string): Bookmark;
  listConnectionProfiles(): readonly ConnectionProfile[];
  getConnectionProfile(id: string): ConnectionProfile;
}
/** Selected reference projection; its owner retains the actual database handle. */
export interface CatalogReferenceSource {
  readonly participant: RelationalParticipant;
  retainedBy(hostId: string): readonly 'tunnel'[];
}
export interface CatalogReferences {
  register(owner: string, contribution: CatalogReferenceSource): () => Promise<void>;
}
export interface CatalogConnectionHistory {
  recordSuccessful(input: { readonly host: Host; readonly persistedHostId: string | null }): void;
}
declare module '@deepseek-ai/cordis' {
  interface Context {
    catalog: CatalogQueries;
    catalogReferences: CatalogReferences;
    catalogConnectionHistory: CatalogConnectionHistory;
  }
}

/** Synchronous, owner-validated participation in Configuration's shared transaction. */
export interface CatalogConfigurationImport {
  readonly hosts: {
    createHostGroup(input: CreateHostGroupInput): HostGroup;
    createHost(input: CreateHostInput): Host;
  };
  readonly bookmarks: {
    snapshot(): BookmarkTree;
    createGroup(input: CreateBookmarkGroupInput, ifMatch: string | undefined): BookmarkTree;
    createBookmark(input: CreateBookmarkInput, ifMatch: string | undefined): BookmarkTree;
  };
  readonly profiles: {
    list(): ConnectionProfile[];
    create(input: ConnectionProfileInput): ConnectionProfile;
  };
}
