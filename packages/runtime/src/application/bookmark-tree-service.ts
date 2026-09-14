import { bookmarkQuickCommandsSchema, bookmarkTriggersSchema } from '@workspace/contracts';
import type {
  BookmarkTreeSearchResult,
  BookmarkTreeSnapshot,
  CreateBookmarkGroupInput,
  CreateBookmarkInput,
  MoveBookmarkTreeNodeInput,
  UpdateBookmarkGroupInput,
  UpdateBookmarkInput,
} from '../domain/bookmarks/model';
import type { BookmarkRepository } from '../adapters/sqlite/bookmark-repository';
import { ApplicationError } from './errors';
import { validateTriggerPattern } from './trigger-engine';

const colorPattern = /^#[0-9a-f]{6}$/i;

export class BookmarkTreeService {
  constructor(private readonly repository: BookmarkRepository) {}

  snapshot(): BookmarkTreeSnapshot {
    return this.repository.snapshot();
  }

  createGroup(
    input: Partial<CreateBookmarkGroupInput> & Pick<CreateBookmarkGroupInput, 'name'>,
    treeIfMatch: string | undefined,
  ): BookmarkTreeSnapshot {
    return this.repository.createGroup(
      {
        parentId: input.parentId ?? null,
        name: requiredText(input.name, 'Bookmark group name', 80),
        color: optionalColor(input.color ?? null),
        description: boundedText(input.description ?? '', 'Bookmark group description', 1_024),
      },
      treeIfMatch,
    );
  }

  updateGroup(
    id: string,
    input: UpdateBookmarkGroupInput,
    treeIfMatch: string | undefined,
  ): BookmarkTreeSnapshot {
    if (!Object.keys(input).length)
      throw new ApplicationError('INVALID_STATE', 'Bookmark group update is empty');
    return this.repository.updateGroup(
      id,
      {
        ...(input.name === undefined
          ? {}
          : { name: requiredText(input.name, 'Bookmark group name', 80) }),
        ...(input.color === undefined ? {} : { color: optionalColor(input.color) }),
        ...(input.description === undefined
          ? {}
          : {
              description: boundedText(input.description, 'Bookmark group description', 1_024),
            }),
      },
      treeIfMatch,
    );
  }

  deleteGroup(id: string, treeIfMatch: string | undefined): BookmarkTreeSnapshot {
    return this.repository.deleteGroup(id, treeIfMatch);
  }

  createBookmark(
    input: Partial<CreateBookmarkInput> &
      Pick<CreateBookmarkInput, 'protocol' | 'title' | 'hostId'>,
    treeIfMatch: string | undefined,
  ): BookmarkTreeSnapshot {
    if (input.protocol === 'ssh' && !input.hostId)
      throw new ApplicationError('INVALID_STATE', 'An SSH bookmark requires a Host reference');
    if (input.protocol !== 'ssh' && input.hostId)
      throw new ApplicationError('INVALID_STATE', 'Only an SSH bookmark can reference an SSH Host');
    if (input.protocol === 'ftp' && !input.ftp)
      throw new ApplicationError('INVALID_STATE', 'An FTP bookmark requires FTP settings');
    if (input.protocol !== 'ftp' && input.ftp)
      throw new ApplicationError('INVALID_STATE', 'Only an FTP bookmark can contain FTP settings');
    if (input.protocol === 'telnet' && !input.telnet)
      throw new ApplicationError('INVALID_STATE', 'A Telnet bookmark requires Telnet settings');
    if (input.protocol !== 'telnet' && input.telnet)
      throw new ApplicationError(
        'INVALID_STATE',
        'Only a Telnet bookmark can contain Telnet settings',
      );
    if (input.protocol === 'serial' && !input.serial)
      throw new ApplicationError('INVALID_STATE', 'A Serial bookmark requires Serial settings');
    if (input.protocol !== 'serial' && input.serial)
      throw new ApplicationError(
        'INVALID_STATE',
        'Only a Serial bookmark can contain Serial settings',
      );
    if (input.protocol === 'rdp' && !input.rdp)
      throw new ApplicationError('INVALID_STATE', 'An RDP bookmark requires RDP settings');
    if (input.protocol !== 'rdp' && input.rdp)
      throw new ApplicationError('INVALID_STATE', 'Only an RDP bookmark can contain RDP settings');
    if (input.protocol === 'vnc' && !input.vnc)
      throw new ApplicationError('INVALID_STATE', 'A VNC bookmark requires VNC settings');
    if (input.protocol !== 'vnc' && input.vnc)
      throw new ApplicationError('INVALID_STATE', 'Only a VNC bookmark can contain VNC settings');
    if (input.protocol === 'spice' && !input.spice)
      throw new ApplicationError('INVALID_STATE', 'A SPICE bookmark requires SPICE settings');
    if (input.protocol !== 'spice' && input.spice)
      throw new ApplicationError(
        'INVALID_STATE',
        'Only a SPICE bookmark can contain SPICE settings',
      );
    if (input.protocol === 'web' && !input.web)
      throw new ApplicationError('INVALID_STATE', 'A Web bookmark requires Web settings');
    if (input.protocol !== 'web' && input.web)
      throw new ApplicationError('INVALID_STATE', 'Only a Web bookmark can contain Web settings');
    return this.repository.createBookmark(
      {
        groupId: input.groupId ?? null,
        protocol: input.protocol,
        hostId: input.hostId,
        title: requiredText(input.title, 'Bookmark title', 100),
        color: optionalColor(input.color ?? null),
        description: boundedText(input.description ?? '', 'Bookmark description', 2_000),
        profileId: input.profileId ?? null,
        connectionProfileId: input.connectionProfileId ?? null,
        quickCommands: bookmarkQuickCommandsSchema.parse(input.quickCommands ?? []),
        triggers: validateBookmarkTriggers(input.triggers ?? []),
        ftp: input.ftp ?? null,
        telnet: input.telnet ?? null,
        serial: input.serial ?? null,
        rdp: input.rdp ?? null,
        vnc: input.vnc ?? null,
        spice: input.spice ?? null,
        web: input.web ?? null,
      },
      treeIfMatch,
    );
  }

  assertMutationTarget(groupId: string | null, treeIfMatch: string | undefined): void {
    this.repository.assertMutationTarget(groupId, treeIfMatch);
  }

  createBookmarksBatch(
    inputs: Array<
      Partial<CreateBookmarkInput> & Pick<CreateBookmarkInput, 'protocol' | 'title' | 'hostId'>
    >,
    treeIfMatch: string | undefined,
  ): { bookmarks: BookmarkTreeSnapshot['bookmarks']; tree: BookmarkTreeSnapshot } {
    return this.repository.createBookmarksBatch(
      inputs.map((input) => {
        if (input.protocol === 'ssh' && !input.hostId)
          throw new ApplicationError('INVALID_STATE', 'An SSH bookmark requires a Host reference');
        if (input.protocol !== 'ssh' && input.hostId)
          throw new ApplicationError(
            'INVALID_STATE',
            'Only an SSH bookmark can reference an SSH Host',
          );
        if (input.protocol === 'ftp' && !input.ftp)
          throw new ApplicationError('INVALID_STATE', 'An FTP bookmark requires FTP settings');
        if (input.protocol !== 'ftp' && input.ftp)
          throw new ApplicationError(
            'INVALID_STATE',
            'Only an FTP bookmark can contain FTP settings',
          );
        if (input.protocol === 'telnet' && !input.telnet)
          throw new ApplicationError('INVALID_STATE', 'A Telnet bookmark requires Telnet settings');
        if (input.protocol !== 'telnet' && input.telnet)
          throw new ApplicationError(
            'INVALID_STATE',
            'Only a Telnet bookmark can contain Telnet settings',
          );
        if (input.protocol === 'serial' && !input.serial)
          throw new ApplicationError('INVALID_STATE', 'A Serial bookmark requires Serial settings');
        if (input.protocol !== 'serial' && input.serial)
          throw new ApplicationError(
            'INVALID_STATE',
            'Only a Serial bookmark can contain Serial settings',
          );
        if (input.protocol === 'rdp' && !input.rdp)
          throw new ApplicationError('INVALID_STATE', 'An RDP bookmark requires RDP settings');
        if (input.protocol !== 'rdp' && input.rdp)
          throw new ApplicationError(
            'INVALID_STATE',
            'Only an RDP bookmark can contain RDP settings',
          );
        if (input.protocol === 'vnc' && !input.vnc)
          throw new ApplicationError('INVALID_STATE', 'A VNC bookmark requires VNC settings');
        if (input.protocol !== 'vnc' && input.vnc)
          throw new ApplicationError(
            'INVALID_STATE',
            'Only a VNC bookmark can contain VNC settings',
          );
        if (input.protocol === 'spice' && !input.spice)
          throw new ApplicationError('INVALID_STATE', 'A SPICE bookmark requires SPICE settings');
        if (input.protocol !== 'spice' && input.spice)
          throw new ApplicationError(
            'INVALID_STATE',
            'Only a SPICE bookmark can contain SPICE settings',
          );
        if (input.protocol === 'web' && !input.web)
          throw new ApplicationError('INVALID_STATE', 'A Web bookmark requires Web settings');
        if (input.protocol !== 'web' && input.web)
          throw new ApplicationError(
            'INVALID_STATE',
            'Only a Web bookmark can contain Web settings',
          );
        return {
          groupId: input.groupId ?? null,
          protocol: input.protocol,
          hostId: input.hostId,
          title: requiredText(input.title, 'Bookmark title', 100),
          color: optionalColor(input.color ?? null),
          description: boundedText(input.description ?? '', 'Bookmark description', 2_000),
          profileId: input.profileId ?? null,
          connectionProfileId: input.connectionProfileId ?? null,
          quickCommands: bookmarkQuickCommandsSchema.parse(input.quickCommands ?? []),
          triggers: validateBookmarkTriggers(input.triggers ?? []),
          ftp: input.ftp ?? null,
          telnet: input.telnet ?? null,
          serial: input.serial ?? null,
          rdp: input.rdp ?? null,
          vnc: input.vnc ?? null,
          spice: input.spice ?? null,
          web: input.web ?? null,
        };
      }),
      treeIfMatch,
    );
  }

  updateBookmark(
    id: string,
    input: UpdateBookmarkInput,
    treeIfMatch: string | undefined,
  ): BookmarkTreeSnapshot {
    if (!Object.keys(input).length)
      throw new ApplicationError('INVALID_STATE', 'Bookmark update is empty');
    const current = this.getBookmark(id);
    if (input.ftp !== undefined && current.protocol !== 'ftp')
      throw new ApplicationError('INVALID_STATE', 'Only an FTP bookmark can contain FTP settings');
    if (input.telnet !== undefined && current.protocol !== 'telnet')
      throw new ApplicationError(
        'INVALID_STATE',
        'Only a Telnet bookmark can contain Telnet settings',
      );
    if (input.serial !== undefined && current.protocol !== 'serial')
      throw new ApplicationError(
        'INVALID_STATE',
        'Only a Serial bookmark can contain Serial settings',
      );
    if (input.rdp !== undefined && current.protocol !== 'rdp')
      throw new ApplicationError('INVALID_STATE', 'Only an RDP bookmark can contain RDP settings');
    if (input.vnc !== undefined && current.protocol !== 'vnc')
      throw new ApplicationError('INVALID_STATE', 'Only a VNC bookmark can contain VNC settings');
    if (input.spice !== undefined && current.protocol !== 'spice')
      throw new ApplicationError(
        'INVALID_STATE',
        'Only a SPICE bookmark can contain SPICE settings',
      );
    if (input.web !== undefined && current.protocol !== 'web')
      throw new ApplicationError('INVALID_STATE', 'Only a Web bookmark can contain Web settings');
    return this.repository.updateBookmark(
      id,
      {
        ...(input.title === undefined
          ? {}
          : { title: requiredText(input.title, 'Bookmark title', 100) }),
        ...(input.color === undefined ? {} : { color: optionalColor(input.color) }),
        ...(input.description === undefined
          ? {}
          : { description: boundedText(input.description, 'Bookmark description', 2_000) }),
        ...(input.profileId === undefined ? {} : { profileId: input.profileId }),
        ...(input.connectionProfileId === undefined
          ? {}
          : { connectionProfileId: input.connectionProfileId }),
        ...(input.quickCommands === undefined
          ? {}
          : { quickCommands: bookmarkQuickCommandsSchema.parse(input.quickCommands) }),
        ...(input.triggers === undefined
          ? {}
          : { triggers: validateBookmarkTriggers(input.triggers) }),
        ...(input.ftp === undefined ? {} : { ftp: input.ftp }),
        ...(input.telnet === undefined ? {} : { telnet: input.telnet }),
        ...(input.serial === undefined ? {} : { serial: input.serial }),
        ...(input.rdp === undefined ? {} : { rdp: input.rdp }),
        ...(input.vnc === undefined ? {} : { vnc: input.vnc }),
        ...(input.spice === undefined ? {} : { spice: input.spice }),
        ...(input.web === undefined ? {} : { web: input.web }),
      },
      treeIfMatch,
    );
  }

  getBookmark(id: string): BookmarkTreeSnapshot['bookmarks'][number] {
    const bookmark = this.snapshot().bookmarks.find((item) => item.id === id);
    if (!bookmark) throw new ApplicationError('NOT_FOUND', 'Bookmark not found', 404);
    return bookmark;
  }

  updateBookmarkWithPlacement(
    id: string,
    input: UpdateBookmarkInput & { groupId?: string | null | undefined },
    treeIfMatch: string | undefined,
  ): BookmarkTreeSnapshot {
    const current = this.getBookmark(id);
    if (input.ftp !== undefined && current.protocol !== 'ftp')
      throw new ApplicationError('INVALID_STATE', 'Only an FTP bookmark can contain FTP settings');
    if (input.telnet !== undefined && current.protocol !== 'telnet')
      throw new ApplicationError(
        'INVALID_STATE',
        'Only a Telnet bookmark can contain Telnet settings',
      );
    if (input.serial !== undefined && current.protocol !== 'serial')
      throw new ApplicationError(
        'INVALID_STATE',
        'Only a Serial bookmark can contain Serial settings',
      );
    if (input.rdp !== undefined && current.protocol !== 'rdp')
      throw new ApplicationError('INVALID_STATE', 'Only an RDP bookmark can contain RDP settings');
    if (input.vnc !== undefined && current.protocol !== 'vnc')
      throw new ApplicationError('INVALID_STATE', 'Only a VNC bookmark can contain VNC settings');
    if (input.spice !== undefined && current.protocol !== 'spice')
      throw new ApplicationError(
        'INVALID_STATE',
        'Only a SPICE bookmark can contain SPICE settings',
      );
    if (input.web !== undefined && current.protocol !== 'web')
      throw new ApplicationError('INVALID_STATE', 'Only a Web bookmark can contain Web settings');
    return this.repository.updateBookmarkWithPlacement(
      id,
      {
        ...(input.groupId === undefined ? {} : { groupId: input.groupId }),
        ...(input.title === undefined
          ? {}
          : { title: requiredText(input.title, 'Bookmark title', 100) }),
        ...(input.color === undefined ? {} : { color: optionalColor(input.color) }),
        ...(input.description === undefined
          ? {}
          : { description: boundedText(input.description, 'Bookmark description', 2_000) }),
        ...(input.profileId === undefined ? {} : { profileId: input.profileId }),
        ...(input.connectionProfileId === undefined
          ? {}
          : { connectionProfileId: input.connectionProfileId }),
        ...(input.quickCommands === undefined
          ? {}
          : { quickCommands: bookmarkQuickCommandsSchema.parse(input.quickCommands) }),
        ...(input.triggers === undefined
          ? {}
          : { triggers: validateBookmarkTriggers(input.triggers) }),
        ...(input.ftp === undefined ? {} : { ftp: input.ftp }),
        ...(input.telnet === undefined ? {} : { telnet: input.telnet }),
        ...(input.serial === undefined ? {} : { serial: input.serial }),
        ...(input.rdp === undefined ? {} : { rdp: input.rdp }),
        ...(input.vnc === undefined ? {} : { vnc: input.vnc }),
        ...(input.spice === undefined ? {} : { spice: input.spice }),
        ...(input.web === undefined ? {} : { web: input.web }),
      },
      treeIfMatch,
    );
  }

  deleteBookmark(id: string, treeIfMatch: string | undefined): BookmarkTreeSnapshot {
    return this.repository.deleteBookmark(id, treeIfMatch);
  }

  deleteBookmarksForHost(
    hostId: string,
    treeIfMatch: string | undefined,
  ): { bookmarkIds: string[]; tree: BookmarkTreeSnapshot } {
    return this.repository.deleteBookmarksForHost(hostId, treeIfMatch);
  }

  move(input: MoveBookmarkTreeNodeInput, treeIfMatch: string | undefined): BookmarkTreeSnapshot {
    return this.repository.move(input, treeIfMatch);
  }

  search(query: string, snapshot = this.snapshot()): BookmarkTreeSearchResult {
    const keyword = query.trim().toLocaleLowerCase();
    if (!keyword) return { bookmarkIds: [], ancestorGroupIds: [] };

    const groups = new Map(snapshot.groups.map((group) => [group.id, group]));
    const bookmarkIds: string[] = [];
    const ancestorGroupIds = new Set<string>();
    for (const bookmark of snapshot.bookmarks) {
      if (
        !bookmark.title.toLocaleLowerCase().includes(keyword) &&
        !bookmark.description.toLocaleLowerCase().includes(keyword) &&
        !bookmark.connectionDisplay?.toLocaleLowerCase().includes(keyword)
      )
        continue;
      bookmarkIds.push(bookmark.id);
      const visited = new Set<string>();
      let cursor = bookmark.groupId;
      while (cursor) {
        if (visited.has(cursor))
          throw new ApplicationError('INVALID_STATE', 'Stored bookmark group cycle detected');
        visited.add(cursor);
        ancestorGroupIds.add(cursor);
        const group = groups.get(cursor);
        if (!group)
          throw new ApplicationError('INVALID_STATE', 'Bookmark references a missing group');
        cursor = group.parentId;
      }
    }
    return { bookmarkIds, ancestorGroupIds: [...ancestorGroupIds] };
  }
}

function requiredText(value: string, label: string, maximum: number): string {
  const normalized = value.trim();
  if (!normalized) throw new ApplicationError('INVALID_STATE', `${label} is required`);
  if (normalized.length > maximum)
    throw new ApplicationError('INVALID_STATE', `${label} exceeds ${maximum} characters`);
  return normalized;
}

function boundedText(value: string, label: string, maximum: number): string {
  if (value.length > maximum)
    throw new ApplicationError('INVALID_STATE', `${label} exceeds ${maximum} characters`);
  return value;
}

function optionalColor(value: string | null): string | null {
  if (value === null || value === '') return null;
  if (!colorPattern.test(value))
    throw new ApplicationError('INVALID_STATE', 'Bookmark color must be a six-digit hex color');
  return value.toLowerCase();
}

function validateBookmarkTriggers(input: unknown) {
  const triggers = bookmarkTriggersSchema.parse(input);
  for (const trigger of triggers) {
    try {
      validateTriggerPattern({ match: trigger.match });
    } catch (error) {
      throw new ApplicationError(
        'VALIDATION_ERROR',
        error instanceof Error ? error.message : 'Bookmark trigger pattern is invalid',
        400,
      );
    }
  }
  return triggers;
}
