import { describe, expect, it } from 'vitest';
import { TerminalDirectoryTracker } from './terminal-directory';

describe('bounded live terminal directory metadata', () => {
  it('tracks byte-fragmented UTF-8 OSC 633 and OSC 7 markers with both terminators', () => {
    const tracker = new TerminalDirectoryTracker('/initial');
    for (const byte of Buffer.from('\x1b]633;P;Cwd=/tmp/项目\x07'))
      tracker.receive(Uint8Array.of(byte));
    expect(tracker.directory).toBe('/tmp/项目');
    tracker.receive(Buffer.from('output\x1b]7;file://host/tmp/space%20dir\x1b\\ordinary output'));
    expect(tracker.directory).toBe('/tmp/space dir');
    tracker.receive(Buffer.from('\x1b]7;file:///C:/Users/Test\x07'));
    expect(tracker.directory).toBe('C:/Users/Test');
  });
  it('discards malformed, relative, control-bearing and oversized markers and recovers', () => {
    const tracker = new TerminalDirectoryTracker('/safe');
    for (const marker of [
      '633;P;Cwd=relative',
      '7;https://example.org/tmp',
      '7;file:///tmp/%0Ainjected',
      '7;file:///tmp/%ZZ',
      '633;P;Cwd=/' + 'x'.repeat(9000),
    ]) {
      tracker.receive(Buffer.from(`\x1b]${marker}\x07`));
      expect(tracker.directory).toBe('/safe');
    }
    tracker.receive(Buffer.from('x'.repeat(100_000) + '\x1b]633;P;Cwd=/next\x1b\\'));
    expect(tracker.directory).toBe('/next');
  });
});
