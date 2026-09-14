import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_TERMINAL_APPEARANCE,
  DEFAULT_TERMINAL_BEHAVIOR,
  type TerminalSession,
} from '@workspace/contracts';
import { CommandHistoryRepository } from '../adapters/sqlite/command-history-repository';
import { ProductDatabase } from '../adapters/sqlite/database';
import { etagFor, ProductRepository } from '../adapters/sqlite/product-repository';
import {
  COMMAND_HISTORY_RECORD_RECEIPT_LIMIT,
  CommandHistoryService,
} from './command-history-service';

function liveTerminal(): TerminalSession {
  return {
    id: randomUUID(),
    kind: 'local',
    title: 'fixture',
    state: 'ready',
    appearance: { ...DEFAULT_TERMINAL_APPEARANCE },
    behavior: { ...DEFAULT_TERMINAL_BEHAVIOR },
    createdAt: new Date().toISOString(),
  };
}

async function fixture() {
  const database = await ProductDatabase.open();
  const repository = new ProductRepository(database);
  const history = new CommandHistoryRepository(database);
  const terminal = liveTerminal();
  const service = new CommandHistoryService(database, history, repository, {
    get(id) {
      if (id !== terminal.id) throw new Error('unknown terminal');
      return terminal;
    },
  });
  return { database, repository, history, terminal, service };
}

const input = (terminalId: string, command: string) => ({
  terminalId,
  command,
  source: 'shellIntegration' as const,
});

describe('CommandHistoryService', () => {
  it('makes disabled, sensitive and recorded outcomes retry-safe without persisting command copies', async () => {
    const context = await fixture();
    try {
      const disabledKey = randomUUID();
      const disabled = context.service.record(
        input(context.terminal.id, 'echo disabled'),
        disabledKey,
      );
      expect(disabled).toMatchObject({ recorded: false, reason: 'disabled' });
      expect(
        context.service.record(input(context.terminal.id, 'echo disabled'), disabledKey),
      ).toEqual(disabled);
      expect(() =>
        context.service.record(input(context.terminal.id, 'echo changed'), disabledKey),
      ).toThrowError(expect.objectContaining({ code: 'CONFLICT' }));

      const settings = context.repository.getSettings();
      context.repository.updateSettings(
        { privacy: { commandHistoryEnabled: true } },
        etagFor(settings.version),
      );
      const sensitive = 'export BUILD_SECRET=credential-marker';
      const sensitiveKey = randomUUID();
      const dropped = context.service.record(input(context.terminal.id, sensitive), sensitiveKey);
      expect(dropped).toMatchObject({ recorded: false, reason: 'sensitive' });
      expect(context.service.record(input(context.terminal.id, sensitive), sensitiveKey)).toEqual(
        dropped,
      );

      const recordKey = randomUUID();
      const recorded = context.service.record(input(context.terminal.id, 'git status'), recordKey);
      expect(recorded).toMatchObject({ recorded: true, count: 1 });
      expect(context.service.record(input(context.terminal.id, 'git status'), recordKey)).toEqual(
        recorded,
      );
      expect(context.history.list().items[0]?.count).toBe(1);
      expect(
        context.service.record(input(context.terminal.id, 'git status'), randomUUID()),
      ).toMatchObject({ recorded: true, count: 2 });

      expect(() =>
        context.service.record(input(context.terminal.id, ' leading-space'), randomUUID()),
      ).toThrow();
      expect(context.history.list().items.some(({ command }) => command.startsWith(' '))).toBe(
        false,
      );

      const receipts = context.database.all<{
        operation: string;
        request_hash: string;
        response: string;
      }>(
        "SELECT operation, request_hash, response FROM idempotency_records WHERE operation LIKE 'command-history.%'",
      );
      const events = context.database.all<{ payload: string }>(
        "SELECT payload FROM domain_events WHERE type LIKE 'command-history.%'",
      );
      expect(JSON.stringify({ receipts, events })).not.toContain('credential-marker');
      expect(receipts.every(({ response }) => !response.includes('git status'))).toBe(true);
    } finally {
      context.database.close();
    }
  });

  it('bounds high-frequency record receipts and defines the old-key replay window', async () => {
    const context = await fixture();
    try {
      const settings = context.repository.getSettings();
      context.repository.updateSettings(
        { privacy: { commandHistoryEnabled: true } },
        etagFor(settings.version),
      );
      for (let index = 0; index < COMMAND_HISTORY_RECORD_RECEIPT_LIMIT + 8; index += 1)
        context.service.record(
          input(context.terminal.id, `echo receipt-${index}`),
          `command-receipt-${String(index).padStart(4, '0')}`,
        );

      expect(
        context.database.get<{ count: number }>(
          "SELECT COUNT(*) AS count FROM idempotency_records WHERE operation='command-history.record'",
        )?.count,
      ).toBe(COMMAND_HISTORY_RECORD_RECEIPT_LIMIT);
      expect(context.history.list({ limit: 200 }).total).toBe(200);

      // Once the deterministic receipt window expires, the old key is a new
      // request and may increment the exact command again.
      expect(
        context.service.record(
          input(context.terminal.id, 'echo receipt-0'),
          'command-receipt-0000',
        ),
      ).toMatchObject({ recorded: true });
    } finally {
      context.database.close();
    }
  });

  it('removes command receipts on explicit clear and when privacy is disabled', async () => {
    const context = await fixture();
    try {
      let settings = context.repository.getSettings();
      context.repository.updateSettings(
        { privacy: { commandHistoryEnabled: true } },
        etagFor(settings.version),
      );
      context.service.record(input(context.terminal.id, 'echo clear-me'), randomUUID());
      const beforeClear = context.history.state();
      const cleared = context.service.clear(beforeClear.etag, 'clear-receipt');
      expect(cleared.deletedCount).toBe(1);
      expect(
        context.database.all<{ operation: string }>(
          "SELECT operation FROM idempotency_records WHERE operation LIKE 'command-history.%'",
        ),
      ).toEqual([{ operation: 'command-history.clear' }]);
      expect(context.service.clear(beforeClear.etag, 'clear-receipt')).toEqual(cleared);

      context.service.record(input(context.terminal.id, 'echo after-clear'), randomUUID());
      settings = context.repository.getSettings();
      context.repository.updateSettings(
        { privacy: { commandHistoryEnabled: false } },
        etagFor(settings.version),
      );
      expect(context.history.list().items).toEqual([]);
      expect(
        context.database.get<{ count: number }>(
          "SELECT COUNT(*) AS count FROM idempotency_records WHERE operation LIKE 'command-history.%'",
        )?.count,
      ).toBe(0);
    } finally {
      context.database.close();
    }
  });
});
