import iconv from 'iconv-lite';
import {
  triggerRuleInputSchema,
  type TriggerCollection,
  type TriggerRule,
  type TriggerRuleInput,
  type TriggerRulePatch,
} from '@workspace/contracts';
import type { TriggerRepository } from '../adapters/sqlite/trigger-repository';
import type { TerminalOutputObserver, TerminalService } from './terminal-service';
import type { BookmarkTreeService } from './bookmark-tree-service';
import { ApplicationError } from './errors';
import type { RealtimeHub } from './realtime-hub';
import {
  expandTriggerControlCharacters,
  TriggerEngine,
  validateTriggerPattern,
} from './trigger-engine';

interface TerminalTriggerSession {
  engine: TriggerEngine;
  decoder: ReturnType<typeof iconv.getDecoder>;
  encoding: string;
  fireCount: number;
  bookmarkRules: TriggerRule[];
}

const MAX_TRIGGERS = 256;
const MAX_FIRES_PER_TERMINAL = 1_000;

export class TriggerService implements TerminalOutputObserver {
  private readonly sessions = new Map<string, TerminalTriggerSession>();
  private readonly removeObserver: () => void;
  private rules: TriggerRule[];

  constructor(
    private readonly repository: TriggerRepository,
    private readonly terminals: TerminalService,
    private readonly realtime: RealtimeHub,
    private readonly bookmarks?: BookmarkTreeService,
  ) {
    this.rules = repository.snapshot().triggers;
    this.removeObserver = terminals.addOutputObserver(this);
  }

  snapshot(): TriggerCollection {
    return this.repository.snapshot();
  }

  create(input: TriggerRuleInput, ifMatch: string | undefined): TriggerCollection {
    if (this.rules.length >= MAX_TRIGGERS)
      throw new ApplicationError('CONFLICT', `At most ${MAX_TRIGGERS} triggers may be saved`, 409);
    const next = this.repository.create(normalize(input), ifMatch);
    this.refresh(next);
    return next;
  }

  update(id: string, patch: TriggerRulePatch, ifMatch: string | undefined): TriggerCollection {
    if (!Object.keys(patch).length)
      throw new ApplicationError('INVALID_STATE', 'Trigger update is empty', 409);
    const current = this.rules.find((rule) => rule.id === id);
    if (!current) throw new ApplicationError('NOT_FOUND', 'Trigger not found', 404);
    const next = this.repository.update(
      id,
      normalize({
        name: patch.name ?? current.name,
        enabled: patch.enabled ?? current.enabled,
        match: patch.match ?? current.match,
        action: patch.action ?? current.action,
        sendEnter: patch.sendEnter ?? current.sendEnter,
        mode: patch.mode ?? current.mode,
        cooldownMs: patch.cooldownMs ?? current.cooldownMs,
      }),
      ifMatch,
    );
    this.refresh(next);
    return next;
  }

  delete(id: string, ifMatch: string | undefined): TriggerCollection {
    const next = this.repository.delete(id, ifMatch);
    this.refresh(next);
    return next;
  }

  replace(inputs: TriggerRuleInput[], ifMatch: string | undefined): TriggerCollection {
    if (inputs.length > MAX_TRIGGERS)
      throw new ApplicationError('CONFLICT', `At most ${MAX_TRIGGERS} triggers may be saved`, 409);
    const next = this.repository.replace(inputs.map(normalize), ifMatch);
    this.refresh(next);
    return next;
  }

  receive(terminalId: string, data: Uint8Array, encoding: string): void {
    if (!data.byteLength) return;
    let session = this.sessions.get(terminalId);
    if (!session || session.encoding !== encoding) {
      session?.engine.dispose();
      const decoder = iconv.getDecoder(iconv.encodingExists(encoding) ? encoding : 'utf8');
      const bookmarkRules = this.bookmarkRulesForTerminal(terminalId);
      session = {
        decoder,
        encoding,
        fireCount: 0,
        bookmarkRules,
        engine: new TriggerEngine((event) => {
          const current = this.sessions.get(terminalId);
          if (!current) return;
          current.fireCount += 1;
          if (current.fireCount > MAX_FIRES_PER_TERMINAL) {
            current.engine.setRules([]);
            this.realtime.publish('trigger.session-disabled', {
              terminalId,
              errorCode: 'TRIGGER_FIRE_LIMIT',
            });
            return;
          }
          if (event.action === 'send') {
            const expanded = expandTriggerControlCharacters(event.rule.action.value);
            const payload =
              event.rule.sendEnter && !/[\r\n]$/u.test(expanded) ? `${expanded}\r` : expanded;
            if (payload) this.terminals.insertText(terminalId, payload);
          }
          this.realtime.publish('trigger.fired', {
            terminalId,
            triggerId: event.rule.id,
            name: event.rule.name,
            actionType: event.action,
          });
        }),
      };
      session.engine.setRules(this.effectiveRules(bookmarkRules));
      this.sessions.set(terminalId, session);
    }
    session.engine.push(session.decoder.write(Buffer.from(data)));
  }

  closed(terminalId: string): void {
    const session = this.sessions.get(terminalId);
    if (!session) return;
    session.engine.dispose();
    this.sessions.delete(terminalId);
  }

  resourceCount(): number {
    return this.sessions.size;
  }

  close(): void {
    this.removeObserver();
    for (const session of this.sessions.values()) session.engine.dispose();
    this.sessions.clear();
  }

  private refresh(collection: TriggerCollection): void {
    this.rules = collection.triggers;
    for (const session of this.sessions.values())
      session.engine.setRules(this.effectiveRules(session.bookmarkRules));
  }

  private effectiveRules(bookmarkRules: TriggerRule[]): TriggerRule[] {
    if (!bookmarkRules.length) return this.rules;
    const globalIds = new Set(this.rules.map(({ id }) => id));
    return [...this.rules, ...bookmarkRules.filter(({ id }) => !globalIds.has(id))];
  }

  private bookmarkRulesForTerminal(terminalId: string): TriggerRule[] {
    if (!this.bookmarks) return [];
    const bookmarkId = this.terminals.get(terminalId).bookmarkId;
    if (!bookmarkId) return [];
    let bookmark;
    try {
      bookmark = this.bookmarks.getBookmark(bookmarkId);
    } catch {
      return [];
    }
    return bookmark.triggers.map((rule) => ({
      ...rule,
      createdAt: bookmark.createdAt,
      updatedAt: bookmark.updatedAt,
      version: bookmark.version,
    }));
  }
}

function normalize(input: TriggerRuleInput): TriggerRuleInput {
  const parsed = triggerRuleInputSchema.parse({ ...input, name: input.name.trim() });
  try {
    validateTriggerPattern({ match: parsed.match });
  } catch (error) {
    throw new ApplicationError(
      'VALIDATION_ERROR',
      error instanceof Error ? error.message : 'Trigger pattern is invalid',
      400,
    );
  }
  return parsed;
}
