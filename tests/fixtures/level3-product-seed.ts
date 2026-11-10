import { Context } from '@deepseek-ai/cordis';
import { randomUUID } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, relative, isAbsolute, sep } from 'node:path';
import Storage from '@axterm/infra-storage';
import * as Schema from '@axterm/data-schema';
import * as Relational from '@axterm/infra-storage-relational';
import * as Domains from '@axterm/infra-storage-domain';
import * as Configuration from '@axterm/plugin-configuration';
import * as TerminalFacts from '../../packages/plugins/terminals/src/facts.ts';
import type { RelationalDomain } from '@axterm/plugin-api/storage';

/** Isolated test storage only: real owned facets, no HTTP/PTy, never a user home. */
export async function withLevel3StorageSeed<T>(
  home: string,
  seed: (ctx: Context) => T | Promise<T>,
): Promise<T> {
  const [directory, temporary] = await Promise.all([realpath(home), realpath(tmpdir())]);
  const suffix = relative(temporary, directory);
  if (!suffix || isAbsolute(suffix) || suffix === '..' || suffix.startsWith(`..${sep}`))
    throw Error('Product seed requires an isolated temporary descendant');
  const ctx = new Context();
  try {
    ctx.provide('runtimeIdentity', {
      runtimeId: randomUUID(),
      generation: randomUUID(),
      startedAt: new Date().toISOString(),
      pid: process.pid,
      mode: 'headless',
      appVersion: '0.10.0',
    });
    await ctx.plugin(Storage);
    await ctx.plugin(Schema);
    await ctx.plugin(Relational, {
      path: resolve(directory, 'data-v2/axterm.sqlite'),
      schema: 'productSchema',
    });
    await ctx.plugin(Domains, { backend: 'relational' });
    return await seed(ctx);
  } finally {
    await ctx.fiber.dispose();
  }
}

/** Prepare ordinary product input before launching the private test app. */
export async function withLevel3ProductSeed<T>(
  home: string,
  seed: (ctx: Context) => T | Promise<T>,
): Promise<T> {
  return withLevel3StorageSeed(home, async (ctx) => {
    await ctx.plugin(Configuration);
    await ctx.plugin(TerminalFacts);
    return seed(ctx);
  });
}

/** Fixed Catalog fixture input; production consumers continue through Catalog commands. */
export async function withLevel3CatalogSeed<T>(
  home: string,
  seed: (domain: RelationalDomain) => T | Promise<T>,
): Promise<T> {
  return withLevel3ProductSeed(home, async (ctx) => {
    const domain = await ctx.storage.domain.open(Schema.productDomains.catalog);
    try {
      return await seed(domain);
    } finally {
      await domain.close();
    }
  });
}
