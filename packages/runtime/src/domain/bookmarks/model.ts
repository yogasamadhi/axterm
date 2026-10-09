import type {
  Bookmark as ContractBookmark,
  BookmarkDropPosition,
  BookmarkGroup as ContractBookmarkGroup,
  BookmarkProtocol,
  BookmarkTree as ContractBookmarkTree,
  BookmarkTreeNodeRef,
} from '@workspace/contracts';

export type Bookmark = ContractBookmark;
export type BookmarkGroup = ContractBookmarkGroup;
export type { BookmarkDropPosition, BookmarkProtocol, BookmarkTreeNodeRef };

export type BookmarkTreeSnapshot = ContractBookmarkTree;
export type BookmarkTreeNodeKind = BookmarkTreeNodeRef['kind'];

export interface MoveBookmarkTreeNodeInput {
  source: BookmarkTreeNodeRef;
  target: BookmarkTreeNodeRef;
  position: BookmarkDropPosition;
}

export interface BookmarkTreeSearchResult {
  bookmarkIds: string[];
  ancestorGroupIds: string[];
}

export interface CreateBookmarkGroupInput {
  parentId: string | null;
  name: string;
  color: string | null;
  description: string;
}

export interface UpdateBookmarkGroupInput {
  name?: string | undefined;
  color?: string | null | undefined;
  description?: string | undefined;
}

export interface CreateBookmarkInput {
  groupId: string | null;
  protocol: BookmarkProtocol;
  hostId: string | null;
  title: string;
  color: string | null;
  description: string;
  profileId: string | null;
  connectionProfileId: string | null;
  quickCommands: ContractBookmark['quickCommands'];
  triggers: ContractBookmark['triggers'];
  ftp: ContractBookmark['ftp'];
  telnet: ContractBookmark['telnet'];
  serial: ContractBookmark['serial'];
  rdp: ContractBookmark['rdp'];
  vnc: ContractBookmark['vnc'];
  spice: ContractBookmark['spice'];
  web: ContractBookmark['web'];
}

export interface UpdateBookmarkInput {
  title?: string | undefined;
  color?: string | null | undefined;
  description?: string | undefined;
  profileId?: string | null | undefined;
  connectionProfileId?: string | null | undefined;
  quickCommands?: ContractBookmark['quickCommands'] | undefined;
  triggers?: ContractBookmark['triggers'] | undefined;
  ftp?: ContractBookmark['ftp'] | undefined;
  telnet?: ContractBookmark['telnet'] | undefined;
  serial?: ContractBookmark['serial'] | undefined;
  rdp?: ContractBookmark['rdp'] | undefined;
  vnc?: ContractBookmark['vnc'] | undefined;
  spice?: ContractBookmark['spice'] | undefined;
  web?: ContractBookmark['web'] | undefined;
}
