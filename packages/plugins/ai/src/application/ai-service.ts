import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { parseAiThemeDraft } from './theme-draft.ts';
import { buildAiModelContext, redact } from './ai-context.ts';
export { redact } from './ai-context.ts';
import {
  aiContextPreviewRequestSchema,
  aiRequestSchema,
  aiRunEventSchema,
  aiToolCallSchema,
  type AiContextPreview,
  type AiContextPreviewInput,
  aiBookmarkDraftSchema,
  type AiAttachmentMetadata,
  type AiAttachmentPreview,
  type AiConversationInput,
  type AiConversationPatch,
  type AiModel,
  type AiProvider,
  type AiProviderTestResult,
  type AiRun,
  type AiRunEvent,
  type AiToolCall,
  type AiWorkspace,
} from '@axterm/plugin-api/ai';
import type { AiHostPort } from '../ports/host.ts';
import type { AiModelsPort, AiModelProvider } from '../ports/models.ts';
import type { AiCommandReviewer } from '../ports/review.ts';

import type { AiRepositoryPort } from '../ports/repository.ts';
import { stableHash } from './hash.ts';
import type { AiRealtimePort } from '../ports/realtime.ts';
import type { AiToolsPort } from '../ports/tools.ts';
import type { AiFactsPort } from '../ports/facts.ts';
import { VisibleOutput } from './visible-output.ts';
import type { AiWorkspaceService } from './ai-workspace-service.ts';
import { ApplicationError } from './errors.ts';
import { COMMAND_POLICY_VERSION } from '../ports/review.ts';
import { AiWorkBudget } from './ai-work-budget.ts';
import type { ModelProvider } from '../ports/model-provider.ts';
import type { McpToolInvocation } from '../ports/mcp.ts';

export type { AiRunEvent } from '@axterm/plugin-api/ai';
type AiInput = {
  workspace?: AiWorkspace | undefined;
  mode?: 'chat' | 'work' | undefined;
  modelId: string;
  conversationId?: string | undefined;
  useCase: AiRun['useCase'];
  prompt: string;
  context: string;
  attachmentIds?: string[] | undefined;
  terminalId?: string | undefined;
  includeConversationHistory?: boolean | undefined;
  reviewReceipt?: string | undefined;
  reviewExpiresAt?: string | undefined;
  tool?: { name: string; args: Record<string, unknown>; target: string } | undefined;
};

interface PreparedAiAttachment {
  preview: AiAttachmentPreview;
  content: string;
}

export const AI_ATTACHMENT_FILE_BYTES = 50 * 1024;
export const AI_ATTACHMENT_TOTAL_BYTES = 100 * 1024;
const AI_ATTACHMENT_PREVIEW_CHARACTERS = 8 * 1024;
const AI_ATTACHMENT_TTL_MS = 15 * 60_000;
const AI_ATTACHMENT_DRAFT_CAPACITY = 32;

export class AiService {
  skills() {
    return this.models.skills();
  }
  catalog() {
    return this.models.catalog();
  }
  private readonly reviewKey = randomBytes(32);
  private closed = false;
  private readonly lifetime = new AbortController();
  private readonly setups = new Set<Promise<unknown>>();
  private closing: Promise<void> | undefined;
  private readonly contextRequests = new Set<Promise<string[]>>();
  private readonly controllers = new Map<string, AbortController>();
  private readonly listeners = new Map<string, Set<(event: AiRunEvent) => void>>();
  private readonly partialResults = new Map<string, string>();
  private readonly sourceRuns = new Map<string, Set<string>>();
  private readonly sourceSetups = new Map<string, Set<Promise<unknown>>>();
  private readonly sourceTasks = new Map<string, Set<Promise<void>>>();
  private readonly stoppedSources = new Set<string>();
  private readonly ownedRuns = new Set<string>();
  private readonly tasks = new Set<Promise<void>>();
  private readonly runTasks = new Map<string, Set<Promise<void>>>();
  private readonly preparedAttachments = new Map<string, PreparedAiAttachment>();
  private readonly workTargets = new Map<string, string>();
  private readonly approvalWaiters = new Map<string, { approve(): void }>();
  private readonly commandCompletions = new Map<string, Promise<void>>();
  private readonly modelApprovals = new Map<string, { approve(): void; done: Promise<void> }>();
  constructor(
    private readonly repository: AiRepositoryPort,
    private readonly facts: AiFactsPort,
    private readonly host: AiHostPort | undefined,
    private readonly realtime: AiRealtimePort,
    private readonly tools: AiToolsPort,
    private readonly models: AiModelsPort,
    private readonly reviewer: AiCommandReviewer,
    private readonly workspaces: AiWorkspaceService | undefined,
    private readonly commandGeneration: string,
  ) {}

  workspace(terminalId: string) {
    if (!this.workspaces)
      throw new ApplicationError('CAPABILITY_UNAVAILABLE', 'AI workspace unavailable', 503);
    return this.workspaces.resolve(terminalId);
  }

  start(input: AiInput, idempotencyKey: string | undefined, signal?: AbortSignal): Promise<AiRun> {
    try {
      const snapshot = aiRequestSchema.parse(structuredClone(input));
      return this.setup(() => this.startOwned(snapshot, idempotencyKey, signal));
    } catch (error) {
      return Promise.reject(error);
    }
  }
  private async startOwned(
    input: AiInput,
    idempotencyKey: string | undefined,
    signal?: AbortSignal,
  ): Promise<AiRun> {
    if (this.closed)
      throw new ApplicationError('CAPABILITY_UNAVAILABLE', 'AI Runtime is closed', 503);
    if (!idempotencyKey)
      throw new ApplicationError('PRECONDITION_REQUIRED', 'Idempotency-Key is required', 428);
    const previous = this.facts.lookup(idempotencyKey, this.commandGeneration, input);
    if (previous) return previous;
    const knownSecrets = await this.knownAiSecrets(signal);
    if (
      input.tool &&
      redact(JSON.stringify(input.tool), knownSecrets) !== JSON.stringify(input.tool)
    )
      throw new ApplicationError('AI_SECRET_BOUNDARY', 'Tool arguments contain a credential');
    if (this.closed)
      throw new ApplicationError('CAPABILITY_UNAVAILABLE', 'AI Runtime is closed', 503);
    if (signal?.aborted)
      throw new ApplicationError('REQUEST_CANCELED', 'AI request was canceled', 409);
    const idempotencyInput = input;
    const attachments = this.resolveAttachments(input.attachmentIds ?? []);
    const workspace =
      (await this.selectedWorkspace(input)) ??
      (input.tool?.name === 'workspace.exec' ? await this.workspace(input.tool.target) : undefined);
    if (input.tool?.name === 'workspace.exec') {
      if (workspace?.terminalId !== input.tool.target)
        throw new ApplicationError(
          'PRECONDITION_FAILED',
          'Command target differs from the selected terminal',
          412,
        );
      if (input.mode !== 'work' || !['chat', 'diagnose'].includes(input.useCase))
        throw new ApplicationError(
          'PRECONDITION_FAILED',
          'Workspace commands require work mode',
          412,
        );
      if (!this.workspaces)
        throw new ApplicationError('CAPABILITY_UNAVAILABLE', 'AI workspace unavailable', 503);
      input = {
        ...input,
        tool: {
          ...input.tool,
          args: await this.workspaces.bind(input.tool.target, input.tool.args),
        },
      };
    }
    if (this.closed || signal?.aborted)
      throw new ApplicationError('REQUEST_CANCELED', 'AI request was canceled', 409);
    if (!input.prompt.trim() && !attachments.length)
      throw new ApplicationError('VALIDATION_ERROR', 'A prompt or attachment is required', 400);
    if (input.tool && attachments.length)
      throw new ApplicationError(
        'VALIDATION_ERROR',
        'Attachments cannot be combined with a direct tool proposal',
        400,
      );
    const model = this.modelForContext(input, !!input.reviewReceipt);
    const built = this.contextFor(
      { ...input, workspace },
      attachments,
      model?.provider.role,
      knownSecrets,
    );
    if (input.reviewReceipt || input.reviewExpiresAt) {
      if (input.tool || !input.reviewReceipt || !input.reviewExpiresAt || !model)
        throw new ApplicationError(
          'VALIDATION_ERROR',
          'A model context receipt and expiry are required together',
          400,
        );
      const expiry = Date.parse(input.reviewExpiresAt);
      if (!Number.isFinite(expiry) || expiry <= Date.now() || expiry > Date.now() + 5 * 60_000)
        throw new ApplicationError('PRECONDITION_FAILED', 'AI context review expired', 412);
      const expected = this.reviewReceipt(input, built, model, input.reviewExpiresAt);
      if (
        !/^[a-f0-9]{64}$/u.test(input.reviewReceipt) ||
        !timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(input.reviewReceipt, 'hex'))
      )
        throw new ApplicationError(
          'PRECONDITION_FAILED',
          'AI context or target changed; review again',
          412,
        );
    }
    const { reviewReceipt: _receipt, reviewExpiresAt: _expiry, ...modelInput } = input;
    const safe: AiInput = {
      ...modelInput,
      mode: input.mode ?? 'chat',
      prompt: built.prompt,
      context: built.context,
      attachmentIds: [],
      ...(workspace ? { workspace } : {}),
    };
    const attachmentMetadata = attachments.map(({ preview }) => attachmentMetadataOf(preview));
    const isWork =
      (!safe.tool || safe.tool.name === 'workspace.exec') &&
      safe.mode === 'work' &&
      ['chat', 'diagnose'].includes(safe.useCase) &&
      ((safe.workspace?.execution !== 'unavailable' && !!safe.workspace) ||
        safe.tool?.name === 'workspace.exec');
    const workTarget = safe.workspace?.terminalId ?? safe.tool?.target;
    if (isWork && (this.workTargets.size >= 4 || this.workTargets.has(workTarget!)))
      throw new ApplicationError(
        'CAPACITY_EXCEEDED',
        'Work target is busy or work capacity is full',
        409,
      );
    const admission = this.facts.admit(
      idempotencyKey,
      this.commandGeneration,
      {
        engineId: model?.provider.engineId ?? 'application',
        useCase: input.useCase,
        prompt: safe.prompt,
        context: built.baseContext,
        system: built.system,
        ...(input.conversationId ? { conversationId: input.conversationId } : {}),
        attachments: attachmentMetadata,
        ...(model
          ? {
              selection: {
                providerId: model.provider.id,
                providerVersion: model.provider.version,
                modelId: model.model.id,
                modelVersion: model.model.version,
              },
            }
          : {}),
      },
      idempotencyInput,
    );
    const { run } = admission;
    if (!admission.admitted) return run;
    this.ownedRuns.add(run.id);
    for (const id of input.attachmentIds ?? []) this.preparedAttachments.delete(id);
    if (this.closed || signal?.aborted)
      return this.update(run.id, 'canceled', undefined, 'REQUEST_CANCELED');
    if (isWork) this.workTargets.set(workTarget!, run.id);
    this.track(
      () =>
        safe.tool && safe.tool.name !== 'workspace.exec'
          ? this.runTool(run.id, safe.tool)
          : this.runModel(run.id, safe, built.system, model ? structuredClone(model) : undefined),
      run.id,
    );
    return run;
  }

  previewContext(raw: AiContextPreviewInput, signal?: AbortSignal): Promise<AiContextPreview> {
    try {
      const snapshot = aiContextPreviewRequestSchema.parse(structuredClone(raw));
      return this.setup(() => this.previewContextOwned(snapshot, signal));
    } catch (error) {
      return Promise.reject(error);
    }
  }
  private async previewContextOwned(
    raw: AiContextPreviewInput,
    signal?: AbortSignal,
  ): Promise<AiContextPreview> {
    if (this.closed)
      throw new ApplicationError('CAPABILITY_UNAVAILABLE', 'AI Runtime is closed', 503);
    const input = aiContextPreviewRequestSchema.parse(raw);
    const knownSecrets = await this.knownAiSecrets(signal);
    if (this.closed)
      throw new ApplicationError('CAPABILITY_UNAVAILABLE', 'AI Runtime is closed', 503);
    if (signal?.aborted)
      throw new ApplicationError('REQUEST_CANCELED', 'AI review was canceled', 409);
    const attachments = this.resolveAttachments(input.attachmentIds);
    if (!input.prompt.trim() && !attachments.length)
      throw new ApplicationError('VALIDATION_ERROR', 'A prompt or attachment is required', 400);
    const model = this.modelForContext(input, true)!;
    if (!model.provider.enabled)
      throw new ApplicationError('CAPABILITY_UNAVAILABLE', 'AI provider is disabled', 503);
    const workspace = await this.selectedWorkspace(input);
    if (this.closed || signal?.aborted)
      throw new ApplicationError('REQUEST_CANCELED', 'AI review was canceled', 409);
    const built = this.contextFor(
      { ...input, workspace },
      attachments,
      model.provider.role,
      knownSecrets,
    );
    const request = { ...input, prompt: built.prompt, context: built.explicitContext };
    const reviewExpiresAt = new Date(Date.now() + 5 * 60_000).toISOString();
    return {
      request,
      system: built.system,
      prompt: built.prompt,
      context: built.context,
      sources: built.sources,
      reviewReceipt: this.reviewReceipt(request, built, model, reviewExpiresAt),
      reviewExpiresAt,
    };
  }

  private async selectedWorkspace(input: Pick<AiInput, 'terminalId' | 'reviewReceipt'>) {
    if (!input.terminalId || !this.workspaces) return undefined;
    try {
      return await this.workspaces.resolve(input.terminalId);
    } catch (error) {
      if (input.reviewReceipt)
        throw new ApplicationError(
          'PRECONDITION_FAILED',
          'AI workspace changed; review again',
          412,
        );
      throw error;
    }
  }

  private knownAiSecrets(signal?: AbortSignal): Promise<string[]> {
    if (this.contextRequests.size >= 32)
      return Promise.reject(
        new ApplicationError('CAPACITY_EXCEEDED', 'Too many context preparations are active', 409),
      );
    const ownedSignal = signal
      ? AbortSignal.any([signal, this.lifetime.signal])
      : this.lifetime.signal;
    const task = this.resolveKnownAiSecrets(ownedSignal);
    this.contextRequests.add(task);
    void task.then(
      () => this.contextRequests.delete(task),
      () => this.contextRequests.delete(task),
    );
    return task;
  }

  private async resolveKnownAiSecrets(signal: AbortSignal): Promise<string[]> {
    if (!this.host) return [];
    const providers = this.repository.listJson<AiProvider>('ai_providers');
    const signatureOf = (items: AiProvider[]) =>
      stableHash(
        items
          .map((provider) => ({
            id: provider.id,
            version: provider.version,
            credentialRef: provider.credentialRef,
            proxyCredentialRef: provider.proxy?.credentialRef ?? null,
            headerCredentialRefs: provider.pi?.headerCredentialRefs ?? {},
          }))
          .sort((a, b) => a.id.localeCompare(b.id)),
      );
    const scopeSignature = signatureOf(providers);
    const refs = [
      ...new Set(
        providers.flatMap((provider) =>
          [
            provider.credentialRef,
            provider.proxy?.credentialRef,
            ...Object.values(provider.pi?.headerCredentialRefs ?? {}),
          ].filter((ref): ref is string => !!ref),
        ),
      ),
    ];
    if (refs.length > 32)
      throw new ApplicationError(
        'CAPACITY_EXCEEDED',
        'Too many AI credential scopes to safely prepare context',
        409,
      );
    const secrets: string[] = [];
    for (let offset = 0; offset < refs.length; offset += 4) {
      const results = await Promise.allSettled(
        refs.slice(offset, offset + 4).map((ref) => this.host!.resolveCredential(ref, signal)),
      );
      const failed = results.find((result) => result.status === 'rejected');
      if (failed?.status === 'rejected') throw failed.reason;
      for (const result of results)
        if (result.status === 'fulfilled' && result.value.length > 0) secrets.push(result.value);
    }
    if (signatureOf(this.repository.listJson<AiProvider>('ai_providers')) !== scopeSignature)
      throw new ApplicationError(
        'PRECONDITION_FAILED',
        'AI configuration changed during context preparation',
        412,
      );
    return secrets;
  }

  private modelForContext(input: AiInput, required: boolean) {
    if (input.tool) return undefined;
    try {
      const model = this.repository.getJson<AiModel>('ai_models', input.modelId);
      const provider = this.repository.getJson<AiProvider>('ai_providers', model.providerId);
      return { model, provider };
    } catch (cause) {
      if (required) throw cause;
      return undefined;
    }
  }

  private contextFor(
    input: AiInput,
    attachments: readonly PreparedAiAttachment[],
    role?: string,
    knownSecrets: readonly string[] = [],
  ) {
    const history =
      input.conversationId && input.includeConversationHistory !== false
        ? this.repository.listAiContextMessages(input.conversationId)
        : { messages: [], count: 0 };
    return buildAiModelContext({
      skillInstructions: this.models.skillInstructions(input.useCase),
      ...(input.workspace ? { workspaceContext: JSON.stringify(input.workspace) } : {}),
      prompt: input.prompt,
      context: input.context,
      useCase: input.useCase,
      mode: input.mode ?? 'chat',
      ...(role ? { role } : {}),
      history: history.messages,
      historyCount: history.count,
      includeConversationHistory: input.includeConversationHistory !== false,
      attachments,
      knownSecrets,
    });
  }

  private reviewReceipt(
    input: AiInput,
    built: ReturnType<typeof buildAiModelContext>,
    config: { model: AiModel; provider: AiProvider },
    expiresAt: string,
  ): string {
    const binding = {
      modelId: config.model.id,
      modelVersion: config.model.version,
      providerId: config.provider.id,
      providerVersion: config.provider.version,
      conversationId: input.conversationId ?? null,
      terminalId: input.terminalId ?? null,
      mode: input.mode ?? 'chat',
      useCase: input.useCase,
      includeConversationHistory: input.includeConversationHistory !== false,
      attachmentIds: input.attachmentIds ?? [],
      system: built.system,
      prompt: built.prompt,
      context: built.context,
      expiresAt,
    };
    return createHmac('sha256', this.reviewKey).update(JSON.stringify(binding)).digest('hex');
  }

  prepareAttachment(grantId: string, signal?: AbortSignal): Promise<AiAttachmentPreview> {
    return this.setup(() => this.prepareAttachmentOwned(grantId, signal));
  }
  private async prepareAttachmentOwned(
    grantId: string,
    signal?: AbortSignal,
  ): Promise<AiAttachmentPreview> {
    if (this.closed)
      throw new ApplicationError('CAPABILITY_UNAVAILABLE', 'AI Runtime is closed', 503);
    if (!this.host)
      throw new ApplicationError(
        'CAPABILITY_UNAVAILABLE',
        'Desktop file capabilities are unavailable',
        503,
      );
    const ownedSignal = signal
      ? AbortSignal.any([signal, this.lifetime.signal])
      : this.lifetime.signal;
    this.purgeAttachments();
    if (this.preparedAttachments.size >= AI_ATTACHMENT_DRAFT_CAPACITY)
      throw new ApplicationError(
        'CAPACITY_EXCEEDED',
        'Too many attachment drafts are already open',
        409,
      );
    try {
      const knownSecrets = await this.knownAiSecrets(ownedSignal);
      if (this.closed || ownedSignal.aborted)
        throw new ApplicationError('REQUEST_CANCELED', 'Attachment preparation was canceled', 409);
      const file = await this.host.readGrantedTextPrefix(
        grantId,
        AI_ATTACHMENT_FILE_BYTES,
        AI_ATTACHMENT_TOTAL_BYTES,
        ownedSignal,
      );
      if (this.closed || ownedSignal.aborted)
        throw new ApplicationError('REQUEST_CANCELED', 'Attachment preparation was canceled', 409);
      const content = redact(file.content, knownSecrets);
      const preview: AiAttachmentPreview = {
        id: crypto.randomUUID(),
        name: normalizeAttachmentName(redact(file.name, knownSecrets)),
        size: file.size,
        includedBytes: file.includedBytes,
        truncated: file.truncated,
        preview: content.slice(0, AI_ATTACHMENT_PREVIEW_CHARACTERS),
        redacted: content !== file.content,
        expiresAt: new Date(Date.now() + AI_ATTACHMENT_TTL_MS).toISOString(),
      };
      this.preparedAttachments.set(preview.id, { preview, content });
      return preview;
    } finally {
      await this.host.revokeGrant(grantId);
    }
  }

  discardAttachment(id: string): void {
    if (!this.preparedAttachments.delete(id))
      throw new ApplicationError('NOT_FOUND', 'Attachment draft was not found', 404);
  }

  list() {
    return this.repository.listAiRuns();
  }
  get(id: string) {
    const run = this.repository.getAiRun(id);
    const result = this.partialResults.get(id);
    return result === undefined || ['succeeded', 'failed', 'canceled'].includes(run.state)
      ? run
      : { ...run, result };
  }
  toolCalls(id: string) {
    return this.repository.listToolCalls(id);
  }
  approvals() {
    const approvals = this.repository.pendingApprovals();
    for (const approval of approvals) {
      if (approval.state !== 'pending' || Date.parse(approval.expiresAt) > Date.now()) continue;
      const call = this.repository.getToolCall(approval.toolCallId);
      this.facts.decideApproval(approval.id, 'expired');
      if (call.review || this.modelApprovals.has(call.id))
        this.controllers
          .get(call.runId)
          ?.abort(new ApplicationError('APPROVAL_EXPIRED', 'Approval expired', 409));
      if (!['succeeded', 'failed', 'canceled'].includes(call.state))
        this.facts.updateToolCall(call.id, 'canceled', { code: 'APPROVAL_EXPIRED' });
      const run = this.get(call.runId);
      if (!['succeeded', 'failed', 'canceled'].includes(run.state))
        this.update(call.runId, 'canceled', undefined, 'APPROVAL_EXPIRED');
    }
    return this.repository.listApprovals();
  }

  invokeRegisteredTool(
    proposal: { name: string; args: Record<string, unknown>; target: string },
    idempotencyKey: string,
    sourceId: string,
  ): Promise<McpToolInvocation> {
    try {
      if (!/^[a-zA-Z0-9._-]{1,128}$/.test(sourceId) || this.stoppedSources.has(sourceId))
        throw new ApplicationError('CAPABILITY_UNAVAILABLE', 'MCP source stopped or invalid', 503);
      if (!this.sourceRuns.has(sourceId)) {
        if (this.sourceRuns.size >= 64)
          throw new ApplicationError('CAPACITY_EXCEEDED', 'MCP source capacity reached');
        this.sourceRuns.set(sourceId, new Set());
      }
      const snapshot = structuredClone(proposal);
      return this.setup(() => this.invokeRegisteredToolOwned(snapshot, idempotencyKey, sourceId));
    } catch (error) {
      return Promise.reject(error);
    }
  }
  private async invokeRegisteredToolOwned(
    proposal: { name: string; args: Record<string, unknown>; target: string },
    idempotencyKey: string,
    sourceId: string,
  ): Promise<McpToolInvocation> {
    if (this.closed)
      throw new ApplicationError('CAPABILITY_UNAVAILABLE', 'AI service is closed', 503);
    if (!/^[a-zA-Z0-9._-]{1,128}$/.test(sourceId) || this.stoppedSources.has(sourceId))
      throw new ApplicationError('CAPABILITY_UNAVAILABLE', 'MCP source stopped or invalid', 503);
    if (!this.sourceRuns.has(sourceId) && this.sourceRuns.size >= 64)
      throw new ApplicationError('CAPACITY_EXCEEDED', 'MCP source capacity reached');
    const request = { source: 'mcp', sourceId, tool: proposal };
    const previous = this.facts.lookup(idempotencyKey, this.commandGeneration, request);
    if (previous) return this.mcpInvocation(previous.id);
    const { run, admitted } = this.facts.admit(
      idempotencyKey,
      this.commandGeneration,
      { engineId: 'application', useCase: 'diagnose', prompt: '', operation: 'mcp-tool', sourceId },
      request,
    );
    if (!admitted) return this.mcpInvocation(run.id);
    this.ownedRuns.add(run.id);
    const runs = this.sourceRuns.get(sourceId) ?? new Set<string>();
    runs.add(run.id);
    this.sourceRuns.set(sourceId, runs);
    const tasks = this.sourceTasks.get(sourceId) ?? new Set<Promise<void>>();
    this.sourceTasks.set(sourceId, tasks);
    const task = this.track(async () => {
      if (this.stoppedSources.has(sourceId) || this.closed) {
        this.cancel(run.id);
        return;
      }
      await this.runTool(run.id, proposal);
    }, run.id);
    tasks.add(task);
    try {
      await task;
    } finally {
      tasks.delete(task);
    }
    return this.mcpInvocation(run.id);
  }

  async stopMcpSource(sourceId: string): Promise<void> {
    if (!this.sourceRuns.has(sourceId)) return;
    this.stoppedSources.add(sourceId);
    const revoke = () => {
      for (const runId of this.sourceRuns.get(sourceId) ?? []) {
        const run = this.repository.getAiRun(runId);
        if (!['succeeded', 'failed', 'canceled'].includes(run.state)) this.cancel(runId);
      }
    };
    revoke();
    await Promise.allSettled([...(this.sourceSetups.get(sourceId) ?? [])]);
    revoke();
    await Promise.allSettled([...(this.sourceTasks.get(sourceId) ?? [])]);
    this.sourceRuns.delete(sourceId);
    this.sourceTasks.delete(sourceId);
    this.sourceSetups.delete(sourceId);
    while (this.stoppedSources.size > 2048)
      this.stoppedSources.delete(this.stoppedSources.values().next().value!);
  }

  conversations() {
    return this.repository.listAiConversations();
  }

  conversation(id: string) {
    return {
      conversation: this.repository.getAiConversation(id),
      messages: this.repository.listAiMessages(id),
    };
  }

  createConversation(input: AiConversationInput) {
    if (this.closed)
      throw new ApplicationError('CAPABILITY_UNAVAILABLE', 'AI service is closed', 503);
    this.repository.getJson<AiModel>('ai_models', input.modelId);
    return this.repository.createAiConversation(input);
  }

  updateConversation(id: string, input: AiConversationPatch, ifMatch: string | undefined) {
    if (this.closed)
      throw new ApplicationError('CAPABILITY_UNAVAILABLE', 'AI service is closed', 503);
    if (input.modelId) this.repository.getJson<AiModel>('ai_models', input.modelId);
    return this.repository.updateAiConversation(id, input, ifMatch);
  }

  deleteConversation(id: string, ifMatch: string | undefined) {
    if (this.closed)
      throw new ApplicationError('CAPABILITY_UNAVAILABLE', 'AI service is closed', 503);
    const runIds = this.repository
      .listAiRuns()
      .filter(
        (run) =>
          run.conversationId === id && !['succeeded', 'failed', 'canceled'].includes(run.state),
      )
      .map((run) => run.id);
    this.repository.deleteAiConversation(id, ifMatch);
    for (const runId of runIds) this.cancel(runId);
  }

  testProvider(id: string, signal?: AbortSignal): Promise<AiProviderTestResult> {
    const owned = AbortSignal.any([this.lifetime.signal, ...(signal ? [signal] : [])]);
    return this.setup(() => this.testProviderOwned(id, owned));
  }
  private async testProviderOwned(id: string, signal: AbortSignal): Promise<AiProviderTestResult> {
    signal.throwIfAborted();
    const provider = this.repository.getJson<AiProvider>('ai_providers', id);
    if (!provider.enabled)
      throw new ApplicationError('CAPABILITY_UNAVAILABLE', 'AI provider is disabled', 503);
    if (provider.engineId !== 'pi')
      throw new ApplicationError(
        'ENGINE_DISCOVERY_UNSUPPORTED',
        'The selected Engine does not provide model discovery',
        409,
      );
    const startedAt = Date.now();
    try {
      const adapter = await this.adapter(provider, signal);
      const models = await adapter.listModels(signal);
      return {
        providerId: provider.id,
        protocol: provider.protocol ?? 'openai-chat',
        ok: true,
        latencyMs: Date.now() - startedAt,
        models,
      };
    } catch {
      if (signal?.aborted)
        throw new ApplicationError('REQUEST_CANCELED', 'AI provider test was canceled', 409);
      throw new ApplicationError('AI_PROVIDER_FAILED', 'AI provider test failed', 409);
    }
  }

  subscribe(runId: string, listener: (event: AiRunEvent) => void): () => void {
    const run = this.get(runId);
    if (this.closed)
      throw new ApplicationError('CAPABILITY_UNAVAILABLE', 'AI service is closed', 503);
    if (this.listeners.size >= 128 && !this.listeners.has(runId))
      throw new ApplicationError('CAPACITY_EXCEEDED', 'AI observation capacity reached');
    const listeners = this.listeners.get(runId) ?? new Set();
    if (listeners.size >= 16)
      throw new ApplicationError('CAPACITY_EXCEEDED', 'AI observation capacity reached');
    listeners.add(listener);
    this.listeners.set(runId, listeners);
    listener({ runId, type: 'snapshot', data: run });
    return () => {
      listeners.delete(listener);
      if (!listeners.size) this.listeners.delete(runId);
    };
  }

  cancel(id: string): void {
    this.cancelCommitted(id);
    this.prepareCancellation(id);
  }
  cancelCommitted(id: string): void {
    this.controllers.get(id)?.abort(new Error('AI run canceled'));
  }
  /** Synchronous facts only; Controller commits its receipt before requesting actual cancellation. */
  prepareCancellation(id: string): void {
    const run = this.get(id);
    if (['succeeded', 'failed', 'canceled'].includes(run.state)) return;
    for (const approval of this.repository.pendingApprovals(id))
      this.facts.decideApproval(approval.id, 'rejected');
    let uncertain = false;
    for (const call of this.repository.activeToolCalls(id)) {
      const effectUncertain = call.state === 'running' && call.risk !== 'read_only';
      uncertain ||= effectUncertain;
      this.facts.updateToolCall(call.id, 'canceled', {
        code: 'REQUEST_CANCELED',
        ...(effectUncertain ? { effect: 'uncertain' } : {}),
      });
    }
    this.update(id, 'canceled', undefined, uncertain ? 'AI_EFFECT_UNCERTAIN' : undefined);
  }

  decideApproval(
    id: string,
    input: { decision: 'approve_once' | 'reject'; argsHash: string },
    commandId: string,
  ) {
    return this.setup(() => this.decideApprovalOwned(id, input, commandId));
  }
  private async decideApprovalOwned(
    id: string,
    input: { decision: 'approve_once' | 'reject'; argsHash: string },
    commandId: string,
  ) {
    const previous = this.facts.lookupApproval(commandId, {
      id,
      argsHash: input.argsHash,
      decision: input.decision,
    });
    if (previous) return this.get(previous.runId);
    const approval = this.repository.getApproval(id);
    if (approval.state !== 'pending' || approval.argsHash !== input.argsHash)
      throw new ApplicationError(
        'PRECONDITION_FAILED',
        'Approval no longer matches this tool call',
        412,
      );
    const call = this.repository.getToolCall(approval.toolCallId);
    if (
      call.runId !== approval.runId ||
      call.target !== approval.target ||
      call.argsHash !== approval.argsHash ||
      call.state !== 'waiting_approval' ||
      this.get(approval.runId).state !== 'waiting_approval'
    )
      throw new ApplicationError(
        'PRECONDITION_FAILED',
        'Approval target or work state changed',
        412,
      );
    if (Date.parse(approval.expiresAt) <= Date.now()) {
      this.facts.decideApproval(id, 'expired');
      if (call.review)
        this.controllers
          .get(call.runId)
          ?.abort(new ApplicationError('APPROVAL_EXPIRED', 'Approval expired', 409));
      this.facts.updateToolCall(call.id, 'canceled', { code: 'APPROVAL_EXPIRED' });
      this.update(call.runId, 'canceled', undefined, 'APPROVAL_EXPIRED');
      throw new ApplicationError('APPROVAL_EXPIRED', 'Approval expired', 409);
    }
    if (
      this.commandHash(call, approval.expiresAt) !== approval.argsHash ||
      (call.review
        ? call.review.generation !== this.commandGeneration ||
          call.review.policyVersion !== COMMAND_POLICY_VERSION ||
          !this.approvalWaiters.has(call.id)
        : this.tools.risk(call.toolName) !== call.risk)
    )
      throw new ApplicationError(
        'PRECONDITION_FAILED',
        'Tool identity, arguments, risk, policy or expiry changed',
        412,
      );
    if (call.review) {
      if (input.decision === 'reject') {
        this.facts.decideApproval(id, 'rejected', commandId);
        this.cancel(call.runId);
        return this.get(call.runId);
      }
      this.facts.decideApproval(id, 'approved', commandId);
      const completing = this.commandCompletions.get(call.id);
      this.approvalWaiters.get(call.id)!.approve();
      await completing;
      return this.get(call.runId);
    }
    if (
      stableHash({
        toolName: call.toolName,
        args: call.args,
        target: call.target,
        risk: call.risk,
        expiresAt: approval.expiresAt,
      }) !== approval.argsHash ||
      this.tools.risk(call.toolName) !== call.risk
    )
      throw new ApplicationError(
        'PRECONDITION_FAILED',
        'Tool identity, arguments, risk or expiry changed',
        412,
      );
    const modelApproval = this.modelApprovals.get(call.id);
    if (modelApproval) {
      if (input.decision === 'reject') {
        this.facts.decideApproval(id, 'rejected', commandId);
        this.cancel(call.runId);
      } else {
        this.facts.decideApproval(id, 'approved', commandId);
        modelApproval.approve();
        await modelApproval.done;
      }
      return this.get(call.runId);
    }
    if (input.decision === 'reject') {
      this.facts.decideApproval(id, 'rejected', commandId);
      this.facts.updateToolCall(call.id, 'canceled');
      return this.update(call.runId, 'canceled');
    }
    this.facts.decideApproval(id, 'approved', commandId);
    const task = this.track(() => this.executeTool(call), call.runId);
    await task;
    return this.get(call.runId);
  }

  private async runTool(
    runId: string,
    proposal: { name: string; args: Record<string, unknown>; target: string },
  ) {
    try {
      if (this.closed) {
        this.update(runId, 'canceled');
        return;
      }
      this.update(runId, 'running');
      const risk = this.tools.risk(proposal.name);
      const expiresAt =
        risk === 'read_only' ? null : new Date(Date.now() + 10 * 60_000).toISOString();
      const argsHash = stableHash({
        toolName: proposal.name,
        args: aiToolCallSchema.shape.args.parse(proposal.args),
        target: proposal.target,
        risk,
        expiresAt,
      });
      const call = this.facts.createToolCall({
        runId,
        toolName: proposal.name,
        risk,
        argsHash,
        args: aiToolCallSchema.shape.args.parse(proposal.args),
        target: proposal.target,
        state: 'proposed',
      });
      if (risk === 'read_only') await this.executeTool(call);
      else {
        const approval = this.facts.createApproval({
          runId,
          toolCallId: call.id,
          argsHash,
          target: call.target,
          expiresAt: expiresAt!,
        });
        this.update(runId, 'waiting_approval');
        this.emit({
          runId,
          type: 'state',
          data: { run: this.get(runId), approval, toolCall: call },
        });
      }
    } catch (error) {
      if (['succeeded', 'failed', 'canceled'].includes(this.repository.getAiRun(runId).state))
        return;
      this.update(
        runId,
        'failed',
        undefined,
        error instanceof ApplicationError ? error.code : 'AI_TOOL_FAILED',
      );
    }
  }

  private mcpInvocation(runId: string): McpToolInvocation {
    const run = this.get(runId);
    const call = this.repository.listToolCalls(runId).at(-1);
    const approval = this.repository
      .listApprovals()
      .find((item) => item.runId === runId && item.toolCallId === call?.id);
    return {
      runId,
      state: run.state,
      ...(call ? { toolCallId: call.id, argsHash: call.argsHash } : {}),
      ...(approval
        ? {
            approvalId: approval.id,
            expiresAt: approval.expiresAt,
          }
        : {}),
      ...(call?.resultMetadata ? { result: call.resultMetadata } : {}),
      ...(run.errorCode ? { errorCode: run.errorCode } : {}),
    };
  }

  private async executeTool(call: AiToolCall) {
    const controller = new AbortController();
    if (this.lifetime.signal.aborted) controller.abort(this.lifetime.signal.reason);
    this.controllers.set(call.runId, controller);
    this.facts.updateToolCall(call.id, 'running');
    this.update(call.runId, 'running');
    try {
      const knownSecrets = await this.knownAiSecrets(controller.signal);
      if (this.tools.risk(call.toolName) !== call.risk)
        throw new ApplicationError('PRECONDITION_FAILED', 'Tool risk changed');
      controller.signal.throwIfAborted();
      const result = await this.tools.execute(
        call.toolName,
        call.args,
        call.target,
        controller.signal,
        { id: call.id, generation: this.commandGeneration },
      );
      if (controller.signal.aborted) return;
      const safeResult = sanitizeToolResult(result, knownSecrets) as Record<string, unknown>;
      this.facts.updateToolCall(call.id, 'succeeded', safeResult);
      this.update(call.runId, 'succeeded', JSON.stringify(safeResult));
    } catch (error) {
      if (!controller.signal.aborted) {
        this.facts.updateToolCall(call.id, 'failed', { code: 'TOOL_EXECUTION_FAILED' });
        this.update(
          call.runId,
          'failed',
          undefined,
          error instanceof ApplicationError ? error.code : 'AI_TOOL_FAILED',
        );
      }
    } finally {
      this.controllers.delete(call.runId);
    }
  }

  private async runModel(
    runId: string,
    input: AiInput,
    system: string,
    selection?: { model: AiModel; provider: AiProvider },
  ) {
    const controller = new AbortController();
    if (this.lifetime.signal.aborted) controller.abort(this.lifetime.signal.reason);
    this.controllers.set(runId, controller);
    this.update(runId, 'running');
    let result = '';
    const visible = new VisibleOutput();
    const structuredDraft = ['createBookmark', 'createTheme'].includes(input.useCase);
    const acceptVisible = (text: string) => {
      controller.signal.throwIfAborted();
      if (!text) return;
      result += text;
      if (structuredDraft) return;
      this.facts.output(runId, text);
      this.partialResults.set(runId, result);
      this.emit({ runId, type: 'delta', data: { text } });
    };
    const working =
      this.workTargets.get(input.workspace?.terminalId ?? input.tool?.target ?? '') === runId;
    const budget = working ? new AiWorkBudget(controller) : undefined;
    let targetTimer: ReturnType<typeof setInterval> | undefined;
    try {
      controller.signal.throwIfAborted();
      let model: AiModel | undefined;
      let provider: AiProvider | undefined;
      try {
        model = selection?.model ?? this.repository.getJson<AiModel>('ai_models', input.modelId);
        provider =
          selection?.provider ??
          this.repository.getJson<AiProvider>('ai_providers', model.providerId);
      } catch (error) {
        if (!input.tool) throw error;
      }
      if (provider && !provider.enabled && !input.tool)
        throw new ApplicationError('CAPABILITY_UNAVAILABLE', 'AI provider is disabled', 503);
      if (!this.host && !input.tool)
        throw new ApplicationError(
          'CAPABILITY_UNAVAILABLE',
          'Credential vault is unavailable',
          503,
        );
      const adapter: ModelProvider =
        provider && this.host && provider.enabled
          ? await this.adapter(provider, controller.signal)
          : {
              stream() {
                throw new Error('Reviewer unavailable');
              },
            };
      const workspace = input.workspace ?? (input.tool?.args.workspace as AiWorkspace | undefined);
      if (working && workspace) {
        targetTimer = setInterval(() => {
          if (!this.workspaces?.targetReady(workspace))
            controller.abort(
              new ApplicationError(
                'PRECONDITION_FAILED',
                'Work execution target closed or changed',
                412,
              ),
            );
        }, 250);
        targetTimer.unref();
      }
      const executeCommand =
        working && workspace && budget
          ? (command: string, _toolCallId: string, _signal: AbortSignal) =>
              this.executeReviewedCommand(
                runId,
                input,
                workspace,
                command,
                adapter,
                model?.model ?? 'unavailable',
                provider?.timeoutMs ?? 30_000,
                controller,
                budget,
              )
          : undefined;
      if (input.tool?.name === 'workspace.exec') {
        if (!executeCommand || typeof input.tool.args.command !== 'string')
          throw new ApplicationError('PRECONDITION_FAILED', 'No work execution target', 412);
        const toolResult = await executeCommand(
          input.tool.args.command,
          'direct',
          controller.signal,
        );
        this.update(runId, 'succeeded', toolResult.text);
        return;
      }
      const modelToolIds = new Set<string>();
      const executePluginManagement =
        !!provider &&
        (this.models.supportsApplicationTools?.(provider) ?? provider.engineId === 'pi') &&
        ['chat', 'diagnose'].includes(input.useCase) &&
        this.tools.modelTools?.().includes('plugins.manage')
          ? (args: Record<string, unknown>, callId: string, signal: AbortSignal) => {
              if (modelToolIds.has(callId) || modelToolIds.size >= 50)
                throw new ApplicationError(
                  'AI_RUNTIME_LIMIT',
                  'Model tool call limit reached',
                  409,
                );
              modelToolIds.add(callId);
              return this.executeModelTool(
                runId,
                'plugins.manage',
                args,
                AbortSignal.any([signal, controller.signal]),
                controller,
              );
            }
          : undefined;
      for await (const event of adapter.stream({
        executePluginManagement,
        model: model!.model,
        system,
        prompt: input.prompt,
        context: input.context,
        signal: controller.signal,
        executeCommand,
        allowCommandProposal:
          input.mode === 'work' &&
          ['chat', 'diagnose'].includes(input.useCase) &&
          !!input.workspace &&
          input.workspace.execution !== 'unavailable',
      })) {
        if (event.type === 'delta') {
          acceptVisible(visible.push(event.text));
        } else if (event.type === 'usage')
          this.emit({ runId, type: 'usage', data: { ...event, purpose: 'execution' } });
        else if (event.type === 'commandProposal') {
          throw new ApplicationError(
            'AI_POLICY_REJECTED',
            'Model command bypassed the Runtime execution callback',
            409,
          );
        }
      }
      acceptVisible(visible.finish());
      const accepted =
        input.useCase === 'createBookmark'
          ? normalizeBookmarkResult(result)
          : input.useCase === 'createTheme'
            ? normalizeThemeResult(result)
            : result;
      if (structuredDraft && accepted) {
        this.facts.output(runId, accepted);
        this.emit({ runId, type: 'delta', data: { text: accepted } });
      }
      this.update(runId, 'succeeded', accepted);
    } catch (error) {
      if (['succeeded', 'failed', 'canceled'].includes(this.get(runId).state)) return;
      const partialResult = structuredDraft ? undefined : result || undefined;
      const engineCanceled =
        error instanceof ApplicationError && error.code === 'AI_ENGINE_CANCELLED';
      if (controller.signal.aborted || engineCanceled) {
        const reason = engineCanceled ? error : controller.signal.reason;
        this.update(
          runId,
          reason instanceof ApplicationError && reason.code === 'AI_RUNTIME_LIMIT'
            ? 'failed'
            : 'canceled',
          partialResult,
          reason instanceof ApplicationError ? reason.code : undefined,
        );
      } else
        this.update(
          runId,
          'failed',
          partialResult,
          error instanceof ApplicationError ? error.code : 'AI_PROVIDER_FAILED',
        );
    } finally {
      visible.discard();
      clearInterval(targetTimer);
      budget?.close();
      for (const [target, id] of this.workTargets)
        if (id === runId) this.workTargets.delete(target);
      this.controllers.delete(runId);
      this.partialResults.delete(runId);
    }
  }

  /** Model plugin tools always use explicit per-call approval; no command reviewer path. */
  private async executeModelTool(
    runId: string,
    name: string,
    args: Record<string, unknown>,
    signal: AbortSignal,
    controller: AbortController,
  ): Promise<{ text: string; isError: boolean }> {
    signal.throwIfAborted();
    if (!this.tools.modelProposal || !this.tools.modelTools?.().includes(name))
      throw new ApplicationError('CAPABILITY_UNAVAILABLE', 'Model tool is unavailable', 503);
    const proposal = this.tools.modelProposal(name, args);
    const secrets = await this.knownAiSecrets(signal);
    signal.throwIfAborted();
    if (redact(JSON.stringify(proposal.args), secrets) !== JSON.stringify(proposal.args))
      throw new ApplicationError('AI_SECRET_BOUNDARY', 'Tool arguments contain a credential');
    const risk = this.tools.risk(name);
    if (risk !== 'privileged')
      throw new ApplicationError(
        'AI_POLICY_REJECTED',
        'Model management requires privileged approval',
        409,
      );
    const expiresAt = new Date(Date.now() + 10 * 60_000).toISOString();
    const capturedArgs = aiToolCallSchema.shape.args.parse(structuredClone(proposal.args));
    const argsHash = stableHash({
      toolName: name,
      args: capturedArgs,
      target: proposal.target,
      risk,
      expiresAt,
    });
    const call = this.facts.createToolCall({
      runId,
      toolName: name,
      risk,
      argsHash,
      args: capturedArgs,
      target: proposal.target,
      state: 'proposed',
    });
    const approval = this.facts.createApproval({
      runId,
      toolCallId: call.id,
      argsHash,
      target: call.target,
      expiresAt,
    });
    const decision = Promise.withResolvers<void>(),
      done = Promise.withResolvers<void>();
    const abort = () =>
      decision.reject(
        new ApplicationError('REQUEST_CANCELED', 'Model tool approval canceled', 409),
      );
    signal.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(
      () =>
        controller.abort(
          new ApplicationError('APPROVAL_EXPIRED', 'Model tool approval expired', 409),
        ),
      10 * 60_000,
    );
    this.modelApprovals.set(call.id, { approve: () => decision.resolve(), done: done.promise });
    void decision.promise.catch(() => {});
    try {
      this.update(runId, 'waiting_approval');
      this.emit({
        runId,
        type: 'state',
        data: { run: this.get(runId), approval, toolCall: this.repository.getToolCall(call.id) },
      });
      if (signal.aborted) abort();
      await decision.promise;
      clearTimeout(timer);
      signal.throwIfAborted();
      const current = this.repository.getToolCall(call.id);
      if (
        current.argsHash !== argsHash ||
        stableHash({
          toolName: current.toolName,
          args: current.args,
          target: current.target,
          risk: current.risk,
          expiresAt,
        }) !== argsHash ||
        this.tools.risk(name) !== risk ||
        this.get(runId).state !== 'waiting_approval'
      )
        throw new ApplicationError(
          'PRECONDITION_FAILED',
          'Model tool approval no longer matches',
          412,
        );
      this.facts.updateToolCall(call.id, 'running');
      this.update(runId, 'running');
      const result = await this.tools.execute(name, capturedArgs, call.target, signal, {
        id: call.id,
        generation: this.commandGeneration,
      });
      const safe = sanitizeToolResult(result, secrets) as Record<string, unknown>;
      // Record durable admission even if Engine self-unload cancels this Run concurrently.
      this.facts.updateToolCall(call.id, 'succeeded', safe);
      const text = JSON.stringify(safe);
      return {
        text:
          Buffer.byteLength(text, 'utf8') <= 12 * 1024
            ? text
            : JSON.stringify({
                truncated: true,
                message:
                  'The recorded result exceeds model output limits. Inspect the plugin management page.',
              }),
        isError: false,
      };
    } catch (error) {
      if (signal.aborted) {
        if (
          controller.signal.reason instanceof ApplicationError &&
          controller.signal.reason.code === 'APPROVAL_EXPIRED' &&
          this.repository.getApproval(approval.id).state === 'pending'
        )
          this.facts.decideApproval(approval.id, 'expired');
        const state = this.repository.getToolCall(call.id).state;
        if (state === 'waiting_approval' || state === 'proposed' || state === 'running')
          this.facts.updateToolCall(call.id, 'canceled');
        throw error;
      }
      this.facts.updateToolCall(call.id, 'failed', { code: 'TOOL_EXECUTION_FAILED' });
      if (this.get(runId).state === 'waiting_approval') this.update(runId, 'running');
      return {
        text: 'Plugin management request was not admitted. Inspect the application record before requesting another change.',
        isError: true,
      };
    } finally {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      this.modelApprovals.delete(call.id);
      done.resolve();
    }
  }

  private commandHash(
    call: Pick<AiToolCall, 'toolName' | 'args' | 'target' | 'risk' | 'review' | 'step'>,
    expiresAt: string | null,
  ) {
    return stableHash({
      toolName: call.toolName,
      args: call.args,
      target: call.target,
      risk: call.risk,
      expiresAt,
      ...(call.review ? { review: call.review, step: call.step } : {}),
    });
  }

  private waitForCommandApproval(
    call: AiToolCall,
    controller: AbortController,
    budget: AiWorkBudget,
  ) {
    const approval = this.facts.createApproval({
      runId: call.runId,
      toolCallId: call.id,
      argsHash: call.argsHash,
      target: call.target,
      expiresAt: call.review!.expiresAt,
    });
    this.update(call.runId, 'waiting_approval');
    this.emit({
      runId: call.runId,
      type: 'state',
      data: { run: this.get(call.runId), approval, toolCall: this.repository.getToolCall(call.id) },
    });
    budget.pause();
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const done = (error?: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        controller.signal.removeEventListener('abort', abort);
        this.approvalWaiters.delete(call.id);
        budget.resume();
        if (error) reject(error);
        else resolve();
      };
      const abort = () => done(controller.signal.reason ?? new Error('Work canceled'));
      const timer = setTimeout(
        () => {
          this.facts.decideApproval(approval.id, 'expired');
          controller.abort(
            new ApplicationError('APPROVAL_EXPIRED', 'Command approval expired', 409),
          );
        },
        Math.max(0, Date.parse(approval.expiresAt) - Date.now()),
      );
      timer.unref();
      this.approvalWaiters.set(call.id, { approve: () => done() });
      controller.signal.addEventListener('abort', abort, { once: true });
      if (controller.signal.aborted) abort();
    });
  }

  private async executeReviewedCommand(
    runId: string,
    input: AiInput,
    workspace: AiWorkspace,
    command: string,
    adapter: ModelProvider,
    model: string,
    timeoutMs: number,
    controller: AbortController,
    budget: AiWorkBudget,
  ) {
    let call: AiToolCall | undefined;
    let complete: (() => void) | undefined;
    try {
      const step = budget.next();
      const secrets = await this.knownAiSecrets(controller.signal);
      if (redact(command, secrets) !== command)
        throw new ApplicationError('AI_SECRET_BOUNDARY', 'Command contains a credential', 409);
      // Validate that the original target is still live before reviewing or waiting.
      const current = await this.workspace(workspace.terminalId);
      if (
        current.connectionId !== workspace.connectionId ||
        current.terminalKind !== workspace.terminalKind
      )
        throw new ApplicationError('PRECONDITION_FAILED', 'Work target changed', 412);
      call = this.facts.createToolCall({
        runId,
        toolName: 'workspace.exec',
        args: aiToolCallSchema.shape.args.parse({ command, workspace }),
        target: workspace.terminalId,
        risk: 'mutating',
        argsHash: stableHash({ runId, command, workspace }),
        state: 'proposed',
      });
      this.commandCompletions.set(
        call.id,
        new Promise<void>((resolve) => {
          complete = resolve;
        }),
      );
      call = this.facts.updateCommandCall(call.id, {
        step,
        review: {
          status: 'pending',
          decision: 'ask_user',
          riskLevel: 'high',
          userAuthorization: 'unknown',
          reason: 'Reviewing this command.',
          source: 'rules',
          generation: this.commandGeneration,
          policyVersion: COMMAND_POLICY_VERSION,
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        },
      });
      this.emit({ runId, type: 'tool', data: call });
      const review = await this.reviewer.review({
        command,
        workspace,
        modelId: input.modelId,
        model,
        generation: this.commandGeneration,
        messages: [
          ...(input.conversationId && input.includeConversationHistory !== false
            ? this.repository.listAiContextMessages(input.conversationId).messages
            : []),
          { role: 'user', content: input.prompt },
        ],
        adapter,
        signal: controller.signal,
        timeoutMs,
        secrets,
        usage: (event) =>
          this.emit({ runId, type: 'usage', data: { type: 'usage', purpose: 'review', ...event } }),
      });
      controller.signal.throwIfAborted();
      review.expiresAt = new Date(
        Date.now() + (review.decision === 'ask_user' ? 10 * 60_000 : 60_000),
      ).toISOString();
      const risk: AiToolCall['risk'] =
        review.riskLevel === 'low'
          ? 'read_only'
          : review.riskLevel === 'medium'
            ? 'mutating'
            : /\b(?:sudo|su|doas|Set-Acl)\b/iu.test(command)
              ? 'privileged'
              : 'destructive';
      call = this.facts.updateCommandCall(call.id, { step, risk, review });
      call = this.facts.updateCommandCall(call.id, {
        argsHash: this.commandHash(call, review.expiresAt),
      });
      this.emit({ runId, type: 'tool', data: call });
      if (review.decision === 'reject')
        throw new ApplicationError('AI_POLICY_REJECTED', review.reason, 409);
      if (review.decision === 'ask_user')
        await this.waitForCommandApproval(call, controller, budget);
      controller.signal.throwIfAborted();
      const bound = this.repository.getToolCall(call.id);
      if (
        bound.argsHash !== this.commandHash(bound, review.expiresAt) ||
        bound.approvalSource ||
        bound.state !== (review.decision === 'auto_approve' ? 'proposed' : 'waiting_approval') ||
        bound.review?.generation !== this.commandGeneration ||
        Date.parse(review.expiresAt) <= Date.now()
      )
        throw new ApplicationError(
          'PRECONDITION_FAILED',
          'Command decision changed or expired',
          412,
        );
      call = this.facts.updateCommandCall(call.id, {
        approvalSource: review.decision === 'auto_approve' ? 'automatic' : 'user',
      });
      this.facts.updateToolCall(call.id, 'running');
      this.update(runId, 'running');
      this.emit({ runId, type: 'tool', data: this.repository.getToolCall(call.id) });
      const execution = await this.tools.execute(
        call.toolName,
        call.args,
        call.target,
        controller.signal,
      );
      controller.signal.throwIfAborted();
      const safe = sanitizeToolResult(execution, secrets) as Record<string, unknown>;
      const isError = typeof safe.exitCode === 'number' && safe.exitCode !== 0;
      this.facts.updateToolCall(call.id, isError ? 'failed' : 'succeeded', safe);
      this.emit({ runId, type: 'tool', data: this.repository.getToolCall(call.id) });
      const text = JSON.stringify(safe);
      const buffer = Buffer.from(text);
      return {
        text:
          buffer.length > 16 * 1024
            ? buffer.subarray(0, 16 * 1024 - 40).toString('utf8') + '\n[tool output truncated]'
            : text,
        isError,
      };
    } catch (error) {
      const failure =
        controller.signal.reason instanceof ApplicationError ? controller.signal.reason : error;
      const code = failure instanceof ApplicationError ? failure.code : 'AI_TOOL_FAILED';
      const state =
        controller.signal.aborted && code !== 'AI_RUNTIME_LIMIT' ? 'canceled' : 'failed';
      if (
        call &&
        !['succeeded', 'failed', 'canceled'].includes(this.repository.getToolCall(call.id).state)
      )
        this.facts.updateToolCall(call.id, state, { code });
      if (!['failed', 'canceled'].includes(this.get(runId).state))
        this.update(runId, state, undefined, code);
      throw error;
    } finally {
      complete?.();
      if (call) this.commandCompletions.delete(call.id);
    }
  }

  private update(id: string, state: AiRun['state'], result?: string, errorCode?: string) {
    const current = this.repository.getAiRun(id);
    if (current.state === state && result === undefined && errorCode === undefined) {
      this.emit({ runId: id, type: 'state', data: current });
      return current;
    }
    const run = this.facts.updateAiRun(id, state, result ?? this.partialResults.get(id), errorCode);
    if (['succeeded', 'failed', 'canceled'].includes(run.state)) {
      this.ownedRuns.delete(id);
      for (const runs of this.sourceRuns.values()) runs.delete(id);
    }
    this.emit({ runId: id, type: 'state', data: run });
    return run;
  }
  private emit(event: AiRunEvent) {
    event = aiRunEventSchema.parse(event);
    if (event.type === 'usage') {
      const data = event.data;
      this.facts.usage(event.runId, data);
    }
    this.realtime.publish(`ai.run.${event.type}`, event);
    for (const listener of this.listeners.get(event.runId) ?? []) {
      try {
        listener(event);
      } catch {
        /* Observers cannot change committed facts or authorize effects. */
      }
    }
  }
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    this.reviewKey.fill(0);
    this.lifetime.abort();
    for (const controller of this.controllers.values()) controller.abort();
    return (this.closing = (async () => {
      await Promise.allSettled([...this.setups]);
      for (const runId of this.ownedRuns) {
        const run = this.repository.getAiRun(runId);
        if (!['succeeded', 'failed', 'canceled'].includes(run.state)) this.cancel(runId);
      }
      await Promise.allSettled([...this.tasks, ...this.contextRequests]);
      this.controllers.clear();
      this.partialResults.clear();
      this.listeners.clear();
      this.preparedAttachments.clear();
    })());
  }
  private setup<T>(apply: () => Promise<T>): Promise<T> {
    if (this.closed)
      return Promise.reject(
        new ApplicationError('CAPABILITY_UNAVAILABLE', 'AI service is closed', 503),
      );
    if (this.setups.size >= 64)
      return Promise.reject(new ApplicationError('CAPACITY_EXCEEDED', 'AI setup capacity reached'));
    const task = Promise.resolve().then(apply);
    this.setups.add(task);
    void task.then(
      () => this.setups.delete(task),
      () => this.setups.delete(task),
    );
    return task;
  }

  private resolveAttachments(ids: readonly string[]): PreparedAiAttachment[] {
    this.purgeAttachments();
    if (new Set(ids).size !== ids.length)
      throw new ApplicationError('VALIDATION_ERROR', 'Attachment IDs must be unique', 400);
    const attachments = ids.map((id) => {
      const attachment = this.preparedAttachments.get(id);
      if (!attachment)
        throw new ApplicationError(
          'ATTACHMENT_EXPIRED',
          'An attachment draft expired or belongs to another Runtime generation',
          409,
        );
      return attachment;
    });
    const total = attachments.reduce((sum, attachment) => sum + attachment.preview.size, 0);
    if (total > AI_ATTACHMENT_TOTAL_BYTES)
      throw new ApplicationError(
        'PAYLOAD_TOO_LARGE',
        `Attachment source files must not exceed ${AI_ATTACHMENT_TOTAL_BYTES} bytes in total`,
        413,
      );
    return attachments;
  }

  private purgeAttachments(): void {
    const now = Date.now();
    for (const [id, attachment] of this.preparedAttachments)
      if (Date.parse(attachment.preview.expiresAt) <= now) this.preparedAttachments.delete(id);
  }

  activeTaskCount(): number {
    return this.setups.size + this.tasks.size + this.ownedRuns.size;
  }
  /** A terminal Run fact can precede actual provider/tool cleanup. Join the owned execution. */
  async drainRun(id: string): Promise<void> {
    this.get(id);
    while (this.runTasks.get(id)?.size) await Promise.allSettled([...this.runTasks.get(id)!]);
  }
  private track(apply: () => Promise<void>, runId?: string): Promise<void> {
    const task = Promise.resolve().then(apply);
    this.tasks.add(task);
    const sources: Set<Promise<void>>[] = [];
    if (runId) {
      const tasks = this.runTasks.get(runId) ?? new Set<Promise<void>>();
      this.runTasks.set(runId, tasks);
      tasks.add(task);
      sources.push(tasks);
    }
    if (runId)
      for (const [sourceId, runs] of this.sourceRuns)
        if (runs.has(runId)) {
          const selected = this.sourceTasks.get(sourceId) ?? new Set<Promise<void>>();
          this.sourceTasks.set(sourceId, selected);
          selected.add(task);
          sources.push(selected);
        }
    const release = () => {
      this.tasks.delete(task);
      for (const source of sources) source.delete(task);
      if (runId && !this.runTasks.get(runId)?.size) this.runTasks.delete(runId);
    };
    void task.then(release, release);
    return task;
  }

  private async adapter(provider: AiProvider, signal?: AbortSignal): Promise<AiModelProvider> {
    const model = this.repository
      .listJson<AiModel>('ai_models')
      .find(({ providerId }) => providerId === provider.id)?.model;
    return this.models.create(provider, model, signal);
  }
}

function attachmentMetadataOf(value: AiAttachmentPreview): AiAttachmentMetadata {
  return {
    name: value.name,
    size: value.size,
    includedBytes: value.includedBytes,
    truncated: value.truncated,
  };
}

function normalizeAttachmentName(value: string): string {
  const name = value
    // Attachment display names cannot retain terminal control characters.
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/gu, ' ')
    .trim()
    .slice(0, 255);
  return name || 'attachment.txt';
}

function normalizeBookmarkResult(value: string): string {
  const candidate = value.match(/^\s*```(?:json)?\s*([\s\S]*?)\s*```\s*$/iu)?.[1] ?? value;
  try {
    return JSON.stringify(aiBookmarkDraftSchema.parse(JSON.parse(candidate)));
  } catch {
    throw new ApplicationError(
      'AI_OUTPUT_INVALID',
      'AI bookmark output did not match the safe bookmark schema',
      400,
    );
  }
}

function normalizeThemeResult(value: string): string {
  try {
    return JSON.stringify(parseAiThemeDraft(value));
  } catch {
    throw new ApplicationError(
      'AI_OUTPUT_INVALID',
      'AI theme output did not match the safe readable theme schema',
      400,
    );
  }
}

function sanitizeToolResult(value: unknown, secrets: readonly string[]): unknown {
  const encoded = JSON.stringify(value);
  if (!encoded || Buffer.byteLength(encoded) > 256 * 1024)
    throw new ApplicationError('CAPACITY_EXCEEDED', 'AI tool result too large');
  const visit = (value: unknown, depth = 0): unknown => {
    if (depth > 32) throw new ApplicationError('CAPACITY_EXCEEDED', 'AI tool result too deep');
    if (typeof value === 'string') return redact(value, secrets);
    if (Array.isArray(value)) return value.map((item) => visit(item, depth + 1));
    if (value && typeof value === 'object')
      return Object.fromEntries(
        Object.entries(value).map(([key, item]) => [redact(key, secrets), visit(item, depth + 1)]),
      );
    return value;
  };
  return visit(JSON.parse(encoded));
}
