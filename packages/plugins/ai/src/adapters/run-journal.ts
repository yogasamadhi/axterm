import { z } from 'zod';
import { DomainCommands, commandPayloadHash } from '@axterm/infra-storage-domain';
import type { RelationalDomain } from '@axterm/plugin-api/storage';
import {
  aiToolCallSchema,
  aiUseCaseSchema,
  aiAttachmentMetadataSchema,
  type AiRun,
  type AiRunCommandOutcome,
  type AiToolCall,
  type AiApproval,
} from '@axterm/plugin-api/ai';
import { ApplicationError } from '../application/errors.ts';
import type { AiRepository } from './repository.ts';
import type { AiAdmission } from '../ports/facts.ts';

const engineId = z.string().regex(/^[a-z][a-z0-9.-]{0,127}$/);
const ownerSchema = z
  .object({
    profile: z.string().min(1).max(128),
    generation: z.uuid(),
    pid: z.number().int().min(1).max(0x7fffffff),
  })
  .strict();
export type AiRunOwner = z.infer<typeof ownerSchema>;
import { aiLogPayloadSchema, type AiLogPayload, type AiLogEntry } from '@axterm/plugin-api/ai';
export { aiLogPayloadSchema, type AiLogPayload, type AiLogEntry } from '@axterm/plugin-api/ai';
const text = z.string().max(128 * 1024);
interface IntentRow {
  command_id: string;
  profile_name: string;
  generation: string;
  owner_pid: number;
  run_id: string | null;
  state: string;
}
const activeStates = "('queued','running','waiting_approval','uncertain')";

/** Fact admission is atomic; the returned admitted flag is the sole permission to start new IO. */
export class AiRunJournal {
  private readonly commands: DomainCommands;
  private readonly owner: Readonly<AiRunOwner>;
  constructor(
    private readonly domain: RelationalDomain,
    private readonly repository: AiRepository,
    owner: AiRunOwner,
    private readonly redact: (text: string) => string,
  ) {
    this.owner = Object.freeze(ownerSchema.parse(owner));
    this.commands = new DomainCommands(domain, 'axterm_ai_command_receipts');
  }
  /** Original request identity is checked before context, attachment or Engine preparation. */
  lookup(key: string, generation: string, originalRequest: unknown): AiRun | undefined {
    if (generation !== this.owner.generation)
      throw new ApplicationError('CONFLICT', 'Stale generation');
    const saved = this.commands.lookup<{ id: string }>(key, 'ai.run.admit', originalRequest);
    if (saved === undefined) return undefined;
    if (!z.object({ id: z.uuid() }).strict().safeParse(saved).success)
      throw new ApplicationError('INVALID_STATE', 'Invalid AI command receipt');
    return this.repository.getAiRun(saved.id);
  }
  outcome(key: string, generation: string): AiRunCommandOutcome {
    z.uuid().parse(key);
    if (generation !== this.owner.generation)
      throw new ApplicationError('CONFLICT', 'Stale generation');
    const intent = this.domain.get<{ run_id: string | null }>(
      'SELECT run_id FROM axterm_ai_run_intents WHERE command_id=? AND profile_name=? AND generation=?',
      key.toLowerCase(),
      this.owner.profile,
      this.owner.generation,
    );
    if (!intent) return { status: 'missing' };
    if (!intent.run_id) return { status: 'uncertain' };
    if (!z.uuid().safeParse(intent.run_id).success)
      throw new ApplicationError('INVALID_STATE', 'Invalid AI command outcome');
    return { status: 'accepted', id: intent.run_id };
  }
  admit(
    key: string,
    generation: string,
    input: AiAdmission,
    originalRequest: unknown = input,
  ): { run: AiRun; admitted: boolean } {
    if (generation !== this.owner.generation)
      throw new ApplicationError('CONFLICT', 'Stale generation');
    const parsed = z
      .object({
        operation: z.enum(['run', 'mcp-tool']).optional(),
        sourceId: z
          .string()
          .regex(/^[a-zA-Z0-9._-]{1,128}$/)
          .optional(),
        engineId,
        useCase: aiUseCaseSchema,
        prompt: text,
        context: text.optional(),
        system: z.string().max(32_768).optional(),
        conversationId: z.uuid().optional(),
        attachments: z.array(aiAttachmentMetadataSchema).max(8).optional(),
        selection: z
          .object({
            providerId: z.uuid(),
            providerVersion: z.number().int().positive(),
            modelId: z.uuid(),
            modelVersion: z.number().int().positive(),
          })
          .strict()
          .optional(),
      })
      .strict()
      .parse(input);
    let admitted = false;
    const receipt = this.commands.execute(key, 'ai.run.admit', originalRequest, () => {
      const count = this.domain.get<{ count: number }>(
        `SELECT count(*) AS count FROM axterm_ai_run_intents WHERE state IN ${activeStates}`,
      )!.count;
      if (count >= 64) throw new ApplicationError('CAPACITY_EXCEEDED', 'AI run capacity reached');
      const prompt = this.redactText(parsed.prompt);
      const attachments = parsed.attachments?.map((item) =>
        aiAttachmentMetadataSchema.parse(this.redactValue(item)),
      );
      const run = this.repository.createAiRun({
        engineId: parsed.engineId,
        useCase: parsed.useCase,
        // Only application-reviewed visible inputs are admitted; no provider request or private reasoning.
        request: {
          useCase: parsed.useCase,
          prompt,
          ...(parsed.context === undefined ? {} : { context: this.redactText(parsed.context) }),
          ...(parsed.system === undefined
            ? {}
            : { system: this.redactText(parsed.system, 32_768) }),
          ...(parsed.selection ? { selection: parsed.selection } : {}),
          ...(attachments ? { attachments } : {}),
          ...(parsed.sourceId ? { sourceId: parsed.sourceId } : {}),
        },
        ...(parsed.conversationId
          ? {
              conversation: {
                id: parsed.conversationId,
                prompt,
                ...(attachments ? { attachments } : {}),
              },
            }
          : {}),
      });
      const now = new Date().toISOString();
      this.domain.run(
        `INSERT INTO axterm_ai_run_intents(command_id,profile_name,generation,owner_pid,operation,run_id,state,created_at,updated_at) VALUES (?,?,?,?,?,?,'queued',?,?)`,
        key.toLowerCase(),
        this.owner.profile,
        this.owner.generation,
        this.owner.pid,
        parsed.operation ?? 'run',
        run.id,
        now,
        now,
      );
      this.append(run.id, { kind: 'input', text: prompt });
      this.append(run.id, { kind: 'audit', action: 'admitted', outcome: 'accepted' });
      admitted = true;
      return { id: run.id };
    });
    return { run: this.repository.getAiRun(receipt.id), admitted };
  }
  transition(runId: string, state: AiRun['state'], result?: string, errorCode?: string): AiRun {
    z.uuid().parse(runId);
    return this.domain.transaction(() => {
      this.assertOwner(runId);
      const previous = this.repository.getAiRun(runId);
      if (['succeeded', 'failed', 'canceled'].includes(previous.state))
        throw new ApplicationError('INVALID_STATE', 'AI run already finished');
      const allowed: Record<AiRun['state'], readonly AiRun['state'][]> = {
        queued: ['running', 'canceled', 'failed'],
        running: ['waiting_approval', 'succeeded', 'failed', 'canceled'],
        waiting_approval: ['running', 'failed', 'canceled'],
        succeeded: [],
        failed: [],
        canceled: [],
      };
      if (!allowed[previous.state].includes(state))
        throw new ApplicationError('INVALID_STATE', 'Invalid AI run transition');
      const safeResult =
        result === undefined ? undefined : this.redactText(result, 2 * 1024 * 1024);
      if (errorCode !== undefined && !/^[A-Z][A-Z0-9_]{0,79}$/.test(errorCode))
        throw new ApplicationError('VALIDATION_ERROR', 'Invalid AI error code');
      const run = this.repository.updateAiRun(runId, state, safeResult, errorCode);
      const intentState = state === 'succeeded' ? 'completed' : state;
      this.domain.run(
        'UPDATE axterm_ai_run_intents SET state=?,updated_at=? WHERE run_id=? AND profile_name=? AND generation=? AND owner_pid=?',
        intentState,
        run.updatedAt,
        runId,
        this.owner.profile,
        this.owner.generation,
        this.owner.pid,
      );
      if (safeResult !== undefined) {
        if (!safeResult.length) this.append(runId, { kind: 'output', text: '', mode: 'replace' });
        for (let start = 0; start < safeResult.length;) {
          let end = Math.min(start + 32768, safeResult.length);
          if (end < safeResult.length && /[\uD800-\uDBFF]/.test(safeResult[end - 1]!)) end--;
          this.append(runId, {
            kind: 'output',
            text: safeResult.slice(start, end),
            mode: start === 0 ? 'replace' : 'append',
          });
          start = end;
        }
      }
      const { result: _result, ...stateRun } = run;
      this.append(runId, { kind: 'state', run: stateRun });
      return run;
    });
  }
  append(runId: string, raw: AiLogPayload): number {
    z.uuid().parse(runId);
    commandPayloadHash(raw);
    const parsed = aiLogPayloadSchema.parse(raw);
    // Re-parse after redaction as well; a redactor must not invalidate the wire contract.
    const safe = aiLogPayloadSchema.parse(this.redactValue(parsed));
    const payload = JSON.stringify(safe);
    if (Buffer.byteLength(payload) > 256 * 1024)
      throw new ApplicationError('CAPACITY_EXCEEDED', 'AI log record too large');
    return this.domain.transaction(() => {
      this.assertOwner(runId);
      const result = this.domain.run(
        'INSERT INTO axterm_ai_run_log(run_id,kind,payload,created_at) VALUES (?,?,?,?)',
        runId,
        safe.kind,
        payload,
        new Date().toISOString(),
      );
      const cursor = Number(result.lastInsertRowid);
      this.domain.appendEvent('ai/log-appended', { runId, cursor, kind: safe.kind });
      return cursor;
    });
  }
  createTool(
    input: Pick<AiToolCall, 'runId' | 'toolName' | 'risk' | 'argsHash' | 'args' | 'target'>,
  ): AiToolCall {
    commandPayloadHash(input);
    const parsed = aiToolCallSchema
      .pick({ runId: true, toolName: true, risk: true, argsHash: true, args: true, target: true })
      .strict()
      .parse(input);
    if (
      parsed.toolName.length > 128 ||
      !/^[a-f0-9]{64}$/.test(parsed.argsHash) ||
      parsed.target.length > 4096
    )
      throw new ApplicationError('VALIDATION_ERROR', 'Invalid AI tool identity');
    const safe = aiToolCallSchema
      .pick({ runId: true, toolName: true, risk: true, argsHash: true, args: true, target: true })
      .parse(this.redactValue(parsed));
    return this.domain.transaction(() => {
      this.assertActiveRun(safe.runId);
      const tool = this.repository.createToolCall({ ...safe, state: 'proposed' });
      this.append(tool.runId, { kind: 'tool', tool });
      return tool;
    });
  }
  updateTool(
    id: string,
    state: AiToolCall['state'],
    metadata?: Record<string, unknown>,
  ): AiToolCall {
    z.uuid().parse(id);
    commandPayloadHash(metadata ?? {});
    const safe = metadata ? (this.redactValue(metadata) as Record<string, unknown>) : undefined;
    return this.domain.transaction(() => {
      const before = this.repository.getToolCall(id);
      this.assertActiveRun(before.runId);
      const allowed: Record<AiToolCall['state'], readonly AiToolCall['state'][]> = {
        proposed: ['waiting_approval', 'running', 'canceled', 'failed'],
        waiting_approval: ['running', 'canceled', 'failed'],
        running: ['succeeded', 'failed', 'canceled'],
        succeeded: [],
        failed: [],
        canceled: [],
      };
      if (!allowed[before.state].includes(state))
        throw new ApplicationError('INVALID_STATE', 'Invalid AI tool transition');
      const tool = this.repository.updateToolCall(id, state, safe);
      this.append(tool.runId, { kind: 'tool', tool });
      return tool;
    });
  }
  updateCommand(
    id: string,
    patch: Partial<Pick<AiToolCall, 'risk' | 'argsHash' | 'review' | 'step' | 'approvalSource'>>,
  ): AiToolCall {
    z.uuid().parse(id);
    commandPayloadHash(patch);
    const schema = aiToolCallSchema
      .pick({ risk: true, argsHash: true, review: true, step: true, approvalSource: true })
      .partial()
      .strict();
    const selected = schema.parse(this.redactValue(schema.parse(patch)));
    return this.domain.transaction(() => {
      const before = this.repository.getToolCall(id);
      this.assertActiveRun(before.runId);
      if (before.toolName !== 'workspace.exec')
        throw new ApplicationError(
          'PRECONDITION_FAILED',
          'Only workspace commands use automatic review',
        );
      if (
        before.state !== 'proposed' &&
        !(
          before.state === 'waiting_approval' &&
          Object.keys(selected).length === 1 &&
          selected.approvalSource === 'user'
        )
      )
        throw new ApplicationError('INVALID_STATE', 'AI command identity already submitted');
      if (
        selected.approvalSource === 'automatic' &&
        (before.review?.decision !== 'auto_approve' ||
          before.review.generation !== this.owner.generation ||
          Date.parse(before.review.expiresAt) <= Date.now())
      )
        throw new ApplicationError(
          'PRECONDITION_FAILED',
          'Automatic command review missing or expired',
        );
      if (
        selected.approvalSource === 'user' &&
        !this.repository
          .approvalsForTool(id)
          .some(
            (a) =>
              a.toolCallId === id &&
              a.argsHash === before.argsHash &&
              a.state === 'approved' &&
              Date.parse(a.expiresAt) > Date.now(),
          )
      )
        throw new ApplicationError(
          'PRECONDITION_FAILED',
          'Human command approval missing or expired',
        );
      const tool = this.repository.updateCommandCall(id, {
        ...(selected.risk === undefined ? {} : { risk: selected.risk }),
        ...(selected.argsHash === undefined ? {} : { argsHash: selected.argsHash }),
        ...(selected.review === undefined ? {} : { review: selected.review }),
        ...(selected.step === undefined ? {} : { step: selected.step }),
        ...(selected.approvalSource === undefined
          ? {}
          : { approvalSource: selected.approvalSource }),
      });
      this.append(tool.runId, { kind: 'tool', tool });
      return tool;
    });
  }
  requestApproval(toolId: string, expiresAt: string): AiApproval {
    z.uuid().parse(toolId);
    const expires = z.iso.datetime().parse(expiresAt);
    if (Date.parse(expires) <= Date.now() || Date.parse(expires) > Date.now() + 30 * 60 * 1000)
      throw new ApplicationError('VALIDATION_ERROR', 'Invalid AI approval lifetime');
    return this.domain.transaction(() => {
      const tool = this.repository.getToolCall(toolId);
      this.assertActiveRun(tool.runId);
      if (tool.state !== 'proposed')
        throw new ApplicationError('INVALID_STATE', 'AI tool already submitted');
      const approval = this.repository.createApproval({
        runId: tool.runId,
        toolCallId: tool.id,
        argsHash: tool.argsHash,
        target: tool.target,
        expiresAt: expires,
      });
      this.updateTool(tool.id, 'waiting_approval');
      this.transition(tool.runId, 'waiting_approval');
      this.append(tool.runId, { kind: 'approval', approval });
      return approval;
    });
  }
  lookupApproval(
    key: string,
    generation: string,
    input: { id: string; argsHash: string; decision: 'approve_once' | 'reject' },
  ): AiApproval | undefined {
    if (generation !== this.owner.generation)
      throw new ApplicationError('CONFLICT', 'Stale generation');
    const parsed = z
      .object({
        id: z.uuid(),
        argsHash: z.string().regex(/^[a-f0-9]{64}$/),
        decision: z.enum(['approve_once', 'reject']),
      })
      .strict()
      .parse(input);
    const saved = this.commands.lookup<{ id: string; state: AiApproval['state']; cursor: number }>(
      key,
      'ai.approval.decide',
      parsed,
    );
    if (saved === undefined) return;
    z.object({
      id: z.uuid(),
      state: z.enum(['approved', 'rejected', 'expired']),
      cursor: z.number().int().positive(),
    })
      .strict()
      .parse(saved);
    if (saved.id !== parsed.id)
      throw new ApplicationError('INVALID_STATE', 'Invalid AI approval receipt');
    return this.repository.getApproval(saved.id);
  }
  decideApproval(
    key: string,
    generation: string,
    input: { id: string; argsHash: string; decision: 'approve_once' | 'reject' },
  ): { id: string; state: AiApproval['state']; cursor: number } {
    if (generation !== this.owner.generation)
      throw new ApplicationError('CONFLICT', 'Stale generation');
    const parsed = z
      .object({
        id: z.uuid(),
        argsHash: z.string().regex(/^[a-f0-9]{64}$/),
        decision: z.enum(['approve_once', 'reject']),
      })
      .strict()
      .parse(input);
    return this.commands.execute(key, 'ai.approval.decide', parsed, () => {
      const current = this.repository.getApproval(parsed.id);
      this.assertActiveRun(current.runId);
      const tool = this.repository.getToolCall(current.toolCallId);
      if (
        current.argsHash !== parsed.argsHash ||
        tool.argsHash !== parsed.argsHash ||
        tool.target !== current.target ||
        tool.state !== 'waiting_approval'
      )
        throw new ApplicationError('CONFLICT', 'AI approval target changed');
      const state =
        Date.parse(current.expiresAt) <= Date.now()
          ? 'expired'
          : parsed.decision === 'approve_once'
            ? 'approved'
            : 'rejected';
      const approval = this.repository.decideApproval(current.id, state);
      const cursor = this.append(current.runId, { kind: 'approval', approval });
      this.append(current.runId, {
        kind: 'audit',
        action: 'approval-decided',
        outcome: state === 'approved' ? 'accepted' : state === 'expired' ? 'expired' : 'canceled',
      });
      return { id: approval.id, state: approval.state, cursor };
    });
  }
  read(runId: string, after = 0, limit = 100): { entries: AiLogEntry[]; hasMore: boolean } {
    z.uuid().parse(runId);
    if (
      !Number.isSafeInteger(after) ||
      after < 0 ||
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 200
    )
      throw new ApplicationError('VALIDATION_ERROR', 'Invalid AI log page');
    this.repository.getAiRun(runId);
    const rows = this.domain.all<{
      cursor: number;
      run_id: string;
      payload: string;
      created_at: string;
    }>(
      'SELECT cursor,run_id,payload,created_at FROM axterm_ai_run_log WHERE run_id=? AND cursor>? ORDER BY cursor LIMIT ?',
      runId,
      after,
      limit + 1,
    );
    return {
      entries: rows.slice(0, limit).map((row) => ({
        cursor: row.cursor,
        runId: row.run_id,
        createdAt: row.created_at,
        payload: aiLogPayloadSchema.parse(JSON.parse(row.payload)),
      })),
      hasMore: rows.length > limit,
    };
  }
  activeOwners(): AiRunOwner[] {
    return this.domain
      .all<{ profile_name: string; generation: string; owner_pid: number }>(
        `SELECT DISTINCT profile_name,generation,owner_pid FROM axterm_ai_run_intents WHERE state IN ${activeStates} LIMIT 65`,
      )
      .map((row) =>
        ownerSchema.parse({
          profile: row.profile_name,
          generation: row.generation,
          pid: row.owner_pid,
        }),
      );
  }
  /** Internal recovery seam. Composition must hold the owner lock and supply conservative ESRCH proof. */
  interruptStoppedOwner(owner: AiRunOwner, processExited: (pid: number) => boolean): number {
    owner = ownerSchema.parse(owner);
    if (owner.pid === process.pid || !processExited(owner.pid)) return 0;
    return this.domain.transaction(() => {
      const rows = this.domain.all<IntentRow>(
        `SELECT command_id,profile_name,generation,owner_pid,run_id,state FROM axterm_ai_run_intents WHERE profile_name=? AND generation=? AND owner_pid=? AND state IN ${activeStates} LIMIT 65`,
        owner.profile,
        owner.generation,
        owner.pid,
      );
      if (rows.length > 64)
        throw new ApplicationError('CAPACITY_EXCEEDED', 'AI recovery capacity reached');
      // Check once more under the transaction. A live/reused PID always wins over recovery.
      if (!processExited(owner.pid)) return 0;
      for (const row of rows) {
        if (!row.run_id) continue;
        const now = new Date().toISOString();
        const run = this.repository.getAiRun(row.run_id);
        if (!['succeeded', 'failed', 'canceled'].includes(run.state)) {
          const interrupted = this.repository.updateAiRun(
            run.id,
            'failed',
            undefined,
            'RUN_INTERRUPTED',
          );
          const { result: _result, ...stateRun } = interrupted;
          const statePayload = { kind: 'state', run: stateRun };
          this.domain.run(
            "INSERT INTO axterm_ai_run_log(run_id,kind,payload,created_at) VALUES (?,'state',?,?)",
            run.id,
            JSON.stringify(statePayload),
            now,
          );
        }
        const pending = this.repository.pendingApprovals(run.id);
        const tools = this.repository.activeToolCalls(run.id);
        for (const approval of pending) {
          const changed = this.repository.decideApproval(approval.id, 'expired');
          this.appendRecovery(run.id, { kind: 'approval', approval: changed }, now);
        }
        for (const tool of tools) {
          const changed = this.repository.updateToolCall(tool.id, 'canceled', {
            code: 'RUN_INTERRUPTED',
            ...(tool.state === 'running' && tool.risk !== 'read_only'
              ? { effect: 'uncertain' }
              : {}),
          });
          this.appendRecovery(run.id, { kind: 'tool', tool: changed }, now);
        }
        this.domain.run(
          "UPDATE axterm_ai_run_intents SET state='interrupted',updated_at=? WHERE command_id=?",
          now,
          row.command_id,
        );
        const payload: AiLogPayload = {
          kind: 'audit',
          action: 'interrupted',
          outcome: 'interrupted',
        };
        const cursor = Number(
          this.domain.run(
            "INSERT INTO axterm_ai_run_log(run_id,kind,payload,created_at) VALUES (?,'audit',?,?)",
            run.id,
            JSON.stringify(payload),
            now,
          ).lastInsertRowid,
        );
        this.domain.appendEvent('ai/run-interrupted', { runId: run.id, cursor });
      }
      return rows.length;
    });
  }
  private appendRecovery(runId: string, payload: AiLogPayload, now: string): void {
    commandPayloadHash(payload);
    const safe = aiLogPayloadSchema.parse(this.redactValue(aiLogPayloadSchema.parse(payload)));
    const encoded = JSON.stringify(safe);
    if (Buffer.byteLength(encoded) > 256 * 1024)
      throw new ApplicationError('CAPACITY_EXCEEDED', 'AI recovery record too large');
    this.domain.run(
      'INSERT INTO axterm_ai_run_log(run_id,kind,payload,created_at) VALUES (?,?,?,?)',
      runId,
      safe.kind,
      encoded,
      now,
    );
  }
  private assertOwner(runId: string): void {
    const row = this.domain.get<IntentRow>(
      'SELECT command_id,profile_name,generation,owner_pid,run_id,state FROM axterm_ai_run_intents WHERE run_id=?',
      runId,
    );
    if (
      !row ||
      row.profile_name !== this.owner.profile ||
      row.generation !== this.owner.generation ||
      row.owner_pid !== this.owner.pid ||
      row.state === 'interrupted'
    )
      throw new ApplicationError('CONFLICT', 'AI run owner changed');
  }
  private assertActiveRun(runId: string): void {
    this.assertOwner(runId);
    const run = this.repository.getAiRun(runId);
    if (!['running', 'waiting_approval'].includes(run.state))
      throw new ApplicationError('INVALID_STATE', 'AI run is not active');
  }
  private redactText(value: string, maximum = 128 * 1024): string {
    if (Buffer.byteLength(value) > maximum)
      throw new ApplicationError('CAPACITY_EXCEEDED', 'AI text too large');
    const safe = this.redact(value);
    if (typeof safe !== 'string' || Buffer.byteLength(safe) > maximum)
      throw new ApplicationError('CAPACITY_EXCEEDED', 'AI text too large');
    return safe;
  }
  private redactValue(value: unknown): unknown {
    if (typeof value === 'string') return this.redactText(value);
    if (Array.isArray(value)) return value.map((item) => this.redactValue(item));
    if (value && typeof value === 'object')
      return Object.fromEntries(
        Object.entries(value).map(([key, item]) => {
          if (/^(?:reasoning|thinking|chain[-_]?of[-_]?thought|privateReasoning)$/i.test(key))
            throw new ApplicationError('VALIDATION_ERROR', 'Private reasoning is not an AI fact');
          return [key, this.redactValue(item)];
        }),
      );
    return value;
  }
}
