import { Context } from '@deepseek-ai/cordis';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Storage from '@axterm/infra-storage';
import * as Relational from '@axterm/infra-storage-relational';
import * as Domains from '@axterm/infra-storage-domain';
import * as Schema from '@axterm/data-schema';
import { NativeFileGrantRegistry } from '@axterm/infra-desktop-native';
import type { FileGrants } from '@axterm/plugin-api/host';
import { GrantedStreamingFiles } from '../../packages/plugins/files/src/adapters/streaming-files.ts';
import { TerminalStageStore } from '../../packages/plugins/terminals/src/adapters/terminal-transfer/stage-store.ts';
import { PrivateTerminalStaging } from '../../packages/plugins/terminals/src/adapters/terminal-transfer/private-staging.ts';
export async function privateTerminalStagingFixture(cleanups: (() => Promise<unknown>)[]) {
  const directory = await mkdtemp(join(tmpdir(), 'axterm-terminal-stage-'));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const target = join(directory, 'target');
  await mkdir(target);
  const generation = randomUUID(),
    ctx = new Context();
  cleanups.push(() => ctx.fiber.dispose());
  await ctx.plugin(Storage);
  await ctx.plugin(Schema);
  await ctx.plugin(Relational, { path: ':memory:', schema: 'productSchema' });
  await ctx.plugin(Domains, { backend: 'relational' });
  const domain = await ctx.storage.domain.open(Schema.productDomains.terminalTransferStages);
  const registry = new NativeFileGrantRegistry(generation),
    aborts = new Map<string, Set<AbortController>>();
  const grants = {
    authorize: async (id, permission, signal) => {
      const authority = await registry.authorize(id, permission, signal),
        abort = new AbortController(),
        lifetime = AbortSignal.any([abort.signal, ...(signal ? [signal] : [])]);
      const set = aborts.get(id) ?? new Set();
      set.add(abort);
      aborts.set(id, set);
      return {
        authority,
        signal: lifetime,
        assert: () => lifetime.throwIfAborted(),
        dispose: () => {
          set.delete(abort);
          abort.abort();
        },
      };
    },
  } satisfies Pick<FileGrants, 'authorize'>;
  const files = new GrantedStreamingFiles(() => grants),
    store = new TerminalStageStore(domain, 'desktop', generation),
    base = join(directory, 'private');
  const staging = new PrivateTerminalStaging(base, files, grants as FileGrants, store);
  cleanups.push(async () => {
    await staging.close();
    await files.close();
    registry.close();
  });
  const grant = await registry.createTrustedPath(target, 'directory', ['read', 'write']);
  return {
    directory,
    target,
    generation,
    ctx,
    domain,
    registry,
    grant,
    files,
    store,
    staging,
    base,
    signal: new AbortController().signal,
    revoke(id: string) {
      for (const abort of aborts.get(id) ?? []) abort.abort();
      registry.revoke(id);
    },
  };
}
