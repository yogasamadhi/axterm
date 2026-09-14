import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Terminal as HeadlessTerminal } from '@xterm/headless';
import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_TERMINAL_APPEARANCE,
  DEFAULT_TERMINAL_BEHAVIOR,
  TERMINAL_INPUT_FRAME_MAX_BYTES,
} from '@workspace/contracts';
import type { PtyPort, ShellIntegrationKind, TerminalChannel } from '../ports/terminal-channel';
import { TerminalService, type TerminalSocket } from './terminal-service';

class FakeChannel implements TerminalChannel {
  shellIntegrationKind?: ShellIntegrationKind;
  writes: Uint8Array[] = [];
  resize = vi.fn();
  signal = vi.fn();
  pause = vi.fn();
  resume = vi.fn();
  close = vi.fn(async () => {});
  private readonly dataListeners = new Set<(data: Uint8Array) => void>();
  private readonly exitListeners = new Set<(code: number | null) => void>();
  constructor(shellIntegrationKind?: ShellIntegrationKind) {
    if (shellIntegrationKind) this.shellIntegrationKind = shellIntegrationKind;
  }
  write(data: Uint8Array) {
    this.writes.push(data);
  }
  onData(listener: (data: Uint8Array) => void) {
    this.dataListeners.add(listener);
    return () => this.dataListeners.delete(listener);
  }
  onExit(listener: (exitCode: number | null) => void) {
    this.exitListeners.add(listener);
    return () => this.exitListeners.delete(listener);
  }
  emitData(data: Uint8Array) {
    for (const listener of this.dataListeners) listener(data);
  }
  emitExit(code: number | null) {
    for (const listener of this.exitListeners) listener(code);
  }
  listenerCount() {
    return this.dataListeners.size + this.exitListeners.size;
  }
}

class FakeSocket extends EventEmitter {
  bufferedAmount = 0;
  readyState = 1;
  sent: Array<Uint8Array | string> = [];
  send(data: Uint8Array | string) {
    this.sent.push(data);
  }
  close() {
    this.readyState = 3;
    this.emit('close');
  }
}

function controls(socket: FakeSocket) {
  return socket.sent
    .filter((item): item is string => typeof item === 'string')
    .map((item) => JSON.parse(item) as Record<string, unknown>);
}

function binary(socket: FakeSocket) {
  return socket.sent.filter((item): item is Uint8Array => typeof item !== 'string');
}

describe('TerminalService', () => {
  it('inserts bounded text without appending an execution byte', async () => {
    const channel = new FakeChannel('unsupported');
    const service = new TerminalService({ open: () => channel });
    const terminal = service.createLocal({ cols: 80, rows: 24 });

    service.insertText(terminal.id, '"/tmp/example file" ');
    expect(Buffer.concat(channel.writes.map((value) => Buffer.from(value))).toString('utf8')).toBe(
      '"/tmp/example file" ',
    );
    expect(() => service.insertText(terminal.id, '')).toThrowError(
      expect.objectContaining({ code: 'VALIDATION_ERROR' }),
    );
    await service.closeAll();
  });

  it('runs startup steps in order after delay and bounded output-idle waits, then cancels on close', async () => {
    vi.useFakeTimers();
    const channel = new FakeChannel('unsupported');
    const service = new TerminalService({ open: () => channel });
    try {
      const terminal = service.createLocal({ cols: 80, rows: 24 });
      service.enqueueStartupSequence(terminal.id, [
        {
          text: 'one',
          delayMs: 100,
          sendEnter: true,
          waitForOutput: true,
          settleIdleMs: 50,
          settleTimeoutMs: 500,
        },
        {
          text: 'two',
          delayMs: 0,
          sendEnter: false,
          waitForOutput: false,
          settleIdleMs: 50,
          settleTimeoutMs: 500,
        },
      ]);
      service.insertText(terminal.id, 'user-input');
      await vi.advanceTimersByTimeAsync(99);
      expect(channel.writes.map((data) => Buffer.from(data).toString())).toEqual(['one\r']);
      await vi.advanceTimersByTimeAsync(1);
      channel.emitData(Buffer.from('working'));
      await vi.advanceTimersByTimeAsync(49);
      expect(channel.writes).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(channel.writes.map((data) => Buffer.from(data).toString())).toEqual([
        'one\r',
        'two',
        'user-input',
      ]);
      expect(service.startupSequenceCount()).toBe(0);

      service.enqueueStartupSequence(terminal.id, [
        {
          text: 'before-close',
          delayMs: 0,
          sendEnter: true,
          waitForOutput: true,
          settleIdleMs: 1_000,
          settleTimeoutMs: 5_000,
        },
        {
          text: 'must-not-run',
          delayMs: 0,
          sendEnter: true,
          waitForOutput: false,
          settleIdleMs: 50,
          settleTimeoutMs: 500,
        },
      ]);
      await vi.advanceTimersByTimeAsync(0);
      await service.close(terminal.id);
      await vi.advanceTimersByTimeAsync(5_000);
      expect(channel.writes.map((data) => Buffer.from(data).toString())).not.toContain(
        'must-not-run\r',
      );
      expect(service.startupSequenceCount()).toBe(0);
    } finally {
      await service.closeAll();
      vi.useRealTimers();
    }
  });

  it('passes the effective local profile to PTY and snapshots its renderer configuration', async () => {
    const channel = new FakeChannel();
    let openInput: Parameters<PtyPort['open']>[0] | undefined;
    const service = new TerminalService({
      open: (input) => {
        openInput = input;
        return channel;
      },
    });
    const appearance = {
      fontFamily: 'JetBrains Mono, monospace',
      fontSize: 18,
      lineHeight: 1.3,
      cursorStyle: 'bar' as const,
      cursorBlink: true,
    };
    const profileId = randomUUID();
    const behavior = {
      ...DEFAULT_TERMINAL_BEHAVIOR,
      wordSeparator: ' /',
      backspaceMode: '^H' as const,
      shiftEnterMode: '\\r',
    };
    const session = service.createLocal({
      profileId,
      shell: '/bin/zsh',
      shellArgs: ['-d', '-f'],
      cwd: '/tmp',
      env: { PROFILE_MARKER: 'active', LANG: 'zh_CN.UTF-8' },
      term: 'xterm-direct',
      loginShell: true,
      appearance,
      behavior,
      cols: 132,
      rows: 43,
    });

    expect(openInput).toEqual({
      shell: '/bin/zsh',
      args: ['-d', '-f'],
      cwd: '/tmp',
      env: { PROFILE_MARKER: 'active', LANG: 'zh_CN.UTF-8' },
      term: 'xterm-direct',
      loginShell: true,
      cols: 132,
      rows: 43,
    });
    expect(session).toMatchObject({ profileId, appearance, behavior });
    expect(service.createLocal({ cols: 80, rows: 24 }).appearance).toEqual(
      DEFAULT_TERMINAL_APPEARANCE,
    );
    expect(service.createLocal({ cols: 80, rows: 24 }).behavior).toEqual(DEFAULT_TERMINAL_BEHAVIOR);
    await service.closeAll();
  });

  it('uses binary terminal frames, validates controls, applies backpressure and cleans resources', async () => {
    const channel = new FakeChannel();
    const pty: PtyPort = { open: () => channel };
    const service = new TerminalService(pty);
    const session = service.createLocal({ cols: 80, rows: 24 });
    const socket = new FakeSocket();
    service.attach(session.id, socket as unknown as TerminalSocket);

    socket.emit('message', Buffer.from('hello'), true);
    socket.emit(
      'message',
      Buffer.from(JSON.stringify({ type: 'resize', cols: 120, rows: 40 })),
      false,
    );
    socket.emit('message', Buffer.from('{'), false);
    expect(Buffer.from(channel.writes[0]!).toString()).toBe('hello');
    expect(channel.resize).toHaveBeenCalledWith(120, 40);
    expect(
      socket.sent.some((item) => typeof item === 'string' && item.includes('INVALID_CONTROL')),
    ).toBe(true);

    socket.emit('message', Buffer.alloc(TERMINAL_INPUT_FRAME_MAX_BYTES + 1), true);
    expect(controls(socket)).toContainEqual({
      type: 'error',
      code: 'TERMINAL_INPUT_TOO_LARGE',
    });

    socket.bufferedAmount = 2 * 1024 * 1024;
    channel.emitData(Buffer.from('output'));
    channel.emitData(Buffer.from('more'));
    expect(channel.pause).toHaveBeenCalledTimes(1);
    socket.bufferedAmount = 0;
    await vi.waitFor(() => expect(channel.resume).toHaveBeenCalledTimes(1));

    await service.close(session.id);
    expect(channel.close).toHaveBeenCalledTimes(1);
    expect(channel.listenerCount()).toBe(0);
    expect(service.resourceCount()).toBe(0);
  });

  it('transcodes only SSH input using the immutable session encoding', async () => {
    const sshChannel = new FakeChannel();
    const localChannel = new FakeChannel();
    const service = new TerminalService({ open: () => localChannel });
    const ssh = service.registerExternal(
      {
        id: randomUUID(),
        kind: 'ssh',
        title: 'GBK SSH',
        state: 'ready',
        connectionId: randomUUID(),
        appearance: { ...DEFAULT_TERMINAL_APPEARANCE },
        behavior: { ...DEFAULT_TERMINAL_BEHAVIOR, encoding: 'gbk' },
        createdAt: new Date().toISOString(),
      },
      sshChannel,
    );
    const sshSocket = new FakeSocket();
    service.attach(ssh.id, sshSocket as unknown as TerminalSocket);
    sshSocket.emit('message', Buffer.from('中文', 'utf8'), true);
    expect(Buffer.from(sshChannel.writes[0]!).toString('hex')).toBe('d6d0cec4');
    sshChannel.emitData(Buffer.from('d6d0cec4', 'hex'));
    expect(service.recentOutput(ssh.id)).toBe('中文');

    const local = service.createLocal({
      behavior: { ...DEFAULT_TERMINAL_BEHAVIOR, encoding: 'gbk' },
      cols: 80,
      rows: 24,
    });
    const localSocket = new FakeSocket();
    service.attach(local.id, localSocket as unknown as TerminalSocket);
    localSocket.emit('message', Buffer.from('中文', 'utf8'), true);
    expect(Buffer.from(localChannel.writes[0]!).toString('hex')).toBe(
      Buffer.from('中文', 'utf8').toString('hex'),
    );
    await service.closeAll();
  });

  it('records bounded recent and live output to an append-only granted file', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'axterm-terminal-service-log-'));
    const path = join(directory, 'terminal.log');
    const channel = new FakeChannel();
    const service = new TerminalService({ open: () => channel });
    try {
      const session = service.createLocal({ cols: 80, rows: 24 });
      const socket = new FakeSocket();
      service.attach(session.id, socket as unknown as TerminalSocket, randomUUID());
      channel.emitData(Buffer.from('\u001b[31mRECENT\u001b[0m\r\n'));

      const active = await service.startRecording(session.id, {
        path,
        fileName: 'terminal.log',
        timestamps: false,
        includeRecent: true,
      });
      expect(active).toMatchObject({
        terminalId: session.id,
        state: 'active',
        fileName: 'terminal.log',
        timestamps: false,
      });
      expect(active).not.toHaveProperty('path');
      expect(controls(socket)).toContainEqual({ type: 'recording', recording: active });
      expect(JSON.stringify(controls(socket))).not.toContain(path);
      await expect(
        service.startRecording(session.id, {
          path,
          fileName: 'other.log',
          timestamps: false,
          includeRecent: false,
        }),
      ).rejects.toMatchObject({ code: 'INVALID_STATE', status: 409 });

      channel.emitData(Buffer.from('LIVE\r\n'));
      const stopped = await service.stopRecording(session.id);
      expect(stopped).toMatchObject({ state: 'stopped', fileName: 'terminal.log' });
      expect(stopped.bytesWritten).toBe(Buffer.byteLength('RECENT\nLIVE\n'));
      expect(controls(socket)).toContainEqual({ type: 'recording', recording: stopped });
      expect(await readFile(path, 'utf8')).toBe('RECENT\nLIVE\n');
      expect(service.get(session.id).recording).toEqual(stopped);
      await expect(service.stopRecording(session.id)).rejects.toMatchObject({
        code: 'INVALID_STATE',
        status: 409,
      });
    } finally {
      await service.closeAll();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('bounds recent output independently of attached sockets', async () => {
    const channel = new FakeChannel();
    const service = new TerminalService({ open: () => channel });
    const session = service.createLocal({ cols: 80, rows: 24 });
    channel.emitData(Buffer.alloc(80 * 1024, 97));
    channel.emitData(Buffer.alloc(80 * 1024, 98));
    expect(Buffer.byteLength(service.recentOutput(session.id))).toBe(80 * 1024);
    expect(service.recentOutput(session.id)).toBe('b'.repeat(80 * 1024));
    await service.closeAll();
  });

  it('replays complete chunks and reports when an older chunk was truncated', async () => {
    const channel = new FakeChannel();
    const service = new TerminalService({ open: () => channel });
    const session = service.createLocal({ cols: 80, rows: 24 });
    channel.emitData(Buffer.alloc(80 * 1024, 97));
    channel.emitData(Buffer.alloc(80 * 1024, 98));

    const socket = new FakeSocket();
    service.attach(session.id, socket as unknown as TerminalSocket, randomUUID());

    expect(controls(socket)).toContainEqual({
      type: 'replay',
      firstSequence: 2,
      lastSequence: 2,
      byteLength: 80 * 1024,
      truncated: true,
    });
    expect(binary(socket)).toHaveLength(1);
    expect(Buffer.from(binary(socket)[0]!).equals(Buffer.alloc(80 * 1024, 98))).toBe(true);
    await service.closeAll();
  });

  it('uses a stable client cursor to avoid duplicate replay after reattach', async () => {
    const channel = new FakeChannel();
    const service = new TerminalService({ open: () => channel });
    const session = service.createLocal({ cols: 80, rows: 24 });
    const clientId = randomUUID();
    channel.emitData(Buffer.from('one'));

    const first = new FakeSocket();
    service.attach(session.id, first as unknown as TerminalSocket, clientId);
    channel.emitData(Buffer.from('two'));
    first.close();
    channel.emitData(Buffer.from('three'));

    const second = new FakeSocket();
    service.attach(session.id, second as unknown as TerminalSocket, clientId);

    expect(controls(second)).toContainEqual({
      type: 'replay',
      firstSequence: 3,
      lastSequence: 3,
      byteLength: 5,
      truncated: false,
    });
    expect(Buffer.concat(binary(second).map((item) => Buffer.from(item))).toString('utf8')).toBe(
      'three',
    );
    await service.closeAll();
  });

  it('queues stdin until shell integration is confirmed without joining it to the hook', async () => {
    vi.useFakeTimers();
    const channel = new FakeChannel('bash');
    const service = new TerminalService({ open: () => channel });
    try {
      const session = service.createLocal({ cols: 80, rows: 24 });
      const socket = new FakeSocket();
      service.attach(session.id, socket as unknown as TerminalSocket);

      socket.emit('message', Buffer.from("printf 'user-first'\r"), true);
      expect(channel.writes).toEqual([]);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(channel.writes).toHaveLength(1);
      expect(Buffer.from(channel.writes[0]!).toString('utf8')).toContain(
        'AXTERM_SHELL_INTEGRATION',
      );
      expect(Buffer.from(channel.writes[0]!).toString('utf8')).not.toContain('user-first');

      channel.emitData(Buffer.from(`bootstrap echo\r\n\u001b]633;A\u0007fixture$ `));
      await vi.advanceTimersByTimeAsync(50);
      expect(controls(socket)).toContainEqual({ type: 'shellIntegration', state: 'active' });
      expect(channel.writes).toHaveLength(2);
      expect(Buffer.from(channel.writes[1]!).toString('utf8')).toBe("printf 'user-first'\r");
    } finally {
      await service.closeAll();
      vi.useRealTimers();
    }
  });

  it('replaces the hidden bootstrap prompt without rendering a duplicate prompt', async () => {
    vi.useFakeTimers();
    const channel = new FakeChannel('zsh');
    const service = new TerminalService({ open: () => channel });
    try {
      const session = service.createLocal({ cols: 80, rows: 24 });
      const socket = new FakeSocket();
      service.attach(session.id, socket as unknown as TerminalSocket);

      channel.emitData(Buffer.from('Welcome to AxTerm\r\nold-prompt-title\r\nold-prompt$ '));
      expect(binary(socket)).toEqual([]);

      await vi.advanceTimersByTimeAsync(1_000);
      channel.emitData(
        Buffer.from(`echoed bootstrap\r\n\u001b]633;A\u0007new-prompt-title\r\nnew-prompt$ `),
      );
      await vi.advanceTimersByTimeAsync(50);

      const rendered = Buffer.concat(binary(socket).map((item) => Buffer.from(item))).toString(
        'utf8',
      );
      expect(rendered).toBe(
        'Welcome to AxTerm\r\n\u001b]633;A\u0007new-prompt-title\r\nnew-prompt$ ',
      );
      expect(rendered).not.toContain('old-prompt');
      expect(rendered).not.toContain('echoed bootstrap');
    } finally {
      await service.closeAll();
      vi.useRealTimers();
    }
  });

  it('does not retain a leading blank line when replacing the local bootstrap prompt', async () => {
    vi.useFakeTimers();
    const channel = new FakeChannel('zsh');
    const service = new TerminalService({ open: () => channel });
    try {
      const session = service.createLocal({ cols: 80, rows: 24 });
      const socket = new FakeSocket();
      service.attach(session.id, socket as unknown as TerminalSocket);

      channel.emitData(Buffer.from('\r\nold-prompt-title\r\nold-prompt$ '));
      await vi.advanceTimersByTimeAsync(1_000);
      channel.emitData(Buffer.from(`echoed bootstrap\r\n\u001b]633;A\u0007new-title\r\nnew$ `));
      await vi.advanceTimersByTimeAsync(50);

      expect(Buffer.concat(binary(socket).map((item) => Buffer.from(item))).toString('utf8')).toBe(
        '\u001b]633;A\u0007new-title\r\nnew$ ',
      );
    } finally {
      await service.closeAll();
      vi.useRealTimers();
    }
  });

  it('replaces a cursor-redrawn local prompt as one visual prompt', async () => {
    vi.useFakeTimers();
    const channel = new FakeChannel('bash');
    const service = new TerminalService({ open: () => channel });
    try {
      const session = service.createLocal({ cols: 80, rows: 24 });
      const socket = new FakeSocket();
      service.attach(session.id, socket as unknown as TerminalSocket);

      channel.emitData(
        Buffer.from(
          '\u001b[?25l\u001b[>c\u001b[6n\u001b[?25h' +
            '\u001b[?25l\r\n\u001b[1L\u001b[1A\r\n\u001b[1Aold-title\r\nold$ \u001b[?25h',
        ),
      );
      await vi.advanceTimersByTimeAsync(1_000);
      const replacement = Buffer.from(
        '\u001b]633;A\u0007\u001b[?25l\r\n\u001b[1L\u001b[1A\r\n' +
          '\u001b[1Anew-title\r\nnew$ \u001b[?25h',
      );
      channel.emitData(Buffer.concat([Buffer.from('echoed bootstrap\r\n'), replacement]));
      await vi.advanceTimersByTimeAsync(50);

      const rendered = Buffer.concat(binary(socket).map((item) => Buffer.from(item)));
      expect(rendered).toEqual(replacement);
      vi.useRealTimers();
      const screen = new HeadlessTerminal({ allowProposedApi: true, cols: 80, rows: 24 });
      await new Promise<void>((resolve) => screen.write(rendered, resolve));
      expect(screen.buffer.active.getLine(0)?.translateToString(true)).toBe('new-title');
      expect(screen.buffer.active.getLine(1)?.translateToString(true)).toBe('new$ ');
      screen.dispose();
    } finally {
      await service.closeAll();
      vi.useRealTimers();
    }
  });

  it('keeps an SSH banner before a cursor-redrawn prompt', async () => {
    vi.useFakeTimers();
    const channel = new FakeChannel('bash');
    const service = new TerminalService({ open: () => channel });
    const terminalId = randomUUID();
    try {
      service.registerExternal(
        {
          id: terminalId,
          kind: 'ssh',
          title: 'fixture',
          state: 'ready',
          connectionId: randomUUID(),
          appearance: { ...DEFAULT_TERMINAL_APPEARANCE },
          behavior: { ...DEFAULT_TERMINAL_BEHAVIOR },
          createdAt: new Date().toISOString(),
        },
        channel,
        'bash',
      );
      const socket = new FakeSocket();
      service.attach(terminalId, socket as unknown as TerminalSocket);

      channel.emitData(
        Buffer.from(
          'Last login\r\n\u001b[?25l\u001b[>c\u001b[6n\u001b[?25h' +
            '\u001b[?25l\r\n\u001b[1Aold-title\r\nold$ \u001b[?25h',
        ),
      );
      await vi.advanceTimersByTimeAsync(1_000);
      const replacement = Buffer.from(
        '\u001b]633;A\u0007\u001b[?25l\r\n\u001b[1L\u001b[1A\r\n' +
          '\u001b[1Anew-title\r\nnew$ \u001b[?25h',
      );
      channel.emitData(Buffer.concat([Buffer.from('echoed bootstrap\r\n'), replacement]));
      await vi.advanceTimersByTimeAsync(250);

      const rendered = Buffer.concat(binary(socket).map((item) => Buffer.from(item)));
      expect(rendered).toEqual(Buffer.concat([Buffer.from('Last login\r\n'), replacement]));
      expect(rendered.toString('utf8')).not.toContain('old-title');
    } finally {
      await service.closeAll();
      vi.useRealTimers();
    }
  });

  it('waits for a split SSH prompt before replacing its native prompt', async () => {
    vi.useFakeTimers();
    const channel = new FakeChannel('zsh');
    const service = new TerminalService({ open: () => channel });
    const terminalId = randomUUID();
    try {
      service.registerExternal(
        {
          id: terminalId,
          kind: 'ssh',
          title: 'fixture',
          state: 'ready',
          connectionId: randomUUID(),
          appearance: { ...DEFAULT_TERMINAL_APPEARANCE },
          behavior: { ...DEFAULT_TERMINAL_BEHAVIOR },
          createdAt: new Date().toISOString(),
        },
        channel,
        'zsh',
      );
      const socket = new FakeSocket();
      service.attach(terminalId, socket as unknown as TerminalSocket);

      channel.emitData(Buffer.from('Last login\r\nold-title\r\nold$ '));
      await vi.advanceTimersByTimeAsync(1_000);
      channel.emitData(Buffer.from(`echoed bootstrap\r\n\u001b]633;A\u0007new-title`));
      await vi.advanceTimersByTimeAsync(75);
      expect(binary(socket)).toEqual([]);

      channel.emitData(Buffer.from('\r\nnew$ '));
      await vi.advanceTimersByTimeAsync(250);
      expect(Buffer.concat(binary(socket).map((item) => Buffer.from(item))).toString('utf8')).toBe(
        'Last login\r\n\u001b]633;A\u0007new-title\r\nnew$ ',
      );
    } finally {
      await service.closeAll();
      vi.useRealTimers();
    }
  });

  it('falls back before injection when hidden startup output reaches its bound', async () => {
    vi.useFakeTimers();
    const channel = new FakeChannel('bash');
    const service = new TerminalService({ open: () => channel });
    try {
      const session = service.createLocal({ cols: 80, rows: 24 });
      const socket = new FakeSocket();
      service.attach(session.id, socket as unknown as TerminalSocket);
      socket.emit('message', Buffer.from("printf 'ready'\r"), true);

      const startupOutput = Buffer.alloc(64 * 1024 + 1, 0x61);
      channel.emitData(startupOutput);

      expect(controls(socket)).toContainEqual({ type: 'shellIntegration', state: 'unavailable' });
      expect(Buffer.concat(binary(socket).map((item) => Buffer.from(item)))).toEqual(startupOutput);
      expect(Buffer.concat(channel.writes.map((item) => Buffer.from(item))).toString()).toBe(
        "printf 'ready'\r",
      );
      await vi.advanceTimersByTimeAsync(1_000);
      expect(channel.writes).toHaveLength(1);
    } finally {
      await service.closeAll();
      vi.useRealTimers();
    }
  });

  it('interrupts a timed-out shell hook before releasing queued input', async () => {
    vi.useFakeTimers();
    const channel = new FakeChannel('bash');
    const service = new TerminalService({ open: () => channel });
    try {
      const session = service.createLocal({ cols: 80, rows: 24 });
      const socket = new FakeSocket();
      service.attach(session.id, socket as unknown as TerminalSocket);

      const reviewed = service.executeCommand(session.id, 'printf reviewed');
      await vi.advanceTimersByTimeAsync(1_000);
      expect(channel.writes).toHaveLength(1);
      expect(Buffer.from(channel.writes[0]!).toString('utf8')).toContain(
        'AXTERM_SHELL_INTEGRATION',
      );

      await vi.advanceTimersByTimeAsync(3_000);
      expect(channel.writes).toHaveLength(2);
      expect(Buffer.from(channel.writes[1]!)).toEqual(Buffer.from([0x03]));
      channel.emitData(Buffer.from('^C\r\nfixture$ '));
      await vi.advanceTimersByTimeAsync(5_100);
      await reviewed;

      expect(controls(socket)).toContainEqual({ type: 'shellIntegration', state: 'unavailable' });
      expect(
        Buffer.concat(channel.writes.slice(2).map((value) => Buffer.from(value))).toString(),
      ).toBe('printf reviewed\r');
    } finally {
      await service.closeAll();
      vi.useRealTimers();
    }
  });

  it('rejects stdin beyond the bounded shell-integration queue and cancels it on close', async () => {
    vi.useFakeTimers();
    const channel = new FakeChannel('bash');
    const service = new TerminalService({ open: () => channel });
    const session = service.createLocal({ cols: 80, rows: 24 });
    const socket = new FakeSocket();
    service.attach(session.id, socket as unknown as TerminalSocket);

    for (let index = 0; index < 5; index += 1)
      socket.emit('message', Buffer.alloc(TERMINAL_INPUT_FRAME_MAX_BYTES, index), true);
    expect(controls(socket)).toContainEqual({
      type: 'error',
      code: 'TERMINAL_INPUT_QUEUE_FULL',
    });
    expect(channel.writes).toEqual([]);

    await service.close(session.id);
    await vi.runAllTimersAsync();
    expect(channel.writes).toEqual([]);
    vi.useRealTimers();
  });

  it('sends an exit control and disposes listeners for an external terminal', async () => {
    const channel = new FakeChannel();
    const service = new TerminalService({ open: () => channel });
    const terminalId = randomUUID();
    service.registerExternal(
      {
        id: terminalId,
        kind: 'ssh',
        title: 'fixture',
        state: 'ready',
        connectionId: randomUUID(),
        appearance: { ...DEFAULT_TERMINAL_APPEARANCE },
        behavior: { ...DEFAULT_TERMINAL_BEHAVIOR },
        createdAt: new Date().toISOString(),
      },
      channel,
    );
    const socket = new FakeSocket();
    service.attach(terminalId, socket as unknown as TerminalSocket, randomUUID());

    channel.emitExit(23);

    expect(controls(socket)).toContainEqual({ type: 'exit', exitCode: 23 });
    expect(socket.readyState).toBe(3);
    expect(channel.listenerCount()).toBe(0);
    await service.closeAll();
  });
});
