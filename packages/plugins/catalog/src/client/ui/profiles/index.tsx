import type { Context } from '@deepseek-ai/cordis';
import type { PropsLocale } from '@axterm/ui';
import type { CatalogModel } from '../../index.ts';
import { ConnectionProfileCommands } from './commands.ts';
import { ConnectionProfilesPanel } from './panel.tsx';
import { CatalogI18n } from '../i18n.tsx';
import styles, { cssText } from './profiles.module.css';
export function installConnectionProfilesUi(ctx: Context, model: CatalogModel): void {
  ctx.inject(['savedCredentialActions', 'fileGrantActions', 'workspaceUi'], (owner) => {
    const commands = new ConnectionProfileCommands(
      model,
      owner.savedCredentialActions,
      owner.fileGrantActions,
    );
    owner.effect(() => () => commands.close());
    owner.effect(() => {
      const style = document.createElement('style');
      style.dataset.axtermOwner = '@axterm/plugin-catalog';
      style.textContent = cssText;
      document.head.append(style);
      return () => style.remove();
    });
    owner.slots.inject('settings.profiles', function* () {
      yield owner.slots.register(
        { name: 'settings.profiles', id: 'catalog.connection-profiles', locale: 'catalog' },
        function Profiles({ t }: PropsLocale<'catalog'>) {
          return (
            <CatalogI18n translate={t}>
              <div
                className={`${styles['section-settings']} ${styles['surface-section']}`}
                style={{ display: 'contents' }}
              >
                <ConnectionProfilesPanel
                  model={model}
                  commands={commands}
                  workspace={owner.workspaceUi}
                />
              </div>
            </CatalogI18n>
          );
        },
      );
    });
  });
}
