import type { Context } from '@deepseek-ai/cordis';
import type { StorageBootstrapPlan } from '@axterm/plugin-api/host';
import { storageBackendServiceKey } from '@axterm/plugin-api';
import type {} from '@axterm/plugin-api/host';
import z from '@deepseek-ai/schemastery';
import { RelationalStorageBackend } from './backend.ts';
export { RelationalStorageBackend } from './backend.ts';
export const name = 'storage-relational';
export const inject = ['storage'];
export interface Config {
  readonly path: string;
  readonly schema?: string;
}
export const Config: z<Config> = z.object({ path: z.string().required(), schema: z.string() });
export async function apply(ctx: Context, config: Config): Promise<void> {
  const mount = async (scope: Context) => {
    const plan =
      config.schema === undefined ? undefined : (scope.get(config.schema) as StorageBootstrapPlan);
    const backend = new RelationalStorageBackend(config.path, plan);
    scope.effect(() => () => backend.close(), 'storage-relational.close');
    await backend.initialize();
    scope.storage.backend.register('relational', backend);
    scope.provide(storageBackendServiceKey('relational'), backend);
  };
  if (config.schema === undefined) await mount(ctx);
  else await ctx.inject([config.schema], mount);
}
