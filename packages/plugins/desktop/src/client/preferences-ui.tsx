import type { Context } from '@deepseek-ai/cordis';
import type { PropsLocale } from '@axterm/ui';
import type { ShortcutReferenceSeat } from '@axterm/ui/shortcuts';
import type { DesktopPreferencesModel } from './preferences-model.ts';
import type { DesktopPreferenceCommands } from './preferences-commands.ts';
import { WindowPreferencesPanel } from './preferences-panel.tsx';
import { GlobalHotkey } from './global-hotkey.tsx';
import { dictionaries } from './preferences-locales.ts';
import { cssText } from './preferences-styles.ts';
export function installDesktopPreferencesUi(
  ctx: Context,
  model: DesktopPreferencesModel,
  commands: DesktopPreferenceCommands,
): void {
  ctx.inject(['slots', 'desktopWindow'], (owner) => {
    owner.effect(() => owner.locale.register('desktopPreferences', dictionaries));
    owner.effect(() => {
      const style = document.createElement('style');
      style.dataset.axtermOwner = '@axterm/plugin-desktop/preferences';
      style.textContent = cssText;
      document.head.append(style);
      return () => style.remove();
    });
    owner.slots.inject('settings.common', function* () {
      yield owner.slots.register(
        {
          name: 'settings.common',
          id: 'desktop.preferences',
          order: 30,
          locale: 'desktopPreferences',
        },
        ({ t }: PropsLocale<'desktopPreferences'>) => (
          <WindowPreferencesPanel model={model} commands={commands} x={t} />
        ),
      );
    });
    owner.slots.inject('shortcuts.footer', function* () {
      yield owner.slots.register(
        { name: 'shortcuts.footer', id: 'desktop.globalHotkey', locale: 'desktopPreferences' },
        ({ t, ...seat }: PropsLocale<'desktopPreferences'> & ShortcutReferenceSeat) => (
          <GlobalHotkey ctx={owner} model={model} commands={commands} seat={seat} x={t} />
        ),
      );
    });
  });
}
declare module '@axterm/ui' {
  interface LocaleNamespaceMap {
    desktopPreferences: keyof typeof dictionaries.en;
  }
}
