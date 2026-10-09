import { describe, expect, it } from 'vitest';
import {
  TERMINAL_OUTPUT_FRAME_MAX_BYTES,
  TERMINAL_OUTPUT_PENDING_MAX_BYTES,
} from '@workspace/contracts';
import {
  TerminalOutputWindow,
  OUTPUT_FLOW_HIGH_WATER_FRAMES,
  OUTPUT_FLOW_MAX_PENDING_FRAMES,
} from './terminal-output-flow';

describe('socket-local terminal consumption window', () => {
  it('never grants credit for wrong streams, backwards counts, non-integers or bytes not sent', () => {
    const window = new TerminalOutputWindow('stream-a', 4);
    window.sent(10, 5);
    for (const [id, bytes] of [
      ['stream-b', 10],
      ['stream-a', 11],
      ['stream-a', -1],
      ['stream-a', 0.5],
    ] as const)
      expect(window.acknowledge(id, bytes)).toBe(false);
    expect(window.pendingBytes()).toBe(10);
    expect(window.acknowledge('stream-a', 5)).toBe(true);
    expect(window.lastConsumedSequence).toBe(4);
    expect(window.acknowledge('stream-a', 4)).toBe(false);
    expect(window.acknowledge('stream-a', 5)).toBe(true);
    expect(window.pendingBytes()).toBe(5);
    expect(window.acknowledge('stream-a', 10)).toBe(true);
    expect(window.lastConsumedSequence).toBe(5);
    window.dispose();
    expect(window.pendingBytes()).toBe(0);
    expect(window.acknowledge('stream-a', 0)).toBe(false);
    expect(window.canSend(1)).toBe(false);
  });
  it('bounds both output bytes and checkpoint count, including a one-byte producer', () => {
    const bytes = new TerminalOutputWindow('bytes', 0);
    for (let i = 0; i < 8; i++) bytes.sent(TERMINAL_OUTPUT_FRAME_MAX_BYTES, i + 1);
    expect(bytes.pendingBytes()).toBe(TERMINAL_OUTPUT_PENDING_MAX_BYTES);
    expect(bytes.canSend(1)).toBe(false);
    expect(() => bytes.sent(1, 9)).toThrow('exhausted');
    const tiny = new TerminalOutputWindow('tiny', 0);
    for (let i = 0; i < OUTPUT_FLOW_HIGH_WATER_FRAMES; i++) tiny.sent(1, i + 1);
    expect(tiny.high()).toBe(true);
    for (let i = OUTPUT_FLOW_HIGH_WATER_FRAMES; i < OUTPUT_FLOW_MAX_PENDING_FRAMES; i++)
      tiny.sent(1, i + 1);
    expect(tiny.canSend(1)).toBe(false);
    expect(tiny.acknowledge('tiny', OUTPUT_FLOW_MAX_PENDING_FRAMES)).toBe(true);
    expect(tiny.low()).toBe(true);
    expect(tiny.canSend(1)).toBe(true);
  });
});
