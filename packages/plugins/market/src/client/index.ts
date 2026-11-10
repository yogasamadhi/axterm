import type {} from '@axterm/infra-client-modules/client';
import type { Context } from '@deepseek-ai/cordis';
import remote from '@axterm/plugin-market/remote';
import { MarketModel } from './model.ts';
export const inject = ['typert', 'remote', 'connection'];
export async function apply(ctx: Context): Promise<void> {
  const unmount = await ctx.remote.$mount(remote);
  ctx.effect(() => unmount);
  await ctx.inject(['remote.market'], (scope) => {
    const model = new MarketModel(scope);
    scope.effect(() => () => model.close());
    scope.inject(['slots', 'workspaceUi', 'locale', 'pluginActions'], async (ui) => {
      const { installMarketUi } = await import('./ui.tsx');
      if (ui.fiber.uid !== null) installMarketUi(ui, model);
    });
  });
}
