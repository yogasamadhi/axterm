import type { Context } from '@deepseek-ai/cordis';
import type { PropsLocale } from '@axterm/ui';
import type { WidgetModel } from '../widgets.ts';
import { WidgetUiActions } from './widget-actions.ts';
import { WidgetWorkspace } from './widget-workspace.tsx';
import { WidgetTranslation } from './widget-context.tsx';
import { cssText } from './widget-styles.ts';
import dictionaries from './widget-locales.json' with { type: 'json' };
declare module '@axterm/ui' {
  interface LocaleNamespaceMap {
    widgets: keyof typeof dictionaries.en;
  }
}
export function installWidgetsUi(ctx: Context, model: WidgetModel) {
  const actions = new WidgetUiActions(ctx, model);
  ctx.effect(() => () => actions.close());
  ctx.effect(() => ctx.locale.register('widgets', dictionaries));
  ctx.effect(() => {
    const style = document.createElement('style');
    style.dataset.plugin = '@axterm/plugin-automation/widgets';
    style.textContent = cssText;
    document.head.append(style);
    return () => style.remove();
  });
  ctx.slots.inject('settings.widgets', function* () {
    yield ctx.slots.register(
      { name: 'settings.widgets', id: 'automation.widgets', locale: 'widgets' },
      function Widgets({ t }: PropsLocale<'widgets'>) {
        return (
          <WidgetTranslation.Provider value={t}>
            <WidgetWorkspace client={actions} model={model} />
          </WidgetTranslation.Provider>
        );
      },
    );
  });
}
