import type { Context } from '@deepseek-ai/cordis';
import type {} from '@axterm/plugin-api/host';
import type {} from '@axterm/infra-cmdline';
export const inject = ['runtimeIdentity', 'cmdlineArgs', 'appReady', 'appExit'];
/** Finite offline inspection. Engine-owned task execution joins this entry during M5. */
export function apply(ctx: Context): void {
  const args = ctx.cmdlineArgs!.get();
  if (
    args.length > 1 ||
    (args[0] !== undefined && !['--help', '--health', '--version'].includes(args[0]))
  )
    throw new Error('HEADLESS_ARGUMENTS_UNSUPPORTED');
  const output =
    args[0] === '--health'
      ? JSON.stringify({
          status: 'ok',
          generation: ctx.runtimeIdentity.generation,
          mode: 'headless',
        })
      : args[0] === '--version'
        ? ctx.runtimeIdentity.appVersion
        : 'Usage: axterm --profile headless --health | --version | --help';
  ctx.provide('headlessCommand', true);
  ctx.effect(
    () =>
      ctx.appReady!.onReady(() => {
        queueMicrotask(() => {
          process.stdout.write(`${output}\n`);
          ctx.appExit!(0);
        });
      }),
    'headless: finite command',
  );
}
