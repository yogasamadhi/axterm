import type { TriggerRule } from '@workspace/contracts';

interface RuleState {
  signature: string;
  startAt: number;
  seenEnd: number;
  consumedEnd: number;
  lastFire: number;
  firedOnce: boolean;
}

export interface TriggerFire {
  rule: TriggerRule;
  matched: string;
  action: 'send' | 'notify';
}

export class TriggerEngine {
  private buffer = '';
  private base = 0;
  private rules: TriggerRule[] = [];
  private readonly expressions = new Map<string, RegExp | null>();
  private ruleState = new Map<string, RuleState>();
  private readonly sanitizer = new StreamingTerminalTextSanitizer();

  constructor(
    private readonly fire: (event: TriggerFire) => void,
    private readonly now: () => number = Date.now,
    private readonly maxBuffer = 65_536,
  ) {}

  setRules(rules: TriggerRule[]): void {
    const streamEnd = this.base + this.buffer.length;
    const next = new Map<string, RuleState>();
    for (const rule of rules) {
      const signature = JSON.stringify([
        rule.enabled,
        rule.match,
        rule.action,
        rule.sendEnter,
        rule.mode,
        rule.cooldownMs,
      ]);
      const previous = this.ruleState.get(rule.id);
      next.set(
        rule.id,
        previous?.signature === signature
          ? previous
          : {
              signature,
              startAt: streamEnd,
              seenEnd: streamEnd,
              consumedEnd: streamEnd,
              lastFire: 0,
              firedOnce: false,
            },
      );
    }
    this.rules = rules;
    this.ruleState = next;
    this.expressions.clear();
  }

  push(raw: string): void {
    const text = this.sanitizer.push(raw);
    if (!text) return;
    this.buffer += text;
    if (this.buffer.length > this.maxBuffer) {
      const over = this.buffer.length - this.maxBuffer;
      this.buffer = this.buffer.slice(over);
      this.base += over;
    }
    this.scan();
  }

  dispose(): void {
    this.buffer = '';
    this.base = 0;
    this.rules = [];
    this.expressions.clear();
    this.ruleState.clear();
    this.sanitizer.reset();
  }

  private scan(): void {
    const now = this.now();
    const streamEnd = this.base + this.buffer.length;
    for (const rule of this.rules) {
      if (!rule.enabled) continue;
      const state = this.ruleState.get(rule.id);
      if (!state) continue;
      if (rule.mode === 'once' && state.firedOnce) {
        state.seenEnd = streamEnd;
        continue;
      }
      const expression = this.expression(rule);
      if (!expression) {
        state.seenEnd = streamEnd;
        continue;
      }
      const global = new RegExp(expression.source, `${expression.ignoreCase ? 'i' : ''}g`);
      const previousEnd = state.seenEnd;
      if (rule.match.type === 'text') {
        const overlap = Math.max(0, rule.match.value.length - 1);
        global.lastIndex = Math.max(0, previousEnd - this.base - overlap);
      }
      let match: RegExpExecArray | null;
      while ((match = global.exec(this.buffer))) {
        const matchStart = this.base + match.index;
        const matchEnd = matchStart + match[0].length;
        const fresh =
          matchEnd > previousEnd && matchStart >= state.startAt && matchStart >= state.consumedEnd;
        const cooledDown = rule.mode !== 'cooldown' || now - state.lastFire >= rule.cooldownMs;
        if (fresh) {
          state.consumedEnd = Math.max(state.consumedEnd, matchEnd);
          if (cooledDown) {
            state.lastFire = now;
            if (rule.mode === 'once') state.firedOnce = true;
            try {
              this.fire({ rule, matched: match[0], action: rule.action.type });
            } catch {
              // One rejected action must not break scanning or terminal output delivery.
            }
            if (rule.mode === 'once') break;
          }
        }
        if (!match[0].length) global.lastIndex += 1;
        if (global.lastIndex > this.buffer.length) break;
      }
      state.seenEnd = streamEnd;
    }
  }

  private expression(rule: TriggerRule): RegExp | null {
    if (this.expressions.has(rule.id)) return this.expressions.get(rule.id)!;
    try {
      const source =
        rule.match.type === 'regex' ? rule.match.value : escapeRegExp(rule.match.value);
      const expression = new RegExp(source, rule.match.caseSensitive ? '' : 'i');
      this.expressions.set(rule.id, expression);
      return expression;
    } catch {
      this.expressions.set(rule.id, null);
      return null;
    }
  }
}

export function expandTriggerControlCharacters(text: string): string {
  let result = '';
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index]!;
    const next = text[index + 1];
    if (character === '\\' && next) {
      if (next === 'n') result += '\n';
      else if (next === 't') result += '\t';
      else if (next === 'r') result += '\r';
      else if (next === '\\') result += '\\';
      else if (next === 'x' && /^[0-9a-f]{2}$/iu.test(text.slice(index + 2, index + 4))) {
        result += String.fromCharCode(Number.parseInt(text.slice(index + 2, index + 4), 16));
        index += 2;
      } else {
        result += character;
        continue;
      }
      index += 1;
    } else if (character === '^' && next && /^[@A-Z[\\\]^_]$/u.test(next)) {
      result += String.fromCharCode(next.charCodeAt(0) - 64);
      index += 1;
    } else result += character;
  }
  return result;
}

export function validateTriggerPattern(rule: Pick<TriggerRule, 'match'>): void {
  if (rule.match.type !== 'regex') return;
  try {
    new RegExp(rule.match.value);
  } catch {
    throw new Error('Trigger regular expression is invalid');
  }
  if (
    /\\[1-9]/u.test(rule.match.value) ||
    /\(\?<[=!]/u.test(rule.match.value) ||
    /\([^)]*(?:\*|\+|\{\d+(?:,\d*)?\})[^)]*\)(?:\*|\+|\{\d+(?:,\d*)?\})/u.test(rule.match.value) ||
    /(?:\*|\+|\{\d+(?:,\d*)?\})[^)]{0,32}(?:\*|\+|\{\d+(?:,\d*)?\})/u.test(rule.match.value)
  )
    throw new Error('Trigger regular expression uses an unsafe construct');
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

class StreamingTerminalTextSanitizer {
  private state: 'text' | 'escape' | 'csi' | 'osc' | 'osc-escape' = 'text';
  private pendingCarriageReturn = false;

  push(input: string): string {
    let output = '';
    for (const character of input) {
      if (this.state === 'osc') {
        if (character === '\u0007') this.state = 'text';
        else if (character === '\u001b') this.state = 'osc-escape';
        continue;
      }
      if (this.state === 'osc-escape') {
        this.state = character === '\\' ? 'text' : character === '\u001b' ? 'osc-escape' : 'osc';
        continue;
      }
      if (this.state === 'csi') {
        if (character >= '@' && character <= '~') this.state = 'text';
        continue;
      }
      if (this.state === 'escape') {
        if (character === '[') this.state = 'csi';
        else if (character === ']') this.state = 'osc';
        else this.state = 'text';
        continue;
      }
      if (character === '\u001b') {
        this.state = 'escape';
        continue;
      }
      if (this.pendingCarriageReturn) {
        output += '\n';
        this.pendingCarriageReturn = false;
        if (character === '\n') continue;
      }
      if (character === '\r') this.pendingCarriageReturn = true;
      else output += character;
    }
    return output;
  }

  reset(): void {
    this.state = 'text';
    this.pendingCarriageReturn = false;
  }
}
