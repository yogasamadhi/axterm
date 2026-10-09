import {
  clearCommandHistoryResultSchema,
  commandHistoryPageQuerySchema,
  deleteCommandHistoryResultSchema,
  recordCommandHistoryResultSchema,
  recordCommandHistorySchema,
  type ClearCommandHistoryResult,
  type CommandHistoryPage,
  type CommandHistoryPageQuery,
  type DeleteCommandHistoryResult,
  type RecordCommandHistoryInput,
  type RecordCommandHistoryResult,
  type TerminalSession,
} from '@workspace/contracts';
import { isSensitiveCommandLine } from '@workspace/shared';
import type { CommandHistoryRepository } from '../adapters/sqlite/command-history-repository';
import { stableHash, type ProductRepository } from '../adapters/sqlite/product-repository';
import type { UnitOfWork } from '../ports/unit-of-work';
import { ApplicationError } from './errors';

interface TerminalLookup {
  get(id: string): TerminalSession;
}

export const COMMAND_HISTORY_RECORD_RECEIPT_LIMIT = 512;
export const COMMAND_HISTORY_MUTATION_RECEIPT_LIMIT = 64;

/**
 * Coordinates privacy, live-terminal ownership and durable command history.
 * Only OSC 633 shell-integration events may reach this use case.
 */
export class CommandHistoryService {
  constructor(
    private readonly unitOfWork: UnitOfWork,
    private readonly history: CommandHistoryRepository,
    private readonly repository: ProductRepository,
    private readonly terminals: TerminalLookup,
  ) {}

  list(input: CommandHistoryPageQuery = {}): CommandHistoryPage {
    return this.history.list(commandHistoryPageQuerySchema.parse(input));
  }

  record(
    input: RecordCommandHistoryInput,
    idempotencyKey: string | undefined,
  ): RecordCommandHistoryResult {
    const command = recordCommandHistorySchema.parse(input);
    const key = requireIdempotencyKey(idempotencyKey);
    // The generic receipt stores only a hash and safe result metadata. It never
    // creates a second durable copy of the command body.
    const receiptRequest = {
      terminalId: command.terminalId,
      source: command.source,
      commandHash: stableHash(command.command),
    };
    const previous = this.repository.resolveIdempotency<RecordCommandHistoryResult>(
      key,
      'command-history.record',
      receiptRequest,
    );
    if (previous) return recordCommandHistoryResultSchema.parse(previous);

    const terminal = this.terminals.get(command.terminalId);
    if (terminal.state !== 'ready')
      throw new ApplicationError('INVALID_STATE', 'Terminal is not ready', 409);

    let result: RecordCommandHistoryResult | undefined;
    this.unitOfWork.transaction(() => {
      const state = this.history.state();
      if (!this.repository.getSettings().privacy.commandHistoryEnabled) {
        result = recordCommandHistoryResultSchema.parse({
          recorded: false,
          reason: 'disabled',
          ...state,
        });
      } else if (isSensitiveCommandLine(command.command)) {
        result = recordCommandHistoryResultSchema.parse({
          recorded: false,
          reason: 'sensitive',
          ...state,
        });
      } else {
        const item = this.history.record(command.command);
        result = recordCommandHistoryResultSchema.parse({
          recorded: true,
          id: item.id,
          count: item.count,
          ...this.history.state(),
        });
      }
      this.repository.recordIdempotency(
        key,
        'command-history.record',
        receiptRequest,
        result,
        COMMAND_HISTORY_RECORD_RECEIPT_LIMIT,
      );
    });
    if (!result) throw new Error('Command history record workflow did not return a result');
    return result;
  }

  delete(
    id: string,
    ifMatch: string | undefined,
    idempotencyKey: string | undefined,
  ): DeleteCommandHistoryResult {
    const key = requireIdempotencyKey(idempotencyKey);
    const request = { id, ifMatch };
    const previous = this.repository.resolveIdempotency<DeleteCommandHistoryResult>(
      key,
      'command-history.delete',
      request,
    );
    if (previous) return deleteCommandHistoryResultSchema.parse(previous);

    let result: DeleteCommandHistoryResult | undefined;
    this.unitOfWork.transaction(() => {
      result = this.history.delete(id, ifMatch);
      this.repository.recordIdempotency(
        key,
        'command-history.delete',
        request,
        result,
        COMMAND_HISTORY_MUTATION_RECEIPT_LIMIT,
      );
    });
    if (!result) throw new Error('Command history delete workflow did not return a result');
    return result;
  }

  clear(
    ifMatch: string | undefined,
    idempotencyKey: string | undefined,
  ): ClearCommandHistoryResult {
    const key = requireIdempotencyKey(idempotencyKey);
    const request = { ifMatch };
    const previous = this.repository.resolveIdempotency<ClearCommandHistoryResult>(
      key,
      'command-history.clear',
      request,
    );
    if (previous) return clearCommandHistoryResultSchema.parse(previous);

    let result: ClearCommandHistoryResult | undefined;
    this.unitOfWork.transaction(() => {
      result = this.history.clear(ifMatch);
      this.repository.deleteIdempotencyByOperationPrefix('command-history.');
      this.repository.recordIdempotency(
        key,
        'command-history.clear',
        request,
        result,
        COMMAND_HISTORY_MUTATION_RECEIPT_LIMIT,
      );
    });
    if (!result) throw new Error('Command history clear workflow did not return a result');
    return result;
  }
}

/**
 * Conservative deny policy: when a command resembles an inline credential we
 * drop the whole line instead of attempting reversible redaction.
 */
function requireIdempotencyKey(value: string | undefined): string {
  if (!value)
    throw new ApplicationError('PRECONDITION_REQUIRED', 'Idempotency-Key is required', 428);
  if (value.length > 200)
    throw new ApplicationError('PRECONDITION_FAILED', 'Idempotency-Key is invalid', 412);
  return value;
}
