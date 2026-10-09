import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { Terminal as HeadlessTerminal } from '@xterm/headless';
import { describe, expect, it } from 'vitest';
import { TerminalCommandTrackerAddon } from '../../../../apps/desktop/src/renderer/src/components/terminal-command-tracker';
import { CommandHistoryRepository } from '../adapters/sqlite/command-history-repository';
import { ProductDatabase } from '../adapters/sqlite/database';
import { NodePtyAdapter } from '../adapters/pty/node-pty-adapter';
import { etagFor, ProductRepository } from '../adapters/sqlite/product-repository';
import type { TerminalSocket } from './terminal-service';
import { TerminalService } from './terminal-service';
import { createShellIntegrationCommand, detectShellIntegrationKind } from './shell-integration';
import { CommandHistoryService } from './command-history-service';

class Osc633Stream {
  private buffer = '';
  readonly events: string[] = [];

  constructor(private readonly tracker: TerminalCommandTrackerAddon) {}

  push(data: Uint8Array): void {
    this.buffer += Buffer.from(data).toString('utf8');
    while (true) {
      const start = this.buffer.indexOf('\u001b]633;');
      if (start < 0) {
        this.buffer = this.buffer.slice(-32);
        return;
      }
      const end = this.buffer.indexOf('\u0007', start + 6);
      if (end < 0) {
        this.buffer = this.buffer.slice(start);
        return;
      }
      const event = this.buffer.slice(start + 6, end);
      this.events.push(event);
      this.tracker.handle(event);
      this.buffer = this.buffer.slice(end + 1);
    }
  }
}

class TrackingSocket extends EventEmitter {
  bufferedAmount = 0;
  readyState = 1;
  readonly controls: Array<Record<string, unknown>> = [];
  readonly binary: Buffer[] = [];
  private replayBytes = 0;
  readonly stream: Osc633Stream;

  constructor(readonly tracker: TerminalCommandTrackerAddon) {
    super();
    this.stream = new Osc633Stream(tracker);
  }

  send(data: Uint8Array | string): void {
    if (typeof data === 'string') {
      const control = JSON.parse(data) as Record<string, unknown>;
      this.controls.push(control);
      if (control.type === 'shellIntegration')
        this.tracker.setState(control.state as 'pending' | 'active' | 'unavailable');
      if (control.type === 'replay') {
        this.replayBytes = Number(control.byteLength);
        if (this.replayBytes) this.tracker.beginReplay();
      }
      return;
    }
    const chunk = Buffer.from(data);
    this.binary.push(chunk);
    this.stream.push(chunk);
    if (this.replayBytes) {
      this.replayBytes -= chunk.length;
      if (this.replayBytes <= 0) {
        this.replayBytes = 0;
        this.tracker.endReplay();
      }
    }
  }

  close(): void {
    if (this.readyState !== 1) return;
    this.readyState = 3;
    this.emit('close');
  }
}

describe('Runtime shell integration', () => {
  it('detects only supported POSIX shells and keeps injection bounded', () => {
    expect(detectShellIntegrationKind('/bin/bash', 'linux')).toBe('bash');
    expect(detectShellIntegrationKind('/usr/bin/zsh', 'darwin')).toBe('zsh');
    expect(detectShellIntegrationKind('/opt/homebrew/bin/fish', 'darwin')).toBe('fish');
    expect(detectShellIntegrationKind('/bin/sh', 'linux')).toBe('unsupported');
    expect(detectShellIntegrationKind('/bin/bash', 'win32')).toBe('unsupported');
    expect(createShellIntegrationCommand('unsupported')).toBeUndefined();
    for (const kind of ['bash', 'zsh', 'fish'] as const) {
      const command = createShellIntegrationCommand(kind);
      expect(command).toBeDefined();
      expect(Buffer.byteLength(command!, 'utf8')).toBeLessThan(16 * 1024);
      expect(command).toContain('AXTERM_SHELL_INTEGRATION');
      expect(command).toContain('633;P;Cwd=');
    }
  });

  it.skipIf(process.platform === 'win32')(
    'executes an application-approved command in a real interactive PTY',
    async () => {
      const directory = await mkdtemp(join(tmpdir(), 'axterm-approved-command-'));
      const outputPath = join(directory, 'approved.txt');
      const terminals = new TerminalService(new NodePtyAdapter());
      try {
        const terminal = terminals.createLocal({
          shell: '/bin/bash',
          shellArgs: ['--noprofile', '--norc'],
          cwd: directory,
          env: { PS1: 'AXTERM_FIXTURE$ ' },
          cols: 100,
          rows: 30,
        });
        const socket = new TrackingSocket(
          new TerminalCommandTrackerAddon(
            () => {},
            () => {},
          ),
        );
        terminals.attach(terminal.id, socket as unknown as TerminalSocket, 'approved-command');
        await expect
          .poll(
            () =>
              socket.controls.some(
                ({ type, state }) => type === 'shellIntegration' && state === 'active',
              ),
            { timeout: 5_000 },
          )
          .toBe(true);
        await terminals.executeCommand(terminal.id, `printf APPROVED > '${outputPath}'`);
        await expect
          .poll(async () => readFile(outputPath, 'utf8').catch(() => ''))
          .toBe('APPROVED');
      } finally {
        await terminals.closeAll();
        await rm(directory, { recursive: true, force: true });
      }
    },
    10_000,
  );

  it.skipIf(process.platform !== 'darwin')(
    'renders one copy of a multiline zsh prompt after delayed integration',
    async () => {
      const terminals = new TerminalService(new NodePtyAdapter());
      try {
        const terminal = terminals.createLocal({
          shell: '/bin/zsh',
          shellArgs: ['-d', '-f'],
          env: { PROMPT: 'AXTERM_PROMPT_TITLE\nAXTERM_PROMPT_INPUT ' },
          cols: 100,
          rows: 30,
        });
        const socket = new TrackingSocket(
          new TerminalCommandTrackerAddon(
            () => {},
            () => {},
          ),
        );
        terminals.attach(terminal.id, socket as unknown as TerminalSocket, 'zsh-multiline-prompt');

        await expect
          .poll(
            () =>
              socket.controls.some(
                ({ type, state }) => type === 'shellIntegration' && state === 'active',
              ),
            { timeout: 5_000 },
          )
          .toBe(true);
        const visibleOutput = Buffer.concat(socket.binary).toString('utf8');
        expect(visibleOutput.match(/AXTERM_PROMPT_TITLE/gu)).toHaveLength(1);
        expect(visibleOutput.match(/AXTERM_PROMPT_INPUT/gu)).toHaveLength(1);

        const screen = new HeadlessTerminal({ allowProposedApi: true, cols: 100, rows: 30 });
        await new Promise<void>((resolve) => screen.write(visibleOutput, resolve));
        expect(screen.buffer.active.getLine(0)?.translateToString(true)).toContain(
          'AXTERM_PROMPT_TITLE',
        );
        expect(screen.buffer.active.getLine(1)?.translateToString(true)).toContain(
          'AXTERM_PROMPT_INPUT',
        );
        screen.dispose();
      } finally {
        await terminals.closeAll();
      }
    },
    10_000,
  );

  it.skipIf(process.platform === 'win32')(
    'records one compound bash line, drops leading-space and sensitive lines, and suppresses replay',
    async () => {
      const database = await ProductDatabase.open();
      const repository = new ProductRepository(database);
      const terminals = new TerminalService(new NodePtyAdapter());
      const history = new CommandHistoryRepository(database);
      const commandHistory = new CommandHistoryService(database, history, repository, terminals);
      let terminalId = '';
      const createTracker = () =>
        new TerminalCommandTrackerAddon(
          (command) =>
            commandHistory.record(
              { terminalId, command, source: 'shellIntegration' },
              randomUUID(),
            ),
          () => {},
        );
      try {
        const settings = repository.getSettings();
        repository.updateSettings(
          { privacy: { commandHistoryEnabled: true } },
          etagFor(settings.version),
        );
        const terminal = terminals.createLocal({
          shell: '/bin/bash',
          shellArgs: ['--noprofile', '--norc'],
          cwd: process.cwd(),
          env: {
            HISTCONTROL: 'ignoreboth',
            HISTFILE: '/dev/null',
            PS1: 'AXTERM_FIXTURE$ ',
          },
          cols: 100,
          rows: 30,
        });
        terminalId = terminal.id;
        const first = new TrackingSocket(createTracker());
        terminals.attach(terminal.id, first as unknown as TerminalSocket, 'fixture-live');

        await expect
          .poll(
            () =>
              first.controls.some(
                ({ type, state }) => type === 'shellIntegration' && state === 'active',
              ),
            { timeout: 5_000 },
          )
          .toBe(true);
        first.emit('message', Buffer.from("printf 'one' && printf 'two'\r"), true);
        await expect
          .poll(() => history.list().items[0]?.command, { timeout: 5_000 })
          .toBe("printf 'one' && printf 'two'");

        first.emit('message', Buffer.from(' echo leading-hidden\r'), true);
        first.emit(
          'message',
          Buffer.from('export FIXTURE_SECRET=credential-marker; printf sensitive-finished\r'),
          true,
        );
        await expect
          .poll(() => Buffer.concat(first.binary).toString('utf8'), { timeout: 5_000 })
          .toContain('sensitive-finished');
        expect(history.list().items.map(({ command }) => command)).toEqual([
          "printf 'one' && printf 'two'",
        ]);
        expect(first.stream.events).toContain("E;printf 'one' && printf 'two'");
        expect(first.stream.events.some((event) => event.includes('FIXTURE_SECRET'))).toBe(true);
        expect(first.stream.events.some((event) => event.includes('leading-hidden'))).toBe(false);

        first.close();
        const replay = new TrackingSocket(createTracker());
        terminals.attach(terminal.id, replay as unknown as TerminalSocket, 'fixture-replay');
        expect(replay.controls.some(({ type }) => type === 'replay')).toBe(true);
        expect(replay.stream.events.some((event) => event.startsWith('E;'))).toBe(true);
        expect(history.list().items[0]?.count).toBe(1);
        replay.close();
      } finally {
        await terminals.closeAll();
        database.close();
      }
    },
    10_000,
  );
});
