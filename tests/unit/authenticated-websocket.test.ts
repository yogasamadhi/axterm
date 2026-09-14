import { afterEach, describe, expect, it, vi } from 'vitest';
import { registerAuthenticatedWebSocket } from '../../apps/desktop/src/renderer/src/components/authenticated-websocket';

describe('RDP authenticated WebSocket registry', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('adds protocols once for the exact URL and leaves every other socket unchanged', () => {
    const calls: unknown[][] = [];
    class NativeWebSocket {
      constructor(...args: unknown[]) {
        calls.push(args);
      }
    }
    vi.stubGlobal('window', {
      location: { href: 'http://127.0.0.1:3000/' },
      WebSocket: NativeWebSocket,
    });

    registerAuthenticatedWebSocket('ws://127.0.0.1:3000/api/v1/rdp/sessions/one/stream', [
      'rdp.v1',
      'auth.runtime-token',
    ]);
    new window.WebSocket('ws://127.0.0.1:3000/api/v1/rdp/sessions/other/stream');
    new window.WebSocket('ws://127.0.0.1:3000/api/v1/rdp/sessions/one/stream');
    new window.WebSocket('ws://127.0.0.1:3000/api/v1/rdp/sessions/one/stream');

    expect(calls).toEqual([
      ['ws://127.0.0.1:3000/api/v1/rdp/sessions/other/stream'],
      ['ws://127.0.0.1:3000/api/v1/rdp/sessions/one/stream', ['rdp.v1', 'auth.runtime-token']],
      ['ws://127.0.0.1:3000/api/v1/rdp/sessions/one/stream'],
    ]);
  });

  it('authenticates only the bounded number of exact-URL SPICE channel sockets', () => {
    const calls: unknown[][] = [];
    class NativeWebSocket {
      constructor(...args: unknown[]) {
        calls.push(args);
      }
    }
    vi.stubGlobal('window', {
      location: { href: 'http://127.0.0.1:3000/' },
      WebSocket: NativeWebSocket,
    });

    registerAuthenticatedWebSocket(
      'ws://127.0.0.1:3000/api/v1/spice/sessions/one/stream',
      ['spice.v1', 'auth.runtime-token'],
      2,
    );
    new window.WebSocket('ws://127.0.0.1:3000/api/v1/spice/sessions/one/stream');
    new window.WebSocket('ws://127.0.0.1:3000/api/v1/spice/sessions/other/stream');
    new window.WebSocket('ws://127.0.0.1:3000/api/v1/spice/sessions/one/stream');
    new window.WebSocket('ws://127.0.0.1:3000/api/v1/spice/sessions/one/stream');

    expect(calls).toEqual([
      ['ws://127.0.0.1:3000/api/v1/spice/sessions/one/stream', ['spice.v1', 'auth.runtime-token']],
      ['ws://127.0.0.1:3000/api/v1/spice/sessions/other/stream'],
      ['ws://127.0.0.1:3000/api/v1/spice/sessions/one/stream', ['spice.v1', 'auth.runtime-token']],
      ['ws://127.0.0.1:3000/api/v1/spice/sessions/one/stream'],
    ]);
  });
});
