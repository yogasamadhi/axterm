import { z } from 'zod';
import type { RelationalDomain } from '@axterm/plugin-api/storage';
import { type AiApproval } from '@axterm/plugin-api/ai';
import { ApplicationError } from '../application/errors.ts';
import type { AiFactsPort } from '../ports/facts.ts';
import type { AiRepository } from './repository.ts';
import type { AiRunJournal } from './run-journal.ts';
/** Composition adapter: application mutations cannot omit the durable journal. */
export class AiFacts implements AiFactsPort {
  constructor(
    private readonly domain: RelationalDomain,
    private readonly repository: AiRepository,
    private readonly journal: AiRunJournal,
    private readonly generation: string,
  ) {}
  lookup: AiFactsPort['lookup'] = (...args) => this.journal.lookup(...args);
  admit: AiFactsPort['admit'] = (...args) => this.journal.admit(...args);
  updateAiRun: AiFactsPort['updateAiRun'] = (...args) => this.journal.transition(...args);
  output(runId: string, text: string): void {
    // A single Engine delta may be larger than one record. No acknowledgements occur until all records commit.
    this.domain.transaction(() => {
      for (let start = 0; start < text.length;) {
        let end = Math.min(start + 32768, text.length);
        if (end < text.length && /[\uD800-\uDBFF]/u.test(text[end - 1]!)) end--;
        this.journal.append(runId, { kind: 'output', text: text.slice(start, end) });
        start = end;
      }
    });
  }
  usage: AiFactsPort['usage'] = (runId, input) => {
    this.journal.append(runId, {
      kind: 'usage',
      ...(input.purpose === undefined ? {} : { purpose: input.purpose }),
      ...(input.inputTokens === undefined ? {} : { inputTokens: input.inputTokens }),
      ...(input.outputTokens === undefined ? {} : { outputTokens: input.outputTokens }),
    });
  };
  createToolCall: AiFactsPort['createToolCall'] = (input) => {
    if (input.state !== 'proposed')
      throw new ApplicationError('INVALID_STATE', 'AI tools must be proposed first');
    const { state: _state, ...proposed } = input;
    return this.journal.createTool(proposed);
  };
  updateToolCall: AiFactsPort['updateToolCall'] = (...args) => this.journal.updateTool(...args);
  updateCommandCall: AiFactsPort['updateCommandCall'] = (...args) =>
    this.journal.updateCommand(...args);
  createApproval: AiFactsPort['createApproval'] = (input) => {
    const tool = this.repository.getToolCall(input.toolCallId);
    if (
      tool.runId !== input.runId ||
      tool.argsHash !== input.argsHash ||
      tool.target !== input.target
    )
      throw new ApplicationError('CONFLICT', 'AI approval target changed');
    return this.journal.requestApproval(tool.id, input.expiresAt);
  };
  lookupApproval: AiFactsPort['lookupApproval'] = (key, input) =>
    this.journal.lookupApproval(key, this.generation, input);
  decideApproval(
    id: string,
    state: 'approved' | 'rejected' | 'expired',
    commandId?: string,
  ): AiApproval {
    z.uuid().parse(id);
    return this.domain.transaction(() => {
      const current = this.repository.getApproval(id);
      if (commandId && (state === 'approved' || state === 'rejected')) {
        this.journal.decideApproval(commandId, this.generation, {
          id,
          argsHash: current.argsHash,
          decision: state === 'approved' ? 'approve_once' : 'reject',
        });
        const next = this.repository.getApproval(id);
        if (state === 'approved' && next.state !== 'approved')
          throw new ApplicationError('PRECONDITION_FAILED', 'Approval expired');
        return next;
      }
      if (state === 'approved')
        throw new ApplicationError('PRECONDITION_REQUIRED', 'Approval command identity required');
      if (state === 'expired' && Date.parse(current.expiresAt) > Date.now())
        throw new ApplicationError('PRECONDITION_FAILED', 'Approval has not expired');
      // Internal cleanup can only revoke authority. It must never manufacture approval.
      this.journal.append(current.runId, { kind: 'approval', approval: current });
      const next = this.repository.decideApproval(id, state);
      this.journal.append(next.runId, { kind: 'approval', approval: next });
      return next;
    });
  }
}
