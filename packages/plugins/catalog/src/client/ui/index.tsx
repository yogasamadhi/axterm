import { installEmptyCatalogUi } from './empty-workspace.tsx';
import { installConnectionProfilesUi } from './profiles/index.tsx';
import { installCatalogWorkspace } from './workspace.tsx';
import '@axterm/ui/workspace';
import type { Context } from '@deepseek-ai/cordis';
import type { PropsLocale } from '@axterm/ui';
import { useSyncExternalStore } from 'react';
import { FolderInput, Clock3 } from 'lucide-react';
import { Button } from '@axterm/ui/controls';
import type { CatalogModel } from '../index.ts';
import { CatalogImportLauncher } from './import-launcher.ts';
import { SshConfigImportDialog } from './import-dialog.tsx';
import { CatalogI18n } from './i18n.tsx';
import { dictionaries } from './locales.ts';
import { ConnectionHistorySidebar } from './history-sidebar.tsx';
import { HistoryView } from './history-view.ts';
import { HistoryActions } from './history-actions.ts';
import { cssText as historyCss } from './history.module.css';
import { cssText } from './import.module.css';
/** Catalog contributes to Slots; only the application renderer mounts a React root. */
export function installCatalogUi(ctx: Context, model: CatalogModel): void {
  installCatalogWorkspace(ctx, model);
  installConnectionProfilesUi(ctx, model);
  ctx.effect(() => ctx.locale.register('catalog', dictionaries));
  ctx.effect(() => {
    const style = document.createElement('style');
    style.dataset.axtermOwner = '@axterm/plugin-catalog';
    style.dataset.plugin = '@axterm/plugin-catalog';
    style.textContent = cssText + historyCss;
    document.head.append(style);
    return () => style.remove();
  });
  ctx.inject(['configurationActions', 'connectionWorkspaceUi'], (owner) => {
    const view = new HistoryView(model);
    const actions = new HistoryActions(
      model,
      owner.configurationActions,
      owner.connectionWorkspaceUi,
    );
    owner.effect(() => () => view.dispose());
    owner.effect(() => () => actions.dispose());
    installEmptyCatalogUi(owner, model, view, actions);
    owner.effect(() =>
      owner.workspaceUi.registerNavigation({
        id: 'history',
        label: {
          en: dictionaries.en['history.navigation'],
          ja: dictionaries.ja['history.navigation'],
          'zh-CN': dictionaries['zh-CN']['history.navigation'],
          'zh-TW': dictionaries['zh-TW']['history.navigation'],
        },
        icon: <Clock3 size={18} />,
        order: 15,
      }),
    );
    owner.slots.inject('workspace.sidebar', function* () {
      yield owner.slots.register(
        { name: 'workspace.sidebar', key: 'history', locale: 'catalog' },
        function HistorySidebar({ t }: PropsLocale<'catalog'>) {
          return (
            <CatalogI18n translate={t}>
              <ConnectionHistorySidebar
                model={model}
                settings={owner.configurationActions}
                view={view}
                actions={actions}
              />
            </CatalogI18n>
          );
        },
      );
    });
  });
  const launcher = new CatalogImportLauncher(model, ctx.fileGrantActions);
  ctx.effect(() => () => launcher.dispose());
  ctx.effect(() => model.subscribe(() => launcher.retireGeneration()));
  ctx.effect(() => ctx.workspaceUi.registerAction('import-ssh-config', () => launcher.open()));
  ctx.slots.inject('workspace.toolbar', function* () {
    yield ctx.slots.register(
      { name: 'workspace.toolbar', id: 'catalog.import', locale: 'catalog', order: 35 },
      function ImportButton({ t }: PropsLocale<'catalog'>) {
        const view = useSyncExternalStore(launcher.subscribe, launcher.getSnapshot);
        return (
          <>
            <Button
              data-catalog-import-trigger
              onDragOver={(event) => {
                event.preventDefault();
              }}
              onDrop={(event) => {
                event.preventDefault();
                const file = event.dataTransfer.files[0];
                if (file) void launcher.open(file);
              }}
              disabled={view.busy || !!view.actions}
              onClick={() => {
                void launcher.open();
              }}
            >
              <FolderInput size={14} />
              {t('sshConfigImport.load')}
            </Button>
            {view.failed && <span role="alert">{t('common.operationFailed')}</span>}
          </>
        );
      },
    );
  });
  ctx.slots.inject('workspace.overlay', function* () {
    yield ctx.slots.register(
      { name: 'workspace.overlay', id: 'catalog.import', locale: 'catalog', order: 30 },
      function ImportOverlay({ t }: PropsLocale<'catalog'>) {
        const view = useSyncExternalStore(launcher.subscribe, launcher.getSnapshot);
        const facts = useSyncExternalStore(model.subscribe, model.getSnapshot);
        if (!view.actions || !view.root || facts.status !== 'ready') return null;
        return (
          <CatalogI18n translate={t}>
            <SshConfigImportDialog
              key={view.root.grantId}
              client={view.actions}
              rootGrant={view.root}
              groupId={null}
              bookmarkTree={facts.baseline.bookmarks}
              onClose={() => {
                void launcher.close();
              }}

              onTreeStale={() => model.retry()}
            />
          </CatalogI18n>
        );
      },
    );
  });
}
