import type { PersistedTerminalTab } from '@axterm/plugin-api/configuration';
import { installNewSessionUi } from './session/menu.tsx';
import type { Bookmark } from '@axterm/plugin-api/catalog';
import { CatalogProtocolOverlay } from './editor/protocol-overlay.tsx';
import { useSyncExternalStore } from 'react';
import type { Context } from '@deepseek-ai/cordis';
import type { PropsLocale } from '@axterm/ui';
import { Server, Plus } from 'lucide-react';
import { Button } from '@axterm/ui/controls';
import type { CatalogModel } from '../index.ts';
import { CatalogI18n } from './i18n.tsx';
import { CatalogEditorOwner } from './editor/owner.ts';
import { SshBookmarkEditor } from './editor/ssh-editor.tsx';
import { CatalogTreeActions } from './tree/tree-actions.ts';
import { BookmarkTreeUiStore } from './tree/tree-ui.tsx';
import { CatalogSidebar, CatalogGroupOverlay } from './tree/sidebar.tsx';
import { dictionaries } from './locales.ts';
import { cssText as managerCss } from './manager/manager.module.css';
import { cssText as treeCss } from './tree/bookmark-tree.module.css';
import { cssText as editorCss } from './editor/editor.module.css';
export function installCatalogWorkspace(ctx: Context, model: CatalogModel): void {
  ctx.inject(
    [
      'connectionActions',
      'configurationActions',
      'connectionWorkspaceUi',
      'tunnelWorkspaceUi',
      'terminalWorkspaceUi',
      'terminalFactsView',
      'savedCredentialActions',
    ],
    (owner) => {
      const actions = new CatalogTreeActions(
        model,
        owner.connectionWorkspaceUi,
        owner.terminalWorkspaceUi,
        undefined,
        (kind, generation) => {
          if (kind === 'ssh' || kind === 'ftp') {
            const state = owner.connectionActions.getSnapshot();
            if (state.status !== 'ready' || state.baseline.generation !== generation) return false;
          }
          return (
            kind === 'ftp' ||
            owner
              .get('workspaceSessionDescriptions')
              ?.isReady(kind as PersistedTerminalTab['kind'], generation) === true
          );
        },
      );
      owner.provide('catalogStartupUi', {
        openBookmark: async (id, generation, signal) => {
          signal.throwIfAborted();
          const state = model.getSnapshot();
          if (state.status !== 'ready' || state.baseline.generation !== generation)
            throw Error('CATALOG_STARTUP_RETIRED');
          const bookmark = state.baseline.bookmarks.bookmarks.find((item) => item.id === id);
          if (!bookmark) throw Error('CATALOG_STARTUP_REFERENCE_UNAVAILABLE');
          if (!(await actions.connect(bookmark, signal))) throw Error('CATALOG_STARTUP_FAILED');
        },
      });
      owner.inject(['workspacePaletteUi'], (palette) => {
        palette.effect(() =>
          palette.workspacePaletteUi.registerSource('catalog', () => {
            const state = model.getSnapshot();
            if (state.status !== 'ready') return [];
            const generation = state.baseline.generation;
            const x = owner.locale.bind('catalog');
            return state.baseline.hosts.map((host) => ({
              id: host.id,
              label: x('palette.connectHost', { name: host.name, hostname: host.hostname }),
              aliases: [host.name, host.hostname],
              group: 'hosts' as const,
              shortcuts: [],
              execute: async () => {
                const current = model.getSnapshot();
                if (
                  current.status !== 'ready' ||
                  current.baseline.generation !== generation ||
                  !current.baseline.hosts.some(
                    (item) => item.id === host.id && item.version === host.version,
                  )
                )
                  throw Error('CATALOG_PALETTE_RETIRED');
                if (!(await actions.connectHost(host))) throw Error('CATALOG_PALETTE_UNAVAILABLE');
              },
            }));
          }),
        );
      });
      owner.inject(['webSessionWorkspaceUi'], (scope) => {
        scope.effect(() => actions.attachWebSessions(scope.webSessionWorkspaceUi));
      });
      owner.inject(['remoteDesktopWorkspaceUi'], (scope) => {
        scope.effect(() => actions.attachRemoteDesktop(scope.remoteDesktopWorkspaceUi));
      });
      owner.inject(['filesWorkspaceUi'], (scope) => {
        const off = actions.attachFiles(scope.filesWorkspaceUi);
        scope.effect(() => off);
      });
      const services = {
        catalog: model,
        terminalWorkspace: owner.terminalWorkspaceUi,
        launch: (bookmark: Bookmark, signal: AbortSignal) => actions.connect(bookmark, signal),
        connections: owner.connectionActions,
        tunnels: owner.tunnelWorkspaceUi,
        connectionWorkspace: owner.connectionWorkspaceUi,
        terminals: owner.terminalFactsView,
        workspace: owner.workspaceUi,
      };
      const editor = new CatalogEditorOwner(services, owner.savedCredentialActions);
      const store = new BookmarkTreeUiStore();
      installNewSessionUi(owner, model, editor);
      owner.effect(() => () => editor.dispose());
      owner.effect(() => () => actions.close());
      owner.effect(() => () => store.close());
      let generation: string | undefined;
      owner.effect(() =>
        model.subscribe(() => {
          editor.retireGeneration();
          const facts = model.getSnapshot();
          if (facts.status === 'ready') {
            if (generation && generation !== facts.baseline.generation)
              store.getSnapshot().setGroupDialog(undefined);
            generation = facts.baseline.generation;
          }
        }),
      );
      owner.effect(() => {
        const style = document.createElement('style');
        style.dataset.axtermOwner = '@axterm/plugin-catalog';
        style.textContent = treeCss + editorCss + managerCss;
        document.head.append(style);
        return () => style.remove();
      });
      owner.effect(() =>
        owner.workspaceUi.registerNavigation({
          id: 'hosts',
          label: {
            en: dictionaries.en['hosts.title'],
            ja: dictionaries.ja['hosts.title'],
            'zh-CN': dictionaries['zh-CN']['hosts.title'],
            'zh-TW': dictionaries['zh-TW']['hosts.title'],
          },
          icon: <Server size={18} />,
          order: 10,
        }),
      );
      owner.effect(() => owner.workspaceUi.registerAction('new-bookmark', () => editor.open()));
      owner.effect(() =>
        owner.workspaceUi.registerAction('manage-bookmarks', () =>
          store.getSnapshot().setManagerOpen(true),
        ),
      );
      owner.effect(() =>
        owner.workspaceUi.registerAction('show-bookmark-tree', () =>
          store.getSnapshot().setManagerOpen(false),
        ),
      );
      owner.effect(() =>
        owner.workspaceUi.registerAction('new-bookmark-group', () =>
          store.getSnapshot().setGroupDialog({ kind: 'create', parentId: null }),
        ),
      );
      owner.slots.inject('workspace.sidebar', function* () {
        yield owner.slots.register(
          { name: 'workspace.sidebar', key: 'hosts', locale: 'catalog' },
          function Sidebar({ t }: PropsLocale<'catalog'>) {
            return (
              <CatalogI18n translate={t}>
                <CatalogSidebar
                  model={model}
                  actions={actions}
                  store={store}
                  editor={editor}
                  workspace={owner.workspaceUi}
                  connectionActions={owner.connectionActions}
                  configuration={owner.configurationActions}
                />
              </CatalogI18n>
            );
          },
        );
      });
      owner.slots.inject('workspace.toolbar', function* () {
        yield owner.slots.register(
          { name: 'workspace.toolbar', id: 'catalog.new', locale: 'catalog', order: 30 },
          function NewBookmark({ t }: PropsLocale<'catalog'>) {
            const state = useSyncExternalStore(editor.subscribe, editor.getSnapshot);
            return (
              <Button
                disabled={!!state.session || state.busy}
                data-catalog-new-bookmark
                onClick={() => editor.open()}
              >
                <Plus size={14} />
                {t('hosts.addHost')}
              </Button>
            );
          },
        );
      });
      owner.slots.inject('workspace.overlay', function* () {
        yield owner.slots.register(
          { name: 'workspace.overlay', id: 'catalog.editor', locale: 'catalog', order: 25 },
          function EditorOverlay({ t }: PropsLocale<'catalog'>) {
            const selected = useSyncExternalStore(editor.subscribe, editor.getSnapshot);
            return (
              <CatalogI18n translate={t}>
                {selected.failed && <p role="alert">{t('common.operationFailed')}</p>}
                {selected.session?.protocol === 'ssh' && (
                  <SshBookmarkEditor
                    key={selected.session.id}
                    services={services}
                    workflow={selected.session.workflow}
                    operations={selected.session.operations}
                    {...(selected.session.host ? { host: selected.session.host } : {})}
                    {...(selected.session.bookmark ? { bookmark: selected.session.bookmark } : {})}
                    onClose={() => {
                      void editor.close();
                    }}
                    onCreateBookmarkGroup={() =>
                      store.getSnapshot().setGroupDialog({ kind: 'create', parentId: null })
                    }
                    onProtocol={(protocol) => {
                      void editor.protocol(protocol);
                    }}
                    onSaved={(receipt, action, temporary) =>
                      editor.saved(receipt, action, temporary)
                    }
                  />
                )}
                <CatalogProtocolOverlay owner={editor} />
                <CatalogGroupOverlay store={store} actions={actions} />
              </CatalogI18n>
            );
          },
        );
      });
    },
  );
}
