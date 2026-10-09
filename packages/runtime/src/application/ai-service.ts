import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { buildAiModelContext, redact } from './ai-context';
export { redact } from './ai-context';
import {
  aiContextPreviewRequestSchema,
  aiRunEventSchema,
  type AiContextPreview,
  type AiContextPreviewInput,
  aiBookmarkDraftSchema,
  aiTerminalThemeDraftSchema,
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
} from '@workspace/contracts';
import type { HostCapabilityClient } from '../adapters/host-capability/client';
import { PiModelProvider, piCatalog, piSkillCatalog } from '../adapters/ai/pi-provider';
import type { ProductRepository } from '../adapters/sqlite/product-repository';
import { stableHash } from '../adapters/sqlite/product-repository';
import type { RealtimeHub } from './realtime-hub';
import type { AiToolService } from './ai-tool-service';
import type { AiWorkspaceService } from './ai-workspace-service';
import { ApplicationError } from './errors';
import { reviewCommand, COMMAND_POLICY_VERSION } from '../adapters/ai/command-review';
import { AiWorkBudget } from './ai-work-budget';
import type { ModelProvider } from '../ports/model-provider';
import type { McpToolInvocation } from '../ports/widget-server';

export type { AiRunEvent } from '@workspace/contracts';
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
    return piSkillCatalog();
  }
  catalog() {
    return piCatalog();
  }
  private readonly reviewKey = randomBytes(32);
  private closed = false;
  private readonly lifetime = new AbortController();
  private readonly contextRequests = new Set<Promise<string[]>>();
  private readonly controllers = new Map<string, AbortController>();
  private readonly listeners = new Map<string, Set<(event: AiRunEvent) => void>>();
  private readonly partialResults = new Map<string, string>();
  private readonly tasks = new Set<Promise<void>>();
  private readonly preparedAttachments = new Map<string, PreparedAiAttachment>();
  private readonly workTargets = new Map<string, string>();
  private readonly approvalWaiters = new Map<string, { approve(): void }>();
  private readonly commandCompletions = new Map<string, Promise<void>>();
  constructor(
    private readonly repository: ProductRepository,
    private readonly host: HostCapabilityClient | undefined,
    private readonly realtime: RealtimeHub,
    private readonly tools: AiToolService,
    private readonly workspaces?: AiWorkspaceService,
    private readonly commandGeneration = randomBytes(16).toString('hex'),
  ) {}

  workspace(terminalId: string) {
    if (!this.workspaces)
      throw new ApplicationError('CAPABILITY_UNAVAILABLE', 'AI workspace unavailable', 503);
    return this.workspaces.resolve(terminalId);
  }

  async start(
    input: AiInput,
    idempotencyKey: string | undefined,
    signal?: AbortSignal,
  ): Promise<AiRun> {
    if (this.closed)
      throw new ApplicationError('CAPABILITY_UNAVAILABLE', 'AI Runtime is closed', 503);
    if (!idempotencyKey)
      throw new ApplicationError('PRECONDITION_REQUIRED', 'Idempotency-Key is required', 428);
    const knownSecrets = input.tool ? [] : await this.knownAiSecrets(signal);
    if (this.closed)
      throw new ApplicationError('CAPABILITY_UNAVAILABLE', 'AI Runtime is closed', 503);
    if (signal?.aborted)
      throw new ApplicationError('REQUEST_CANCELED', 'AI request was canceled', 409);
    const previous = this.repository.resolveIdempotency<AiRun>(idempotencyKey, 'ai-run', input);
    if (previous) return previous;
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
    const baseContext = built.baseContext;
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
    const committed = this.repository.resolveIdempotency<AiRun>(
      idempotencyKey,
      'ai-run',
      idempotencyInput,
    );
    if (committed) return committed;
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
    const run = this.repository.createAiRun({
      useCase: input.useCase,
      request: { ...safe, context: baseContext, attachments: attachmentMetadata },
      ...(input.conversationId
        ? {
            conversation: {
              id: input.conversationId,
              prompt: safe.prompt,
              attachments: attachmentMetadata,
            },
          }
        : {}),
    });
    for (const id of input.attachmentIds ?? []) this.preparedAttachments.delete(id);
    this.repository.recordIdempotency(idempotencyKey, 'ai-run', idempotencyInput, run);
    if (isWork) this.workTargets.set(workTarget!, run.id);
    this.track(
      safe.tool && safe.tool.name !== 'workspace.exec'
        ? this.runTool(run.id, safe.tool)
        : this.runModel(run.id, safe, built.system),
    );
    return run;
  }

  async previewContext(
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

  async prepareAttachment(grantId: string, signal?: AbortSignal): Promise<AiAttachmentPreview> {
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
      await this.host.revokeGrant(grantId).catch(() => undefined);
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
    const approvals = this.repository.listApprovals();
    for (const approval of approvals) {
      if (approval.state !== 'pending' || Date.parse(approval.expiresAt) > Date.now()) continue;
      const call = this.repository.getToolCall(approval.toolCallId);
      this.repository.decideApproval(approval.id, 'expired');
      if (call.review)
        this.controllers
          .get(call.runId)
          ?.abort(new ApplicationError('APPROVAL_EXPIRED', 'Approval expired', 409));
      if (!['succeeded', 'failed', 'canceled'].includes(call.state))
        this.repository.updateToolCall(call.id, 'canceled', { code: 'APPROVAL_EXPIRED' });
      const run = this.get(call.runId);
      if (!['succeeded', 'failed', 'canceled'].includes(run.state))
        this.update(call.runId, 'canceled', undefined, 'APPROVAL_EXPIRED');
    }
    return this.repository.listApprovals();
  }

  async invokeRegisteredTool(
    proposal: { name: string; args: Record<string, unknown>; target: string },
    idempotencyKey: string,
  ): Promise<McpToolInvocation> {
    const request = { source: 'mcp', tool: proposal };
    const previous = this.repository.resolveIdempotency<AiRun>(
      idempotencyKey,
      'mcp-tool-call',
      request,
    );
    if (previous) return this.mcpInvocation(previous.id);
    const run = this.repository.createAiRun({ useCase: 'diagnose', request });
    this.repository.recordIdempotency(idempotencyKey, 'mcp-tool-call', request, run);
    await this.runTool(run.id, proposal);
    return this.mcpInvocation(run.id);
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
    this.repository.getJson<AiModel>('ai_models', input.modelId);
    return this.repository.createAiConversation(input);
  }

  updateConversation(id: string, input: AiConversationPatch, ifMatch: string | undefined) {
    if (input.modelId) this.repository.getJson<AiModel>('ai_models', input.modelId);
    return this.repository.updateAiConversation(id, input, ifMatch);
  }

  deleteConversation(id: string, ifMatch: string | undefined) {
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

  async testProvider(id: string, signal?: AbortSignal): Promise<AiProviderTestResult> {
    const provider = this.repository.getJson<AiProvider>('ai_providers', id);
    if (!provider.enabled)
      throw new ApplicationError('CAPABILITY_UNAVAILABLE', 'AI provider is disabled', 503);
    const startedAt = Date.now();
    try {
      const adapter = await this.adapter(provider);
      const models = await adapter.listModels(signal);
      return {
        providerId: provider.id,
        protocol: provider.protocol ?? 'openai-chat',
        ok: true,
        latencyMs: Date.now() - startedAt,
        models,
      };
    } catch (error) {
      if (signal?.aborted)
        throw new ApplicationError('REQUEST_CANCELED', 'AI provider test was canceled', 409);
      throw new ApplicationError(
        'AI_PROVIDER_FAILED',
        error instanceof Error ? error.message : 'AI provider test failed',
        409,
      );
    }
  }

  subscribe(runId: string, listener: (event: AiRunEvent) => void): () => void {
    const run = this.get(runId);
    const listeners = this.listeners.get(runId) ?? new Set();
    listeners.add(listener);
    this.listeners.set(runId, listeners);
    listener({ runId, type: 'snapshot', data: run });
    return () => {
      listeners.delete(listener);
      if (!listeners.size) this.listeners.delete(runId);
    };
  }

  cancel(id: string) {
    this.controllers.get(id)?.abort(new Error('AI run canceled'));
    const run = this.get(id);
    if (['succeeded', 'failed', 'canceled'].includes(run.state)) return;
    for (const approval of this.repository
      .listApprovals()
      .filter((item) => item.runId === id && item.state === 'pending'))
      this.repository.decideApproval(approval.id, 'rejected');
    for (const call of this.repository
      .listToolCalls(id)
      .filter((item) => !['succeeded', 'failed', 'canceled'].includes(item.state)))
      this.repository.updateToolCall(call.id, 'canceled', { code: 'REQUEST_CANCELED' });
    this.update(id, 'canceled');
  }

  async decideApproval(
    id: string,
    input: { decision: 'approve_once' | 'reject'; argsHash: string },
  ) {
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
      this.repository.decideApproval(id, 'expired');
      if (call.review)
        this.controllers
          .get(call.runId)
          ?.abort(new ApplicationError('APPROVAL_EXPIRED', 'Approval expired', 409));
      this.repository.updateToolCall(call.id, 'canceled', { code: 'APPROVAL_EXPIRED' });
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
        this.cancel(call.runId);
        return this.get(call.runId);
      }
      this.repository.decideApproval(id, 'approved');
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
    if (input.decision === 'reject') {
      this.repository.decideApproval(id, 'rejected');
      this.repository.updateToolCall(call.id, 'canceled');
      return this.update(call.runId, 'canceled');
    }
    this.repository.decideApproval(id, 'approved');
    const task = this.executeTool(call);
    this.track(task);
    await task;
    return this.get(call.runId);
  }

  private async runTool(
    runId: string,
    proposal: { name: string; args: Record<string, unknown>; target: string },
  ) {
    try {
      const risk = this.tools.risk(proposal.name);
      const expiresAt =
        risk === 'read_only' ? null : new Date(Date.now() + 10 * 60_000).toISOString();
      const argsHash = stableHash({
        toolName: proposal.name,
        args: proposal.args,
        target: proposal.target,
        risk,
        expiresAt,
      });
      const call = this.repository.createToolCall({
        runId,
        toolName: proposal.name,
        risk,
        argsHash,
        args: proposal.args,
        target: proposal.target,
        state: risk === 'read_only' ? 'running' : 'waiting_approval',
      });
      if (risk === 'read_only') await this.executeTool(call);
      else {
        const approval = this.repository.createApproval({
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
    this.controllers.set(call.runId, controller);
    this.repository.updateToolCall(call.id, 'running');
    this.update(call.runId, 'running');
    try {
      const knownSecrets =
        call.toolName === 'workspace.exec' ? await this.knownAiSecrets(controller.signal) : [];
      controller.signal.throwIfAborted();
      const result = await this.tools.execute(
        call.toolName,
        call.args,
        call.target,
        controller.signal,
      );
      if (controller.signal.aborted) return;
      const safeResult = JSON.parse(redact(JSON.stringify(result), knownSecrets)) as Record<
        string,
        unknown
      >;
      this.repository.updateToolCall(call.id, 'succeeded', safeResult);
      this.update(call.runId, 'succeeded', JSON.stringify(safeResult));
    } catch (error) {
      if (!controller.signal.aborted) {
        this.repository.updateToolCall(call.id, 'failed', { code: 'TOOL_EXECUTION_FAILED' });
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

  private async runModel(runId: string, input: AiInput, system: string) {
    const controller = new AbortController();
    this.controllers.set(runId, controller);
    this.update(runId, 'running');
    let result = '';
    const working =
      this.workTargets.get(input.workspace?.terminalId ?? input.tool?.target ?? '') === runId;
    const budget = working ? new AiWorkBudget(controller) : undefined;
    let targetTimer: ReturnType<typeof setInterval> | undefined;
    try {
      let model: AiModel | undefined;
      let provider: AiProvider | undefined;
      try {
        model = this.repository.getJson<AiModel>('ai_models', input.modelId);
        provider = this.repository.getJson<AiProvider>('ai_providers', model.providerId);
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
      for await (const event of adapter.stream({
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
          result += event.text;
          if (result.length > 2 * 1024 * 1024) throw new Error('AI result exceeded limit');
          if (!['createBookmark', 'createTheme'].includes(input.useCase))
            this.partialResults.set(runId, result);
          this.emit({ runId, type: 'delta', data: { text: event.text } });
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
      this.update(
        runId,
        'succeeded',
        input.useCase === 'createBookmark'
          ? normalizeBookmarkResult(result)
          : input.useCase === 'createTheme'
            ? normalizeThemeResult(result)
            : result,
      );
    } catch (error) {
      if (['succeeded', 'failed', 'canceled'].includes(this.get(runId).state)) return;
      const partialResult = ['createBookmark', 'createTheme'].includes(input.useCase)
        ? undefined
        : result || undefined;
      if (controller.signal.aborted) {
        const reason = controller.signal.reason;
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
      clearInterval(targetTimer);
      budget?.close();
      for (const [target, id] of this.workTargets)
        if (id === runId) this.workTargets.delete(target);
      this.controllers.delete(runId);
      this.partialResults.delete(runId);
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
    const approval = this.repository.createApproval({
      runId: call.runId,
      toolCallId: call.id,
      argsHash: call.argsHash,
      target: call.target,
      expiresAt: call.review!.expiresAt,
    });
    this.repository.updateToolCall(call.id, 'waiting_approval');
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
          this.repository.decideApproval(approval.id, 'expired');
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
      call = this.repository.createToolCall({
        runId,
        toolName: 'workspace.exec',
        args: { command, workspace },
        target: workspace.terminalId,
        risk: 'mutating',
        argsHash: '',
        state: 'proposed',
      });
      this.commandCompletions.set(
        call.id,
        new Promise<void>((resolve) => {
          complete = resolve;
        }),
      );
      call = this.repository.updateCommandCall(call.id, {
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
      const review = await reviewCommand({
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
      call = this.repository.updateCommandCall(call.id, { step, risk, review });
      call = this.repository.updateCommandCall(call.id, {
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
      call = this.repository.updateCommandCall(call.id, {
        approvalSource: review.decision === 'auto_approve' ? 'automatic' : 'user',
      });
      this.repository.updateToolCall(call.id, 'running');
      this.update(runId, 'running');
      this.emit({ runId, type: 'tool', data: this.repository.getToolCall(call.id) });
      const execution = await this.tools.execute(
        call.toolName,
        call.args,
        call.target,
        controller.signal,
      );
      controller.signal.throwIfAborted();
      const safe = JSON.parse(JSON.stringify(execution), (_key, value: unknown) =>
        typeof value === 'string' ? redact(value, secrets) : value,
      ) as Record<string, unknown>;
      const isError = typeof safe.exitCode === 'number' && safe.exitCode !== 0;
      this.repository.updateToolCall(call.id, isError ? 'failed' : 'succeeded', safe);
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
        this.repository.updateToolCall(call.id, state, { code });
      if (!['failed', 'canceled'].includes(this.get(runId).state))
        this.update(runId, state, undefined, code);
      throw error;
    } finally {
      complete?.();
      if (call) this.commandCompletions.delete(call.id);
    }
  }

  private update(id: string, state: AiRun['state'], result?: string, errorCode?: string) {
    const run = this.repository.updateAiRun(
      id,
      state,
      result ?? this.partialResults.get(id),
      errorCode,
    );
    this.emit({ runId: id, type: 'state', data: run });
    return run;
  }
  private emit(event: AiRunEvent) {
    event = aiRunEventSchema.parse(event);
    this.realtime.publish(`ai.run.${event.type}`, event);
    for (const listener of this.listeners.get(event.runId) ?? []) listener(event);
  }
  async close() {
    this.closed = true;
    this.reviewKey.fill(0);
    this.lifetime.abort();
    for (const controller of this.controllers.values()) controller.abort();
    await Promise.allSettled([...this.tasks, ...this.contextRequests]);
    this.controllers.clear();
    this.partialResults.clear();
    this.listeners.clear();
    this.preparedAttachments.clear();
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

  private track(task: Promise<void>) {
    this.tasks.add(task);
    void task.finally(() => this.tasks.delete(task));
  }

  private async adapter(provider: AiProvider, signal?: AbortSignal): Promise<PiModelProvider> {
    if (!this.host)
      throw new ApplicationError('CAPABILITY_UNAVAILABLE', 'Credential vault is unavailable', 503);
    const apiKey = await this.host.resolveCredential(provider.credentialRef, signal);
    const proxy = provider.proxy
      ? {
          url: provider.proxy.url,
          username: provider.proxy.username,
          ...(provider.proxy.credentialRef
            ? { password: await this.host.resolveCredential(provider.proxy.credentialRef, signal) }
            : {}),
        }
      : null;
    const headers: Record<string, string> = {};
    for (const [name, ref] of Object.entries(provider.pi?.headerCredentialRefs ?? {}))
      headers[name] = await this.host.resolveCredential(ref, signal);
    const testModel = this.repository
      .listJson<AiModel>('ai_models')
      .find(({ providerId }) => providerId === provider.id)?.model;
    return new PiModelProvider(provider, apiKey, proxy, headers, testModel);
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
  const candidate = value.match(/^\s*```(?:json)?\s*([\s\S]*?)\s*```\s*$/iu)?.[1] ?? value;
  try {
    return JSON.stringify(aiTerminalThemeDraftSchema.parse(JSON.parse(candidate)));
  } catch {
    throw new ApplicationError(
      'AI_OUTPUT_INVALID',
      'AI theme output did not match the safe readable theme schema',
      400,
    );
  }
}
