import { describe, expect, it } from 'vitest';
import type { Connection } from '../../packages/contracts/src';
import {
  reconnectCountdownSeconds,
  terminalReconnectPresentation,
  TerminalReconnectTransitionTracker,
} from '../../apps/desktop/src/renderer/src/components/terminal-reconnect';

const connection = (patch: Partial<Connection>): Connection => ({
  id: 'ba5db749-ea65-4b89-8cb2-a9daf64af0de',
  hostId: 'de719971-c72b-4fb8-a807-afee0daeb22e',
  state: 'ready',
  reconnectAttempt: 0,
  nextReconnectAt: null,
  createdAt: '2026-09-12T00:00:00.000Z',
  updatedAt: '2026-09-12T00:00:00.000Z',
  ...patch,
});

describe('terminal reconnect overlay model', () => {
  it('rounds countdowns up and never presents a negative value', () => {
    const now = Date.parse('2026-09-12T00:00:00.000Z');
    expect(reconnectCountdownSeconds('2026-09-12T00:00:03.001Z', now)).toBe(4);
    expect(reconnectCountdownSeconds('2026-09-11T23:59:59.000Z', now)).toBe(0);
    expect(reconnectCountdownSeconds('invalid', now)).toBeNull();
  });

  it('matches the pinned countdown label and exposes retry plus cancellation', () => {
    expect(
      terminalReconnectPresentation(
        connection({
          state: 'reconnecting',
          reconnectAttempt: 2,
          nextReconnectAt: '2026-09-12T00:00:03.000Z',
        }),
        Date.parse('2026-09-12T00:00:01.100Z'),
      ),
    ).toEqual({
      tone: 'progress',
      message: 'RECONNECTING',
      countdown: 2,
      errorCode: null,
      canRetry: true,
      canCancel: true,
    });
  });

  it('shows typed failures while omitting initial, ready and closed connections', () => {
    expect(
      terminalReconnectPresentation(connection({ state: 'failed', errorCode: 'SSH_TIMEOUT' })),
    ).toEqual({
      tone: 'error',
      message: 'DISCONNECTED',
      countdown: null,
      errorCode: 'SSH_TIMEOUT',
      canRetry: true,
      canCancel: false,
    });
    expect(terminalReconnectPresentation(connection({ state: 'created' }))).toBeNull();
    expect(terminalReconnectPresentation(connection({ state: 'resolving' }))).toBeNull();
    expect(terminalReconnectPresentation(connection({ state: 'connecting' }))).toBeNull();
    expect(terminalReconnectPresentation(connection({ state: 'authenticating' }))).toBeNull();
    expect(terminalReconnectPresentation(connection({ state: 'ready' }))).toBeNull();
    expect(terminalReconnectPresentation(connection({ state: 'closed' }))).toBeNull();
  });

  it('emits one terminal reload after an automatic recovery and resets by generation', () => {
    const tracker = new TerminalReconnectTransitionTracker(2);
    const id = connection({});
    expect(tracker.observe('generation-a', id)).toBe(false);
    expect(
      tracker.observe('generation-a', connection({ state: 'reconnecting', reconnectAttempt: 1 })),
    ).toBe(false);
    expect(
      tracker.observe('generation-a', connection({ state: 'connecting', reconnectAttempt: 1 })),
    ).toBe(false);
    expect(tracker.observe('generation-a', connection({ state: 'ready' }))).toBe(true);
    expect(tracker.observe('generation-a', connection({ state: 'ready' }))).toBe(false);

    expect(
      tracker.observe('generation-a', connection({ state: 'reconnecting', reconnectAttempt: 2 })),
    ).toBe(false);
    expect(tracker.observe('generation-b', connection({ state: 'ready' }))).toBe(false);
  });

  it('recognizes an in-progress reconnect first observed after its countdown state', () => {
    const tracker = new TerminalReconnectTransitionTracker();
    expect(
      tracker.observe('generation-a', connection({ state: 'resolving', reconnectAttempt: 1 })),
    ).toBe(false);
    expect(tracker.observe('generation-a', connection({ state: 'ready' }))).toBe(true);
  });
});
