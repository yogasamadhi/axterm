// First-party AI facts adapted from the frozen ProductRepository; SQL stays within the AI facet.
import { randomUUID } from 'node:crypto';
import type {
  AiConversation,
  AiConversationInput,
  AiConversationPatch,
  AiAttachmentMetadata,
  AiMessage,
  AiRun,
  AiApproval,
  AiToolCall,
} from '@axterm/plugin-api/ai';
import {
  aiAttachmentMetadataSchema,
  aiConversationInputSchema,
  aiToolCallSchema,
} from '@axterm/plugin-api/ai';
import { ApplicationError } from '../application/errors.ts';
import type { AiSql } from '../ports/sql.ts';
interface JsonRow {
  id: string;
  name: string;
  payload: string;
  created_at: string;
  updated_at: string;
  version: number;
}
export type JsonTable = 'ai_providers' | 'ai_models' | 'ai_conversations';
export class AiRepository {
  constructor(private readonly database: AiSql) {}
  listAiConversations(): AiConversation[] {
    return this.listJson<Omit<AiConversation, 'messageCount' | 'lastMessageAt'>>('ai_conversations')
      .map((conversation) => this.withConversationStats(conversation))
      .sort((left, right) =>
        (right.lastMessageAt ?? right.updatedAt).localeCompare(
          left.lastMessageAt ?? left.updatedAt,
        ),
      );
  }

  getAiConversation(id: string): AiConversation {
    return this.withConversationStats(
      this.getJson<Omit<AiConversation, 'messageCount' | 'lastMessageAt'>>('ai_conversations', id),
    );
  }

  createAiConversation(input: AiConversationInput): AiConversation {
    const created = this.createJson(
      'ai_conversations',
      aiConversationInputSchema.parse(input),
      'ai-conversation',
    );
    return this.getAiConversation(created.id);
  }

  updateAiConversation(
    id: string,
    input: AiConversationPatch,
    ifMatch: string | undefined,
  ): AiConversation {
    this.updateJson('ai_conversations', id, input, ifMatch, 'ai-conversation');
    return this.getAiConversation(id);
  }

  deleteAiConversation(id: string, ifMatch: string | undefined): void {
    const current = this.getAiConversation(id);
    if (current.version !== versionFromEtag(ifMatch))
      throw new ApplicationError('PRECONDITION_FAILED', 'Resource changed', 412);
    this.database.transaction(() => {
      this.database.run('DELETE FROM ai_messages WHERE conversation_id=?', id);
      this.database.run('UPDATE ai_runs SET conversation_id=NULL WHERE conversation_id=?', id);
      const result = this.database.run(
        'DELETE FROM ai_conversations WHERE id=? AND version=?',
        id,
        current.version,
      );
      if (!result.changes)
        throw new ApplicationError('PRECONDITION_FAILED', 'Resource changed', 412);
      this.database.appendEvent('ai-conversation.deleted', id, { id });
    });
  }

  listAiContextMessages(conversationId: string): {
    messages: Array<Pick<AiMessage, 'role' | 'content'>>;
    count: number;
  } {
    this.getJson('ai_conversations', conversationId);
    const messages = this.database
      .all<{ role: AiMessage['role']; content: string }>(
        `SELECT role, content FROM ai_messages WHERE conversation_id=? AND run_id IS NOT NULL
       ORDER BY created_at DESC, CASE role WHEN 'user' THEN 0 ELSE 1 END DESC, id DESC LIMIT 32`,
        conversationId,
      )
      .reverse();
    const count =
      this.database.get<{ count: number }>(
        'SELECT COUNT(*) AS count FROM ai_messages WHERE conversation_id=? AND run_id IS NOT NULL',
        conversationId,
      )?.count ?? 0;
    return { messages, count };
  }

  listAiMessages(conversationId: string): AiMessage[] {
    this.getJson('ai_conversations', conversationId);
    return this.database
      .all<{
        id: string;
        conversation_id: string;
        run_id: string;
        role: AiMessage['role'];
        content: string;
        state: AiMessage['state'];
        error_code: string | null;
        attachments_json: string;
        created_at: string;
        updated_at: string;
        version: number;
      }>(
        `SELECT id, conversation_id, run_id, role, content, state, error_code, attachments_json,
                created_at, updated_at, version
           FROM ai_messages
          WHERE conversation_id=? AND run_id IS NOT NULL
          ORDER BY created_at, CASE role WHEN 'user' THEN 0 ELSE 1 END, id
          LIMIT 1000`,
        conversationId,
      )
      .map((row) => ({
        id: row.id,
        conversationId: row.conversation_id,
        runId: row.run_id,
        role: row.role,
        content: row.content,
        attachments: aiAttachmentMetadataSchema
          .array()
          .max(8)
          .parse(JSON.parse(row.attachments_json)),
        state: row.state,
        ...(row.error_code ? { errorCode: row.error_code } : {}),
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        version: row.version,
      }));
  }

  createAiRun(input: {
    engineId: string;
    useCase: AiRun['useCase'];
    request: unknown;
    conversation?:
      { id: string; prompt: string; attachments?: AiAttachmentMetadata[] | undefined } | undefined;
  }): AiRun {
    const now = new Date().toISOString();
    const run: AiRun = {
      id: randomUUID(),
      engineId: input.engineId,
      ...(input.conversation ? { conversationId: input.conversation.id } : {}),
      state: 'queued',
      useCase: input.useCase,
      createdAt: now,
      updatedAt: now,
      version: 1,
    };
    if (input.conversation) this.getAiConversation(input.conversation.id);
    this.database.transaction(() => {
      this.database.run(
        `INSERT INTO ai_runs(
           id, engine_id, conversation_id, state, use_case, request, created_at, updated_at, version
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)`,
        run.id,
        run.engineId,
        run.conversationId ?? null,
        run.state,
        run.useCase,
        JSON.stringify(input.request),
        now,
        now,
      );
      if (input.conversation) {
        this.database.run(
          `INSERT INTO ai_messages(
             id, conversation_id, run_id, role, content, attachments_json, state,
             created_at, updated_at, version
           ) VALUES (?, ?, ?, 'user', ?, ?, 'complete', ?, ?, 1)`,
          randomUUID(),
          input.conversation.id,
          run.id,
          input.conversation.prompt,
          JSON.stringify(input.conversation.attachments ?? []),
          now,
          now,
        );
        this.database.run(
          'UPDATE ai_conversations SET updated_at=?, version=version+1 WHERE id=?',
          now,
          input.conversation.id,
        );
      }
      this.database.appendEvent('ai-run.created', run.id, run);
    });
    return run;
  }

  updateAiRun(id: string, state: AiRun['state'], result?: string, errorCode?: string): AiRun {
    const current = this.getAiRun(id);
    const updatedAt = new Date().toISOString();
    const next: AiRun = {
      ...current,
      state,
      updatedAt,
      version: current.version + 1,
      ...(result === undefined ? {} : { result }),
      ...(errorCode ? { errorCode } : {}),
    };
    this.database.transaction(() => {
      const changed = this.database.run(
        'UPDATE ai_runs SET state=?, result=?, error_code=?, updated_at=?, version=? WHERE id=? AND version=?',
        state,
        result ?? null,
        errorCode ?? null,
        updatedAt,
        next.version,
        id,
        current.version,
      );
      if (!changed.changes) throw new ApplicationError('CONFLICT', 'AI run changed');
      if (current.conversationId && ['succeeded', 'failed', 'canceled'].includes(state)) {
        const messageState: AiMessage['state'] =
          state === 'succeeded' ? 'complete' : state === 'failed' ? 'failed' : 'canceled';
        const previous = this.database.get<{ id: string; version: number }>(
          "SELECT id, version FROM ai_messages WHERE run_id=? AND role='assistant'",
          id,
        );
        if (previous)
          this.database.run(
            `UPDATE ai_messages
                SET content=?, state=?, error_code=?, updated_at=?, version=?
              WHERE id=? AND version=?`,
            result ?? '',
            messageState,
            errorCode ?? null,
            updatedAt,
            previous.version + 1,
            previous.id,
            previous.version,
          );
        else
          this.database.run(
            `INSERT INTO ai_messages(
               id, conversation_id, run_id, role, content, state, error_code,
               created_at, updated_at, version
             ) VALUES (?, ?, ?, 'assistant', ?, ?, ?, ?, ?, 1)`,
            randomUUID(),
            current.conversationId,
            id,
            result ?? '',
            messageState,
            errorCode ?? null,
            updatedAt,
            updatedAt,
          );
        this.database.run(
          'UPDATE ai_conversations SET updated_at=?, version=version+1 WHERE id=?',
          updatedAt,
          current.conversationId,
        );
      }
      this.database.appendEvent('ai-run.updated', id, next);
    });
    return next;
  }

  listAiRuns(): AiRun[] {
    return this.database
      .all<{
        id: string;
        conversation_id: string | null;
        state: AiRun['state'];
        engine_id: string;
        use_case: AiRun['useCase'];
        result: string | null;
        error_code: string | null;
        created_at: string;
        updated_at: string;
        version: number;
      }>(
        `SELECT id, engine_id, conversation_id, state, use_case, result, error_code,
                created_at, updated_at, version
           FROM ai_runs ORDER BY created_at DESC LIMIT 200`,
      )
      .map((row) => ({
        id: row.id,
        engineId: row.engine_id,
        ...(row.conversation_id ? { conversationId: row.conversation_id } : {}),
        state: row.state,
        useCase: row.use_case,
        ...(row.result === null ? {} : { result: row.result }),
        ...(row.error_code === null ? {} : { errorCode: row.error_code }),
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        version: row.version,
      }));
  }

  getAiRun(id: string): AiRun {
    const row = this.database.get<{
      id: string;
      conversation_id: string | null;
      state: AiRun['state'];
      engine_id: string;
      use_case: AiRun['useCase'];
      result: string | null;
      error_code: string | null;
      created_at: string;
      updated_at: string;
      version: number;
    }>(
      `SELECT id, engine_id, conversation_id, state, use_case, result, error_code,
              created_at, updated_at, version
         FROM ai_runs WHERE id=?`,
      id,
    );
    if (!row) throw new ApplicationError('NOT_FOUND', 'AI run not found', 404);
    return {
      id: row.id,
      engineId: row.engine_id,
      ...(row.conversation_id ? { conversationId: row.conversation_id } : {}),
      state: row.state,
      useCase: row.use_case,
      ...(row.result === null ? {} : { result: row.result }),
      ...(row.error_code === null ? {} : { errorCode: row.error_code }),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      version: row.version,
    };
  }

  createToolCall(input: {
    runId: string;
    toolName: string;
    risk: AiToolCall['risk'];
    argsHash: string;
    args: Record<string, unknown>;
    target: string;
    state: AiToolCall['state'];
  }): AiToolCall {
    const now = new Date().toISOString();
    const call = aiToolCallSchema.parse({
      id: randomUUID(),
      ...input,
      createdAt: now,
      updatedAt: now,
      version: 1,
    });
    this.database.run(
      'INSERT INTO ai_tool_calls(id, run_id, tool_name, risk, args_hash, args_json, target, state, created_at, updated_at, version) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)',
      call.id,
      call.runId,
      call.toolName,
      call.risk,
      call.argsHash,
      JSON.stringify(call.args),
      call.target,
      call.state,
      now,
      now,
    );
    return call;
  }

  updateToolCall(
    id: string,
    state: AiToolCall['state'],
    resultMetadata?: Record<string, unknown>,
  ): AiToolCall {
    const current = this.getToolCall(id);
    const next = aiToolCallSchema.parse({
      ...current,
      state,
      updatedAt: new Date().toISOString(),
      version: current.version + 1,
      ...(resultMetadata ? { resultMetadata } : {}),
    });
    this.database.run(
      'UPDATE ai_tool_calls SET state=?, result_metadata=?, updated_at=?, version=? WHERE id=?',
      state,
      next.resultMetadata === undefined ? null : JSON.stringify(next.resultMetadata),
      next.updatedAt,
      next.version,
      id,
    );
    return next;
  }

  updateCommandCall(
    id: string,
    patch: Partial<Pick<AiToolCall, 'risk' | 'argsHash' | 'review' | 'step' | 'approvalSource'>>,
  ) {
    const call = { ...this.getToolCall(id), ...patch };
    this.database.run(
      'UPDATE ai_tool_calls SET risk=?, args_hash=?, review_json=?, step=?, approval_source=?, updated_at=?, version=version+1 WHERE id=?',
      call.risk,
      call.argsHash,
      call.review ? JSON.stringify(call.review) : null,
      call.step ?? null,
      call.approvalSource ?? null,
      new Date().toISOString(),
      id,
    );
    return this.getToolCall(id);
  }

  listToolCalls(runId?: string, id?: string): AiToolCall[] {
    const rows = this.database.all<{
      id: string;
      run_id: string;
      tool_name: string;
      risk: AiToolCall['risk'];
      args_hash: string;
      args_json: string;
      target: string;
      state: AiToolCall['state'];
      result_metadata: string | null;
      review_json: string | null;
      step: number | null;
      approval_source: AiToolCall['approvalSource'] | null;
      created_at: string;
      updated_at: string;
      version: number;
    }>(
      `SELECT * FROM ai_tool_calls ${id ? 'WHERE id=?' : runId ? 'WHERE run_id=?' : ''} ORDER BY rowid ${runId ? 'ASC' : 'DESC'} LIMIT 1000`,
      ...(id ? [id] : runId ? [runId] : []),
    );
    return rows.map((row) => ({
      id: row.id,
      runId: row.run_id,
      toolName: row.tool_name,
      risk: row.risk,
      argsHash: row.args_hash,
      args: JSON.parse(row.args_json),
      target: row.target,
      state: row.state,
      ...(row.result_metadata ? { resultMetadata: JSON.parse(row.result_metadata) } : {}),
      ...(row.review_json ? { review: JSON.parse(row.review_json) } : {}),
      ...(row.step ? { step: row.step } : {}),
      ...(row.approval_source ? { approvalSource: row.approval_source } : {}),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      version: row.version,
    }));
  }

  getToolCall(id: string): AiToolCall {
    const call = this.listToolCalls(undefined, id)[0];
    if (!call) throw new ApplicationError('NOT_FOUND', 'AI tool call not found', 404);
    return call;
  }

  createApproval(input: {
    runId: string;
    toolCallId: string;
    argsHash: string;
    target: string;
    expiresAt: string;
  }): AiApproval {
    const now = new Date().toISOString();
    const approval: AiApproval = {
      id: randomUUID(),
      ...input,
      state: 'pending',
      createdAt: now,
      updatedAt: now,
      version: 1,
    };
    this.database.run(
      'INSERT INTO ai_approvals(id, run_id, tool_call_id, args_hash, target, state, expires_at, created_at, updated_at, version) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)',
      approval.id,
      approval.runId,
      approval.toolCallId,
      approval.argsHash,
      approval.target,
      approval.state,
      approval.expiresAt,
      now,
      now,
    );
    return approval;
  }

  listApprovals(id?: string): AiApproval[] {
    return this.database
      .all<{
        id: string;
        run_id: string;
        tool_call_id: string;
        args_hash: string;
        target: string;
        state: AiApproval['state'];
        expires_at: string;
        decided_at: string | null;
        created_at: string;
        updated_at: string;
        version: number;
      }>(
        `SELECT * FROM ai_approvals ${id ? 'WHERE id=?' : ''} ORDER BY created_at DESC LIMIT 200`,
        ...(id ? [id] : []),
      )
      .map((row) => ({
        id: row.id,
        runId: row.run_id,
        toolCallId: row.tool_call_id,
        argsHash: row.args_hash,
        target: row.target,
        state: row.state,
        expiresAt: row.expires_at,
        ...(row.decided_at ? { decidedAt: row.decided_at } : {}),
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        version: row.version,
      }));
  }

  activeToolCalls(runId: string): AiToolCall[] {
    const rows = this.database.all<{ id: string }>(
      "SELECT id FROM ai_tool_calls WHERE run_id=? AND state IN ('proposed','waiting_approval','running') LIMIT 257",
      runId,
    );
    if (rows.length > 256)
      throw new ApplicationError('CAPACITY_EXCEEDED', 'AI active tool capacity reached');
    return rows.map((row) => this.getToolCall(row.id));
  }
  pendingApprovals(runId?: string): AiApproval[] {
    const rows = this.database.all<{ id: string }>(
      `SELECT id FROM ai_approvals WHERE state='pending' ${runId ? 'AND run_id=?' : ''} ORDER BY created_at,id LIMIT 3201`,
      ...(runId ? [runId] : []),
    );
    if (rows.length > 3200)
      throw new ApplicationError('CAPACITY_EXCEEDED', 'AI approval capacity reached');
    return rows.map((row) => this.getApproval(row.id));
  }
  approvalsForTool(toolId: string): AiApproval[] {
    const rows = this.database.all<{ id: string }>(
      'SELECT id FROM ai_approvals WHERE tool_call_id=? LIMIT 2',
      toolId,
    );
    if (rows.length > 1)
      throw new ApplicationError('INVALID_STATE', 'AI tool has conflicting approvals');
    return rows.map((row) => this.getApproval(row.id));
  }
  getApproval(id: string): AiApproval {
    const approval = this.listApprovals(id)[0];
    if (!approval) throw new ApplicationError('NOT_FOUND', 'AI approval not found', 404);
    return approval;
  }

  decideApproval(id: string, state: 'approved' | 'rejected' | 'expired'): AiApproval {
    const current = this.getApproval(id);
    if (current.state !== 'pending')
      throw new ApplicationError('CONFLICT', 'Approval already decided');
    const now = new Date().toISOString();
    const next = {
      ...current,
      state,
      decidedAt: now,
      updatedAt: now,
      version: current.version + 1,
    };
    this.database.run(
      `UPDATE ai_approvals SET state=?, decided_at=?, updated_at=?, version=? WHERE id=? AND version=? AND state='pending'`,
      state,
      now,
      now,
      next.version,
      id,
      current.version,
    );
    return next;
  }

  listJson<T>(table: JsonTable): T[] {
    return this.database
      .all<JsonRow>(`SELECT * FROM ${table} ORDER BY name`)
      .map((row) => this.jsonFromRow<T>(row));
  }

  getJson<T>(table: JsonTable, id: string): T {
    const row = this.database.get<JsonRow>(`SELECT * FROM ${table} WHERE id = ?`, id);
    if (!row) throw new ApplicationError('NOT_FOUND', 'Resource not found', 404);
    return this.jsonFromRow<T>(row);
  }

  createJson<T extends { name: string }>(
    table: JsonTable,
    input: T,
    eventType: string,
  ): T & { id: string; createdAt: string; updatedAt: string; version: number } {
    const now = new Date().toISOString();
    const entity = { id: randomUUID(), ...input, createdAt: now, updatedAt: now, version: 1 };
    this.database.transaction(() => {
      this.database.run(
        'INSERT INTO ' +
          table +
          '(id, name, payload, created_at, updated_at, version) VALUES (?, ?, ?, ?, ?, 1)',
        entity.id,
        input.name,
        JSON.stringify(input),
        now,
        now,
      );
      this.database.appendEvent(`${eventType}.created`, entity.id, entity);
    });
    return entity;
  }

  updateJson<T extends { name: string }>(
    table: JsonTable,
    id: string,
    input: { [K in keyof T]?: T[K] | undefined },
    ifMatch: string | undefined,
    eventType: string,
  ): T & { id: string; createdAt: string; updatedAt: string; version: number } {
    const current = this.getJson<
      T & { id: string; createdAt: string; updatedAt: string; version: number }
    >(table, id);
    if (current.version !== versionFromEtag(ifMatch))
      throw new ApplicationError('PRECONDITION_FAILED', 'Resource changed', 412);
    const next = {
      ...current,
      ...Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined)),
      id,
      version: current.version + 1,
      updatedAt: new Date().toISOString(),
    } as T & { id: string; createdAt: string; updatedAt: string; version: number };
    const payload = { ...next };
    delete (payload as Partial<typeof next>).id;
    delete (payload as Partial<typeof next>).createdAt;
    delete (payload as Partial<typeof next>).updatedAt;
    delete (payload as Partial<typeof next>).version;
    this.database.transaction(() => {
      const result = this.database.run(
        `UPDATE ${table} SET name=?, payload=?, updated_at=?, version=? WHERE id=? AND version=?`,
        next.name,
        JSON.stringify(payload),
        next.updatedAt,
        next.version,
        id,
        current.version,
      );
      if (!result.changes)
        throw new ApplicationError('PRECONDITION_FAILED', 'Resource changed', 412);
      this.database.appendEvent(`${eventType}.updated`, id, next);
    });
    return next;
  }

  deleteJson(table: JsonTable, id: string, ifMatch: string | undefined, eventType: string): void {
    const current = this.getJson<{ id: string; version: number }>(table, id);
    if (current.version !== versionFromEtag(ifMatch))
      throw new ApplicationError('PRECONDITION_FAILED', 'Resource changed', 412);
    this.database.transaction(() => {
      this.database.run(`DELETE FROM ${table} WHERE id=? AND version=?`, id, current.version);
      this.database.appendEvent(`${eventType}.deleted`, id, { id });
    });
  }

  replaceJsonCollection<
    T extends {
      id: string;
      name: string;
      createdAt: string;
      updatedAt: string;
      version: number;
    },
  >(table: JsonTable, values: readonly T[], eventType: string): void {
    this.database.transaction(() => {
      this.database.run(`DELETE FROM ${table}`);
      for (const value of values) {
        const payload = { ...value } as Record<string, unknown>;
        delete payload.id;
        delete payload.createdAt;
        delete payload.updatedAt;
        delete payload.version;
        this.database.run(
          `INSERT INTO ${table}(id, name, payload, created_at, updated_at, version)
           VALUES (?, ?, ?, ?, ?, ?)`,
          value.id,
          value.name,
          JSON.stringify(payload),
          value.createdAt,
          value.updatedAt,
          value.version,
        );
      }
      this.database.appendEvent(`${eventType}.replaced`, eventType, { count: values.length });
    });
  }

  private withConversationStats(
    conversation: Omit<AiConversation, 'messageCount' | 'lastMessageAt'>,
  ): AiConversation {
    const stats = this.database.get<{ message_count: number; last_message_at: string | null }>(
      `SELECT COUNT(*) AS message_count, MAX(created_at) AS last_message_at
         FROM ai_messages WHERE conversation_id=?`,
      conversation.id,
    );
    return {
      ...conversation,
      messageCount: Number(stats?.message_count ?? 0),
      lastMessageAt: stats?.last_message_at ?? null,
    };
  }

  private jsonFromRow<T>(row: JsonRow): T {
    return {
      id: row.id,
      ...JSON.parse(row.payload),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      version: row.version,
    } as T;
  }
}
const versionFromEtag = (value: string | undefined): number => {
  if (!value) throw new ApplicationError('PRECONDITION_REQUIRED', 'If-Match is required', 428);
  const match = /^"v(\d+)"$/.exec(value);
  if (!match || !Number.isSafeInteger(Number(match[1])))
    throw new ApplicationError('PRECONDITION_FAILED', 'Invalid entity version', 412);
  return Number(match[1]);
};
