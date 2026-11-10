import { TerminalRecordingWriter } from '../../terminals/src/adapters/terminal-recording.ts';
import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_TERMINAL_APPEARANCE,
  DEFAULT_TERMINAL_BEHAVIOR,
} from '@axterm/plugin-api/terminals';
import type { TriggerRuleInput } from '@axterm/plugin-api/automation';
import type { TerminalChannel } from '../../terminals/src/ports/terminal-channel.ts';
import { BookmarkRepository } from '../../catalog/src/adapters/bookmark-repository.ts';
import {
  ConnectionFactsFixture,
  ConnectionFacts,
} from '../../../../tests/fixtures/level3-connection-facts.ts';
import { productDomains } from '@axterm/data-schema';
import { AutomationStorage } from '../src/adapters/storage.ts';
import { AutomationFacts } from '../src/adapters/facts.ts';
import { QuickCommandRepository } from '../src/adapters/quick-command-repository.ts';
import { QuickCommandService } from '../src/application/quick-commands.ts';
import type { AutomationRealtime } from '../src/ports/realtime.ts';
import { TriggerRepository } from '../src/adapters/trigger-repository.ts';
import { BookmarkTreeService } from '../../catalog/src/application/bookmark-tree-service.ts';
import { TerminalService } from '../../terminals/src/application/terminal-service.ts';
import { TriggerService } from '../src/application/triggers.ts';

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

describe('TriggerService', () => {
  it('persists revisioned rules, sends on streamed output and cleans up with the terminal', async () => {
    const f = await fixture();
    const database = f.sql;
    const channel = new FakeChannel();
    const terminals = new TerminalService({ open: async () => channel }, TerminalRecordingWriter);
    const events: Array<{ type: string; data: unknown }> = [];
    const realtime: AutomationRealtime = {
      publish: (type, data) => {
        events.push({ type, data });
      },
    };
    const repository = new TriggerRepository(database);
    const service = new TriggerService(repository, terminals, realtime);
    const facts = factsFor(f, service);
    try {
      let collection = service.snapshot();
      facts.createTrigger(
        crypto.randomUUID(),
        input('Password responder', 'regex', 'password:$', 'send', String.raw`secret\r`, false),
        collection.etag,
      );
      collection = service.snapshot();
      expect(() =>
        facts.createTrigger(
          crypto.randomUUID(),
          input('stale', 'text', 'stale', 'notify', '', false),
          '"trigger-list-v1"',
        ),
      ).toThrow(/changed/i);
      expect(() =>
        facts.createTrigger(
          crypto.randomUUID(),
          input('unsafe', 'regex', '(a+)+$', 'notify', '', false),
          collection.etag,
        ),
      ).toThrow(/unsafe/i);

      const terminal = await terminals.createLocal({ cols: 80, rows: 24 });
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
      expect(JSON.stringify(f.domain.events(0))).not.toContain('secret');

      await terminals.close(terminal.id);
      expect(service.resourceCount()).toBe(0);
      expect(channel.listenerCount()).toBe(0);
    } finally {
      service.close();
      await terminals.closeAll();
      await f.owner.close();
    }
  });

  it('replaces JSON rules atomically and preserves no previous rule on validation failure', async () => {
    const f = await fixture();
    const database = f.sql;
    const terminals = new TerminalService(
      { open: async () => new FakeChannel() },
      TerminalRecordingWriter,
    );
    const service = new TriggerService(new TriggerRepository(database), terminals, {
      publish: vi.fn(),
    });
    const facts = factsFor(f, service);
    try {
      let collection = service.snapshot();
      facts.replaceTriggers(
        crypto.randomUUID(),
        [
          input('One', 'text', 'one', 'notify', '', false),
          input('Two', 'text', 'two', 'notify', '', false),
        ],
        collection.etag,
      );
      collection = service.snapshot();
      expect(collection.triggers.map(({ name }) => name)).toEqual(['One', 'Two']);
      expect(() =>
        facts.replaceTriggers(
          crypto.randomUUID(),
          [input('Unsafe', 'regex', '(x*)+$', 'notify', '', false)],
          collection.etag,
        ),
      ).toThrow(/unsafe/i);
      expect(service.snapshot().triggers.map(({ name }) => name)).toEqual(['One', 'Two']);
    } finally {
      service.close();
      await f.owner.close();
    }
  });

  it('combines global rules with rules from only the terminal bookmark', async () => {
    const f = await fixture();
    const database = f.sql;
    const products = f.products;
    const bookmarks = f.bookmarks;
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
    const terminals = new TerminalService(
      { open: async () => unrelatedChannel },
      TerminalRecordingWriter,
    );
    const realtime = { publish: vi.fn() };
    const service = new TriggerService(
      new TriggerRepository(database),
      terminals,
      realtime,
      bookmarks,
    );
    const facts = factsFor(f, service);
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
      const unrelated = await terminals.createLocal({ cols: 80, rows: 24 });

      facts.createTrigger(
        crypto.randomUUID(),
        input('Global notification', 'text', 'READY', 'notify', '', false),
        service.snapshot().etag,
      );
      scopedChannel.emit('READY');
      unrelatedChannel.emit('READY');
      expect(realtime.publish).toHaveBeenCalledWith(
        'trigger.fired',
        expect.objectContaining({ terminalId: scopedTerminalId, name: 'Global notification' }),
      );
      expect(realtime.publish).toHaveBeenCalledWith(
        'trigger.fired',
        expect.objectContaining({ terminalId: unrelated.id, name: 'Global notification' }),
      );
      expect(realtime.publish).toHaveBeenCalledWith(
        'trigger.fired',
        expect.objectContaining({ terminalId: scopedTerminalId, name: 'Scoped' }),
      );
      expect(realtime.publish).toHaveBeenCalledTimes(3);

      expect(Buffer.concat(scopedChannel.writes.map(Buffer.from)).toString()).toBe('go\r');
      expect(unrelatedChannel.writes).toHaveLength(0);
      await terminals.close(scopedTerminalId);
      await terminals.close(unrelated.id);
    } finally {
      service.close();
      await terminals.closeAll();
      await f.owner.close();
    }
  });
});

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

async function fixture() {
  const owner = await ConnectionFactsFixture.open();
  const domain = await owner.ctx.storage.domain.open(productDomains.automation);
  owner.ctx.effect(() => () => domain.close());
  return {
    owner,
    domain,
    sql: new AutomationStorage(domain),
    products: new ConnectionFacts(owner),
    bookmarks: new BookmarkTreeService(new BookmarkRepository(owner)),
  };
}
function factsFor(f: Awaited<ReturnType<typeof fixture>>, triggers: TriggerService) {
  return new AutomationFacts(
    f.domain,
    f.sql,
    new QuickCommandService(new QuickCommandRepository(f.sql)),
    triggers,
  );
}
