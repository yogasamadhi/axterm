import { randomUUID } from 'node:crypto';
import {
  bookmarkQuickCommandsSchema,
  bookmarkTriggersSchema,
  ftpBookmarkSettingsSchema,
  rdpBookmarkSettingsSchema,
  serialBookmarkSettingsSchema,
  spiceBookmarkSettingsSchema,
  telnetBookmarkSettingsSchema,
  vncBookmarkSettingsSchema,
  webBookmarkSettingsSchema,
} from '@workspace/contracts';
import type {
  Bookmark,
  BookmarkGroup,
  BookmarkTreeNodeKind,
  BookmarkTreeNodeRef,
  BookmarkTreeSnapshot,
  CreateBookmarkGroupInput,
  CreateBookmarkInput,
  MoveBookmarkTreeNodeInput,
  UpdateBookmarkGroupInput,
  UpdateBookmarkInput,
} from '../../domain/bookmarks/model';
import { ApplicationError } from '../../application/errors';
import type { ProductDatabase } from './database';

interface BookmarkGroupRow {
  id: string;
  parent_id: string | null;
  name: string;
  color: string | null;
  description: string;
  position: number;
  created_at: string;
  updated_at: string;
  version: number;
}

interface BookmarkRow {
  id: string;
  group_id: string | null;
  protocol: Bookmark['protocol'];
  host_id: string | null;
  title: string;
  color: string | null;
  description: string;
  position: number;
  profile_id: string | null;
  connection_profile_id: string | null;
  quick_commands_payload: string;
  triggers_payload: string;
  ftp_payload: string;
  telnet_payload: string;
  serial_payload: string;
  rdp_payload: string;
  vnc_payload: string;
  spice_payload: string;
  web_payload: string;
  created_at: string;
  updated_at: string;
  version: number;
  host_hostname?: string | null;
  host_port?: number | null;
  host_username?: string | null;
}

interface TreeNodeRow {
  kind: BookmarkTreeNodeKind;
  id: string;
  parent_id: string | null;
  position: number;
}

const groupFromRow = (row: BookmarkGroupRow): BookmarkGroup => ({
  id: row.id,
  parentId: row.parent_id,
  name: row.name,
  color: row.color,
  description: row.description,
  position: row.position,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  version: row.version,
});

const bookmarkFromRow = (row: BookmarkRow): Bookmark => {
  const ftp =
    row.protocol === 'ftp'
      ? ftpBookmarkSettingsSchema.parse(JSON.parse(row.ftp_payload) as unknown)
      : null;
  const telnet =
    row.protocol === 'telnet'
      ? telnetBookmarkSettingsSchema.parse(JSON.parse(row.telnet_payload) as unknown)
      : null;
  const serial =
    row.protocol === 'serial'
      ? serialBookmarkSettingsSchema.parse(JSON.parse(row.serial_payload) as unknown)
      : null;
  const rdp =
    row.protocol === 'rdp'
      ? rdpBookmarkSettingsSchema.parse(JSON.parse(row.rdp_payload) as unknown)
      : null;
  const vnc =
    row.protocol === 'vnc'
      ? vncBookmarkSettingsSchema.parse(JSON.parse(row.vnc_payload) as unknown)
      : null;
  const spice =
    row.protocol === 'spice'
      ? spiceBookmarkSettingsSchema.parse(JSON.parse(row.spice_payload) as unknown)
      : null;
  const web =
    row.protocol === 'web'
      ? webBookmarkSettingsSchema.parse(JSON.parse(row.web_payload) as unknown)
      : null;
  return {
    id: row.id,
    groupId: row.group_id,
    protocol: row.protocol,
    hostId: row.host_id,
    title: row.title,
    color: row.color,
    description: row.description,
    position: row.position,
    profileId: row.profile_id,
    connectionProfileId: row.connection_profile_id,
    quickCommands: bookmarkQuickCommandsSchema.parse(
      JSON.parse(row.quick_commands_payload ?? '[]') as unknown,
    ),
    triggers: bookmarkTriggersSchema.parse(JSON.parse(row.triggers_payload ?? '[]') as unknown),
    ftp,
    telnet,
    serial,
    rdp,
    vnc,
    spice,
    web,
    connectionDisplay:
      row.protocol === 'ssh' && row.host_hostname && row.host_port
        ? `${row.host_username ?? ''}@${row.host_hostname}:${row.host_port}`
        : ftp
          ? `${ftp.username}@${ftp.hostname}:${ftp.port}`
          : telnet
            ? `${telnet.username}@${telnet.hostname}:${telnet.port}`
            : serial
              ? `${serial.path} · ${serial.baudRate}`
              : rdp
                ? `${rdp.username}@${rdp.hostname}:${rdp.port}`
                : vnc
                  ? `${vnc.username ? `${vnc.username}@` : ''}${vnc.hostname}:${vnc.port}`
                  : spice
                    ? `${spice.hostname}:${spice.port}`
                    : web
                      ? web.url
                      : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    version: row.version,
  };
};

export const bookmarkTreeEtag = (revision: number): string => `"bookmark-tree-v${revision}"`;

function revisionFromEtag(value: string | undefined): number {
  if (!value)
    throw new ApplicationError('PRECONDITION_REQUIRED', 'Bookmark tree If-Match is required', 428);
  const match = /^"bookmark-tree-v(\d+)"$/.exec(value);
  if (!match)
    throw new ApplicationError('PRECONDITION_FAILED', 'Invalid bookmark tree version', 412);
  return Number(match[1]);
}

export class BookmarkRepository {
  constructor(private readonly database: ProductDatabase) {}

  snapshot(): BookmarkTreeSnapshot {
    const revision = this.readRevision();
    return {
      revision,
      etag: bookmarkTreeEtag(revision),
      groups: this.database
        .all<BookmarkGroupRow>(
          `SELECT * FROM bookmark_groups
           ORDER BY COALESCE(parent_id, ''), position, lower(name), id`,
        )
        .map(groupFromRow),
      bookmarks: this.database
        .all<BookmarkRow>(
          `SELECT b.*, h.hostname AS host_hostname, h.port AS host_port,
                  h.username AS host_username
           FROM bookmarks b
           LEFT JOIN hosts h ON h.id=b.host_id
           ORDER BY COALESCE(b.group_id, ''), b.position, lower(b.title), b.id`,
        )
        .map(bookmarkFromRow),
    };
  }

  createGroup(
    input: CreateBookmarkGroupInput,
    treeIfMatch: string | undefined,
  ): BookmarkTreeSnapshot {
    this.database.transaction(() => {
      this.requireRevision(treeIfMatch);
      if (input.parentId) this.requireGroupRow(input.parentId);
      const now = new Date().toISOString();
      const id = randomUUID();
      const position = this.listChildren(input.parentId).length;
      this.database.run(
        `INSERT INTO bookmark_groups(
          id, parent_id, name, color, description, position, created_at, updated_at, version
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)`,
        id,
        input.parentId,
        input.name,
        input.color,
        input.description,
        position,
        now,
        now,
      );
      const revision = this.advanceRevision();
      this.database.appendEvent('bookmark-group.created', id, {
        id,
        parentId: input.parentId,
        name: input.name,
        color: input.color,
        description: input.description,
        position,
        treeRevision: revision,
      });
    });
    return this.snapshot();
  }

  updateGroup(
    id: string,
    input: UpdateBookmarkGroupInput,
    treeIfMatch: string | undefined,
  ): BookmarkTreeSnapshot {
    this.database.transaction(() => {
      this.requireRevision(treeIfMatch);
      const current = groupFromRow(this.requireGroupRow(id));
      const next = {
        name: input.name ?? current.name,
        color: input.color === undefined ? current.color : input.color,
        description: input.description ?? current.description,
      };
      const now = new Date().toISOString();
      this.database.run(
        `UPDATE bookmark_groups
         SET name=?, color=?, description=?, updated_at=?, version=version+1
         WHERE id=?`,
        next.name,
        next.color,
        next.description,
        now,
        id,
      );
      const revision = this.advanceRevision();
      this.database.appendEvent('bookmark-group.updated', id, {
        id,
        ...next,
        treeRevision: revision,
      });
    });
    return this.snapshot();
  }

  deleteGroup(id: string, treeIfMatch: string | undefined): BookmarkTreeSnapshot {
    this.database.transaction(() => {
      this.requireRevision(treeIfMatch);
      const group = this.requireGroupRow(id);
      const parentChildren = this.listChildren(group.parent_id);
      const groupIndex = parentChildren.findIndex(
        (node) => node.kind === 'group' && node.id === id,
      );
      if (groupIndex < 0)
        throw new ApplicationError('INVALID_STATE', 'Bookmark group is missing from its parent');
      const promoted = this.listChildren(id);
      const nextChildren = parentChildren.filter(
        (node) => !(node.kind === 'group' && node.id === id),
      );
      nextChildren.splice(groupIndex, 0, ...promoted);
      const now = new Date().toISOString();
      this.reindex(group.parent_id, nextChildren, now);
      this.database.run('DELETE FROM bookmark_groups WHERE id=?', id);
      const revision = this.advanceRevision();
      this.database.appendEvent('bookmark-group.deleted', id, {
        id,
        parentId: group.parent_id,
        promoted: promoted.map(({ kind, id: promotedId }) => ({ kind, id: promotedId })),
        treeRevision: revision,
      });
    });
    return this.snapshot();
  }

  createBookmark(
    input: CreateBookmarkInput,
    treeIfMatch: string | undefined,
  ): BookmarkTreeSnapshot {
    this.database.transaction(() => {
      this.requireRevision(treeIfMatch);
      if (input.groupId) this.requireGroupRow(input.groupId);
      if (input.hostId && !this.database.get('SELECT id FROM hosts WHERE id=?', input.hostId))
        throw new ApplicationError('NOT_FOUND', 'Bookmark host not found', 404);
      this.requireConnectionProfile(input.connectionProfileId);
      const id = randomUUID();
      const now = new Date().toISOString();
      const position = this.listChildren(input.groupId).length;
      this.database.run(
        `INSERT INTO bookmarks(
          id, group_id, protocol, host_id, title, color, description, position,
          profile_id, connection_profile_id, quick_commands_payload, triggers_payload, ftp_payload, telnet_payload, serial_payload, rdp_payload, vnc_payload, spice_payload, web_payload, created_at, updated_at, version
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
        id,
        input.groupId,
        input.protocol,
        input.hostId,
        input.title,
        input.color,
        input.description,
        position,
        input.profileId,
        input.connectionProfileId,
        JSON.stringify(input.quickCommands),
        JSON.stringify(input.triggers),
        JSON.stringify(input.ftp),
        JSON.stringify(input.telnet),
        JSON.stringify(input.serial),
        JSON.stringify(input.rdp),
        JSON.stringify(input.vnc),
        JSON.stringify(input.spice),
        JSON.stringify(input.web),
        now,
        now,
      );
      const revision = this.advanceRevision();
      this.database.appendEvent('bookmark.created', id, {
        id,
        groupId: input.groupId,
        protocol: input.protocol,
        hostId: input.hostId,
        title: input.title,
        color: input.color,
        description: input.description,
        position,
        profileId: input.profileId,
        connectionProfileId: input.connectionProfileId,
        quickCommandCount: input.quickCommands.length,
        triggerCount: input.triggers.length,
        ftp: input.ftp,
        telnet: input.telnet,
        serial: input.serial,
        rdp: input.rdp,
        vnc: input.vnc,
        spice: input.spice,
        web: input.web,
        treeRevision: revision,
      });
    });
    return this.snapshot();
  }

  /**
   * Checks the aggregate version and destination before a multi-aggregate workflow
   * performs its first write. The workflow still checks the revision again in the
   * batch mutation so the repository remains safe when called independently.
   */
  assertMutationTarget(groupId: string | null, treeIfMatch: string | undefined): void {
    this.database.transaction(() => {
      this.requireRevision(treeIfMatch);
      if (groupId) this.requireGroupRow(groupId);
    });
  }

  createBookmarksBatch(
    inputs: CreateBookmarkInput[],
    treeIfMatch: string | undefined,
  ): { bookmarks: Bookmark[]; tree: BookmarkTreeSnapshot } {
    const ids: string[] = [];
    this.database.transaction(() => {
      this.requireRevision(treeIfMatch);
      const groupIds = new Set(inputs.map(({ groupId }) => groupId));
      for (const groupId of groupIds) if (groupId) this.requireGroupRow(groupId);
      for (const input of inputs) {
        if (input.hostId && !this.database.get('SELECT id FROM hosts WHERE id=?', input.hostId))
          throw new ApplicationError('NOT_FOUND', 'Bookmark host not found', 404);
        this.requireConnectionProfile(input.connectionProfileId);
      }
      if (!inputs.length) return;

      const nextPositions = new Map<string, number>();
      for (const groupId of groupIds)
        nextPositions.set(groupId ?? '', this.listChildren(groupId).length);
      const now = new Date().toISOString();
      for (const input of inputs) {
        const key = input.groupId ?? '';
        const position = nextPositions.get(key);
        if (position === undefined)
          throw new ApplicationError('INVALID_STATE', 'Bookmark batch position is unavailable');
        const id = randomUUID();
        ids.push(id);
        this.database.run(
          `INSERT INTO bookmarks(
            id, group_id, protocol, host_id, title, color, description, position,
            profile_id, connection_profile_id, quick_commands_payload, triggers_payload, ftp_payload, telnet_payload, serial_payload, rdp_payload, vnc_payload, spice_payload, web_payload, created_at, updated_at, version
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
          id,
          input.groupId,
          input.protocol,
          input.hostId,
          input.title,
          input.color,
          input.description,
          position,
          input.profileId,
          input.connectionProfileId,
          JSON.stringify(input.quickCommands),
          JSON.stringify(input.triggers),
          JSON.stringify(input.ftp),
          JSON.stringify(input.telnet),
          JSON.stringify(input.serial),
          JSON.stringify(input.rdp),
          JSON.stringify(input.vnc),
          JSON.stringify(input.spice),
          JSON.stringify(input.web),
          now,
          now,
        );
        nextPositions.set(key, position + 1);
      }
      const revision = this.advanceRevision();
      const batchId = randomUUID();
      this.database.appendEvent('bookmark.batch-created', batchId, {
        id: batchId,
        bookmarkIds: ids,
        count: ids.length,
        treeRevision: revision,
      });
    });
    const tree = this.snapshot();
    const byId = new Map(tree.bookmarks.map((bookmark) => [bookmark.id, bookmark]));
    return {
      bookmarks: ids.map((id) => {
        const bookmark = byId.get(id);
        if (!bookmark)
          throw new ApplicationError('INVALID_STATE', 'Created Bookmark is missing from snapshot');
        return bookmark;
      }),
      tree,
    };
  }

  updateBookmark(
    id: string,
    input: UpdateBookmarkInput,
    treeIfMatch: string | undefined,
  ): BookmarkTreeSnapshot {
    this.database.transaction(() => {
      this.requireRevision(treeIfMatch);
      const current = bookmarkFromRow(this.requireBookmarkRow(id));
      const next = {
        title: input.title ?? current.title,
        color: input.color === undefined ? current.color : input.color,
        description: input.description ?? current.description,
        profileId: input.profileId === undefined ? current.profileId : input.profileId,
        connectionProfileId:
          input.connectionProfileId === undefined
            ? current.connectionProfileId
            : input.connectionProfileId,
        quickCommands:
          input.quickCommands === undefined ? current.quickCommands : input.quickCommands,
        triggers: input.triggers === undefined ? current.triggers : input.triggers,
        ftp: input.ftp === undefined ? current.ftp : input.ftp,
        telnet: input.telnet === undefined ? current.telnet : input.telnet,
        serial: input.serial === undefined ? current.serial : input.serial,
        rdp: input.rdp === undefined ? current.rdp : input.rdp,
        vnc: input.vnc === undefined ? current.vnc : input.vnc,
        spice: input.spice === undefined ? current.spice : input.spice,
        web: input.web === undefined ? current.web : input.web,
      };
      this.requireConnectionProfile(next.connectionProfileId);
      const now = new Date().toISOString();
      this.database.run(
        `UPDATE bookmarks
         SET title=?, color=?, description=?, profile_id=?, connection_profile_id=?, quick_commands_payload=?, triggers_payload=?, ftp_payload=?, telnet_payload=?, serial_payload=?, rdp_payload=?, vnc_payload=?, spice_payload=?, web_payload=?,
             updated_at=?, version=version+1
         WHERE id=?`,
        next.title,
        next.color,
        next.description,
        next.profileId,
        next.connectionProfileId,
        JSON.stringify(next.quickCommands),
        JSON.stringify(next.triggers),
        JSON.stringify(next.ftp),
        JSON.stringify(next.telnet),
        JSON.stringify(next.serial),
        JSON.stringify(next.rdp),
        JSON.stringify(next.vnc),
        JSON.stringify(next.spice),
        JSON.stringify(next.web),
        now,
        id,
      );
      const revision = this.advanceRevision();
      const { quickCommands: _quickCommands, triggers: _triggers, ...eventFields } = next;
      this.database.appendEvent('bookmark.updated', id, {
        id,
        ...eventFields,
        quickCommandCount: next.quickCommands.length,
        triggerCount: next.triggers.length,
        treeRevision: revision,
      });
    });
    return this.snapshot();
  }

  updateBookmarkWithPlacement(
    id: string,
    input: UpdateBookmarkInput & { groupId?: string | null | undefined },
    treeIfMatch: string | undefined,
  ): BookmarkTreeSnapshot {
    this.database.transaction(() => {
      this.requireRevision(treeIfMatch);
      const current = bookmarkFromRow(this.requireBookmarkRow(id));
      const groupId = input.groupId === undefined ? current.groupId : input.groupId;
      if (groupId) this.requireGroupRow(groupId);
      const next = {
        groupId,
        title: input.title ?? current.title,
        color: input.color === undefined ? current.color : input.color,
        description: input.description ?? current.description,
        profileId: input.profileId === undefined ? current.profileId : input.profileId,
        connectionProfileId:
          input.connectionProfileId === undefined
            ? current.connectionProfileId
            : input.connectionProfileId,
        quickCommands:
          input.quickCommands === undefined ? current.quickCommands : input.quickCommands,
        triggers: input.triggers === undefined ? current.triggers : input.triggers,
        ftp: input.ftp === undefined ? current.ftp : input.ftp,
        telnet: input.telnet === undefined ? current.telnet : input.telnet,
        serial: input.serial === undefined ? current.serial : input.serial,
        rdp: input.rdp === undefined ? current.rdp : input.rdp,
        vnc: input.vnc === undefined ? current.vnc : input.vnc,
        spice: input.spice === undefined ? current.spice : input.spice,
        web: input.web === undefined ? current.web : input.web,
      };
      this.requireConnectionProfile(next.connectionProfileId);
      const now = new Date().toISOString();
      let position = current.position;
      if (groupId !== current.groupId) {
        const remaining = this.listChildren(current.groupId).filter(
          (node) => !(node.kind === 'bookmark' && node.id === id),
        );
        this.reindex(current.groupId, remaining, now);
        position = this.listChildren(groupId).length;
      }
      this.database.run(
        `UPDATE bookmarks
         SET group_id=?, title=?, color=?, description=?, position=?, profile_id=?,
             connection_profile_id=?, quick_commands_payload=?, triggers_payload=?, ftp_payload=?, telnet_payload=?, serial_payload=?, rdp_payload=?, vnc_payload=?, spice_payload=?, web_payload=?,
             updated_at=?, version=version+1
         WHERE id=?`,
        next.groupId,
        next.title,
        next.color,
        next.description,
        position,
        next.profileId,
        next.connectionProfileId,
        JSON.stringify(next.quickCommands),
        JSON.stringify(next.triggers),
        JSON.stringify(next.ftp),
        JSON.stringify(next.telnet),
        JSON.stringify(next.serial),
        JSON.stringify(next.rdp),
        JSON.stringify(next.vnc),
        JSON.stringify(next.spice),
        JSON.stringify(next.web),
        now,
        id,
      );
      const revision = this.advanceRevision();
      const { quickCommands: _quickCommands, triggers: _triggers, ...eventFields } = next;
      this.database.appendEvent('bookmark.updated', id, {
        id,
        ...eventFields,
        quickCommandCount: next.quickCommands.length,
        triggerCount: next.triggers.length,
        position,
        previousGroupId: current.groupId,
        treeRevision: revision,
      });
    });
    return this.snapshot();
  }

  deleteBookmark(id: string, treeIfMatch: string | undefined): BookmarkTreeSnapshot {
    this.database.transaction(() => {
      this.requireRevision(treeIfMatch);
      const current = this.requireBookmarkRow(id);
      this.database.run('DELETE FROM bookmarks WHERE id=?', id);
      const remaining = this.listChildren(current.group_id);
      const now = new Date().toISOString();
      this.reindex(current.group_id, remaining, now);
      const revision = this.advanceRevision();
      this.database.appendEvent('bookmark.deleted', id, {
        id,
        groupId: current.group_id,
        treeRevision: revision,
      });
    });
    return this.snapshot();
  }

  deleteBookmarksForHost(
    hostId: string,
    treeIfMatch: string | undefined,
  ): { bookmarkIds: string[]; tree: BookmarkTreeSnapshot } {
    let bookmarkIds: string[] = [];
    this.database.transaction(() => {
      this.requireRevision(treeIfMatch);
      const bookmarks = this.database.all<Pick<BookmarkRow, 'id' | 'group_id'>>(
        `SELECT id, group_id
         FROM bookmarks
         WHERE host_id=?
         ORDER BY COALESCE(group_id, ''), position, id`,
        hostId,
      );
      bookmarkIds = bookmarks.map(({ id }) => id);
      if (!bookmarks.length) return;

      this.database.run('DELETE FROM bookmarks WHERE host_id=?', hostId);
      const now = new Date().toISOString();
      const affectedParents = new Set(bookmarks.map(({ group_id }) => group_id));
      for (const parentId of affectedParents)
        this.reindex(parentId, this.listChildren(parentId), now);

      const revision = this.advanceRevision();
      this.database.appendEvent('bookmark.bulk-deleted', hostId, {
        hostId,
        bookmarkIds,
        affectedParentIds: [...affectedParents],
        reason: 'host-deleted',
        treeRevision: revision,
      });
    });
    return { bookmarkIds, tree: this.snapshot() };
  }

  move(input: MoveBookmarkTreeNodeInput, treeIfMatch: string | undefined): BookmarkTreeSnapshot {
    this.database.transaction(() => {
      this.requireRevision(treeIfMatch);
      if (input.source.kind === input.target.kind && input.source.id === input.target.id)
        throw new ApplicationError('CONFLICT', 'A bookmark tree node cannot be moved onto itself');

      const source = this.requireNode(input.source);
      const target = this.requireNode(input.target);
      if (input.position === 'inside' && target.kind !== 'group')
        throw new ApplicationError('CONFLICT', 'Only a bookmark group accepts an inside drop');

      const destinationParentId = input.position === 'inside' ? target.id : target.parent_id;
      if (source.kind === 'group')
        this.assertGroupDestinationIsAcyclic(source.id, destinationParentId);

      const sourceSiblings = this.listChildren(source.parent_id).filter(
        (node) => !(node.kind === source.kind && node.id === source.id),
      );
      const destinationSiblings =
        destinationParentId === source.parent_id
          ? sourceSiblings
          : this.listChildren(destinationParentId).filter(
              (node) => !(node.kind === source.kind && node.id === source.id),
            );

      let insertionIndex = destinationSiblings.length;
      if (input.position !== 'inside') {
        const targetIndex = destinationSiblings.findIndex(
          (node) => node.kind === target.kind && node.id === target.id,
        );
        if (targetIndex < 0)
          throw new ApplicationError('INVALID_STATE', 'Drop target is missing from its parent');
        insertionIndex = targetIndex + (input.position === 'after' ? 1 : 0);
      }
      destinationSiblings.splice(insertionIndex, 0, {
        ...source,
        parent_id: destinationParentId,
      });

      const now = new Date().toISOString();
      if (destinationParentId !== source.parent_id)
        this.reindex(source.parent_id, sourceSiblings, now);
      this.reindex(destinationParentId, destinationSiblings, now);
      const revision = this.advanceRevision();
      this.database.appendEvent('bookmark-tree.moved', input.source.id, {
        source: input.source,
        target: input.target,
        position: input.position,
        fromParentId: source.parent_id,
        toParentId: destinationParentId,
        treeRevision: revision,
      });
    });
    return this.snapshot();
  }

  private readRevision(): number {
    const row = this.database.get<{ value: string }>(
      "SELECT value FROM app_meta WHERE key='bookmark-tree:revision'",
    );
    const revision = Number(row?.value);
    if (!Number.isSafeInteger(revision) || revision < 1)
      throw new ApplicationError('INVALID_STATE', 'Bookmark tree revision is unavailable');
    return revision;
  }

  private requireRevision(treeIfMatch: string | undefined): number {
    const expected = revisionFromEtag(treeIfMatch);
    const current = this.readRevision();
    if (expected !== current)
      throw new ApplicationError('PRECONDITION_FAILED', 'Bookmark tree changed', 412);
    return current;
  }

  private advanceRevision(): number {
    const result = this.database.run(
      `UPDATE app_meta
       SET value=CAST(CAST(value AS INTEGER) + 1 AS TEXT)
       WHERE key='bookmark-tree:revision'`,
    );
    if (!result.changes)
      throw new ApplicationError('INVALID_STATE', 'Bookmark tree revision is unavailable');
    return this.readRevision();
  }

  private requireGroupRow(id: string): BookmarkGroupRow {
    const row = this.database.get<BookmarkGroupRow>('SELECT * FROM bookmark_groups WHERE id=?', id);
    if (!row) throw new ApplicationError('NOT_FOUND', 'Bookmark group not found', 404);
    return row;
  }

  private requireBookmarkRow(id: string): BookmarkRow {
    const row = this.database.get<BookmarkRow>('SELECT * FROM bookmarks WHERE id=?', id);
    if (!row) throw new ApplicationError('NOT_FOUND', 'Bookmark not found', 404);
    return row;
  }

  private requireConnectionProfile(id: string | null): void {
    if (!id) return;
    if (!this.database.get('SELECT id FROM connection_profiles WHERE id=?', id))
      throw new ApplicationError('NOT_FOUND', 'Connection Profile not found', 404);
  }

  private requireNode(ref: BookmarkTreeNodeRef): TreeNodeRow {
    if (ref.kind === 'group') {
      const row = this.requireGroupRow(ref.id);
      return { kind: 'group', id: row.id, parent_id: row.parent_id, position: row.position };
    }
    const row = this.requireBookmarkRow(ref.id);
    return { kind: 'bookmark', id: row.id, parent_id: row.group_id, position: row.position };
  }

  private listChildren(parentId: string | null): TreeNodeRow[] {
    return this.database.all<TreeNodeRow>(
      `SELECT 'group' AS kind, id, parent_id, position
       FROM bookmark_groups WHERE parent_id IS ?
       UNION ALL
       SELECT 'bookmark' AS kind, id, group_id AS parent_id, position
       FROM bookmarks WHERE group_id IS ?
       ORDER BY position, kind DESC, id`,
      parentId,
      parentId,
    );
  }

  private reindex(parentId: string | null, nodes: TreeNodeRow[], now: string): void {
    nodes.forEach((node, position) => {
      if (node.kind === 'group') {
        this.database.run(
          `UPDATE bookmark_groups
           SET parent_id=?, position=?, updated_at=?, version=version+1
           WHERE id=?`,
          parentId,
          position,
          now,
          node.id,
        );
      } else {
        this.database.run(
          `UPDATE bookmarks
           SET group_id=?, position=?, updated_at=?, version=version+1
           WHERE id=?`,
          parentId,
          position,
          now,
          node.id,
        );
      }
    });
  }

  private assertGroupDestinationIsAcyclic(groupId: string, parentId: string | null): void {
    const visited = new Set<string>();
    let cursor = parentId;
    while (cursor) {
      if (cursor === groupId)
        throw new ApplicationError('CONFLICT', 'Bookmark group cycle detected');
      if (visited.has(cursor))
        throw new ApplicationError('INVALID_STATE', 'Stored bookmark group cycle detected');
      visited.add(cursor);
      cursor = this.requireGroupRow(cursor).parent_id;
    }
  }
}
