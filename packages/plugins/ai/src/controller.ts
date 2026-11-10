import type { Context } from '@deepseek-ai/cordis';
import {
  Remote,
  RemoteError,
  remoteErrorOf,
  StorageCommandError,
  TypertRemoteService,
} from '@axterm/plugin-api';
import { DomainCommands } from '@axterm/infra-storage-domain';
import { z, ZodError } from 'zod';
import * as Contract from '@axterm/plugin-api/ai';
import { AiCommands } from './adapters/commands.ts';
import { AiQueries } from './adapters/queries.ts';
import type { AiApplicationComponents, OwnedAiApplication } from './adapters/application-owner.ts';
import { AiObservation } from './observation.ts';
import { AiLogObservation } from './log-observation.ts';
import { ApplicationError } from './application/errors.ts';
declare module '@deepseek-ai/cordis' {
  interface Context {
    aiController: AiController;
  }
}
export class AiController extends TypertRemoteService {
  private readonly lifetime = new AbortController();
  private readonly commands: AiCommands;
  private readonly receipts: DomainCommands;
  private readonly queries: AiQueries;
  private readonly observation: AiObservation;
  private readonly logs: AiLogObservation;
  private closing: Promise<void> | undefined;
  constructor(
    ctx: Context,
    private readonly application: AiApplicationComponents,
    private readonly owner: OwnedAiApplication,
    profile: string,
  ) {
    super(ctx, 'aiController', { namespace: 'ai' });
    owner.onStopping(() => this.lifetime.abort());
    this.commands = new AiCommands(
      application.domain,
      application.repository,
      ctx.runtimeIdentity.generation,
      profile,
    );
    this.receipts = new DomainCommands(application.domain, 'axterm_ai_command_receipts');
    this.queries = new AiQueries(application.domain, application.repository, application.journal);
    this.observation = new AiObservation(application.domain, (selected) => {
      const baseline: { generation: string; cursor: number } & {
        -readonly [K in Contract.AiCollection]?: Contract.AiBaseline[K];
      } = { generation: ctx.runtimeIdentity.generation, cursor: application.domain.cursor() };
      for (const name of selected)
        switch (name) {
          case 'providers':
            baseline.providers = this.queries.providers();
            break;
          case 'models':
            baseline.models = this.queries.models();
            break;
          case 'conversations':
            baseline.conversations = this.queries.conversations();
            break;
          case 'runs':
            baseline.runs = this.queries.runs();
            break;
          case 'approvals':
            baseline.approvals = application.repository.pendingApprovals();
            break;
          case 'engines':
            baseline.engines = ctx.engines.list();
            break;
        }
      return baseline;
    });
    ctx.on('engines/changed', () => this.observation.invalidateEngines());
    this.logs = new AiLogObservation(application.domain, this.queries);
    owner.beforeStorageClose(async () => {
      await this.observation.dispose();
      await this.logs.dispose();
    });
    ctx.effect(() => () => this.close());
    ctx.desktopTaskInspection.register('ai', {
      inspect: (signal) => {
        signal.throwIfAborted();
        return { active: owner.activeTaskCount() > 0 };
      },
      dispose: () => this.close(),
    });
  }
  @Remote({ mode: 'stream' }) watchAi(signal: AbortSignal): AsyncIterable<Contract.AiUpdate> {
    return this.call(() => this.observation.watch(this.signal(signal)));
  }
  @Remote({ mode: 'stream' }) watchRunLog(
    id: string,
    after: number,
    signal: AbortSignal,
  ): AsyncIterable<Contract.AiLogEntry> {
    return this.call(() =>
      this.logs.watch(
        z.uuid().parse(id),
        z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).parse(after),
        this.signal(signal),
      ),
    );
  }
  @Remote getProvider(id: string): Contract.AiProvider {
    return this.call(() =>
      Contract.aiProviderSchema.parse(
        this.application.repository.getJson('ai_providers', z.uuid().parse(id)),
      ),
    );
  }
  @Remote getToolCall(id: string): Contract.AiToolCall {
    return this.call(() => this.application.repository.getToolCall(z.uuid().parse(id)));
  }
  @Remote getModel(id: string): Contract.AiModel {
    return this.call(() =>
      Contract.aiModelSchema.parse(
        this.application.repository.getJson('ai_models', z.uuid().parse(id)),
      ),
    );
  }
  @Remote getConversation(id: string): Contract.AiConversation {
    return this.call(() => this.application.repository.getAiConversation(z.uuid().parse(id)));
  }
  @Remote getRun(id: string): Contract.AiRun {
    return this.call(() => this.application.service.get(z.uuid().parse(id)));
  }
  @Remote getMessageWindow(
    id: string,
    query: Contract.AiMessageWindowQuery,
  ): Contract.AiMessageWindow {
    return this.call(() => this.queries.messageWindow(id, query));
  }
  @Remote getMessages(id: string, query: Contract.AiPageQuery): Contract.AiMessagePage {
    return this.call(() => this.queries.messages(id, query));
  }
  @Remote getTools(id: string, query: Contract.AiPageQuery): Contract.AiToolPage {
    return this.call(() => this.queries.tools(id, query));
  }
  @Remote getLog(id: string, query: Contract.AiPageQuery): Contract.AiLogPage {
    return this.call(() => this.queries.logs(id, query));
  }
  @Remote getSkills(): Contract.AiSkill[] {
    return this.call(() => this.application.service.skills());
  }
  @Remote getCatalog(): Contract.PiCatalogProvider[] {
    return this.call(() => this.application.service.catalog());
  }
  @Remote createProvider(
    key: string,
    generation: string,
    input: Contract.AiProviderInput,
  ): Contract.AiReceipt {
    return this.call(() => this.commands.createProvider(key, generation, input));
  }
  @Remote updateProvider(
    key: string,
    generation: string,
    id: string,
    input: Contract.AiProviderPatch,
    ifMatch: string | undefined,
  ): Contract.AiReceipt {
    return this.call(() => this.commands.updateProvider(key, generation, id, input, ifMatch));
  }
  @Remote deleteProvider(
    key: string,
    generation: string,
    id: string,
    ifMatch: string | undefined,
  ): Contract.AiReceipt {
    return this.call(() => this.commands.deleteProvider(key, generation, id, ifMatch));
  }
  @Remote createModel(
    key: string,
    generation: string,
    input: Contract.AiModelInput,
  ): Contract.AiReceipt {
    return this.call(() => this.commands.createModel(key, generation, input));
  }
  @Remote updateModel(
    key: string,
    generation: string,
    id: string,
    input: Contract.AiModelPatch,
    ifMatch: string | undefined,
  ): Contract.AiReceipt {
    return this.call(() => this.commands.updateModel(key, generation, id, input, ifMatch));
  }
  @Remote deleteModel(
    key: string,
    generation: string,
    id: string,
    ifMatch: string | undefined,
  ): Contract.AiReceipt {
    return this.call(() => this.commands.deleteModel(key, generation, id, ifMatch));
  }
  @Remote createConversation(
    key: string,
    generation: string,
    input: Contract.AiConversationInput,
  ): Contract.AiReceipt {
    return this.call(() => this.commands.createConversation(key, generation, input));
  }
  @Remote updateConversation(
    key: string,
    generation: string,
    id: string,
    input: Contract.AiConversationPatch,
    ifMatch: string | undefined,
  ): Contract.AiReceipt {
    return this.call(() => this.commands.updateConversation(key, generation, id, input, ifMatch));
  }
  @Remote deleteConversation(
    key: string,
    generation: string,
    id: string,
    ifMatch: string | undefined,
  ): Contract.AiReceipt {
    return this.call(() => {
      const result = this.commands.deleteConversation(key, generation, id, ifMatch);
      if (result.committed)
        for (const runId of result.cancelRunIds) this.application.service.cancel(runId);
      return { ids: result.ids, cursor: result.cursor };
    });
  }
  @Remote getRunCommandOutcome(generation: string, key: string): Contract.AiRunCommandOutcome {
    return this.call(() => {
      this.commands.assertGeneration(generation);
      return this.application.journal.outcome(key, generation);
    });
  }
  @Remote async startRun(
    key: string,
    generation: string,
    input: Contract.AiRequestInput,
    signal: AbortSignal,
  ): Promise<Contract.AiRun> {
    return this.run(async () => {
      this.commands.assertGeneration(generation);
      return this.application.service.start(
        Contract.aiRequestSchema.parse(input),
        key,
        this.signal(signal),
      );
    });
  }
  @Remote async drainRun(generation: string, id: string): Promise<void> {
    return this.run(async () => {
      this.commands.assertGeneration(generation);
      await this.application.service.drainRun(z.uuid().parse(id));
    });
  }
  @Remote cancelRun(key: string, generation: string, id: string): Contract.AiReceipt {
    return this.call(() => {
      this.commands.assertGeneration(generation);
      z.uuid().parse(id);
      const receipt = this.receipts.execute(key, 'ai.run.cancel', { id }, () => {
        this.application.service.prepareCancellation(id);
        return { ids: [id], cursor: this.application.domain.cursor() };
      });
      this.application.service.cancelCommitted(id);
      return receipt;
    });
  }
  @Remote async decideApproval(
    key: string,
    generation: string,
    id: string,
    input: { decision: 'approve_once' | 'reject'; argsHash: string },
  ): Promise<Contract.AiRun> {
    return this.run(async () => {
      this.commands.assertGeneration(generation);
      z.uuid().parse(id);
      const parsed = z
        .object({
          decision: z.enum(['approve_once', 'reject']),
          argsHash: z.string().regex(/^[a-f0-9]{64}$/),
        })
        .strict()
        .parse(input);
      return this.application.service.decideApproval(id, parsed, key);
    });
  }
  @Remote async previewContext(
    input: Contract.AiContextPreviewInput,
    signal: AbortSignal,
  ): Promise<Contract.AiContextPreview> {
    return this.run(() => this.application.service.previewContext(input, this.signal(signal)));
  }
  @Remote async testProvider(
    id: string,
    signal: AbortSignal,
  ): Promise<Contract.AiProviderTestResult> {
    return this.run(() =>
      this.application.service.testProvider(z.uuid().parse(id), this.signal(signal)),
    );
  }
  @Remote async prepareAttachment(
    grantId: string,
    signal: AbortSignal,
  ): Promise<Contract.AiAttachmentPreview> {
    return this.run(() =>
      this.application.service.prepareAttachment(
        z.string().min(1).max(256).parse(grantId),
        this.signal(signal),
      ),
    );
  }
  @Remote discardAttachment(id: string): void {
    return this.call(() => this.application.service.discardAttachment(z.uuid().parse(id)));
  }
  @Remote async getWorkspace(id: string): Promise<Contract.AiWorkspace> {
    return this.run(() => this.application.service.workspace(z.uuid().parse(id)));
  }
  close(): Promise<void> {
    this.lifetime.abort();
    return (this.closing ??= this.owner.close());
  }
  private signal(signal: AbortSignal): AbortSignal {
    return AbortSignal.any([signal, this.lifetime.signal]);
  }
  private call<T>(apply: () => T): T {
    if (this.lifetime.signal.aborted) throw this.failure('closed');
    try {
      return apply();
    } catch (error) {
      throw this.normalize(error);
    }
  }
  private async run<T>(apply: () => Promise<T>): Promise<T> {
    if (this.lifetime.signal.aborted) throw this.failure('closed');
    try {
      return await apply();
    } catch (error) {
      throw this.normalize(error);
    }
  }
  private normalize(error: unknown): RemoteError<'ai/failure'> {
    const marked = remoteErrorOf(error);
    if (marked?.code === 'ai/failure') return marked;
    let reason: Contract.AiFailureReason = 'unavailable';
    if (this.lifetime.signal.aborted) reason = 'closed';
    else if (error instanceof ZodError) reason = 'invalid';
    else if (error instanceof StorageCommandError)
      reason =
        error.code === 'conflict'
          ? 'conflict'
          : error.code === 'receipt-expired'
            ? 'expired'
            : 'invalid';
    else if (error instanceof ApplicationError) {
      const reasons: Record<string, Contract.AiFailureReason> = {
        NOT_FOUND: 'not-found',
        CONFLICT: 'conflict',
        PRECONDITION_REQUIRED: 'precondition',
        PRECONDITION_FAILED: 'precondition',
        INVALID_STATE: 'precondition',
        VALIDATION_ERROR: 'invalid',
        ENGINE_DISCOVERY_UNSUPPORTED: 'unsupported',
        CAPACITY_EXCEEDED: 'capacity',
        PAYLOAD_TOO_LARGE: 'capacity',
        REQUEST_CANCELED: 'cancelled',
        ATTACHMENT_EXPIRED: 'expired',
        APPROVAL_EXPIRED: 'expired',
        AI_POLICY_REJECTED: 'policy',
        AI_SECRET_BOUNDARY: 'policy',
      };
      reason = reasons[error.code] ?? 'unavailable';
    }
    return this.failure(reason);
  }
  private failure(reason: Contract.AiFailureReason): RemoteError<'ai/failure'> {
    return new RemoteError('ai/failure', 'The AI operation failed', { reason });
  }
}
