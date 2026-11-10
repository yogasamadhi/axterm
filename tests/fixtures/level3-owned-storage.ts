import { Context } from '@deepseek-ai/cordis';
import { realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, relative, isAbsolute, sep } from 'node:path';
import { afterEach } from 'vitest';
import Storage from '@axterm/infra-storage';
import * as Schema from '@axterm/data-schema';
import * as Relational from '@axterm/infra-storage-relational';
import * as Domains from '@axterm/infra-storage-domain';
import type { RelationalDomainSpec } from '@axterm/plugin-api/storage';
const live = new Set<() => Promise<void>>();
afterEach(async () => {
  for (const close of [...live].reverse()) await close();
});
/** Infrastructure-only test composition. SQL is available only from each actual declared domain. */
export async function ownedStorage(path = ':memory:') {
  await assertTemporaryStoragePath(path);
  const ctx = new Context();
  try {
    await ctx.plugin(Storage);
    await ctx.plugin(Schema);
    await ctx.plugin(Relational, { path, schema: 'productSchema' });
    await ctx.plugin(Domains, { backend: 'relational' });
    const close = async () => {
      await ctx.fiber.dispose();
      live.delete(close);
    };
    live.add(close);
    return {
      ctx,
      close,
      async open(spec: RelationalDomainSpec) {
        const domain = await ctx.storage.domain.open(spec);
        ctx.effect(() => () => domain.close());
        return domain;
      },
    };
  } catch (error) {
    await ctx.fiber.dispose();
    throw error;
  }
}

export async function assertTemporaryStoragePath(path: string): Promise<void> {
  if (path !== ':memory:') {
    const [parent, temporary] = await Promise.all([realpath(dirname(path)), realpath(tmpdir())]);
    const suffix = relative(temporary, parent);
    if (!suffix || isAbsolute(suffix) || suffix === '..' || suffix.startsWith(`..${sep}`))
      throw Error('A private temporary storage fixture is required');
  }
}
