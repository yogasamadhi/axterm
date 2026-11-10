import { AiMessageWindows } from './message-windows.ts';
import type { AiMessageWindow, AiMessageWindowQuery } from '@axterm/plugin-api/ai';
import { z } from 'zod';
import type { RelationalDomain } from '@axterm/plugin-api/storage';
import {
  AI_INDEX_MAX_ENTRIES,
  AI_MAX_SNAPSHOT_BYTES,
  aiProviderHeaderSchema,
  aiModelSchema,
  aiConversationSchema,
  aiRunHeaderSchema,
  aiMessageSchema,
  type AiProviderHeader,
  type AiModel,
  type AiConversation,
  type AiRunHeader,
  type AiPageQuery,
  type AiMessagePage,
  type AiToolPage,
  type AiLogPage,
} from '@axterm/plugin-api/ai';
import { ApplicationError } from '../application/errors.ts';
import type { AiRepository } from './repository.ts';
import type { AiRunJournal } from './run-journal.ts';
const pageSchema = z
  .object({
    after: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).default(0),
    limit: z.number().int().min(1).max(100).default(50),
  })
  .strict();
const maximumPageBytes = 3 * 1024 * 1024 - 4096;
interface EntityRow {
  id: string;
  name: string;
  created_at: string;
  updated_at: string;
  version: number;
}
const entity = (row: EntityRow) => ({
  id: row.id,
  name: row.name,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  version: row.version,
});
/** Complete metadata indices avoid fetching large provider payloads or Run outputs into a baseline. */
export class AiQueries {
  constructor(
    private readonly domain: RelationalDomain,
    private readonly repository: AiRepository,
    private readonly journal: AiRunJournal,
  ) {}
  providers(): AiProviderHeader[] {
    return this.index<EntityRow & { engine_id: string; enabled: number }>(
      'ai_providers',
      "SELECT id,name,created_at,updated_at,version,coalesce(json_extract(payload,'$.engineId'),'pi') AS engine_id,json_extract(payload,'$.enabled') AS enabled FROM ai_providers ORDER BY name,id",
    ).map((row) =>
      aiProviderHeaderSchema.parse({
        ...entity(row),
        engineId: row.engine_id,
        enabled: !!row.enabled,
      }),
    );
  }
  models(): AiModel[] {
    return this.index<EntityRow & { provider_id: string; model: string; capabilities: string }>(
      'ai_models',
      "SELECT id,name,created_at,updated_at,version,json_extract(payload,'$.providerId') AS provider_id,json_extract(payload,'$.model') AS model,json_extract(payload,'$.capabilities') AS capabilities FROM ai_models ORDER BY name,id",
    ).map((row) =>
      aiModelSchema.parse({
        ...entity(row),
        providerId: row.provider_id,
        model: row.model,
        capabilities: JSON.parse(row.capabilities),
      }),
    );
  }
  conversations(): AiConversation[] {
    return this.index<
      EntityRow & {
        model_id: string;
        use_case: string;
        terminal_id: string | null;
        message_count: number;
        last_message_at: string | null;
      }
    >(
      'ai_conversations',
      "SELECT c.id,c.name,c.created_at,c.updated_at,c.version,json_extract(c.payload,'$.modelId') AS model_id,coalesce(json_extract(c.payload,'$.useCase'),'chat') AS use_case,json_extract(c.payload,'$.terminalId') AS terminal_id,(SELECT count(*) FROM ai_messages m WHERE m.conversation_id=c.id AND m.run_id IS NOT NULL) AS message_count,(SELECT max(created_at) FROM ai_messages m WHERE m.conversation_id=c.id AND m.run_id IS NOT NULL) AS last_message_at FROM ai_conversations c ORDER BY c.updated_at DESC,c.id",
    ).map((row) =>
      aiConversationSchema.parse({
        ...entity(row),
        modelId: row.model_id,
        useCase: row.use_case,
        ...(row.terminal_id ? { terminalId: row.terminal_id } : {}),
        messageCount: row.message_count,
        lastMessageAt: row.last_message_at,
      }),
    );
  }
  runs(): AiRunHeader[] {
    return this.index<{
      id: string;
      engine_id: string;
      conversation_id: string | null;
      state: string;
      use_case: string;
      error_code: string | null;
      created_at: string;
      updated_at: string;
      version: number;
      has_result: number;
    }>(
      'ai_runs',
      'SELECT id,engine_id,conversation_id,state,use_case,error_code,created_at,updated_at,version,result IS NOT NULL AS has_result FROM ai_runs ORDER BY created_at DESC,id',
    ).map((row) =>
      aiRunHeaderSchema.parse({
        id: row.id,
        engineId: row.engine_id,
        ...(row.conversation_id ? { conversationId: row.conversation_id } : {}),
        state: row.state,
        useCase: row.use_case,
        ...(row.error_code ? { errorCode: row.error_code } : {}),
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        version: row.version,
        hasResult: !!row.has_result,
      }),
    );
  }
  messageWindow(conversationId: string, query: AiMessageWindowQuery): AiMessageWindow {
    return new AiMessageWindows(this.domain, (id) => this.repository.getAiConversation(id)).read(
      conversationId,
      query,
    );
  }
  messages(conversationId: string, raw: AiPageQuery): AiMessagePage {
    z.uuid().parse(conversationId);
    this.repository.getAiConversation(conversationId);
    const query = pageSchema.parse(raw);
    const rows = this.domain.all<{ cursor: number; id: string }>(
      'SELECT rowid AS cursor,id FROM ai_messages WHERE conversation_id=? AND run_id IS NOT NULL AND rowid>? ORDER BY rowid LIMIT ?',
      conversationId,
      query.after,
      query.limit + 1,
    );
    const selected = this.page(rows, query, (index) => {
      const row = this.domain.get<{
        id: string;
        conversation_id: string;
        run_id: string;
        role: string;
        content: string;
        attachments_json: string;
        state: string;
        error_code: string | null;
        created_at: string;
        updated_at: string;
        version: number;
      }>('SELECT * FROM ai_messages WHERE id=?', index.id);
      if (!row) throw new ApplicationError('NOT_FOUND', 'AI message no longer exists');
      return aiMessageSchema.parse({
        id: row.id,
        conversationId: row.conversation_id,
        runId: row.run_id,
        role: row.role,
        content: row.content,
        attachments: JSON.parse(row.attachments_json),
        state: row.state,
        ...(row.error_code ? { errorCode: row.error_code } : {}),
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        version: row.version,
      });
    });
    return {
      messages: selected.values,
      nextCursor: selected.nextCursor,
      hasMore: selected.hasMore,
    };
  }
  tools(runId: string, raw: AiPageQuery): AiToolPage {
    z.uuid().parse(runId);
    this.repository.getAiRun(runId);
    const query = pageSchema.parse(raw);
    const rows = this.domain.all<{ cursor: number; id: string }>(
      'SELECT rowid AS cursor,id FROM ai_tool_calls WHERE run_id=? AND rowid>? ORDER BY rowid LIMIT ?',
      runId,
      query.after,
      query.limit + 1,
    );
    const selected = this.page(rows, query, (row) => ({
      tool: this.repository.getToolCall(row.id),
      approvals: this.repository.approvalsForTool(row.id),
    }));
    return {
      tools: selected.values.map((item) => item.tool),
      approvals: selected.values.flatMap((item) => item.approvals),
      nextCursor: selected.nextCursor,
      hasMore: selected.hasMore,
    };
  }
  logs(runId: string, raw: AiPageQuery): AiLogPage {
    const query = pageSchema.parse(raw);
    this.repository.getAiRun(runId);
    const rows = this.domain.all<{ cursor: number }>(
      'SELECT cursor FROM axterm_ai_run_log WHERE run_id=? AND cursor>? ORDER BY cursor LIMIT ?',
      runId,
      query.after,
      query.limit + 1,
    );
    const selected = this.page(rows, query, (row) => {
      const entry = this.journal.read(runId, row.cursor - 1, 1).entries[0];
      if (!entry || entry.cursor !== row.cursor)
        throw new ApplicationError('NOT_FOUND', 'AI log record no longer exists');
      return entry;
    });
    return { entries: selected.values, nextCursor: selected.nextCursor, hasMore: selected.hasMore };
  }
  private index<T extends object>(
    table: 'ai_providers' | 'ai_models' | 'ai_conversations' | 'ai_runs',
    sql: string,
  ): T[] {
    const count = this.domain.get<{ count: number }>(
      'SELECT count(*) AS count FROM ' + table,
    )!.count;
    if (count > AI_INDEX_MAX_ENTRIES)
      throw new ApplicationError('CAPACITY_EXCEEDED', 'AI metadata index capacity reached');
    const fields =
      table === 'ai_providers'
        ? ['id', 'name', 'created_at', 'updated_at', 'version', 'engine_id', 'enabled']
        : table === 'ai_models'
          ? [
              'id',
              'name',
              'created_at',
              'updated_at',
              'version',
              'provider_id',
              'model',
              'capabilities',
            ]
          : table === 'ai_conversations'
            ? [
                'id',
                'name',
                'created_at',
                'updated_at',
                'version',
                'model_id',
                'message_count',
                'last_message_at',
              ]
            : [
                'id',
                'engine_id',
                'conversation_id',
                'state',
                'use_case',
                'error_code',
                'created_at',
                'updated_at',
                'version',
                'has_result',
              ];
    const projection = fields.map((field) => `'${field}',${field}`).join(',');
    const size = this.domain.get<{ bytes: number }>(
      `SELECT coalesce(sum(length(CAST(json_object(${projection}) AS BLOB))),0) AS bytes FROM (${sql})`,
    )!.bytes;
    if (size > AI_MAX_SNAPSHOT_BYTES)
      throw new ApplicationError('CAPACITY_EXCEEDED', 'AI metadata index byte capacity reached');
    return this.domain.all<T>(sql + ' LIMIT ?', AI_INDEX_MAX_ENTRIES + 1);
  }
  private page<R extends { cursor: number }, T>(
    rows: readonly R[],
    query: { after: number; limit: number },
    map: (row: R) => T,
  ): { values: T[]; nextCursor: number; hasMore: boolean } {
    const values: T[] = [];
    let nextCursor = query.after;
    let bytes = 0;
    for (const row of rows.slice(0, query.limit)) {
      const value = map(row);
      const size = Buffer.byteLength(JSON.stringify(value));
      if (size > maximumPageBytes)
        throw new ApplicationError('CAPACITY_EXCEEDED', 'AI detail record too large');
      if (bytes + size > maximumPageBytes) break;
      values.push(value);
      bytes += size;
      nextCursor = row.cursor;
    }
    return { values, nextCursor, hasMore: values.length < rows.length };
  }
}
