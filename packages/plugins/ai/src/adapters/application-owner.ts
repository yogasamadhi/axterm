import { pluginManagement } from './plugin-management.ts';
import type { Context } from '@deepseek-ai/cordis';
import type { RelationalDomain } from '@axterm/plugin-api/storage';
import { mkdir } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { z } from 'zod';
import { productDomains } from '@axterm/data-schema';
import { AiService, redact } from '../application/ai-service.ts';
import { AiWorkspaceService } from '../application/ai-workspace-service.ts';
import type { AiRealtimePort } from '../ports/realtime.ts';
import { ApplicationError } from '../application/errors.ts';
import { AiRepository } from './repository.ts';
import { AiStorage } from './storage.ts';
import { AiRunJournal } from './run-journal.ts';
import { AiFacts } from './facts.ts';
import { AiModels } from './models.ts';
import { AiHostCapabilities } from './host-capabilities.ts';
import { AiToolResources } from './tool-resources.ts';
import { OwnedWorkspaceCommands } from './workspace-command.ts';
import { AiToolService } from '../application/ai-tool-service.ts';
import { commandReviewer } from './command-review.ts';
import { AiOwnerLease } from './owner-coordination.ts';
export const aiOwnerConfigSchema = z
  .object({
    profile: z.string().min(1).max(128),
    coordinationDirectory: z.string().refine(isAbsolute),
    localHome: z.string().refine(isAbsolute),
    remoteWorkspace: z.string().refine(isAbsolute),
  })
  .strict();
export type AiOwnerConfig = z.infer<typeof aiOwnerConfigSchema>;
export interface AiApplicationComponents {
  readonly service: AiService;
  readonly repository: AiRepository;
  readonly journal: AiRunJournal;
  readonly facts: AiFacts;
  readonly tools: AiToolService;
  readonly domain: RelationalDomain;
}
/** One composition owner. Register its disposer before awaiting ready(). SQL/lease close only after actual drains. */
export class OwnedAiApplication {
  private readonly lifetime = new AbortController();
  private readonly opening: Promise<AiApplicationComponents>;
  private readonly config: AiOwnerConfig;
  private lease: AiOwnerLease | undefined;
  private domain: RelationalDomain | undefined;
  private models: AiModels | undefined;
  private host: AiHostCapabilities | undefined;
  private resources: AiToolResources | undefined;
  private commands: OwnedWorkspaceCommands | undefined;
  private components: AiApplicationComponents | undefined;
  private readonly stoppers = new Set<() => void>();
  private readonly withdrawals = new Set<() => Promise<void>>();
  private initialized = false;
  private failed = false;
  private closing: Promise<void> | undefined;
  constructor(
    private readonly ctx: Context,
    raw: AiOwnerConfig,
    private readonly realtime: AiRealtimePort,
  ) {
    this.config = aiOwnerConfigSchema.parse(raw);
    this.opening = Promise.resolve()
      .then(() => this.initialize())
      .catch((error) => {
        throw error instanceof ApplicationError
          ? error
          : new ApplicationError('CAPABILITY_UNAVAILABLE', 'AI application could not start', 503);
      });
    void this.opening.then(
      () => {
        this.initialized = true;
      },
      () => {
        this.initialized = true;
      },
    );
  }
  onStopping(stop: () => void): () => void {
    if (this.closing)
      throw new ApplicationError('CAPABILITY_UNAVAILABLE', 'AI application is closed', 503);
    if (this.stoppers.size >= 32)
      throw new ApplicationError('CAPACITY_EXCEEDED', 'AI contribution capacity reached');
    this.stoppers.add(stop);
    return () => {
      this.stoppers.delete(stop);
    };
  }
  beforeStorageClose(dispose: () => Promise<void>): () => void {
    if (this.closing)
      throw new ApplicationError('CAPABILITY_UNAVAILABLE', 'AI application is closed', 503);
    if (this.withdrawals.size >= 32)
      throw new ApplicationError('CAPACITY_EXCEEDED', 'AI contribution capacity reached');
    this.withdrawals.add(dispose);
    return () => {
      this.withdrawals.delete(dispose);
    };
  }
  ready(): Promise<AiApplicationComponents> {
    return this.closing
      ? Promise.reject(
          new ApplicationError('CAPABILITY_UNAVAILABLE', 'AI application is closed', 503),
        )
      : this.opening;
  }
  activeTaskCount(): number {
    return (
      (this.initialized ? 0 : 1) +
      (this.failed ? 1 : 0) +
      (this.components?.service.activeTaskCount() ?? 0) +
      (this.models?.resourceCount() ?? 0) +
      (this.host?.resourceCount() ?? 0) +
      (this.resources?.resourceCount() ?? 0) +
      (this.commands?.resourceCount() ?? 0)
    );
  }
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.lifetime.abort();
    for (const stop of this.stoppers)
      try {
        stop();
      } catch {
        this.failed = true;
      }
    const accepted = this.components?.service.close();
    return (this.closing = (async () => {
      await this.opening.catch(() => {});
      const serviceResults = await Promise.allSettled([accepted, this.components?.service.close()]);
      // Attempt every independent resource drain, even when one fails. Keep SQL and owner lease held on failure.
      const drained = await Promise.allSettled([
        this.models?.close(),
        this.resources?.close(),
        this.host?.close(),
        this.commands?.close(),
      ]);
      const withdrawn = await Promise.allSettled(
        [...this.withdrawals].map((dispose) => Promise.resolve().then(dispose)),
      );
      if (
        this.failed ||
        [...serviceResults, ...drained, ...withdrawn].some((result) => result.status === 'rejected')
      ) {
        this.failed = true;
        throw new ApplicationError('CAPABILITY_UNAVAILABLE', 'AI resources could not drain', 503);
      }
      try {
        await this.domain?.close();
        await this.lease?.close();
      } catch {
        this.failed = true;
        throw new ApplicationError('CAPABILITY_UNAVAILABLE', 'AI ownership could not close', 503);
      }
    })().catch((error) => {
      this.failed = true;
      throw error;
    }));
  }
  private async initialize(): Promise<AiApplicationComponents> {
    const { ctx, config } = this;
    this.lifetime.signal.throwIfAborted();
    this.lease = await AiOwnerLease.open(
      config.coordinationDirectory,
      config.profile,
      this.lifetime.signal,
    );
    this.lifetime.signal.throwIfAborted();
    this.domain = await ctx.storage.domain.open(productDomains.ai);
    this.lifetime.signal.throwIfAborted();
    const repository = new AiRepository(new AiStorage(this.domain));
    const journal = new AiRunJournal(
      this.domain,
      repository,
      { profile: config.profile, generation: ctx.runtimeIdentity.generation, pid: process.pid },
      redact,
    );
    await this.lease.recover(journal);
    this.lifetime.signal.throwIfAborted();
    await mkdir(config.remoteWorkspace, { recursive: true, mode: 0o700 });
    this.lifetime.signal.throwIfAborted();
    const models = (this.models = new AiModels(ctx));
    const host = (this.host = new AiHostCapabilities(ctx));
    const resources = (this.resources = new AiToolResources(ctx, config.localHome));
    const commands = (this.commands = new OwnedWorkspaceCommands(ctx.subprocess));
    const workspaces = new AiWorkspaceService(ctx.terminals, ctx.connections, commands, {
      localHome: config.localHome,
      remoteWorkspace: config.remoteWorkspace,
    });
    const tools = new AiToolService(resources, workspaces, pluginManagement(ctx, config.profile));
    const facts = new AiFacts(this.domain, repository, journal, ctx.runtimeIdentity.generation);
    const service = new AiService(
      repository,
      facts,
      host,
      this.realtime,
      tools,
      models,
      commandReviewer,
      workspaces,
      ctx.runtimeIdentity.generation,
    );
    this.components = { service, repository, journal, facts, tools, domain: this.domain };
    this.lifetime.signal.throwIfAborted();
    return this.components;
  }
}
