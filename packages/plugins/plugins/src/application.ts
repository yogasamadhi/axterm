import { z } from 'zod';
import { defineDomain, domainTable, type Domain } from '@axterm/plugin-api/storage';
import type { PluginManagerService } from '@axterm/plugin-api/host';
import {
  pluginCommandInputSchema,
  pluginCommandReceiptSchema,
  pluginFailureSchema,
  type PluginCommandInput,
  type PluginCommandReceipt,
  type PluginManagementSnapshot,
  type PluginFailure,
} from '@axterm/plugin-api/plugins';
export const managementDomain = defineDomain({
  owner: '@axterm/plugin-plugins',
  name: 'plugin_management',
  version: 1,
  tables: {
    commands: domainTable(
      z.object({ receipt: pluginCommandReceiptSchema, request: pluginCommandInputSchema }).strict(),
    ),
  },
});
/** Injective Profile identity; shared homes must never share management command/configuration facts. */
export function managementDomainForProfile(profile: string): typeof managementDomain {
  z.string()
    .min(1)
    .max(64)
    .regex(/^[a-zA-Z0-9_-]+$/u)
    .parse(profile);
  const suffix = [...new TextEncoder().encode(profile)]
    .map((value) => value.toString(16).padStart(2, '0'))
    .join('');
  return { ...managementDomain, name: managementDomain.name + '_' + suffix };
}
export class PluginManagementError extends Error {
  constructor(readonly reason: PluginFailure) {
    super('PLUGIN_MANAGEMENT_' + reason.toUpperCase().replaceAll('-', '_'));
  }
}
export class PluginManagement {
  private readonly lifetime = new AbortController();
  private readonly tasks = new Set<Promise<unknown>>();
  private queue: Promise<unknown> = Promise.resolve();
  private closing?: Promise<void>;
  private faulted = false;
  private inventory: NonNullable<PluginManagementSnapshot['inventory']> | undefined;
  private inventoryAt = 0;
  private inventoryRead: Promise<PluginManagementSnapshot['inventory']> | undefined;
  constructor(
    private readonly manager: PluginManagerService,
    private readonly domain: Domain<typeof managementDomain>,
    readonly generation: string,
    private readonly runtimeVersion?: string,
  ) {}
  async initialize(): Promise<void> {
    if (this.domain.table('commands').size > 10000) throw new PluginManagementError('capacity');
    for (const [id, row] of this.domain.table('commands').entries()) {
      if (row.receipt.status === 'running')
        await this.domain.table('commands').put(id, {
          ...row,
          receipt: {
            ...row.receipt,
            status: 'interrupted',
            reason: 'interrupted',
            updatedAt: new Date().toISOString(),
          },
        });
    }
  }
  outcome(id: string) {
    if (this.closing) throw new PluginManagementError('closed');
    z.uuid().parse(id);
    const row = this.domain.table('commands').get(id);
    return row
      ? { status: 'known' as const, receipt: structuredClone(row.receipt) }
      : { status: 'missing' as const };
  }
  execute(
    id: string,
    generation: string,
    input: PluginCommandInput,
  ): Promise<PluginCommandReceipt> {
    z.uuid().parse(id);
    const request = pluginCommandInputSchema.parse(input);
    if (this.closing) return Promise.reject(new PluginManagementError('closed'));
    if (this.faulted) return Promise.reject(new PluginManagementError('unavailable'));
    if (this.tasks.size >= 8) return Promise.reject(new PluginManagementError('capacity'));
    const task = this.queue.then(async () => {
      this.lifetime.signal.throwIfAborted();
      if (this.faulted) throw new PluginManagementError('unavailable');
      const previous = this.domain.table('commands').get(id);
      if (previous) {
        if (
          previous.receipt.generation !== generation ||
          JSON.stringify(previous.request) !== JSON.stringify(request)
        )
          throw new PluginManagementError('conflict');
        return structuredClone(previous.receipt);
      }
      if (generation !== this.generation) throw new PluginManagementError('stale-generation');
      if (this.domain.table('commands').size >= 10000) throw new PluginManagementError('capacity');
      const now = new Date().toISOString();
      const running: PluginCommandReceipt = {
        id,
        generation,
        operation: request.operation,
        ...(request.operation === 'build'
          ? {}
          : {
              target:
                request.operation === 'install'
                  ? request.spec
                  : request.operation === 'entry'
                    ? request.id
                    : request.operation === 'compatibility'
                      ? request.packageVersion
                      : request.name,
            }),
        status: 'running',
        createdAt: now,
        updatedAt: now,
      };
      await this.domain.table('commands').put(id, { request, receipt: running });
      const job = this.finish(request, running);
      this.tasks.add(job);
      void job.then(
        () => this.tasks.delete(job),
        () => {
          this.tasks.delete(job);
          this.faulted = true;
        },
      );
      return structuredClone(running);
    });
    this.queue = task.catch(() => {});
    this.tasks.add(task);
    void task.then(
      () => this.tasks.delete(task),
      () => this.tasks.delete(task),
    );
    return task;
  }
  async snapshot(): Promise<PluginManagementSnapshot> {
    if (this.closing) throw new PluginManagementError('closed');
    const commands = [...this.domain.table('commands').entries()]
      .map(([, row]) => structuredClone(row.receipt))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, 64);
    const identity = {
      generation: this.generation,
      ...(this.runtimeVersion ? { runtimeVersion: this.runtimeVersion } : {}),
    };
    const inventory = await this.readInventory();
    return { ...identity, inventory, commands };
  }
  private readInventory(): Promise<PluginManagementSnapshot['inventory']> {
    if (this.manager.inspectTasks(this.lifetime.signal).active) {
      this.inventory = undefined;
      return Promise.resolve(null);
    }
    if (this.inventory && performance.now() - this.inventoryAt < 250)
      return Promise.resolve(this.inventory);
    return (this.inventoryRead ??= (async () => {
      const buildRead = this.manager.pendingBuilds();
      const packages = this.manager.list(),
        entries = this.manager.entries();
      const [builds, transactions] = await Promise.all([buildRead, this.manager.transactions()]);
      if (packages.length > 512 || entries.length > 4096 || builds.length > 512)
        throw new PluginManagementError('capacity');
      if (this.manager.inspectTasks(this.lifetime.signal).active) {
        this.inventory = undefined;
        return null;
      }
      this.inventory = { packages, entries, builds, transactions };
      this.inventoryAt = performance.now();
      return this.inventory;
    })().finally(() => {
      this.inventoryRead = undefined;
    }));
  }
  active(): boolean {
    return this.faulted || this.tasks.size > 0;
  }
  close(): Promise<void> {
    return (this.closing ??= (async () => {
      this.lifetime.abort();
      await this.queue;
      await Promise.allSettled([...this.tasks]);
      await this.inventoryRead?.catch(() => {});
      await this.domain.close();
      if (this.faulted) throw new PluginManagementError('unavailable');
    })());
  }
  private async finish(request: PluginCommandInput, running: PluginCommandReceipt): Promise<void> {
    let receipt: PluginCommandReceipt;
    try {
      const result = await this.apply(request);
      receipt = { ...running, status: 'completed', result, updatedAt: new Date().toISOString() };
    } catch (error) {
      const parsed = pluginFailureSchema.safeParse((error as { reason?: unknown } | null)?.reason);
      const reason = parsed.success ? parsed.data : 'unavailable';
      let uncertain = true;
      try {
        uncertain = (await this.manager.transactions()).length > 0;
      } catch {
        // An unreadable transaction journal cannot establish a failed operation's final state.
      }
      receipt = {
        ...running,
        status: uncertain ? 'uncertain' : 'failed',
        reason,
        updatedAt: new Date().toISOString(),
      };
    }
    await this.domain.table('commands').put(running.id, { request, receipt });
  }
  private apply(input: PluginCommandInput) {
    switch (input.operation) {
      case 'install':
        return this.manager.install(input.spec, {
          enabled: input.enabled,
          ...(input.registry ? { registry: input.registry } : {}),
          replace: input.replace,
          signal: this.lifetime.signal,
        });
      case 'remove':
        return this.manager.remove(input.name, this.lifetime.signal);
      case 'bundle':
        return this.manager.setBundleEnabled(input.name, input.enabled);
      case 'entry':
        return this.manager.setPluginEnabled(input.id, input.enabled);
      case 'compatibility':
        return this.manager.allowVersion(
          input.packageVersion,
          input.runtimeVersion,
          input.enabled,
          input.acceptRisk,
        );
      case 'build':
        return this.manager.approveBuilds(input.ids, input.confirmed, this.lifetime.signal);
    }
  }
}
