import type { Context } from '@deepseek-ai/cordis';
import type { PropsLocale } from '@axterm/ui';
import type { TerminalFactsModel } from '../facts.ts';
import { TerminalProfileCommands } from './commands.ts';
import { TerminalProfilesPanel } from './panel.tsx';
import { cssText } from './profiles.module.css';
export function installTerminalProfilesUi(ctx: Context, model: TerminalFactsModel): void {
  ctx.inject(['configurationActions'], (owner) => {
    const commands = new TerminalProfileCommands(model, owner.configurationActions);
    owner.effect(() => () => commands.close());
    owner.effect(() => {
      const style = document.createElement('style');
      style.dataset.axtermOwner = '@axterm/plugin-terminals';
      style.textContent = cssText;
      document.head.append(style);
      return () => style.remove();
    });
    owner.slots.inject('settings.terminal', function* () {
      yield owner.slots.register(
        { name: 'settings.terminal', id: 'terminals.profiles', locale: 'terminals' },
        function Profiles({ t }: PropsLocale<'terminals'>) {
          return (
            <TerminalProfilesPanel
              model={model}
              commands={commands}
              configuration={owner.configurationActions}
              t={t}
            />
          );
        },
      );
    });
  });
}
