import { Remote, RemoteError, TypertRemoteService } from '@axterm/plugin-api';
import type {} from '@axterm/plugin-api/host';
import type { Context } from '@deepseek-ai/cordis';
import { z } from 'zod';
import type {
  PluginInspection,
  PluginCommandInput,
  PluginCommandReceipt,
  PluginCommandOutcome,
  PluginManagementUpdate,
} from '@axterm/plugin-api/plugins';
import { pluginFailureSchema } from '@axterm/plugin-api/plugins';
import {
  managementDomainForProfile,
  PluginManagement,
  PluginManagementError,
} from './application.ts';
import { PluginObservation } from './observation.ts';
export const inject = ['pluginManager', 'storage', 'storageDomain', 'runtimeIdentity'];
export class PluginsController extends TypertRemoteService {
  private readonly observations: PluginObservation;
  private closing?: Promise<void>;
  constructor(
    ctx: Context,
    private readonly app: PluginManagement,
  ) {
    super(ctx, 'pluginsController', { namespace: 'plugins' });
    this.observations = new PluginObservation(() => app.snapshot());
    ctx.effect(() => () => this.close());
  }
  @Remote({ mode: 'stream' }) watchPlugins(
    signal: AbortSignal,
  ): AsyncIterable<PluginManagementUpdate> {
    return this.observations.watch(signal);
  }
  @Remote executePluginCommand(
    id: string,
    generation: string,
    input: PluginCommandInput,
    signal: AbortSignal,
  ): Promise<PluginCommandReceipt> {
    signal.throwIfAborted();
    return this.call(() => this.app.execute(id, generation, input));
  }
  @Remote getPluginCommandOutcome(id: string, signal: AbortSignal): PluginCommandOutcome {
    signal.throwIfAborted();
    if (this.closing) throw this.failure(new PluginManagementError('closed'));
    try {
      return this.app.outcome(id);
    } catch (error) {
      throw this.failure(error);
    }
  }
  @Remote inspectPlugin(spec: string, signal: AbortSignal): Promise<PluginInspection> {
    return this.inspect(spec, undefined, signal);
  }
  @Remote inspectPluginAtRegistry(
    spec: string,
    registry: string,
    signal: AbortSignal,
  ): Promise<PluginInspection> {
    return this.inspect(spec, registry, signal);
  }
  private inspect(
    spec: string,
    registry: string | undefined,
    signal: AbortSignal,
  ): Promise<PluginInspection> {
    return this.call(() => {
      if (
        !/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*(?:@[a-zA-Z0-9.*^~+<>=|_-]+)?$/u.test(
          spec,
        ) ||
        spec.length > 512
      )
        throw new PluginManagementError('invalid-input');
      return this.ctx.pluginManager.inspect(spec, signal, registry);
    });
  }
  close(): Promise<void> {
    return (this.closing ??= (async () => {
      const closing = this.app.close();
      void closing.catch(() => {});
      const results = await Promise.allSettled([this.observations.close(), closing]);
      const failure = results.find((result) => result.status === 'rejected');
      if (failure?.status === 'rejected') throw failure.reason;
    })());
  }
  private async call<T>(operation: () => T | Promise<T>): Promise<T> {
    if (this.closing) throw this.failure(new PluginManagementError('closed'));
    try {
      return await operation();
    } catch (error) {
      throw this.failure(error);
    }
  }
  private failure(error: unknown) {
    const parsed = pluginFailureSchema.safeParse((error as { reason?: unknown } | null)?.reason);
    return new RemoteError('plugins/failure', 'Plugin management is unavailable', {
      reason: parsed.success
        ? parsed.data
        : error instanceof z.ZodError
          ? 'invalid-input'
          : 'unavailable',
    });
  }
}
export async function apply(ctx: Context): Promise<void> {
  const profileName = ctx.runtimeIdentity.profileName;
  if (!profileName) throw new Error('PROFILE_IDENTITY_REQUIRED');
  const domain = await ctx.storage.domain.open(managementDomainForProfile(profileName));
  const app = new PluginManagement(
    ctx.pluginManager,
    domain,
    ctx.runtimeIdentity.generation,
    ctx.runtimeIdentity.appVersion,
  );
  try {
    await app.initialize();
    const controller = new PluginsController(ctx, app);
    ctx.provide(
      'pluginCommands',
      Object.freeze({
        generation: ctx.runtimeIdentity.generation,
        snapshot: () => app.snapshot(),
        inspect: (spec: string, signal?: AbortSignal, registry?: string) =>
          registry === undefined
            ? controller.inspectPlugin(spec, signal ?? AbortSignal.any([]))
            : controller.inspectPluginAtRegistry(spec, registry, signal ?? AbortSignal.any([])),
        execute: (id: string, generation: string, input: PluginCommandInput) =>
          app.execute(id, generation, input),
        outcome: (id: string) => app.outcome(id),
      }),
    );
    ctx.inject(['desktopTaskInspection'], (scope) => {
      scope.desktopTaskInspection.register('plugins.commands', {
        inspect(signal) {
          signal.throwIfAborted();
          return { active: app.active() };
        },
        dispose: () => controller.close(),
      });
    });
  } catch (error) {
    await app.close();
    throw error;
  }
}
