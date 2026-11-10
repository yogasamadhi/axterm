import {
  aiLogPayloadSchema,
  aiRunSchema,
  type AiRun,
  type AiToolCall,
  type AiApproval,
  type AiLogEntry,
} from '@axterm/plugin-api/ai';
/** Visible log reconstruction only. Commands and Engine handles never enter this Client projection. */
export class AiRunProjection {
  private run: AiRun;
  private output: string;
  private input = '';
  private seenOutput = false;
  private cursor = 0;
  private stateVersion = 0;
  private readonly tools = new Map<string, AiToolCall>();
  private readonly approvals = new Map<string, AiApproval>();
  private readonly totals = {
    execution: { inputTokens: 0, outputTokens: 0 },
    review: { inputTokens: 0, outputTokens: 0 },
  };
  constructor(run: AiRun) {
    this.run = aiRunSchema.parse(run);
    this.output = run.result ?? '';
  }
  accept(entry: AiLogEntry): void {
    if (
      entry.runId !== this.run.id ||
      !Number.isSafeInteger(entry.cursor) ||
      entry.cursor <= this.cursor ||
      !Number.isFinite(Date.parse(entry.createdAt))
    )
      throw new Error('AI_RUN_LOG_INVALID');
    if (new TextEncoder().encode(JSON.stringify(entry.payload)).byteLength > 256 * 1024)
      throw new Error('AI_RUN_LOG_CAPACITY');
    const payload = aiLogPayloadSchema.parse(entry.payload);
    switch (payload.kind) {
      case 'input':
        this.input = payload.text;
        break;
      case 'output': {
        const output =
          payload.mode === 'replace' || !this.seenOutput
            ? payload.text
            : this.output + payload.text;
        if (new TextEncoder().encode(output).byteLength > 2 * 1024 * 1024)
          throw new Error('AI_RUN_LOG_CAPACITY');
        this.output = output;
        this.seenOutput = true;
        break;
      }
      case 'state':
        if (payload.run.id !== this.run.id || payload.run.version < this.stateVersion)
          throw new Error('AI_RUN_LOG_INVALID');
        this.run = aiRunSchema.parse(payload.run);
        this.stateVersion = payload.run.version;
        break;
      case 'tool': {
        const previous = this.tools.get(payload.tool.id);
        if (
          payload.tool.runId !== this.run.id ||
          (previous && previous.version > payload.tool.version)
        )
          throw new Error('AI_RUN_LOG_INVALID');
        if (!previous && this.tools.size >= 256) throw new Error('AI_RUN_LOG_CAPACITY');
        this.tools.set(payload.tool.id, freeze(payload.tool));
        break;
      }
      case 'approval': {
        const previous = this.approvals.get(payload.approval.id);
        if (
          payload.approval.runId !== this.run.id ||
          (previous && previous.version > payload.approval.version)
        )
          throw new Error('AI_RUN_LOG_INVALID');
        if (!previous && this.approvals.size >= 256) throw new Error('AI_RUN_LOG_CAPACITY');
        this.approvals.set(payload.approval.id, freeze(payload.approval));
        break;
      }
      case 'usage': {
        const total = this.totals[payload.purpose ?? 'execution'];
        const input = total.inputTokens + (payload.inputTokens ?? 0);
        const output = total.outputTokens + (payload.outputTokens ?? 0);
        if (!Number.isSafeInteger(input) || !Number.isSafeInteger(output))
          throw new Error('AI_RUN_LOG_CAPACITY');
        total.inputTokens = input;
        total.outputTokens = output;
        break;
      }
      case 'audit':
        break;
    }
    this.cursor = entry.cursor;
  }
  snapshot() {
    return Object.freeze({
      run: Object.freeze({ ...this.run }),
      input: this.input,
      output: this.output,
      cursor: this.cursor,
      tools: Object.freeze([...this.tools.values()]),
      approvals: Object.freeze([...this.approvals.values()]),
      usage: Object.freeze({
        execution: Object.freeze({ ...this.totals.execution }),
        review: Object.freeze({ ...this.totals.review }),
      }),
    });
  }
}

function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
