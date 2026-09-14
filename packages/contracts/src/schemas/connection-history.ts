import { z } from 'zod';
import {
  authTypeSchema,
  connectionSchema,
  hostSchema,
  idSchema,
  sshConnectionOptionsSchema,
  timestampSchema,
} from './resources';
import { bookmarkColorSchema, bookmarkSchema, bookmarkTreeSchema } from './bookmarks';

export const CONNECTION_HISTORY_MAX_ITEMS = 50;
export const CONNECTION_HISTORY_DEFAULT_PAGE_SIZE = 25;

export const connectionHistorySortSchema = z.enum(['recent', 'frequency']);
export const connectionHistoryEtagSchema = z.string().regex(/^"connection-history-v\d+"$/);
export const connectionHistoryCursorSchema = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[A-Za-z0-9_-]+$/);

export const connectionHistoryItemSchema = z
  .object({
    id: idSchema,
    hostId: idSchema.nullable(),
    name: z.string().trim().min(1).max(100),
    hostname: z.string().trim().min(1).max(253),
    port: z.number().int().min(1).max(65_535),
    username: z.string().trim().min(1).max(128),
    authType: authTypeSchema,
    jumpHostId: idSchema.nullable(),
    connectionOptions: sshConnectionOptionsSchema,
    count: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    lastConnectedAt: timestampSchema,
    createdAt: timestampSchema,
    updatedAt: timestampSchema,
    version: z.number().int().positive(),
  })
  .strict();

export const connectionHistoryPageQuerySchema = z
  .object({
    sort: connectionHistorySortSchema.default('recent'),
    limit: z.coerce
      .number()
      .int()
      .min(1)
      .max(CONNECTION_HISTORY_MAX_ITEMS)
      .default(CONNECTION_HISTORY_DEFAULT_PAGE_SIZE),
    cursor: connectionHistoryCursorSchema.optional(),
  })
  .strict();

export const connectionHistoryStateSchema = z
  .object({
    revision: z.number().int().positive(),
    etag: connectionHistoryEtagSchema,
  })
  .strict();

export const connectionHistoryPageSchema = connectionHistoryStateSchema
  .extend({
    sort: connectionHistorySortSchema,
    limit: z.number().int().min(1).max(CONNECTION_HISTORY_MAX_ITEMS),
    total: z.number().int().nonnegative().max(CONNECTION_HISTORY_MAX_ITEMS),
    items: z.array(connectionHistoryItemSchema).max(CONNECTION_HISTORY_MAX_ITEMS),
    nextCursor: connectionHistoryCursorSchema.nullable(),
  })
  .strict();

export const reconnectConnectionHistorySchema = z
  .object({
    temporarySecret: z.string().max(131_072).optional(),
    temporaryPassphrase: z.string().max(16_384).optional(),
  })
  .strict();

export const promoteConnectionHistorySchema = z
  .object({
    groupId: idSchema.nullable().default(null),
    title: z.string().trim().min(1).max(100).optional(),
    color: bookmarkColorSchema.default(null),
    description: z.string().max(2_000).default(''),
    profileId: idSchema.nullable().default(null),
  })
  .strict();

export const deleteConnectionHistoryResultSchema = connectionHistoryStateSchema
  .extend({ id: idSchema })
  .strict();

export const clearConnectionHistoryResultSchema = connectionHistoryStateSchema
  .extend({ deletedCount: z.number().int().nonnegative().max(CONNECTION_HISTORY_MAX_ITEMS) })
  .strict();

export const promoteConnectionHistoryResultSchema = z
  .object({
    historyItem: connectionHistoryItemSchema,
    history: connectionHistoryStateSchema,
    host: hostSchema,
    bookmark: bookmarkSchema,
    tree: bookmarkTreeSchema,
    createdHost: z.boolean(),
  })
  .strict();

export const reconnectConnectionHistoryResultSchema = z
  .object({
    connection: connectionSchema,
    historyItem: connectionHistoryItemSchema,
  })
  .strict();

export type ConnectionHistorySort = z.infer<typeof connectionHistorySortSchema>;
export type ConnectionHistoryItem = z.infer<typeof connectionHistoryItemSchema>;
export type ConnectionHistoryPageQuery = z.input<typeof connectionHistoryPageQuerySchema>;
export type ConnectionHistoryPage = z.infer<typeof connectionHistoryPageSchema>;
export type ConnectionHistoryState = z.infer<typeof connectionHistoryStateSchema>;
export type ReconnectConnectionHistoryInput = z.input<typeof reconnectConnectionHistorySchema>;
export type PromoteConnectionHistoryInput = z.input<typeof promoteConnectionHistorySchema>;
export type DeleteConnectionHistoryResult = z.infer<typeof deleteConnectionHistoryResultSchema>;
export type ClearConnectionHistoryResult = z.infer<typeof clearConnectionHistoryResultSchema>;
export type PromoteConnectionHistoryResult = z.infer<typeof promoteConnectionHistoryResultSchema>;
export type ReconnectConnectionHistoryResult = z.infer<
  typeof reconnectConnectionHistoryResultSchema
>;
