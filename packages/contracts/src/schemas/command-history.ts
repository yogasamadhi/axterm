import { z } from 'zod';
import { idSchema, timestampSchema } from './resources';

/**
 * Command history is deliberately smaller than terminal scrollback. It stores
 * only one shell-integration-confirmed command line per row and never terminal
 * output, authentication answers or arbitrary keyboard input.
 */
export const COMMAND_HISTORY_MAX_ITEMS = 200;
export const COMMAND_HISTORY_DEFAULT_PAGE_SIZE = 50;
export const COMMAND_HISTORY_MAX_COMMAND_LENGTH = 4_096;
export const COMMAND_HISTORY_MAX_SEARCH_LENGTH = 256;

const singleCommandLineSchema = z
  .string()
  .min(1)
  .max(COMMAND_HISTORY_MAX_COMMAND_LENGTH)
  .refine((value) => value === value.trim(), {
    message: 'Command history does not retain leading or trailing whitespace',
  })
  .refine((value) => !containsAsciiControl(value), {
    message: 'Command history accepts one printable command line',
  });

export const commandHistorySortSchema = z.enum(['recent', 'frequency']);
export const commandHistoryEtagSchema = z.string().regex(/^"command-history-v\d+"$/);
export const commandHistoryCursorSchema = z
  .string()
  .min(1)
  .max(512)
  .regex(/^[A-Za-z0-9_-]+$/);

export const commandHistoryItemSchema = z
  .object({
    id: idSchema,
    command: singleCommandLineSchema,
    count: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    lastUsedAt: timestampSchema,
    createdAt: timestampSchema,
    updatedAt: timestampSchema,
    version: z.number().int().positive(),
  })
  .strict();

export const commandHistoryPageQuerySchema = z
  .object({
    sort: commandHistorySortSchema.default('recent'),
    search: z
      .string()
      .trim()
      .max(COMMAND_HISTORY_MAX_SEARCH_LENGTH)
      .refine((value) => !containsAsciiControl(value), {
        message: 'Command history search contains control characters',
      })
      .optional(),
    limit: z.coerce
      .number()
      .int()
      .min(1)
      .max(COMMAND_HISTORY_MAX_ITEMS)
      .default(COMMAND_HISTORY_DEFAULT_PAGE_SIZE),
    cursor: commandHistoryCursorSchema.optional(),
  })
  .strict();

function containsAsciiControl(value: string): boolean {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code < 32 || code === 127) return true;
  }
  return false;
}

export const commandHistoryStateSchema = z
  .object({
    revision: z.number().int().positive(),
    etag: commandHistoryEtagSchema,
  })
  .strict();

export const commandHistoryPageSchema = commandHistoryStateSchema
  .extend({
    sort: commandHistorySortSchema,
    search: z.string().max(COMMAND_HISTORY_MAX_SEARCH_LENGTH),
    limit: z.number().int().min(1).max(COMMAND_HISTORY_MAX_ITEMS),
    total: z.number().int().nonnegative().max(COMMAND_HISTORY_MAX_ITEMS),
    items: z.array(commandHistoryItemSchema).max(COMMAND_HISTORY_MAX_ITEMS),
    nextCursor: commandHistoryCursorSchema.nullable(),
  })
  .strict();

export const recordCommandHistorySchema = z
  .object({
    terminalId: idSchema,
    command: singleCommandLineSchema,
    source: z.literal('shellIntegration'),
  })
  .strict();

const commandHistoryRecordStateSchema = commandHistoryStateSchema.extend({
  id: idSchema.optional(),
  count: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
});

export const recordCommandHistoryResultSchema = z.discriminatedUnion('recorded', [
  commandHistoryRecordStateSchema
    .extend({
      recorded: z.literal(true),
      id: idSchema,
      count: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    })
    .strict(),
  commandHistoryRecordStateSchema
    .extend({
      recorded: z.literal(false),
      reason: z.enum(['disabled', 'sensitive']),
    })
    .strict(),
]);

export const deleteCommandHistoryResultSchema = commandHistoryStateSchema
  .extend({ id: idSchema })
  .strict();

export const clearCommandHistoryResultSchema = commandHistoryStateSchema
  .extend({ deletedCount: z.number().int().nonnegative().max(COMMAND_HISTORY_MAX_ITEMS) })
  .strict();

export type CommandHistorySort = z.infer<typeof commandHistorySortSchema>;
export type CommandHistoryItem = z.infer<typeof commandHistoryItemSchema>;
export type CommandHistoryPageQuery = z.input<typeof commandHistoryPageQuerySchema>;
export type CommandHistoryPage = z.infer<typeof commandHistoryPageSchema>;
export type CommandHistoryState = z.infer<typeof commandHistoryStateSchema>;
export type RecordCommandHistoryInput = z.infer<typeof recordCommandHistorySchema>;
export type RecordCommandHistoryResult = z.infer<typeof recordCommandHistoryResultSchema>;
export type DeleteCommandHistoryResult = z.infer<typeof deleteCommandHistoryResultSchema>;
export type ClearCommandHistoryResult = z.infer<typeof clearCommandHistoryResultSchema>;
