import managerStyles from '../manager/manager.module.css';
import { CatalogManager, type CatalogManagerProps } from '../manager/panel.tsx';
import { useState, useSyncExternalStore } from 'react';
import type { CatalogModel } from '../../index.ts';
import type { CatalogTreeActions } from './tree-actions.ts';
import type { CatalogEditorOwner } from '../editor/owner.ts';
import type { WorkspaceUi } from '@axterm/ui/workspace';
import { BookmarkTree } from './bookmark-tree-panel.tsx';
import treeStyles from './bookmark-tree.module.css';
import { BookmarkGroupDialog } from './bookmark-group-dialog.tsx';
import { BookmarkTreeUi, type BookmarkTreeUiStore } from './tree-ui.tsx';
import { useI18n } from '../i18n.tsx';
export function CatalogSidebar({
  model,
  actions,
  store,
  editor,
  workspace,
  connectionActions,
  configuration,
}: {
  model: CatalogModel;
  actions: CatalogTreeActions;
  store: BookmarkTreeUiStore;
  editor: CatalogEditorOwner;
  workspace: WorkspaceUi;
  connectionActions: CatalogManagerProps['connectionActions'];
  configuration: CatalogManagerProps['configuration'];
}) {
  const { x } = useI18n();
  const facts = useSyncExternalStore(model.subscribe, model.getSnapshot),
    command = useSyncExternalStore(actions.subscribe, actions.getSnapshot);
  const ui = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const setDialog = ui.setGroupDialog;
  const [failed, setFailed] = useState(false);
  if (facts.status !== 'ready')
    return (
      <p role="status">
        {x('history.loading')}{' '}
        <button onClick={() => void model.retry().catch(() => setFailed(true))}>
          {x('common.retry')}
        </button>
      </p>
    );
  const tree = facts.baseline.bookmarks;
  return (
    <>
      <div className={treeStyles['bookmark-sidebar-tree']} hidden={ui.managerOpen}>
        <div data-catalog-explorer-title className={managerStyles.explorerTitle}>
          <span>{x('app.bookmarks')}</span>
          <button type="button" data-catalog-manager-open onClick={() => ui.setManagerOpen(true)}>
            {x('shell.manage')}
          </button>
        </div>
        <BookmarkTreeUi store={store}>
          <BookmarkTree
            tree={tree}
            busy={command.busy || command.uncertain}
            onConnect={(value) => {
              void actions.connect(value);
            }}
            onEdit={(value) => editor.open(value)}
            onDuplicate={(value) => {
              void actions.duplicate(value, x('app.copyNoun'));
            }}
            onDelete={(value) => {
              if (window.confirm(x('app.deleteBookmarkConfirm', { title: value.title })))
                void actions.remove(value);
            }}
            onCreateGroup={(parentId) => setDialog({ kind: 'create', parentId })}
            onRenameGroup={(id) => {
              const group = tree.groups.find((value) => value.id === id);
              if (group)
                setDialog({
                  kind: 'rename',
                  id,
                  initialValue: {
                    name: group.name,
                    color: group.color,
                    description: group.description,
                  },
                });
            }}
            onDeleteGroup={(id) => {
              const group = tree.groups.find((value) => value.id === id);
              if (group && window.confirm(x('app.deleteGroupConfirm', { name: group.name })))
                void actions.deleteGroup(id);
            }}
            onMove={(source, target, position) => {
              void actions.move(source, target, position);
            }}
            onImportSshConfig={() => {
              void workspace.invokeAction('import-ssh-config').catch(() => setFailed(true));
            }}
          />
        </BookmarkTreeUi>
      </div>
      <div hidden={!ui.managerOpen}>
        <CatalogManager
          model={model}
          actions={actions}
          store={store}
          editor={editor}
          workspace={workspace}
          connectionActions={connectionActions}
          configuration={configuration}
        />
      </div>
      {(command.failed || failed) && (
        <p role="alert">
          {x('common.operationFailed')}
          {command.uncertain && (
            <button disabled={command.busy} onClick={() => void actions.retry()}>
              {x('history.retryPending')}
            </button>
          )}
        </p>
      )}
    </>
  );
}
export function CatalogGroupOverlay({
  store,
  actions,
}: {
  store: BookmarkTreeUiStore;
  actions: CatalogTreeActions;
}) {
  const { x } = useI18n();
  const ui = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const command = useSyncExternalStore(actions.subscribe, actions.getSnapshot);
  const dialog = ui.groupDialog;
  if (!dialog) return null;
  return (
    <BookmarkGroupDialog
      pending={{ uncertain: command.uncertain, retry: () => actions.retry() }}
      key={dialog.kind === 'rename' ? dialog.id : (dialog.parentId ?? 'root')}
      title={x(
        dialog.kind === 'rename'
          ? 'app.renameGroup'
          : dialog.parentId
            ? 'app.newChildGroup'
            : 'app.newGroup',
      )}
      submitLabel={x(dialog.kind === 'rename' ? 'app.save' : 'app.create')}
      {...(dialog.kind === 'rename' ? { initialValue: dialog.initialValue } : {})}
      onClose={() => ui.setGroupDialog(undefined)}
      onSubmit={(value) =>
        dialog.kind === 'rename'
          ? actions.updateGroup(dialog.id, value)
          : actions.createGroup(dialog.parentId, value)
      }
    />
  );
}
