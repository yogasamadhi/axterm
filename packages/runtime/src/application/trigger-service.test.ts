import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_TERMINAL_APPEARANCE,
  DEFAULT_TERMINAL_BEHAVIOR,
  type TriggerRule,
  type TriggerRuleInput,
} from '@workspace/contracts';
import type { TerminalChannel } from '../ports/terminal-channel';
import { BookmarkRepository } from '../adapters/sqlite/bookmark-repository';
import { ProductDatabase } from '../adapters/sqlite/database';
import { ProductRepository } from '../adapters/sqlite/product-repository';
import { TriggerRepository } from '../adapters/sqlite/trigger-repository';
import { BookmarkTreeService } from './bookmark-tree-service';
import { RealtimeHub, type RealtimeEvent } from './realtime-hub';
import { TerminalService } from './terminal-service';
import { TriggerEngine, expandTriggerControlCharacters } from './trigger-engine';
import { TriggerService } from './trigger-service';

class FakeChannel implements TerminalChannel {
  readonly shellIntegrationKind = 'unsupported' as const;
  readonly writes: Uint8Array[] = [];
  private readonly dataListeners = new Set<(data: Uint8Array) => void>();
  private readonly exitListeners = new Set<(code: number | null) => void>();
  resize = vi.fn();
  signal = vi.fn();
  pause = vi.fn();
  resume = vi.fn();
  close = vi.fn(async () => {});
  write(data: Uint8Array) {
    this.writes.push(Buffer.from(data));
  }
  onData(listener: (data: Uint8Array) => void) {
    this.dataListeners.add(listener);
    return () => this.dataListeners.delete(listener);
  }
  onExit(listener: (exitCode: number | null) => void) {
    this.exitListeners.add(listener);
    return () => this.exitListeners.delete(listener);
  }
  emit(text: string) {
    for (const listener of this.dataListeners) listener(Buffer.from(text));
  }
  listenerCount() {
    return this.dataListeners.size + this.exitListeners.size;
  }
}

describe('TriggerEngine', () => {
  it('matches text across chunks while stripping split ANSI and normalizing CRLF', () => {
    const fired: string[] = [];
    const engine = new TriggerEngine(({ matched }) => fired.push(matched));
    engine.setRules([rule('Prompt', 'Password:\n')]);

    engine.push('\u001b[31mPass');
    engine.push('\u001b[0mword:\r');
    expect(fired).toEqual([]);
    engine.push('\n');

    expect(fired).toEqual(['Password:\n']);
  });

  it('honors repeat, cooldown, once and disabled rules without reusing old matches', () => {
    let now = 1_000;
    const fired: string[] = [];
    const engine = new TriggerEngine(
      ({ rule: current }) => fired.push(current.name),
      () => now,
    );
    engine.setRules([
      rule('repeat', 'R', { mode: 'repeat' }),
      rule('cooldown', 'C', { mode: 'cooldown', cooldownMs: 500 }),
      rule('once', 'O', { mode: 'once' }),
      rule('disabled', 'D', { enabled: false }),
    ]);
    engine.push('RCOD');
    now += 100;
    engine.push('RCO');
    now += 500;
    engine.push('RCO');

    expect(fired.filter((name) => name === 'repeat')).toHaveLength(3);
    expect(fired.filter((name) => name === 'cooldown')).toHaveLength(2);
    expect(fired.filter((name) => name === 'once')).toHaveLength(1);
    expect(fired).not.toContain('disabled');
  });

  it('expands Electerm-compatible control character notation', () => {
    expect(expandTriggerControlCharacters(String.raw`yes\r\x03^D\\`)).toBe(`yes\r\u0003\u0004\\`);
  });
});

describe('TriggerService', () => {
  it('persists revisioned rules, sends on streamed output and cleans up with the terminal', async () => {
    const database = await ProductDatabase.open();
    const channel = new FakeChannel();
    const terminals = new TerminalService({ open: () => channel });
    const realtime = new RealtimeHub();
    const events: RealtimeEvent[] = [];
    const unsubscribe = realtime.subscribe((event) => events.push(event));
    const repository = new TriggerRepository(database);
    const service = new TriggerService(repository, terminals, realtime);
    try {
      let collection = service.snapshot();
      collection = service.create(
        input('Password responder', 'regex', 'password:$', 'send', String.raw`secret\r`, false),
        collection.etag,
      );
      expect(() =>
        service.create(input('stale', 'text', 'stale', 'notify', '', false), '"trigger-list-v1"'),
      ).toThrow(/changed/i);
      expect(() =>
        service.create(input('unsafe', 'regex', '(a+)+$', 'notify', '', false), collection.etag),
      ).toThrow(/unsafe/i);

      const terminal = terminals.createLocal({ cols: 80, rows: 24 });
      channel.emit('\u001b[33mPass');
      channel.emit('word:\u001b[0m');

      expect(Buffer.concat(channel.writes.map(Buffer.from)).toString()).toBe('secret\r');
      expect(service.resourceCount()).toBe(1);
      expect(events.find(({ type }) => type === 'trigger.fired')?.data).toEqual({
        terminalId: terminal.id,
        triggerId: collection.triggers[0]!.id,
        name: 'Password responder',
        actionType: 'send',
      });
      expect(JSON.stringify(database.all('SELECT payload FROM domain_events'))).not.toContain(
        'secret',
      );

      await terminals.close(terminal.id);
      expect(service.resourceCount()).toBe(0);
      expect(channel.listenerCount()).toBe(0);
    } finally {
      service.close();
      unsubscribe();
      await terminals.closeAll();
      database.close();
    }
  });

  it('replaces JSON rules atomically and preserves no previous rule on validation failure', async () => {
    const database = await ProductDatabase.open();
    const terminals = new TerminalService({ open: () => new FakeChannel() });
    const service = new TriggerService(
      new TriggerRepository(database),
      terminals,
      new RealtimeHub(),
    );
    try {
      let collection = service.snapshot();
      collection = service.replace(
        [
          input('One', 'text', 'one', 'notify', '', false),
          input('Two', 'text', 'two', 'notify', '', false),
        ],
        collection.etag,
      );
      expect(collection.triggers.map(({ name }) => name)).toEqual(['One', 'Two']);
      expect(() =>
        service.replace([input('Unsafe', 'regex', '(x*)+$', 'notify', '', false)], collection.etag),
      ).toThrow(/unsafe/i);
      expect(service.snapshot().triggers.map(({ name }) => name)).toEqual(['One', 'Two']);
    } finally {
      service.close();
      database.close();
    }
  });

  it('combines global rules with rules from only the terminal bookmark', async () => {
    const database = await ProductDatabase.open();
    const products = new ProductRepository(database);
    const bookmarkRepository = new BookmarkRepository(database);
    const bookmarks = new BookmarkTreeService(bookmarkRepository);
    const host = products.createHost({
      name: 'Scoped trigger host',
      hostname: '127.0.0.1',
      port: 22,
      username: 'operator',
      authType: 'agent',
    });
    const trigger = {
      id: crypto.randomUUID(),
      name: 'Scoped',
      enabled: true,
      match: { type: 'text' as const, value: 'READY', caseSensitive: false },
      action: { type: 'send' as const, value: 'go' },
      sendEnter: true,
      mode: 'cooldown' as const,
      cooldownMs: 500,
    };
    let tree = bookmarks.snapshot();
    tree = bookmarks.createBookmark(
      {
        protocol: 'ssh',
        hostId: host.id,
        title: 'Scoped trigger bookmark',
        triggers: [trigger],
      },
      tree.etag,
    );
    const bookmark = tree.bookmarks[0]!;
    const scopedChannel = new FakeChannel();
    const unrelatedChannel = new FakeChannel();
    const terminals = new TerminalService({ open: () => unrelatedChannel });
    const realtime = new RealtimeHub();
    const service = new TriggerService(
      new TriggerRepository(database),
      terminals,
      realtime,
      bookmarks,
    );
    try {
      const scopedTerminalId = crypto.randomUUID();
      terminals.registerExternal(
        {
          id: scopedTerminalId,
          kind: 'ssh',
          title: 'Scoped',
          state: 'ready',
          connectionId: crypto.randomUUID(),
          bookmarkId: bookmark.id,
          appearance: DEFAULT_TERMINAL_APPEARANCE,
          behavior: DEFAULT_TERMINAL_BEHAVIOR,
          createdAt: new Date().toISOString(),
        },
        scopedChannel,
      );
      const unrelated = terminals.createLocal({ cols: 80, rows: 24 });

      scopedChannel.emit('READY');
      unrelatedChannel.emit('READY');

      expect(Buffer.concat(scopedChannel.writes.map(Buffer.from)).toString()).toBe('go\r');
      expect(unrelatedChannel.writes).toHaveLength(0);
      await terminals.close(scopedTerminalId);
      await terminals.close(unrelated.id);
    } finally {
      service.close();
      await terminals.closeAll();
      database.close();
    }
  });
});

function rule(name: string, value: string, overrides: Partial<TriggerRule> = {}): TriggerRule {
  const now = new Date().toISOString();
  return {
    id: crypto.randomUUID(),
    name,
    enabled: true,
    match: { type: 'text', value, caseSensitive: true },
    action: { type: 'notify', value: '' },
    sendEnter: false,
    mode: 'repeat',
    cooldownMs: 0,
    createdAt: now,
    updatedAt: now,
    version: 1,
    ...overrides,
  };
}

function input(
  name: string,
  matchType: 'text' | 'regex',
  matchValue: string,
  actionType: 'send' | 'notify',
  actionValue: string,
  sendEnter: boolean,
): TriggerRuleInput {
  return {
    name,
    enabled: true,
    match: { type: matchType, value: matchValue, caseSensitive: false },
    action:
      actionType === 'send' ? { type: 'send', value: actionValue } : { type: 'notify', value: '' },
    sendEnter,
    mode: 'cooldown',
    cooldownMs: 500,
  };
}
