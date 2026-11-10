import { z } from 'zod';
import type { RelationalDomain } from '@axterm/plugin-api/storage';
import { aiMessageSchema, type AiMessage } from '@axterm/plugin-api/ai';
import type { AiMessageWindow, AiMessageWindowQuery } from '@axterm/plugin-api/ai';
import { ApplicationError } from '../application/errors.ts';
const cursor = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const limit = z.number().int().min(1).max(100).default(50);
const querySchema = z.discriminatedUnion('direction', [
  z.object({ direction: z.literal('latest'), limit }).strict(),
  z.object({ direction: z.enum(['earlier', 'later']), cursor, limit }).strict(),
]);
const maximumBytes = 3 * 1024 * 1024 - 4096;
interface Row {
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
}
/** Bounded latest/older/newer reads. Cursors advance only over accepted messages. */
export class AiMessageWindows {
  constructor(
    private readonly domain: RelationalDomain,
    private readonly conversation: (id: string) => unknown,
  ) {}
  read(conversationId: string, raw: AiMessageWindowQuery): AiMessageWindow {
    z.uuid().parse(conversationId);
    const query = querySchema.parse(raw);
    this.conversation(conversationId);
    return this.domain.transaction(() => {
      const forward = query.direction === 'later';
      const anchor = query.direction === 'latest' ? Number.MAX_SAFE_INTEGER : query.cursor;
      const rows = this.domain.all<{ cursor: number; id: string }>(
        forward
          ? 'SELECT rowid AS cursor,id FROM ai_messages WHERE conversation_id=? AND run_id IS NOT NULL AND rowid>? ORDER BY rowid ASC LIMIT ?'
          : 'SELECT rowid AS cursor,id FROM ai_messages WHERE conversation_id=? AND run_id IS NOT NULL AND rowid<? ORDER BY rowid DESC LIMIT ?',
        conversationId,
        anchor,
        query.limit,
      );
      const accepted: { cursor: number; message: AiMessage }[] = [];
      let bytes = 0;
      for (const index of rows) {
        const row = this.domain.get<Row>(
          'SELECT * FROM ai_messages WHERE id=? AND conversation_id=?',
          index.id,
          conversationId,
        );
        if (!row) throw new ApplicationError('NOT_FOUND', 'AI message no longer exists');
        const message = aiMessageSchema.parse({
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
        const size = Buffer.byteLength(JSON.stringify(message));
        if (size > maximumBytes)
          throw new ApplicationError('CAPACITY_EXCEEDED', 'AI detail record too large');
        if (bytes + size > maximumBytes) break;
        accepted.push({ cursor: index.cursor, message });
        bytes += size;
      }
      if (!forward) accepted.reverse();
      const firstCursor = accepted[0]?.cursor ?? anchor;
      const lastCursor = accepted.at(-1)?.cursor ?? anchor;
      const hasEarlier = !!this.domain.get<{ found: number }>(
        'SELECT EXISTS(SELECT 1 FROM ai_messages WHERE conversation_id=? AND run_id IS NOT NULL AND rowid<?) AS found',
        conversationId,
        firstCursor,
      )?.found;
      const hasLater = !!this.domain.get<{ found: number }>(
        'SELECT EXISTS(SELECT 1 FROM ai_messages WHERE conversation_id=? AND run_id IS NOT NULL AND rowid>?) AS found',
        conversationId,
        lastCursor,
      )?.found;
      return {
        messages: accepted.map((row) => row.message),
        firstCursor,
        lastCursor,
        hasEarlier,
        hasLater,
      };
    });
  }
}
