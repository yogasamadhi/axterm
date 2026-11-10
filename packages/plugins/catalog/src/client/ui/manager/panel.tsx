import { useState, useSyncExternalStore, type ReactNode } from 'react';
import {
  Server,
  Plus,
  FolderInput,
  Network,
  Terminal as TerminalIcon,
  Monitor,
  Globe2,
  Search,
  Star,
  Copy,
  LoaderCircle,
  Play,
  Trash2,
  ChevronLeft,
} from 'lucide-react';
import type { Bookmark, BookmarkTree, Host } from '@axterm/plugin-api/catalog';
import type { Connection, ConnectionClientActions } from '@axterm/plugin-api/connections';
import type { ConfigurationClientActions } from '@axterm/plugin-api/configuration';
import type { WorkspaceUi } from '@axterm/ui/workspace';
import type { CatalogModel } from '../../index.ts';
import type { CatalogTreeActions } from '../tree/tree-actions.ts';
import type { BookmarkTreeUiStore } from '../tree/tree-ui.tsx';
import type { CatalogEditorOwner } from '../editor/owner.ts';
import { useI18n } from '../i18n.tsx';
import { maskHostAddress } from '../privacy.ts';
import styles from './manager.module.css';
const classes = (value: string) =>
  value
    .split(/\s+/u)
    .filter(Boolean)
    .map((name) => name + ' ' + (styles[name] ?? ''))
    .join(' ');
type Translator = ReturnType<typeof useI18n>['x'];
export interface CatalogManagerProps {
  model: CatalogModel;
  actions: CatalogTreeActions;
  store: BookmarkTreeUiStore;
  editor: CatalogEditorOwner;
  workspace: WorkspaceUi;
  connectionActions: ConnectionClientActions;
  configuration: ConfigurationClientActions;
}
export function CatalogManager({
  model,
  actions,
  store,
  editor,
  workspace,
  connectionActions,
  configuration,
}: CatalogManagerProps) {
  const { x } = useI18n();
  const facts = useSyncExternalStore(model.subscribe, model.getSnapshot);
  const live = useSyncExternalStore(connectionActions.subscribe, connectionActions.getSnapshot);
  const settings = useSyncExternalStore(configuration.subscribe, configuration.getSnapshot);
  const command = useSyncExternalStore(actions.subscribe, actions.getSnapshot);
  const [hostQuery, setHostQuery] = useState('');
  const [activeGroupId, setActiveGroupId] = useState<string>();
  const [failed, setFailed] = useState(false);
  const busy = command.busy || command.uncertain;
  if (facts.status !== 'ready') return <p role="status">{x('history.loading')}</p>;
  const hosts = [...facts.baseline.hosts],
    bookmarkTree = facts.baseline.bookmarks;
  const connections = live.status === 'ready' ? live.baseline.connections : [];
  const hideAddresses =
    settings.status !== 'ready' || settings.baseline.settings.privacy.hideAddresses;
  const onCreateBookmarkGroup = () =>
    store.getSnapshot().setGroupDialog({ kind: 'create', parentId: null });
  const onConnectBookmark = (bookmark: Bookmark) => {
    void actions.connect(bookmark);
  };
  const onDuplicateBookmark = (bookmark: Bookmark) => {
    void actions.duplicate(bookmark, x('app.copyNoun'));
  };
  const onDeleteBookmark = (bookmark: Bookmark) => {
    if (window.confirm(x('app.deleteBookmarkConfirm', { title: bookmark.title })))
      void actions.remove(bookmark);
  };
  const editHost = (host: Host) => {
    const bookmark = bookmarkTree.bookmarks.find(
      (value) => value.hostId === host.id && value.protocol === 'ssh',
    );
    if (bookmark) editor.open(bookmark);
    else setFailed(true);
  };
  const connect = (host: Host) => {
    const bookmark = bookmarkTree.bookmarks.find(
      (value) => value.hostId === host.id && value.protocol === 'ssh',
    );
    return bookmark ? actions.connect(bookmark) : actions.connectHost(host);
  };
  const openShell = (connection: Connection) => {
    const bookmark = bookmarkTree.bookmarks.find(
      (value) =>
        value.hostId === connection.hostId &&
        value.protocol === 'ssh' &&
        value.connectionProfileId === (connection.connectionProfileId ?? null),
    );
    const host = hosts.find((value) => value.id === connection.hostId);
    return bookmark
      ? actions.connect(bookmark, undefined, connection.id)
      : host
        ? actions.connectHost(host, connection.id)
        : Promise.resolve(false);
  };
  const deleteHost = (host: Host) => {
    if (window.confirm(x('hosts.deleteConfirm', { name: host.name })))
      return actions.removeHost(host);
    return Promise.resolve(false);
  };
  const importConfig = () =>
    workspace.invokeAction('import-ssh-config').catch(() => setFailed(true));
  const setFtpEditing = (bookmark: Bookmark | null) => editor.open(bookmark ?? undefined, 'ftp');
  const setTelnetEditing = (bookmark: Bookmark | null) =>
    editor.open(bookmark ?? undefined, 'telnet');
  const setSerialEditing = (bookmark: Bookmark | null) =>
    editor.open(bookmark ?? undefined, 'serial');
  const setRdpEditing = (bookmark: Bookmark | null) => editor.open(bookmark ?? undefined, 'rdp');
  const setVncEditing = (bookmark: Bookmark | null) => editor.open(bookmark ?? undefined, 'vnc');
  const setSpiceEditing = (bookmark: Bookmark | null) =>
    editor.open(bookmark ?? undefined, 'spice');
  const setWebEditing = (bookmark: Bookmark | null) => editor.open(bookmark ?? undefined, 'web');
  const groupIds = activeGroupId ? descendantGroupIds(bookmarkTree, activeGroupId) : undefined;
  const visibleHostIds = groupIds
    ? new Set(
        bookmarkTree?.bookmarks
          .filter((bookmark) => bookmark.groupId && groupIds.has(bookmark.groupId))
          .flatMap((bookmark) => (bookmark.hostId ? [bookmark.hostId] : [])) ?? [],
      )
    : undefined;
  const visibleHosts = hosts
    .filter((host) => !visibleHostIds || visibleHostIds.has(host.id))
    .filter((host) =>
      `${host.name} ${host.hostname} ${host.username}`
        .toLowerCase()
        .includes(hostQuery.trim().toLowerCase()),
    )
    .sort(
      (left, right) =>
        Number(right.favorite) - Number(left.favorite) || left.name.localeCompare(right.name),
    );
  const visibleFtpBookmarks = (bookmarkTree?.bookmarks ?? [])
    .filter((bookmark) => bookmark.protocol === 'ftp' && bookmark.ftp)
    .filter((bookmark) => !groupIds || (!!bookmark.groupId && groupIds.has(bookmark.groupId)))
    .filter((bookmark) =>
      `${bookmark.title} ${bookmark.ftp?.hostname ?? ''} ${bookmark.ftp?.username ?? ''}`
        .toLocaleLowerCase()
        .includes(hostQuery.trim().toLocaleLowerCase()),
    );
  const visibleTelnetBookmarks = (bookmarkTree?.bookmarks ?? [])
    .filter((bookmark) => bookmark.protocol === 'telnet' && bookmark.telnet)
    .filter((bookmark) => !groupIds || (!!bookmark.groupId && groupIds.has(bookmark.groupId)))
    .filter((bookmark) =>
      `${bookmark.title} ${bookmark.telnet?.hostname ?? ''} ${bookmark.telnet?.username ?? ''}`
        .toLocaleLowerCase()
        .includes(hostQuery.trim().toLocaleLowerCase()),
    );
  const visibleSerialBookmarks = (bookmarkTree?.bookmarks ?? [])
    .filter((bookmark) => bookmark.protocol === 'serial' && bookmark.serial)
    .filter((bookmark) => !groupIds || (!!bookmark.groupId && groupIds.has(bookmark.groupId)))
    .filter((bookmark) =>
      `${bookmark.title} ${bookmark.serial?.path ?? ''} ${bookmark.serial?.baudRate ?? ''}`
        .toLocaleLowerCase()
        .includes(hostQuery.trim().toLocaleLowerCase()),
    );
  const visibleRdpBookmarks = (bookmarkTree?.bookmarks ?? [])
    .filter((bookmark) => bookmark.protocol === 'rdp' && bookmark.rdp)
    .filter((bookmark) => !groupIds || (!!bookmark.groupId && groupIds.has(bookmark.groupId)))
    .filter((bookmark) =>
      `${bookmark.title} ${bookmark.rdp?.hostname ?? ''} ${bookmark.rdp?.username ?? ''}`
        .toLocaleLowerCase()
        .includes(hostQuery.trim().toLocaleLowerCase()),
    );
  const visibleVncBookmarks = (bookmarkTree?.bookmarks ?? [])
    .filter((bookmark) => bookmark.protocol === 'vnc' && bookmark.vnc)
    .filter((bookmark) => !groupIds || (!!bookmark.groupId && groupIds.has(bookmark.groupId)))
    .filter((bookmark) =>
      `${bookmark.title} ${bookmark.vnc?.hostname ?? ''} ${bookmark.vnc?.username ?? ''}`
        .toLocaleLowerCase()
        .includes(hostQuery.trim().toLocaleLowerCase()),
    );
  const visibleSpiceBookmarks = (bookmarkTree?.bookmarks ?? [])
    .filter((bookmark) => bookmark.protocol === 'spice' && bookmark.spice)
    .filter((bookmark) => !groupIds || (!!bookmark.groupId && groupIds.has(bookmark.groupId)))
    .filter((bookmark) =>
      `${bookmark.title} ${bookmark.spice?.hostname ?? ''}`
        .toLocaleLowerCase()
        .includes(hostQuery.trim().toLocaleLowerCase()),
    );
  const visibleWebBookmarks = (bookmarkTree?.bookmarks ?? [])
    .filter((bookmark) => bookmark.protocol === 'web' && bookmark.web)
    .filter((bookmark) => !groupIds || (!!bookmark.groupId && groupIds.has(bookmark.groupId)))
    .filter((bookmark) =>
      `${bookmark.title} ${bookmark.web?.url ?? ''}`
        .toLocaleLowerCase()
        .includes(hostQuery.trim().toLocaleLowerCase()),
    );

  return (
    <section className={classes('workspace-sidebar')} data-catalog-manager>
      <button
        className={classes('bookmark-manager-back')}
        type="button"
        onClick={() => store.getSnapshot().setManagerOpen(false)}
      >
        <ChevronLeft size={13} />
        {x('app.bookmarks')}
      </button>
      {(failed || command.failed) && (
        <p role="alert">
          {x('common.operationFailed')}
          {command.uncertain && (
            <button
              disabled={command.busy}
              onClick={() => {
                void actions.retry();
              }}
            >
              {x('history.retry')}
            </button>
          )}
        </p>
      )}
      <PanelFrame
        eyebrow={x('hosts.eyebrow')}
        title={x('hosts.title')}
        description={x('hosts.description')}
        action={
          <div className={classes('toolbar host-manager-toolbar')}>
            <button disabled={busy} onClick={() => void importConfig()}>
              {x('hosts.importSshConfig')}
            </button>
            <button disabled={busy} onClick={onCreateBookmarkGroup}>
              {x('hosts.newGroup')}
            </button>
            <button disabled={busy} onClick={() => setFtpEditing(null)}>
              <FolderInput size={14} /> {x('hosts.addFtp')}
            </button>
            <button disabled={busy} onClick={() => setTelnetEditing(null)}>
              <Network size={14} /> {x('hosts.addTelnet')}
            </button>
            <button disabled={busy} onClick={() => setSerialEditing(null)}>
              <TerminalIcon size={14} /> {x('hosts.addSerial')}
            </button>
            <button disabled={busy} onClick={() => setRdpEditing(null)}>
              <Monitor size={14} /> {x('hosts.addRdp')}
            </button>
            <button disabled={busy} onClick={() => setVncEditing(null)}>
              <Monitor size={14} /> {x('hosts.addVnc')}
            </button>
            <button disabled={busy} onClick={() => setSpiceEditing(null)}>
              <Monitor size={14} /> {x('hosts.addSpice')}
            </button>
            <button disabled={busy} onClick={() => setWebEditing(null)}>
              <Globe2 size={14} /> {x('hosts.addWeb')}
            </button>
            <button disabled={busy} className={classes('primary')} onClick={() => editor.open()}>
              <Plus size={14} /> {x('hosts.addHost')}
            </button>
          </div>
        }
      >
        <div className={classes('host-filter-bar')}>
          <div className={classes('group-strip')} role="group" aria-label={x('hosts.groups')}>
            <button
              disabled={busy}
              className={classes(!activeGroupId ? 'active' : '')}
              aria-pressed={!activeGroupId}
              onClick={() => setActiveGroupId(undefined)}
            >
              {x('hosts.all')} <small>{hosts.length}</small>
            </button>
            {bookmarkTree?.groups.map((group) => (
              <button
                disabled={busy}
                className={classes(activeGroupId === group.id ? 'active' : '')}
                key={group.id}
                aria-pressed={activeGroupId === group.id}
                onClick={() => setActiveGroupId(group.id)}
              >
                {group.name}
                <small>{hostsInGroup(bookmarkTree, group.id).size}</small>
              </button>
            ))}
          </div>
          <label className={classes('host-search')}>
            <Search size={14} />
            <input
              aria-label={x('hosts.searchList')}
              placeholder={x('hosts.searchPlaceholder')}
              value={hostQuery}
              maxLength={1024}
              onChange={(event) => setHostQuery(event.target.value)}
            />
          </label>
        </div>
        <div className={classes('card-grid')}>
          {visibleHosts.map((host) => {
            const bookmark = bookmarkTree?.bookmarks.find((item) => item.hostId === host.id);
            const connection = connections.find(
              (item) =>
                item.hostId === host.id &&
                (item.connectionProfileId ?? null) === (bookmark?.connectionProfileId ?? null) &&
                item.state !== 'closed' &&
                item.state !== 'failed' &&
                item.state !== 'closing',
            );
            return (
              <article
                className={classes('host-card')}
                data-bookmark-id={bookmark?.id}
                data-bookmark-protocol="ssh"
                data-bookmark-description={bookmark?.description}
                key={host.id}
                title={bookmark?.description || undefined}
              >
                <div className={classes('card-icon')}>
                  <Server size={18} />
                </div>
                <div className={classes('card-copy')}>
                  <strong>
                    {bookmark?.color && (
                      <span
                        className={classes('bookmark-title-color')}
                        data-bookmark-color={bookmark.color}
                        style={{ color: bookmark.color }}
                        aria-hidden="true"
                      >
                        ●
                      </span>
                    )}
                    {bookmark?.title ?? host.name}
                    {host.favorite && <Star size={12} fill="currentColor" />}
                  </strong>
                  <span>
                    {host.username}@{hideAddresses ? maskHostAddress(host.hostname) : host.hostname}
                    :{host.port}
                  </span>
                  <small className={classes(`connection-state ${connection?.state ?? 'idle'}`)}>
                    <i />{' '}
                    {connection
                      ? connectionStateLabel(connection.state, x)
                      : authTypeLabel(host.authType, x)}
                  </small>
                </div>
                <div className={classes('card-actions')}>
                  <button disabled={busy} onClick={() => editHost(host)}>
                    {x('hosts.edit')}
                  </button>
                  {bookmark && (
                    <button
                      disabled={busy}
                      aria-label={x('bookmarkTree.duplicate')}
                      title={x('bookmarkTree.duplicate')}
                      onClick={() => onDuplicateBookmark(bookmark)}
                    >
                      <Copy size={13} />
                    </button>
                  )}
                  <button disabled={busy} onClick={() => void deleteHost(host)}>
                    {x('common.delete')}
                  </button>
                  {connection?.state === 'ready' ? (
                    <button
                      disabled={busy}
                      className={classes('primary connect-action')}
                      onClick={() => void openShell(connection)}
                    >
                      <TerminalIcon size={13} /> {x('hosts.openTerminal')}
                    </button>
                  ) : connection ? (
                    <button disabled>
                      <LoaderCircle className={classes('spin')} size={13} /> {connection.state}
                    </button>
                  ) : (
                    <button
                      disabled={busy}
                      className={classes('connect-action')}
                      onClick={() => void connect(host)}
                    >
                      <Play size={13} /> {x('hosts.connect')}
                    </button>
                  )}
                </div>
              </article>
            );
          })}
          {visibleFtpBookmarks.map((bookmark) => (
            <article
              className={classes('host-card')}
              data-bookmark-id={bookmark.id}
              data-bookmark-protocol={bookmark.protocol}
              data-bookmark-description={bookmark.description}
              key={bookmark.id}
              title={bookmark.description || undefined}
            >
              <div className={classes('card-icon')}>
                <FolderInput size={18} />
              </div>
              <div className={classes('card-copy')}>
                <BookmarkCardHeading bookmark={bookmark} />
                <span>
                  {bookmark.ftp!.username}@
                  {hideAddresses ? maskHostAddress(bookmark.ftp!.hostname) : bookmark.ftp!.hostname}
                  :{bookmark.ftp!.port}
                </span>
                <small className={classes('connection-state idle')}>
                  <i /> {bookmark.ftp!.security === 'plain' ? 'FTP' : 'FTPS'}
                </small>
              </div>
              <div className={classes('card-actions')}>
                <button disabled={busy} onClick={() => setFtpEditing(bookmark)}>
                  {x('hosts.edit')}
                </button>
                <button
                  disabled={busy}
                  aria-label={x('bookmarkTree.duplicate')}
                  title={x('bookmarkTree.duplicate')}
                  onClick={() => onDuplicateBookmark(bookmark)}
                >
                  <Copy size={13} />
                </button>
                <button
                  disabled={busy}
                  aria-label={x('common.delete')}
                  title={x('common.delete')}
                  onClick={() => onDeleteBookmark(bookmark)}
                >
                  <Trash2 size={13} />
                </button>
                <button
                  disabled={busy}
                  className={classes('connect-action')}
                  onClick={() => onConnectBookmark(bookmark)}
                >
                  <Play size={13} /> {x('hosts.connect')}
                </button>
              </div>
            </article>
          ))}
          {visibleTelnetBookmarks.map((bookmark) => (
            <article
              className={classes('host-card')}
              data-bookmark-id={bookmark.id}
              data-bookmark-protocol={bookmark.protocol}
              data-bookmark-description={bookmark.description}
              key={bookmark.id}
              title={bookmark.description || undefined}
            >
              <div className={classes('card-icon')}>
                <TerminalIcon size={18} />
              </div>
              <div className={classes('card-copy')}>
                <BookmarkCardHeading bookmark={bookmark} />
                <span>
                  {bookmark.telnet!.username ? `${bookmark.telnet!.username}@` : ''}
                  {hideAddresses
                    ? maskHostAddress(bookmark.telnet!.hostname)
                    : bookmark.telnet!.hostname}
                  :{bookmark.telnet!.port}
                </span>
                <small className={classes('connection-state idle')}>
                  <i /> Telnet · {bookmark.telnet!.encoding.toUpperCase()}
                </small>
              </div>
              <div className={classes('card-actions')}>
                <button disabled={busy} onClick={() => setTelnetEditing(bookmark)}>
                  {x('hosts.edit')}
                </button>
                <button
                  disabled={busy}
                  aria-label={x('bookmarkTree.duplicate')}
                  title={x('bookmarkTree.duplicate')}
                  onClick={() => onDuplicateBookmark(bookmark)}
                >
                  <Copy size={13} />
                </button>
                <button
                  disabled={busy}
                  aria-label={x('common.delete')}
                  title={x('common.delete')}
                  onClick={() => onDeleteBookmark(bookmark)}
                >
                  <Trash2 size={13} />
                </button>
                <button
                  disabled={busy}
                  className={classes('connect-action')}
                  onClick={() => onConnectBookmark(bookmark)}
                >
                  <Play size={13} /> {x('hosts.connect')}
                </button>
              </div>
            </article>
          ))}
          {visibleSerialBookmarks.map((bookmark) => (
            <article
              className={classes('host-card')}
              data-bookmark-id={bookmark.id}
              data-bookmark-protocol={bookmark.protocol}
              data-bookmark-description={bookmark.description}
              key={bookmark.id}
              title={bookmark.description || undefined}
            >
              <div className={classes('card-icon')}>
                <TerminalIcon size={18} />
              </div>
              <div className={classes('card-copy')}>
                <BookmarkCardHeading bookmark={bookmark} />
                <span>{bookmark.serial!.path}</span>
                <small className={classes('connection-state idle')}>
                  <i /> Serial · {bookmark.serial!.baudRate} · {bookmark.serial!.dataBits}
                  {bookmark.serial!.parity[0]!.toUpperCase()}
                  {bookmark.serial!.stopBits}
                </small>
              </div>
              <div className={classes('card-actions')}>
                <button disabled={busy} onClick={() => setSerialEditing(bookmark)}>
                  {x('hosts.edit')}
                </button>
                <button
                  disabled={busy}
                  aria-label={x('bookmarkTree.duplicate')}
                  title={x('bookmarkTree.duplicate')}
                  onClick={() => onDuplicateBookmark(bookmark)}
                >
                  <Copy size={13} />
                </button>
                <button
                  disabled={busy}
                  aria-label={x('common.delete')}
                  title={x('common.delete')}
                  onClick={() => onDeleteBookmark(bookmark)}
                >
                  <Trash2 size={13} />
                </button>
                <button
                  disabled={busy}
                  className={classes('connect-action')}
                  onClick={() => onConnectBookmark(bookmark)}
                >
                  <Play size={13} /> {x('hosts.open')}
                </button>
              </div>
            </article>
          ))}
          {visibleRdpBookmarks.map((bookmark) => (
            <article
              className={classes('host-card')}
              data-bookmark-id={bookmark.id}
              data-bookmark-protocol={bookmark.protocol}
              data-bookmark-description={bookmark.description}
              key={bookmark.id}
              title={bookmark.description || undefined}
            >
              <div className={classes('card-icon')}>
                <Monitor size={18} />
              </div>
              <div className={classes('card-copy')}>
                <BookmarkCardHeading bookmark={bookmark} />
                <span>
                  {bookmark.rdp!.username}@
                  {hideAddresses ? maskHostAddress(bookmark.rdp!.hostname) : bookmark.rdp!.hostname}
                  :{bookmark.rdp!.port}
                </span>
                <small className={classes('connection-state idle')}>
                  <i /> RDP · {bookmark.rdp!.desktopWidth}×{bookmark.rdp!.desktopHeight}
                  {bookmark.rdp!.domain ? ` · ${bookmark.rdp!.domain}` : ''}
                </small>
              </div>
              <div className={classes('card-actions')}>
                <button disabled={busy} onClick={() => setRdpEditing(bookmark)}>
                  {x('hosts.edit')}
                </button>
                <button
                  disabled={busy}
                  aria-label={x('bookmarkTree.duplicate')}
                  title={x('bookmarkTree.duplicate')}
                  onClick={() => onDuplicateBookmark(bookmark)}
                >
                  <Copy size={13} />
                </button>
                <button
                  disabled={busy}
                  aria-label={x('common.delete')}
                  title={x('common.delete')}
                  onClick={() => onDeleteBookmark(bookmark)}
                >
                  <Trash2 size={13} />
                </button>
                <button
                  disabled={busy}
                  className={classes('connect-action')}
                  onClick={() => onConnectBookmark(bookmark)}
                >
                  <Play size={13} /> {x('hosts.connect')}
                </button>
              </div>
            </article>
          ))}
          {visibleVncBookmarks.map((bookmark) => (
            <article
              className={classes('host-card')}
              data-bookmark-id={bookmark.id}
              data-bookmark-protocol={bookmark.protocol}
              data-bookmark-description={bookmark.description}
              key={bookmark.id}
              title={bookmark.description || undefined}
            >
              <div className={classes('card-icon')}>
                <Monitor size={18} />
              </div>
              <div className={classes('card-copy')}>
                <BookmarkCardHeading bookmark={bookmark} />
                <span>
                  {bookmark.vnc!.username ? `${bookmark.vnc!.username}@` : ''}
                  {hideAddresses ? maskHostAddress(bookmark.vnc!.hostname) : bookmark.vnc!.hostname}
                  :{bookmark.vnc!.port}
                </span>
                <small className={classes('connection-state idle')}>
                  <i />{' '}
                  {x('hosts.vncSummary', {
                    quality: bookmark.vnc!.qualityLevel,
                    compression: bookmark.vnc!.compressionLevel,
                  })}
                </small>
              </div>
              <div className={classes('card-actions')}>
                <button disabled={busy} onClick={() => setVncEditing(bookmark)}>
                  {x('hosts.edit')}
                </button>
                <button
                  disabled={busy}
                  aria-label={x('bookmarkTree.duplicate')}
                  title={x('bookmarkTree.duplicate')}
                  onClick={() => onDuplicateBookmark(bookmark)}
                >
                  <Copy size={13} />
                </button>
                <button
                  disabled={busy}
                  aria-label={x('common.delete')}
                  title={x('common.delete')}
                  onClick={() => onDeleteBookmark(bookmark)}
                >
                  <Trash2 size={13} />
                </button>
                <button
                  disabled={busy}
                  className={classes('connect-action')}
                  onClick={() => onConnectBookmark(bookmark)}
                >
                  <Play size={13} /> {x('hosts.connect')}
                </button>
              </div>
            </article>
          ))}
          {visibleSpiceBookmarks.map((bookmark) => (
            <article
              className={classes('host-card')}
              data-bookmark-id={bookmark.id}
              data-bookmark-protocol={bookmark.protocol}
              data-bookmark-description={bookmark.description}
              key={bookmark.id}
              title={bookmark.description || undefined}
            >
              <div className={classes('card-icon')}>
                <Monitor size={18} />
              </div>
              <div className={classes('card-copy')}>
                <BookmarkCardHeading bookmark={bookmark} />
                <span>
                  {hideAddresses
                    ? maskHostAddress(bookmark.spice!.hostname)
                    : bookmark.spice!.hostname}
                  :{bookmark.spice!.port}
                </span>
                <small className={classes('connection-state idle')}>
                  <i /> SPICE ·{' '}
                  {bookmark.spice!.viewOnly ? x('hosts.readOnly') : x('hosts.interactive')} ·{' '}
                  {bookmark.spice!.scaleViewport ? x('hosts.scaled') : x('hosts.originalSize')}
                </small>
              </div>
              <div className={classes('card-actions')}>
                <button disabled={busy} onClick={() => setSpiceEditing(bookmark)}>
                  {x('hosts.edit')}
                </button>
                <button
                  disabled={busy}
                  aria-label={x('bookmarkTree.duplicate')}
                  title={x('bookmarkTree.duplicate')}
                  onClick={() => onDuplicateBookmark(bookmark)}
                >
                  <Copy size={13} />
                </button>
                <button
                  disabled={busy}
                  aria-label={x('common.delete')}
                  title={x('common.delete')}
                  onClick={() => onDeleteBookmark(bookmark)}
                >
                  <Trash2 size={13} />
                </button>
                <button
                  disabled={busy}
                  className={classes('connect-action')}
                  onClick={() => onConnectBookmark(bookmark)}
                >
                  <Play size={13} /> {x('hosts.connect')}
                </button>
              </div>
            </article>
          ))}
          {visibleWebBookmarks.map((bookmark) => (
            <article
              className={classes('host-card')}
              data-bookmark-id={bookmark.id}
              data-bookmark-protocol={bookmark.protocol}
              data-bookmark-description={bookmark.description}
              key={bookmark.id}
              title={bookmark.description || undefined}
            >
              <div className={classes('card-icon')}>
                <Globe2 size={18} />
              </div>
              <div className={classes('card-copy')}>
                <BookmarkCardHeading bookmark={bookmark} />
                <span>{bookmark.web!.url}</span>
                <small className={classes('connection-state idle')}>
                  <i /> Web ·{' '}
                  {bookmark.web!.hideAddressBar
                    ? x('hosts.hiddenAddressBar')
                    : x('hosts.visibleAddressBar')}
                  {bookmark.web!.userAgent ? x('hosts.customUserAgent') : ''}
                </small>
              </div>
              <div className={classes('card-actions')}>
                <button disabled={busy} onClick={() => setWebEditing(bookmark)}>
                  {x('hosts.edit')}
                </button>
                <button
                  disabled={busy}
                  aria-label={x('bookmarkTree.duplicate')}
                  title={x('bookmarkTree.duplicate')}
                  onClick={() => onDuplicateBookmark(bookmark)}
                >
                  <Copy size={13} />
                </button>
                <button
                  disabled={busy}
                  aria-label={x('common.delete')}
                  title={x('common.delete')}
                  onClick={() => onDeleteBookmark(bookmark)}
                >
                  <Trash2 size={13} />
                </button>
                <button
                  disabled={busy}
                  className={classes('connect-action')}
                  onClick={() => onConnectBookmark(bookmark)}
                >
                  <Play size={13} /> {x('hosts.open')}
                </button>
              </div>
            </article>
          ))}
          {!visibleHosts.length &&
            !visibleFtpBookmarks.length &&
            !visibleTelnetBookmarks.length &&
            !visibleSerialBookmarks.length &&
            !visibleRdpBookmarks.length &&
            !visibleVncBookmarks.length &&
            !visibleSpiceBookmarks.length &&
            !visibleWebBookmarks.length && (
              <EmptyState
                icon={Server}
                title={hosts.length ? x('hosts.noMatches') : x('hosts.empty')}
                text={hosts.length ? x('hosts.noMatchesHint') : x('hosts.emptyHint')}
              />
            )}
        </div>
      </PanelFrame>
    </section>
  );
}
function PanelFrame({
  eyebrow,
  title,
  description,
  action,
  children,
}: {
  eyebrow: string;
  title: string;
  description: string;
  action: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className={classes('panel-page')}>
      <header className={classes('panel-heading')}>
        <div>
          <small>{eyebrow}</small>
          <h1>{title}</h1>
          <p>{description}</p>
        </div>
        {action}
      </header>
      {children}
    </div>
  );
}
function EmptyState({ title, text }: { icon: typeof Server; title: string; text: string }) {
  return (
    <div className={classes('empty-state')}>
      <Server size={20} />
      <h2>{title}</h2>
      <p>{text}</p>
    </div>
  );
}
function BookmarkCardHeading({ bookmark }: { bookmark: Bookmark }) {
  return (
    <strong>
      {bookmark.color && (
        <span
          className={classes('bookmark-title-color')}
          data-bookmark-color={bookmark.color}
          style={{ color: bookmark.color }}
          aria-hidden="true"
        >
          ●
        </span>
      )}
      {bookmark.title}
    </strong>
  );
}
function descendantGroupIds(tree: BookmarkTree | undefined, rootId: string): Set<string> {
  const result = new Set([rootId]);
  if (!tree) return result;
  let changed = true;
  while (changed) {
    changed = false;
    for (const group of tree.groups) {
      if (group.parentId && result.has(group.parentId) && !result.has(group.id)) {
        result.add(group.id);
        changed = true;
      }
    }
  }
  return result;
}
function hostsInGroup(tree: BookmarkTree | undefined, groupId: string): Set<string> {
  const groupIds = descendantGroupIds(tree, groupId);
  return new Set(
    tree?.bookmarks
      .filter((bookmark) => bookmark.groupId && groupIds.has(bookmark.groupId))
      .flatMap((bookmark) => (bookmark.hostId ? [bookmark.hostId] : [])) ?? [],
  );
}

function connectionStateLabel(state: Connection['state'], x: Translator) {
  const keys: Record<Connection['state'], Parameters<Translator>[0]> = {
    created: 'hosts.stateWaiting',
    resolving: 'hosts.stateResolving',
    connecting: 'hosts.stateConnecting',
    authenticating: 'hosts.stateAuthenticating',
    ready: 'hosts.stateReady',
    reconnecting: 'hosts.stateReconnecting',
    closing: 'hosts.stateClosing',
    closed: 'hosts.stateClosed',
    failed: 'hosts.stateFailed',
  };
  return x(keys[state]);
}
function authTypeLabel(authType: Host['authType'], x: Translator) {
  const keys: Record<Host['authType'], Parameters<Translator>[0]> = {
    password: 'hosts.authPassword',
    privateKey: 'hosts.authPrivateKey',
    keyboardInteractive: 'hosts.authInteractive',
    agent: 'hosts.authAgent',
  };
  return x(keys[authType]);
}
