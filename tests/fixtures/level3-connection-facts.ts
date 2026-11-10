import * as Catalog from '../../packages/plugins/catalog/src/index.ts';
import { Context } from '@deepseek-ai/cordis';
import { randomUUID } from 'node:crypto';
import { afterEach, vi } from 'vitest';
import Storage from '@axterm/infra-storage';
import * as Schema from '@axterm/data-schema';
import * as Relational from '@axterm/infra-storage-relational';
import * as Domains from '@axterm/infra-storage-domain';
import type { RelationalDomain, SqlValue } from '@axterm/plugin-api/storage';
import type { UpdateSettingsInput } from '@axterm/plugin-api/configuration';
import * as Configuration from '../../packages/plugins/configuration/src/index.ts';
import { CatalogStorage } from '../../packages/plugins/catalog/src/adapters/catalog-storage.ts';
import { HostRepository } from '../../packages/plugins/catalog/src/adapters/host-repository.ts';
import { KnownHosts } from '../../packages/plugins/connections/src/adapters/known-hosts.ts';
import type { ConnectionRepository } from '../../packages/plugins/connections/src/ports/repository.ts';
const live = new Set<ConnectionFactsFixture>();
afterEach(async () => {
  for (const fixture of [...live].reverse()) await fixture.close();
});
/** Test composition only: every statement enters its actual independently owned relational domain. */
export class ConnectionFactsFixture {
  private constructor(
    readonly ctx: Context,
    readonly catalog: CatalogStorage,
    readonly known: KnownHosts,
    private readonly catalogDomain: RelationalDomain,
    private readonly configurationDomain?: RelationalDomain,
  ) {}
  static async open(
    path: ':memory:' = ':memory:',
    options: { catalogOwner?: boolean } = {},
  ): Promise<ConnectionFactsFixture> {
    if (path !== ':memory:') throw Error('An in-memory owned fixture is required');
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
      await ctx.plugin(Relational, { path: ':memory:', schema: 'productSchema' });
      await ctx.plugin(Domains, { backend: 'relational' });
      let configurationDomain: RelationalDomain | undefined;
      if (options.catalogOwner) {
        const facility = ctx.storage.domain,
          open = facility.open.bind(facility);
        const opening = vi.spyOn(facility, 'open').mockImplementation(async (spec) => {
          const handle = await open(spec);
          if (spec.name === 'configuration' && 'participant' in handle)
            configurationDomain = handle as unknown as RelationalDomain;
          return handle;
        });
        try {
          await ctx.plugin(Configuration);
        } finally {
          opening.mockRestore();
        }
        if (!configurationDomain) throw Error('Configuration owner handle was not captured');
      } else await ctx.plugin(Configuration);
      const domains: RelationalDomain[] = [];
      ctx.effect(() => async () => {
        for (const domain of domains.reverse()) await domain.close();
      });
      let catalog: RelationalDomain;
      if (options.catalogOwner) {
        const facility = ctx.storage.domain,
          open = facility.open.bind(facility);
        let captured: RelationalDomain | undefined;
        const opening = vi.spyOn(facility, 'open').mockImplementation(async (spec) => {
          const handle = await open(spec);
          if (spec.name === 'catalog' && 'participant' in handle)
            captured = handle as unknown as RelationalDomain;
          return handle;
        });
        try {
          await ctx.plugin(Catalog);
        } finally {
          opening.mockRestore();
        }
        if (!captured) throw Error('Catalog owner handle was not captured');
        catalog = captured;
      } else {
        catalog = await ctx.storage.domain.open(Schema.productDomains.catalog);
        domains.push(catalog);
      }
      const connections = await ctx.storage.domain.open(Schema.productDomains.connections);
      domains.push(connections);
      const fixture = new ConnectionFactsFixture(
        ctx,
        new CatalogStorage(catalog),
        new KnownHosts(connections),
        catalog,
        configurationDomain,
      );
      live.add(fixture);
      return fixture;
    } catch (error) {
      await ctx.fiber.dispose();
      throw error;
    }
  }
  subscribeConfiguration(listener: () => void) {
    if (!this.configurationDomain) throw Error('Owned Catalog fixture required');
    return this.configurationDomain.subscribe(listener);
  }
  subscribe(listener: () => void) {
    return this.catalogDomain.subscribe(listener);
  }
  configurationEvents(after = 0) {
    if (!this.configurationDomain) throw Error('Owned Catalog fixture required');
    return this.configurationDomain.events(after);
  }
  events(after = 0) {
    return this.catalogDomain.events(after);
  }
  all<T extends object>(sql: string, ...params: SqlValue[]): T[] {
    return this.catalog.all<T>(sql, ...params);
  }
  get<T extends object>(sql: string, ...params: SqlValue[]): T | undefined {
    return this.catalog.get<T>(sql, ...params);
  }
  run(sql: string, ...params: SqlValue[]) {
    return this.catalog.run(sql, ...params);
  }
  transaction<T>(apply: () => T): T {
    return this.catalog.transaction(apply);
  }
  appendEvent(type: string, id: string, payload: unknown): number {
    return this.catalog.appendEvent(type, id, payload);
  }
  async close(): Promise<void> {
    await this.ctx.fiber.dispose();
    live.delete(this);
  }
}
/** A test driver forwards to real Catalog, Configuration and Connections owners; it stores no facts. */
export class ConnectionFacts extends HostRepository implements ConnectionRepository {
  constructor(private readonly fixture: ConnectionFactsFixture) {
    super(fixture.catalog, () => []);
  }
  getSettings() {
    return this.fixture.ctx.configuration.getSettings();
  }
  updateSettings(patch: UpdateSettingsInput, ifMatch: string | undefined) {
    this.fixture.ctx.configurationController.updateSettings(randomUUID(), patch, ifMatch);
    return this.getSettings();
  }
  getKnownHostKey(host: string, port: number) {
    return this.fixture.known.get(host, port);
  }
  saveKnownHostKey(...args: Parameters<KnownHosts['save']>) {
    return this.fixture.known.save(...args);
  }
}
/** Volatile event observation double; stream delivery itself is covered by real Profile tests. */
export class ConnectionEventObserver {
  readonly publish = vi.fn();
}
export const etagFor = (version: number): string => `"v${version}"`;

import * as TerminalFacts from '../../packages/plugins/terminals/src/facts.ts';
import type { TerminalService } from '../../packages/plugins/terminals/src/application/terminal-service.ts';
import { terminalSessionSchema } from '@axterm/plugin-api/terminals';
/** Uses the actual Host command observation and facts owner, without a client recording path. */
export async function attachOwnedTerminalHistory(
  fixture: ConnectionFactsFixture,
  terminals: TerminalService,
) {
  const ctx = fixture.ctx;
  ctx.provide('terminals', {
    addOutputObserver: terminals.addOutputObserver.bind(terminals),
    insertText: terminals.insertText.bind(terminals),
    executeCommand: terminals.executeCommand.bind(terminals),
    registerExternal: (metadata, channel, kind) =>
      terminals.registerExternal(
        terminalSessionSchema.parse({ ...metadata, id: randomUUID() }),
        channel,
        kind,
      ),
    enqueueStartupSequence: terminals.enqueueStartupSequence.bind(terminals),
    list: terminals.list.bind(terminals),
    get: terminals.get.bind(terminals),
    workingDirectory: terminals.workingDirectory.bind(terminals),
    recentOutput: terminals.recentOutput.bind(terminals),
    disconnect: terminals.disconnect.bind(terminals),
    close: terminals.close.bind(terminals),
    resourceCount: terminals.resourceCount.bind(terminals),
  });
  await ctx.plugin(TerminalFacts);
  ctx.effect(() =>
    terminals.subscribeShellCommands((terminalId, command) => {
      if (ctx.configuration.getSettings().privacy.commandHistoryEnabled)
        ctx.terminalFacts.recordHistory(randomUUID(), {
          terminalId,
          command,
          source: 'shellIntegration',
        });
    }),
  );
  return { list: () => ctx.terminalFacts.listHistory() };
}
