import { describe, expect, it, vi } from 'vitest';
import {
  decodeTerminalMessage,
  splitUtf8Input,
  TERMINAL_INPUT_CHUNK_BYTES,
  TERMINAL_INPUT_MAX_BYTES,
  TerminalInputSender,
  type TerminalInputIssue,
} from '../../apps/desktop/src/renderer/src/components/terminal-protocol';
import { TERMINAL_INPUT_FRAME_MAX_BYTES } from '../../packages/contracts/src';

class FakeInputSocket {
  readyState = 1;
  bufferedAmount = 0;
  readonly sent: Uint8Array[] = [];

  send(data: Uint8Array) {
    this.sent.push(data);
  }
}

describe('terminal Renderer protocol', () => {
  it('rejects malformed text controls without affecting the following binary frame', () => {
    expect(decodeTerminalMessage('{')).toEqual({
      kind: 'invalid',
      code: 'INVALID_CONTROL_MESSAGE',
    });
    expect(decodeTerminalMessage(JSON.stringify({ type: 'status', state: 'invented' }))).toEqual({
      kind: 'invalid',
      code: 'INVALID_CONTROL_MESSAGE',
    });
    expect(decodeTerminalMessage('x'.repeat(4 * 1024 + 1))).toEqual({
      kind: 'invalid',
      code: 'INVALID_CONTROL_MESSAGE',
    });

    const raw = Uint8Array.from([0xff, 0xfe, 0x41]);
    const decoded = decodeTerminalMessage(raw.buffer);
    expect(decoded.kind).toBe('binary');
    if (decoded.kind === 'binary') expect([...decoded.data]).toEqual([...raw]);
  });

  it('parses the bounded replay control through the shared schema', () => {
    expect(
      decodeTerminalMessage(
        JSON.stringify({
          type: 'replay',
          firstSequence: 4,
          lastSequence: 6,
          byteLength: 48,
          truncated: true,
        }),
      ),
    ).toEqual({
      kind: 'control',
      control: {
        type: 'replay',
        firstSequence: 4,
        lastSequence: 6,
        byteLength: 48,
        truncated: true,
      },
    });
  });

  it('parses terminal recording state without exposing the selected path', () => {
    const startedAt = '2026-09-12T21:00:00.000Z';
    expect(
      decodeTerminalMessage(
        JSON.stringify({
          type: 'recording',
          recording: {
            terminalId: '11111111-1111-4111-8111-111111111111',
            state: 'active',
            fileName: 'session.log',
            timestamps: true,
            bytesWritten: 42,
            startedAt,
          },
        }),
      ),
    ).toEqual({
      kind: 'control',
      control: {
        type: 'recording',
        recording: {
          terminalId: '11111111-1111-4111-8111-111111111111',
          state: 'active',
          fileName: 'session.log',
          timestamps: true,
          bytesWritten: 42,
          startedAt,
        },
      },
    });
  });

  it('splits multibyte UTF-8 only at code-point boundaries below the Runtime frame limit', () => {
    const input = `${'a'.repeat(TERMINAL_INPUT_CHUNK_BYTES - 1)}界🙂${'b'.repeat(70_000)}`;
    const split = splitUtf8Input(input);
    expect(split.accepted).toBe(true);
    if (!split.accepted) return;

    const decoder = new TextDecoder('utf-8', { fatal: true });
    for (const frame of split.frames) {
      expect(frame.byteLength).toBeLessThan(TERMINAL_INPUT_FRAME_MAX_BYTES);
      expect(() => decoder.decode(frame)).not.toThrow();
    }
    expect(Buffer.concat(split.frames.map((frame) => Buffer.from(frame))).toString('utf8')).toBe(
      input,
    );
  });

  it('sends input above 64 KiB as bounded UTF-8 binary frames', () => {
    const socket = new FakeInputSocket();
    const issues: TerminalInputIssue[] = [];
    const sender = new TerminalInputSender(socket, (issue) => issues.push(issue));
    const input = '界'.repeat(30_000);

    expect(sender.enqueue(input)).toBe(true);
    expect(socket.sent.length).toBeGreaterThan(1);
    expect(socket.sent.every((frame) => frame.byteLength < TERMINAL_INPUT_FRAME_MAX_BYTES)).toBe(
      true,
    );
    expect(Buffer.concat(socket.sent.map((frame) => Buffer.from(frame))).toString('utf8')).toBe(
      input,
    );
    expect(issues).toEqual([]);
    sender.cancel();
  });

  it('rejects an oversized paste before enqueueing any bytes', () => {
    const socket = new FakeInputSocket();
    const issues: TerminalInputIssue[] = [];
    const sender = new TerminalInputSender(socket, (issue) => issues.push(issue));

    expect(sender.enqueue('a'.repeat(TERMINAL_INPUT_MAX_BYTES + 1))).toBe(false);
    expect(socket.sent).toEqual([]);
    expect(issues).toEqual(['TERMINAL_INPUT_TOO_LARGE']);
    sender.cancel();
  });

  it('rejects new input when the bounded pending queue has no remaining capacity', () => {
    const socket = new FakeInputSocket();
    socket.bufferedAmount = 512 * 1024;
    const issues: TerminalInputIssue[] = [];
    const sender = new TerminalInputSender(socket, (issue) => issues.push(issue));

    expect(sender.enqueue('a'.repeat(700 * 1024))).toBe(true);
    expect(sender.enqueue('b'.repeat(400 * 1024))).toBe(false);
    expect(socket.sent).toEqual([]);
    expect(issues).toEqual(['TERMINAL_INPUT_QUEUE_FULL']);
    sender.cancel();
  });

  it('cancels queued input and its retry timer when the socket closes', () => {
    vi.useFakeTimers();
    const socket = new FakeInputSocket();
    socket.bufferedAmount = 512 * 1024;
    const issues: TerminalInputIssue[] = [];
    const sender = new TerminalInputSender(socket, (issue) => issues.push(issue));

    expect(sender.enqueue('pending')).toBe(true);
    sender.cancel(true);
    socket.bufferedAmount = 0;
    vi.runAllTimers();

    expect(socket.sent).toEqual([]);
    expect(issues).toEqual(['TERMINAL_INPUT_CANCELED']);
    vi.useRealTimers();
  });
});
