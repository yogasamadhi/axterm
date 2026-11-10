import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { access, readFile, writeFile } from 'node:fs/promises';
import type { Context } from '@deepseek-ai/cordis';
import type {} from '@axterm/plugin-api/host';
import type {} from '@axterm/infra-app-boot';
import type { ProfilePnpmInvocation } from '@axterm/infra-app-boot';
import { PluginManager } from './manager.ts';
import { PackageRunner, PackageRunError } from './package-runner.ts';
export { PluginManager } from './manager.ts';
export { PackageRunError } from './package-runner.ts';
export const DEFAULT_PLUGIN_REGISTRY = 'https://registry.npmjs.org/';
export const DEFAULT_PLUGIN_FALLBACK_REGISTRIES: readonly string[] = Object.freeze([]);
export interface Config {
  registry?: string;
  /** Explicit public fallbacks, queried in order; empty by default. Private primary sources remain alone. */
  fallbackRegistries?: readonly string[];
}
export const inject = ['profileContext', 'subprocess'];
/** Bundled pnpm uses the application's runtime, including Electron RunAsNode. */
export function bundledPnpmInvocation(): ProfilePnpmInvocation {
  const manifest = createRequire(import.meta.url).resolve('pnpm');
  return {
    command: process.execPath,
    args: [join(dirname(manifest), 'bin/pnpm.mjs')],
    env: { ELECTRON_RUN_AS_NODE: '1', CI: '1' },
  };
}
/** Application owners retain this lifecycle handle; the public capability excludes shared-service shutdown. */
export async function createPluginManager(
  ctx: Context,
  config: Config = {},
  managementOnly = false,
): Promise<PluginManager> {
  const fallbacks = config.fallbackRegistries ?? DEFAULT_PLUGIN_FALLBACK_REGISTRIES;
  if (!Array.isArray(fallbacks) || fallbacks.length > 8) throw new PackageRunError('invalid-input');
  const profile = ctx.profileContext;
  if (
    managementOnly &&
    (ctx.get('runtimeIdentity') !== undefined ||
      (await readFile(join(profile.dir, 'profile-runtime.lock'), 'utf8')) !== process.pid + '\n')
  )
    throw new PackageRunError('permission');
  const workspace = join(profile.dir, 'pnpm-workspace.yaml');
  try {
    await access(workspace);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    try {
      await writeFile(
        workspace,
        'packages: []\nallowBuilds: {}\nautoInstallPeers: false\nverifyDepsBeforeRun: false\n',
        { mode: 0o600, flag: 'wx' },
      );
    } catch (failure) {
      if ((failure as NodeJS.ErrnoException).code !== 'EEXIST') throw failure;
    }
  }
  const manager = new PluginManager(
    ctx,
    profile,
    new PackageRunner(
      ctx.subprocess,
      profile.packageManager ?? bundledPnpmInvocation(),
      profile.dir,
    ),
    config.registry ?? DEFAULT_PLUGIN_REGISTRY,
    managementOnly,
    fallbacks,
  );
  ctx.provide('pluginManager', manager);
  ctx.effect(() => () => manager.close());
  ctx.inject(['desktopTaskInspection'], (scope) => {
    scope.desktopTaskInspection.register('plugins', {
      inspect: (signal) => manager.inspectTasks(signal),
      dispose: () => manager.close(),
    });
  });
  return manager;
}
export async function apply(ctx: Context, config: Config = {}): Promise<void> {
  await createPluginManager(ctx, config);
}
