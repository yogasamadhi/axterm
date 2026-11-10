import { Context } from '@deepseek-ai/cordis';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, vi } from 'vitest';
import Storage from '@axterm/infra-storage';
import * as Schema from '@axterm/data-schema';
import * as Relational from '@axterm/infra-storage-relational';
import * as Domains from '@axterm/infra-storage-domain';
import { NativeFileGrantRegistry } from '@axterm/infra-desktop-native';
import type { ArchiveTransfers } from '../../packages/plugins/transfers/src/ports/archive.ts';
import { GrantedStreamingFiles } from '../../packages/plugins/files/src/adapters/streaming-files.ts';
import { OwnedTransferRepository } from '../../packages/plugins/transfers/src/adapters/transfer-repository.ts';
import { TransferService } from '../../packages/plugins/transfers/src/application/transfer-service.ts';
import { memoryTransferFiles } from '../support/level3-transfer-memory-files.ts';
const cleanups: (() => Promise<unknown> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
export async function transferFixture(initial: Record<string, string> = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'axterm-transfer-owner-'));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const registry = new NativeFileGrantRegistry(randomUUID());
  cleanups.push(() => registry.close());
  const grant = await registry.createTrustedPath(directory, 'directory', ['read', 'write']);
  const local = new GrantedStreamingFiles(() => ({
    authorize: async (id, permission, signal) => ({
      authority: await registry.authorize(id, permission, signal),
      signal: signal ?? new AbortController().signal,
      assert: () => signal?.throwIfAborted(),
      dispose: () => {},
    }),
  }));
  cleanups.push(() => local.close());
  const ctx = new Context();
  cleanups.push(() => ctx.fiber.dispose());
  await ctx.plugin(Storage);
  await ctx.plugin(Schema);
  await ctx.plugin(Relational, { path: ':memory:', schema: 'productSchema' });
  await ctx.plugin(Domains, { backend: 'relational' });
  const domain = await ctx.storage.domain.open(Schema.productDomains.transfers);
  const repository = new OwnedTransferRepository(domain, 'desktop', randomUUID());
  const remote = memoryTransferFiles(initial);
  const archive: ArchiveTransfers = {
    transfer: vi.fn(async () => {
      throw new Error('The controlled archive port was not selected');
    }),
  };
  const progress = vi.fn();
  const service = new TransferService(
    remote.connection,
    local,
    repository,
    { publish: progress },
    archive,
  );
  cleanups.push(() => service.closeAll());
  return {
    archive,
    connections: remote.connection,
    directory,
    grant,
    local,
    remote,
    repository,
    domain,
    service,
    progress,
    target: { protocol: 'sftp' as const, connectionId: randomUUID() },
  };
}
