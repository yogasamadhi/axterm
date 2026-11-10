import type { ClientFactsState } from '@axterm/plugin-api/types';
import type { PluginManagementSnapshot, PluginCommandInput } from '@axterm/plugin-api/plugins';
import type {} from '@axterm/infra-client-modules/client';
import type { Context } from '@deepseek-ai/cordis';
import remote from '@axterm/plugin-plugins/remote';
import { PluginsModel } from './model.ts';
export const inject = ['typert', 'remote', 'connection'];
export async function apply(ctx: Context): Promise<void> {
  const unmount = await ctx.remote.$mount(remote);
  ctx.effect(() => unmount);
  await ctx.inject(['remote.plugins'], (scope) => {
    const model = new PluginsModel(scope);
    let previous: ReturnType<typeof model.getSnapshot> | undefined;
    let cached: ClientFactsState<PluginManagementSnapshot> = { status: 'connecting' };
    scope.provide(
      'pluginActions',
      Object.freeze({
        getSnapshot: () => {
          const state = model.getSnapshot();
          if (state !== previous) {
            previous = state;
            cached =
              state.status === 'ready'
                ? { status: 'ready', baseline: state.snapshot }
                : state.status === 'error'
                  ? { status: 'error', message: 'Plugin management is unavailable' }
                  : { status: 'connecting' };
          }
          return cached;
        },
        subscribe: model.subscribe,
        retry: () => model.retry(),
        execute: (input: PluginCommandInput, signal?: AbortSignal) => model.execute(input, signal),
      }),
    );
    scope.effect(() => () => model.close());
    scope.inject(['slots', 'workspaceUi', 'locale', 'modules'], async (ui) => {
      const { installPluginsUi } = await import('./ui.tsx');
      if (ui.fiber.uid !== null) installPluginsUi(ui, model);
    });
  });
}
