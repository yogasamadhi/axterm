import {
  DEFAULT_AI_ROLE,
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
  type AiToolCall,
} from '@workspace/contracts';
import type { HostCapabilityClient } from '../adapters/host-capability/client';
import { OpenAiCompatibleProvider } from '../adapters/ai/openai-compatible';
import type { ProductRepository } from '../adapters/sqlite/product-repository';
import { stableHash } from '../adapters/sqlite/product-repository';
import type { RealtimeHub } from './realtime-hub';
import type { AiToolService } from './ai-tool-service';
import { ApplicationError } from './errors';
import type { McpToolInvocation } from '../ports/widget-server';

export interface AiRunEvent {
  runId: string;
  type: 'snapshot' | 'delta' | 'state' | 'usage' | 'tool';
  data: unknown;
}
type AiInput = {
  modelId: string;
  conversationId?: string | undefined;
  useCase: AiRun['useCase'];
  prompt: string;
  context: string;
  attachmentIds?: string[] | undefined;
  terminalId?: string | undefined;
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
  private readonly controllers = new Map<string, AbortController>();
  private readonly listeners = new Map<string, Set<(event: AiRunEvent) => void>>();
  private readonly tasks = new Set<Promise<void>>();
  private readonly preparedAttachments = new Map<string, PreparedAiAttachment>();
  constructor(
    private readonly repository: ProductRepository,
    private readonly host: HostCapabilityClient | undefined,
    private readonly realtime: RealtimeHub,
    private readonly tools: AiToolService,
  ) {}

  start(input: AiInput, idempotencyKey: string | undefined): AiRun {
    if (!idempotencyKey)
      throw new ApplicationError('PRECONDITION_REQUIRED', 'Idempotency-Key is required', 428);
    const previous = this.repository.resolveIdempotency<AiRun>(idempotencyKey, 'ai-run', input);
    if (previous) return previous;
    const attachments = this.resolveAttachments(input.attachmentIds ?? []);
    if (!input.prompt.trim() && !attachments.length)
      throw new ApplicationError('VALIDATION_ERROR', 'A prompt or attachment is required', 400);
    if (input.tool && attachments.length)
      throw new ApplicationError(
        'VALIDATION_ERROR',
        'Attachments cannot be combined with a direct tool proposal',
        400,
      );
    const history = input.conversationId
      ? this.repository
          .listAiMessages(input.conversationId)
          .map((message) => `${message.role === 'user' ? 'User' : 'Assistant'}: ${message.content}`)
          .join('\n\n')
      : '';
    const baseContext = redact([history, input.context].filter(Boolean).join('\n\n')).slice(
      -24_576,
    );
    const attachmentContext = buildAttachmentsBlock(attachments);
    const safe: AiInput = {
      ...input,
      prompt: redact(input.prompt),
      context: [baseContext, attachmentContext].filter(Boolean).join('\n\n').slice(-131_072),
      attachmentIds: [],
    };
    const attachmentMetadata = attachments.map(({ preview }) => attachmentMetadataOf(preview));
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
    this.repository.recordIdempotency(idempotencyKey, 'ai-run', input, run);
    this.track(safe.tool ? this.runTool(run.id, safe.tool) : this.runModel(run.id, safe));
    return run;
  }

  async prepareAttachment(grantId: string, signal?: AbortSignal): Promise<AiAttachmentPreview> {
    if (!this.host)
      throw new ApplicationError(
        'CAPABILITY_UNAVAILABLE',
        'Desktop file capabilities are unavailable',
        503,
      );
    this.purgeAttachments();
    if (this.preparedAttachments.size >= AI_ATTACHMENT_DRAFT_CAPACITY)
      throw new ApplicationError(
        'CAPACITY_EXCEEDED',
        'Too many attachment drafts are already open',
        409,
      );
    try {
      const file = await this.host.readGrantedTextPrefix(
        grantId,
        AI_ATTACHMENT_FILE_BYTES,
        AI_ATTACHMENT_TOTAL_BYTES,
        signal,
      );
      if (signal?.aborted)
        throw new ApplicationError('REQUEST_CANCELED', 'Attachment preparation was canceled', 409);
      const content = redact(file.content);
      const preview: AiAttachmentPreview = {
        id: crypto.randomUUID(),
        name: normalizeAttachmentName(file.name),
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
    return this.repository.getAiRun(id);
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
    const listeners = this.listeners.get(runId) ?? new Set();
    listeners.add(listener);
    this.listeners.set(runId, listeners);
    listener({ runId, type: 'snapshot', data: this.get(runId) });
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
    if (Date.parse(approval.expiresAt) <= Date.now()) {
      this.repository.decideApproval(id, 'expired');
      this.repository.updateToolCall(call.id, 'canceled', { code: 'APPROVAL_EXPIRED' });
      this.update(call.runId, 'canceled', undefined, 'APPROVAL_EXPIRED');
      throw new ApplicationError('APPROVAL_EXPIRED', 'Approval expired', 409);
    }
    if (stableHash({ args: call.args, target: call.target }) !== approval.argsHash)
      throw new ApplicationError('PRECONDITION_FAILED', 'Tool arguments changed', 412);
    if (input.decision === 'reject') {
      this.repository.decideApproval(id, 'rejected');
      this.repository.updateToolCall(call.id, 'canceled');
      return this.update(call.runId, 'canceled');
    }
    this.repository.decideApproval(id, 'approved');
    await this.executeTool(call);
    return this.get(call.runId);
  }

  private async runTool(
    runId: string,
    proposal: { name: string; args: Record<string, unknown>; target: string },
  ) {
    try {
      const risk = this.tools.risk(proposal.name);
      const argsHash = stableHash({ args: proposal.args, target: proposal.target });
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
          expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
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
      const result = await this.tools.execute(
        call.toolName,
        call.args,
        call.target,
        controller.signal,
      );
      if (controller.signal.aborted) return;
      const safeResult = JSON.parse(redact(JSON.stringify(result))) as Record<string, unknown>;
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

  private async runModel(runId: string, input: AiInput) {
    const controller = new AbortController();
    this.controllers.set(runId, controller);
    this.update(runId, 'running');
    let result = '';
    try {
      const model = this.repository.getJson<AiModel>('ai_models', input.modelId);
      const provider = this.repository.getJson<AiProvider>('ai_providers', model.providerId);
      if (!provider.enabled)
        throw new ApplicationError('CAPABILITY_UNAVAILABLE', 'AI provider is disabled', 503);
      if (!this.host)
        throw new ApplicationError(
          'CAPABILITY_UNAVAILABLE',
          'Credential vault is unavailable',
          503,
        );
      const adapter = await this.adapter(provider);
      for await (const event of adapter.stream({
        model: model.model,
        system: `${provider.role || DEFAULT_AI_ROLE}\n\n${systemPrompt(input.useCase)}`,
        prompt: input.prompt,
        context: input.context,
        signal: controller.signal,
      })) {
        if (event.type === 'delta') {
          result += event.text;
          if (result.length > 2 * 1024 * 1024) throw new Error('AI result exceeded limit');
          this.emit({ runId, type: 'delta', data: { text: event.text } });
        } else if (event.type === 'usage') this.emit({ runId, type: 'usage', data: event });
        else if (event.type === 'toolCallDelta') this.emit({ runId, type: 'tool', data: event });
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
      const partialResult = ['createBookmark', 'createTheme'].includes(input.useCase)
        ? undefined
        : result || undefined;
      if (controller.signal.aborted) this.update(runId, 'canceled', partialResult);
      else
        this.update(
          runId,
          'failed',
          partialResult,
          error instanceof ApplicationError ? error.code : 'AI_PROVIDER_FAILED',
        );
    } finally {
      this.controllers.delete(runId);
    }
  }

  private update(id: string, state: AiRun['state'], result?: string, errorCode?: string) {
    const run = this.repository.updateAiRun(id, state, result, errorCode);
    this.emit({ runId: id, type: 'state', data: run });
    return run;
  }
  private emit(event: AiRunEvent) {
    this.realtime.publish(`ai.run.${event.type}`, event);
    for (const listener of this.listeners.get(event.runId) ?? []) listener(event);
  }
  async close() {
    for (const controller of this.controllers.values()) controller.abort();
    await Promise.allSettled(this.tasks);
    this.controllers.clear();
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

  private async adapter(provider: AiProvider): Promise<OpenAiCompatibleProvider> {
    if (!this.host)
      throw new ApplicationError('CAPABILITY_UNAVAILABLE', 'Credential vault is unavailable', 503);
    const apiKey = await this.host.resolveCredential(provider.credentialRef);
    const proxy = provider.proxy
      ? {
          url: provider.proxy.url,
          username: provider.proxy.username,
          ...(provider.proxy.credentialRef
            ? { password: await this.host.resolveCredential(provider.proxy.credentialRef) }
            : {}),
        }
      : null;
    return new OpenAiCompatibleProvider(provider.baseUrl, apiKey, {
      protocol: provider.protocol,
      apiPath: provider.apiPath,
      auth: provider.auth,
      proxy,
      timeoutMs: provider.timeoutMs,
    });
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

function buildAttachmentsBlock(attachments: readonly PreparedAiAttachment[]): string {
  return attachments
    .map(({ preview, content }) => {
      const name = preview.name.replace(/[&<>"']/gu, (character) => {
        const entities: Record<string, string> = {
          '&': '&amp;',
          '<': '&lt;',
          '>': '&gt;',
          '"': '&quot;',
          "'": '&apos;',
        };
        return entities[character]!;
      });
      const truncated = preview.truncated ? ' truncated="true"' : '';
      return `<file name="${name}"${truncated}>\n${content}${
        preview.truncated ? '\n...[truncated]' : ''
      }\n</file>`;
    })
    .join('\n\n');
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

export function redact(value: string): string {
  return value
    .replace(
      /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
      '[REDACTED_PRIVATE_KEY]',
    )
    .replace(/\b(Bearer\s+)[A-Za-z0-9._~+/-]{12,}/gi, '$1[REDACTED]')
    .replace(
      /\b(api[_-]?key|password|passphrase|token|secret)\s*[:=]\s*[^\s,;]+/gi,
      '$1=[REDACTED]',
    );
}
function systemPrompt(useCase: AiRun['useCase']) {
  const prompts = {
    explainCommand:
      'Explain the command accurately and call out material effects. Do not execute it.',
    explainOutput: 'Explain the supplied terminal output and suggest safe next checks.',
    generateCommand: 'Generate a command for review. Never claim it was executed.',
    createBookmark:
      'Return only one JSON object for an SSH bookmark with exactly these keys: name, title, hostname, port, username, authType, description, favorite. authType must be password, privateKey, keyboardInteractive, or agent. Never include a password, private key, passphrase, token, credential, command, markdown fence, or any additional key. Use only facts supplied by the user; choose conservative SSH defaults for omitted non-secret fields.',
    createTheme:
      'Return only one JSON object with exactly name, terminal, and ui. terminal must contain exactly foreground, background, cursor, cursorAccent, selectionBackground, black, red, green, yellow, blue, magenta, cyan, white, brightBlack, brightRed, brightGreen, brightYellow, brightBlue, brightMagenta, brightCyan, brightWhite. ui must contain exactly main, main-dark, main-light, text, text-light, text-dark, text-disabled, primary, info, success, error, warn. Use #rrggbb for UI colors and #rrggbb or valid rgba() for terminal colors. Keep terminal foreground/background and UI text/main contrast at least 4.5:1. Output no markdown, comments, CSS, URLs, images, commands, or extra keys.',
    diagnose: 'Diagnose from the bounded context. State uncertainty and propose ordered checks.',
  };
  return prompts[useCase];
}
