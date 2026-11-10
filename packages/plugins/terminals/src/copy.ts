import { TerminalThemeService } from './application/terminal-theme-service.ts';
import { TerminalThemeRepository } from './adapters/terminal-theme-repository.ts';
import { NamedTerminalFacts } from './adapters/named-facts.ts';
import { TerminalFactsStorage } from './adapters/facts-storage.ts';
import type { Context } from '@deepseek-ai/cordis';
import { productDomains, copiedReferences, type CopiedReferences } from '@axterm/data-schema';
import type {} from '@axterm/infra-storage-domain';
import { constants } from 'node:fs';
import { lstat, open, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { StoredTerminalAssets } from './adapters/background-assets.ts';
import { backgroundFormat } from './application/background-assets.ts';
/** Import copied, inert image files into the existing Terminal asset owner while retaining their IDs. */
export async function migrateCopiedData(
  ctx: Context,
  directory?: string,
): Promise<
  CopiedReferences & { readonly assets: readonly string[]; readonly themes: readonly string[] }
> {
  const facts = await ctx.storage.domain.open(productDomains.terminals);
  try {
    const references = copiedReferences(facts, ['terminal_profiles', 'terminal_themes']);
    const domain = await ctx.storage.domain.open(productDomains.terminalAssets);
    try {
      const store = new StoredTerminalAssets(domain, (operation) => domain.transaction(operation));
      const assets: string[] = [];
      if (directory) {
        const entries = await readdir(directory, { withFileTypes: true });
        if (entries.length > 256) throw Error('DATA_COPY_ASSET_CAPACITY');
        for (const entry of entries) {
          const match =
            /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.(png|jpg|gif|webp)$/i.exec(
              entry.name,
            );
          if (!match || !entry.isFile()) throw Error('DATA_COPY_ASSET_INVALID');
          if (assets.includes(match[1]!)) throw Error('DATA_COPY_ASSET_DUPLICATE');
          const path = join(directory, entry.name),
            before = await lstat(path);
          if (!before.isFile() || before.size < 1 || before.size > 16 * 1024 * 1024)
            throw Error('DATA_COPY_ASSET_INVALID');
          const input = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
          const chunks: Uint8Array[] = [],
            hash = createHash('sha256');
          let bytes = 0;
          try {
            const actual = await input.stat();
            if (actual.dev !== before.dev || actual.ino !== before.ino)
              throw Error('DATA_COPY_ASSET_CHANGED');
            for (;;) {
              const buffer = Buffer.alloc(64 * 1024),
                result = await input.read(buffer, 0, buffer.length, null);
              if (!result.bytesRead) break;
              bytes += result.bytesRead;
              if (bytes > before.size) throw Error('DATA_COPY_ASSET_CHANGED');
              const chunk = buffer.subarray(0, result.bytesRead);
              chunks.push(chunk);
              hash.update(chunk);
            }
            const after = await input.stat();
            if (
              bytes !== before.size ||
              after.mtimeMs !== before.mtimeMs ||
              after.size !== before.size
            )
              throw Error('DATA_COPY_ASSET_CHANGED');
          } finally {
            await input.close();
          }
          const mimeType = backgroundFormat(chunks[0] ?? new Uint8Array());
          if (!mimeType) throw Error('DATA_COPY_ASSET_INVALID');
          const key = randomUUID();
          store.commitImport(
            key,
            { grantId: key, generation: 'home-copy' },
            {
              id: match[1]!,
              mimeType,
              bytes,
              sha256: hash.digest('hex'),
              version: 1,
              createdAt: new Date().toISOString(),
            },
            chunks,
          );
          assets.push(match[1]!);
        }
      }
      return {
        ...references,
        assets: Object.freeze(assets),
        themes: new TerminalThemeService(
          new TerminalThemeRepository(new NamedTerminalFacts(new TerminalFactsStorage(facts))),
        )
          .list()
          .map((theme) => theme.id),
      };
    } finally {
      await domain.close();
    }
  } finally {
    await facts.close();
  }
}
