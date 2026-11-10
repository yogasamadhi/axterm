import { RemoteError, remoteErrorOf } from '@axterm/plugin-api';
import type {
  Bookmark,
  Host,
  BookmarkTreeNodeRef,
  BookmarkDropPosition,
  CreateBookmarkInput,
  CreateSshBookmarkInput,
  CatalogBaseline,
  CatalogReceipt,
} from '@axterm/plugin-api/catalog';
import type {
  ConnectionWorkspaceUi,
  TerminalWorkspaceUi,
  FilesWorkspaceUi,
  RemoteDesktopWorkspaceUi,
  WebSessionWorkspaceUi,
} from '@axterm/ui/workspace';
import type { CatalogModel } from '../../index.ts';
import type { BookmarkGroupDraft } from './bookmark-group-dialog.tsx';
type TreeState = { readonly busy: boolean; readonly failed: boolean; readonly uncertain: boolean };
/** Commands capture identities/preconditions once. Network admission remains owned by Connections/Terminals. */
export class CatalogTreeActions {
  private state: TreeState = { busy: false, failed: false, uncertain: false };
  private readonly listeners = new Set<() => void>();
  private retained: { generation: string; invoke: () => Promise<unknown> } | undefined;
  private pending: Promise<boolean> | undefined;
  private closing: Promise<void> | undefined;
  private readonly lifetime = new AbortController();
  private webSessions: WebSessionWorkspaceUi | undefined;
  private remoteDesktop: RemoteDesktopWorkspaceUi | undefined;
  constructor(
    private readonly model: CatalogModel,
    private readonly connections: ConnectionWorkspaceUi,
    private readonly terminals: TerminalWorkspaceUi,
    private files: FilesWorkspaceUi | undefined = undefined,
    private readonly sourceCurrent?: (kind: Bookmark['protocol'], generation: string) => boolean,
  ) {}
  attachWebSessions(owner: WebSessionWorkspaceUi): () => void {
    if (this.webSessions) throw Error('CATALOG_WEB_SESSION_OWNER_CONFLICT');
    this.webSessions = owner;
    return () => {
      if (this.webSessions === owner) this.webSessions = undefined;
    };
  }
  attachRemoteDesktop(owner: RemoteDesktopWorkspaceUi): () => void {
    if (this.remoteDesktop) throw Error('CATALOG_REMOTE_DESKTOP_OWNER_CONFLICT');
    this.remoteDesktop = owner;
    return () => {
      if (this.remoteDesktop === owner) this.remoteDesktop = undefined;
    };
  }
  attachFiles(files: FilesWorkspaceUi): () => void {
    if (this.files && this.files !== files) throw Error('CATALOG_FILES_OWNER_CONFLICT');
    this.files = files;
    return () => {
      if (this.files === files) this.files = undefined;
    };
  }
  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => {
    if (this.closing) throw new Error('CATALOG_TREE_CLOSED');
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  createGroup(parentId: string | null, input: BookmarkGroupDraft) {
    const request = structuredClone({ ...input, parentId });
    return this.fact((key, facts) =>
      this.model.createBookmarkGroup(key, request, facts.bookmarks.etag),
    );
  }
  updateGroup(id: string, input: BookmarkGroupDraft) {
    const request = structuredClone(input);
    return this.fact((key, facts) =>
      this.model.updateBookmarkGroup(key, id, request, facts.bookmarks.etag),
    );
  }
  deleteGroup(id: string) {
    return this.fact((key, facts) => this.model.deleteBookmarkGroup(key, id, facts.bookmarks.etag));
  }
  move(source: BookmarkTreeNodeRef, target: BookmarkTreeNodeRef, position: BookmarkDropPosition) {
    const request = structuredClone({ source, target, position });
    return this.fact((key, facts) =>
      this.model.moveBookmarkTreeNode(key, request, facts.bookmarks.etag),
    );
  }
  removeHost(host: Host) {
    const id = host.id,
      version = host.version;
    return this.fact((key, facts) =>
      this.model.deleteSshBookmarkHost(key, id, '"v' + version + '"', facts.bookmarks.etag),
    );
  }
  connectHost(host: Host, readyConnectionId?: string): Promise<boolean> {
    if (this.closing || this.pending || this.retained) return Promise.resolve(false);
    const facts = this.model.getSnapshot();
    if (facts.status !== 'ready') return this.unavailable();
    const id = host.id,
      generation = facts.baseline.generation;
    return this.perform(async () => {
      this.lifetime.signal.throwIfAborted();
      const current = this.model.getSnapshot();
      if (current.status !== 'ready' || current.baseline.generation !== generation)
        throw new Error('CATALOG_GENERATION_CHANGED');
      if (this.sourceCurrent && !this.sourceCurrent('ssh', generation))
        throw Error('CATALOG_SESSION_GENERATION_RETIRED');
      return readyConnectionId
        ? this.terminals.open(
            { kind: 'ssh', connectionId: readyConnectionId, cols: 160, rows: 80 },
            this.lifetime.signal,
          )
        : this.connections.openSsh({ hostId: id }, { signal: this.lifetime.signal });
    }, false);
  }
  remove(bookmark: Bookmark) {
    const id = bookmark.id,
      hostId = bookmark.hostId,
      protocol = bookmark.protocol;
    return this.fact((key, facts) => {
      if (protocol === 'ssh' && hostId) {
        const host = facts.hosts.find((value) => value.id === hostId);
        if (!host)
          throw new RemoteError('catalog/failure', 'CATALOG_HOST_MISSING', { reason: 'not-found' });
        return this.model.deleteSshBookmark(
          key,
          id,
          '"v' + host.version + '"',
          facts.bookmarks.etag,
        );
      }
      return this.model.deleteBookmark(key, id, facts.bookmarks.etag);
    });
  }
  duplicate(bookmark: Bookmark, copyLabel: string) {
    const captured = structuredClone(bookmark);
    return this.fact((key, facts) => {
      const title = this.copyTitle(facts, captured.title, copyLabel);
      if (captured.protocol === 'ssh' && captured.hostId) {
        const host = facts.hosts.find((value) => value.id === captured.hostId);
        if (!host)
          throw new RemoteError('catalog/failure', 'CATALOG_HOST_MISSING', { reason: 'not-found' });
        const {
          id: _id,
          groupId: _groupId,
          version: _version,
          createdAt: _createdAt,
          updatedAt: _updatedAt,
          ...metadata
        } = host;
        const input: CreateSshBookmarkInput = {
          host: { ...metadata, name: this.copyTitle(facts, host.name, copyLabel) },
          bookmark: {
            groupId: captured.groupId,
            title,
            color: captured.color,
            description: captured.description,
            profileId: captured.profileId,
            connectionProfileId: captured.connectionProfileId,
            quickCommands: captured.quickCommands,
            triggers: captured.triggers,
          },
        };
        return this.model.createSshBookmark(key, input, facts.bookmarks.etag);
      }
      const {
        id: _id,
        createdAt: _createdAt,
        updatedAt: _updatedAt,
        version: _version,
        position: _position,
        connectionDisplay: _connectionDisplay,
        ...fields
      } = captured;
      const input: CreateBookmarkInput = { ...fields, title };
      return this.model.createBookmark(key, input, facts.bookmarks.etag);
    });
  }
  connect(bookmark: Bookmark, signal?: AbortSignal, readyConnectionId?: string): Promise<boolean> {
    if (this.closing || this.pending || this.retained) return Promise.resolve(false);
    const facts = this.model.getSnapshot();
    if (facts.status !== 'ready') return this.unavailable();
    const captured = structuredClone(bookmark),
      options = {
        bookmarkId: captured.id,
        ...(captured.profileId ? { profileId: captured.profileId } : {}),
      };
    const connectionSignal = signal
      ? AbortSignal.any([signal, this.lifetime.signal])
      : this.lifetime.signal;
    const generation = facts.baseline.generation;
    return this.perform(async () => {
      connectionSignal.throwIfAborted();
      const current = this.model.getSnapshot();
      if (current.status !== 'ready' || current.baseline.generation !== generation)
        throw new Error('CATALOG_GENERATION_CHANGED');
      if (this.sourceCurrent && !this.sourceCurrent(captured.protocol, generation))
        throw Error('CATALOG_SESSION_GENERATION_RETIRED');
      if (captured.protocol === 'local')
        return this.terminals.open(
          {
            kind: 'local',
            cols: 160,
            rows: 80,
            ...(captured.profileId ? { profileId: captured.profileId } : {}),
          },
          connectionSignal,
          { title: captured.title },
        );
      if (captured.protocol === 'ssh' && captured.hostId && readyConnectionId)
        return this.terminals.open(
          {
            kind: 'ssh',
            connectionId: readyConnectionId,
            cols: 160,
            rows: 80,
            bookmarkId: captured.id,
            ...(captured.profileId ? { profileId: captured.profileId } : {}),
          },
          connectionSignal,
          { title: captured.title },
        );
      if (captured.protocol === 'ssh' && captured.hostId)
        return this.connections.openSsh(
          {
            hostId: captured.hostId,
            ...(captured.connectionProfileId
              ? { connectionProfileId: captured.connectionProfileId }
              : {}),
          },
          { signal: connectionSignal, terminal: { ...options, title: captured.title } },
        );
      if (captured.protocol === 'web') {
        if (!this.webSessions) throw Error('WEB_SESSION_NATIVE_UNAVAILABLE');
        return this.webSessions.open(captured.id, connectionSignal);
      }
      if (['rdp', 'vnc', 'spice'].includes(captured.protocol) && this.remoteDesktop)
        return this.remoteDesktop.open(
          { protocol: captured.protocol as 'rdp' | 'vnc' | 'spice', bookmarkId: captured.id },
          connectionSignal,
        );
      if (captured.protocol === 'ftp' && this.files)
        return this.files.openFtp(
          { bookmarkId: captured.id },
          { signal: connectionSignal, title: captured.title },
        );
      if (captured.protocol === 'serial')
        return this.terminals.open(
          { kind: 'serial', cols: 160, rows: 80, ...options },
          connectionSignal,
          { title: captured.title },
        );
      if (captured.protocol === 'telnet')
        return this.terminals.open(
          { kind: 'telnet', cols: 160, rows: 80, ...options },
          connectionSignal,
          { title: captured.title },
        );
      throw new Error('CATALOG_PROTOCOL_UI_UNAVAILABLE');
    }, false);
  }
  retry(): Promise<boolean> {
    if (this.closing || this.pending || !this.retained) return Promise.resolve(false);
    const facts = this.model.getSnapshot();
    if (facts.status !== 'ready') return this.unavailable();
    if (facts.baseline.generation !== this.retained.generation) {
      this.retained = undefined;
      return this.unavailable();
    }
    return this.perform(this.retained.invoke, true);
  }
  close(): Promise<void> {
    return (this.closing ??= (async () => {
      this.lifetime.abort();
      await this.pending;
      this.listeners.clear();
      const current = this.model.getSnapshot();
      if (
        this.retained &&
        !(current.status === 'ready' && current.baseline.generation !== this.retained.generation)
      )
        throw new Error('CATALOG_TREE_DRAIN_UNCERTAIN');
      this.retained = undefined;
    })());
  }
  private fact(
    invoke: (key: string, facts: CatalogBaseline) => Promise<CatalogReceipt>,
  ): Promise<boolean> {
    if (this.closing || this.pending || this.retained) return Promise.resolve(false);
    const state = this.model.getSnapshot();
    if (state.status !== 'ready') return this.unavailable();
    const key = crypto.randomUUID(),
      facts = state.baseline;
    this.retained = {
      generation: facts.generation,
      invoke: async () => {
        const current = this.model.getSnapshot();
        if (current.status !== 'ready') throw new Error('CATALOG_NOT_READY');
        if (current.baseline.generation !== facts.generation) {
          this.retained = undefined;
          throw new Error('CATALOG_GENERATION_CHANGED');
        }
        return invoke(key, facts);
      },
    };
    return this.perform(this.retained.invoke, true);
  }
  private perform(invoke: () => Promise<unknown>, fact: boolean): Promise<boolean> {
    this.publish({ busy: true, failed: false, uncertain: false });
    const task = Promise.resolve()
      .then(invoke)
      .then(
        () => {
          if (fact) this.retained = undefined;
          this.publish({ busy: false, failed: false, uncertain: false });
          return true;
        },
        (error) => {
          const marked = remoteErrorOf(error);
          if (
            marked?.code === 'catalog/failure' &&
            [
              'invalid-input',
              'not-found',
              'capacity',
              'closed',
              'conflict',
              'stale',
              'precondition-required',
              'precondition-failed',
            ].includes(marked.details.reason)
          )
            this.retained = undefined;
          this.publish({ busy: false, failed: true, uncertain: !!this.retained });
          return false;
        },
      );
    this.pending = task;
    void task.finally(() => {
      this.pending = undefined;
    });
    return task;
  }
  private unavailable(): Promise<boolean> {
    this.publish({ busy: false, failed: true, uncertain: !!this.retained });
    return Promise.resolve(false);
  }
  private publish(value: TreeState) {
    this.state = value;
    if (!this.closing) for (const listener of this.listeners) listener();
  }
  private copyTitle(facts: CatalogBaseline, source: string, copyLabel: string): string {
    const escapedLabel = copyLabel.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
    const stem = `${source.replace(new RegExp(`(?:\\s+${escapedLabel}(?:\\s+\\d+)?)$`, 'iu'), '')} ${copyLabel}`;
    const existing = new Set(
      [
        ...facts.bookmarks.bookmarks.map(({ title }) => title),
        ...facts.hosts.map(({ name }) => name),
      ].map((title) => title.toLocaleLowerCase()),
    );
    if (!existing.has(stem.toLocaleLowerCase())) return stem.slice(0, 100);
    for (let index = 2; index < 10_000; index += 1) {
      const suffix = ` ${index}`;
      const candidate = `${stem.slice(0, 100 - suffix.length)}${suffix}`;
      if (!existing.has(candidate.toLocaleLowerCase())) return candidate;
    }
    return `${stem.slice(0, 91)} ${crypto.randomUUID().slice(0, 8)}`;
  }
}
