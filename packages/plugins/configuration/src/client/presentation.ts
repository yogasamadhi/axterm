import type { Context } from '@deepseek-ai/cordis';
import type { PresentationPreferencePort } from '@axterm/ui/presentation';
import { updateSettingsSchema } from '@axterm/plugin-api/configuration';
import type { SettingsModel } from './index.ts';
/** Presentation receives accepted facts; only Configuration issues durable commands. */
export function installPresentationPreferences(ctx: Context, model: SettingsModel): void {
  function port(field: 'language' | 'theme'): PresentationPreferencePort<string> {
    return {
      getSnapshot: () => {
        const state = model.getSnapshot();
        return state.status === 'ready'
          ? { available: true, value: state.baseline.settings.appearance[field] }
          : { available: false, value: undefined };
      },
      subscribe: model.subscribe,
      write: async (value) => {
        const input = updateSettingsSchema.parse({ appearance: { [field]: value } });
        await model.writeObservedSettings(input);
      },
    };
  }
  ctx.inject(['locale'], (scope) => {
    scope.effect(() => scope.locale.attachPreference(port('language')));
  });
  ctx.inject(['theme'], (scope) => {
    scope.effect(() => scope.theme.attachPreference(port('theme')));
  });
}
