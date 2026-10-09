import { describe, expect, it } from 'vitest';
import type { Terminal } from '@xterm/xterm';
import { DEFAULT_TERMINAL_BEHAVIOR } from '../../packages/contracts/src';
import {
  buildOsc52ClipboardResponse,
  decodeOsc52Payload,
  Osc52Addon,
  Osc52RequestError,
  parseOsc52Request,
  OSC52_MAX_BASE64_CHARACTERS,
  OSC52_MAX_DECODED_BYTES,
  OSC52_MAX_RESPONSE_BYTES,
} from '../../apps/desktop/src/renderer/src/components/terminal-osc52';

function base64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  return btoa(String.fromCharCode(...bytes));
}

function errorCode(action: () => unknown): string | undefined {
  try {
    action();
  } catch (error) {
    return error instanceof Osc52RequestError ? error.code : undefined;
  }
  return undefined;
}

describe('OSC 52 clipboard model', () => {
  it('accepts only the exact c target and strict bounded Base64 UTF-8 text', () => {
    expect(parseOsc52Request('c;?')).toEqual({ kind: 'read', target: 'c' });
    expect(parseOsc52Request(`c;${base64('你好 clipboard')}`)).toEqual({
      kind: 'write',
      target: 'c',
      text: '你好 clipboard',
    });
    expect(errorCode(() => parseOsc52Request('p;QQ=='))).toBe('UNSUPPORTED_TARGET');
    expect(errorCode(() => parseOsc52Request('c'))).toBe('MALFORMED_REQUEST');
    expect(errorCode(() => decodeOsc52Payload('QQ=_'))).toBe('INVALID_BASE64');
    expect(errorCode(() => decodeOsc52Payload('AB=='))).toBe('INVALID_BASE64');
    expect(errorCode(() => decodeOsc52Payload('QQ==\n'))).toBe('INVALID_BASE64');
    expect(errorCode(() => decodeOsc52Payload('/w=='))).toBe('INVALID_UTF8');
    expect(errorCode(() => decodeOsc52Payload('A'.repeat(OSC52_MAX_BASE64_CHARACTERS + 4)))).toBe(
      'PAYLOAD_TOO_LARGE',
    );
    const oversized = btoa('x'.repeat(OSC52_MAX_DECODED_BYTES + 1));
    expect(errorCode(() => decodeOsc52Payload(oversized))).toBe('PAYLOAD_TOO_LARGE');
  });

  it('builds a bounded BEL-terminated Unicode clipboard response', () => {
    const response = buildOsc52ClipboardResponse('OSC 你好');
    expect(response.startsWith('\x1b]52;c;')).toBe(true);
    expect(response.endsWith('\x07')).toBe(true);
    expect(new TextEncoder().encode(response).byteLength).toBeLessThanOrEqual(
      OSC52_MAX_RESPONSE_BYTES,
    );
    expect(errorCode(() => buildOsc52ClipboardResponse('x'.repeat(OSC52_MAX_DECODED_BYTES)))).toBe(
      'RESPONSE_TOO_LARGE',
    );
  });

  it('enforces explicit read/write policy and disposes its parser handler', async () => {
    let handler: ((data: string) => boolean | Promise<boolean>) | undefined;
    let handlerDisposed = false;
    const writes: string[] = [];
    const responses: string[] = [];
    const feedback: string[] = [];
    const terminal = {
      parser: {
        registerOscHandler(identifier: number, callback: typeof handler) {
          expect(identifier).toBe(52);
          handler = callback;
          return { dispose: () => (handlerDisposed = true) };
        },
      },
    } as unknown as Terminal;
    const addon = new Osc52Addon({
      policy: {
        ...DEFAULT_TERMINAL_BEHAVIOR,
        osc52Enabled: true,
        osc52ReadPolicy: 'allow',
        osc52WritePolicy: 'allow',
      },
      getClipboard: () => ({
        readText: async () => 'reply ✓',
        writeText: async (text) => void writes.push(text),
      }),
      sendData: (data) => {
        responses.push(data);
        return true;
      },
      feedback: (message) => void feedback.push(message),
    });
    addon.activate(terminal);
    expect(await handler?.(`c;${base64('write ✓')}`)).toBe(true);
    expect(writes).toEqual(['write ✓']);
    expect(await handler?.('c;?')).toBe(true);
    expect(responses).toEqual([buildOsc52ClipboardResponse('reply ✓')]);
    expect(feedback).toEqual(['WRITE_SUCCEEDED', 'READ_SUCCEEDED']);
    addon.dispose();
    expect(handlerDisposed).toBe(true);
  });

  it('consumes denied requests with visible feedback and no clipboard access', async () => {
    let handler: ((data: string) => boolean | Promise<boolean>) | undefined;
    const feedback: string[] = [];
    const addon = new Osc52Addon({
      policy: { ...DEFAULT_TERMINAL_BEHAVIOR, osc52Enabled: true },
      getClipboard: () => {
        throw new Error('must not read clipboard');
      },
      sendData: () => true,
      feedback: (message) => void feedback.push(message),
    });
    addon.activate({
      parser: {
        registerOscHandler: (_identifier: number, callback: typeof handler) => {
          handler = callback;
          return { dispose() {} };
        },
      },
    } as unknown as Terminal);
    expect(await handler?.('c;?')).toBe(true);
    expect(await handler?.(`c;${base64('blocked')}`)).toBe(true);
    expect(feedback).toEqual(['READ_DENIED', 'WRITE_DENIED']);
  });

  it('does not send or report an async read after disposal', async () => {
    let handler: ((data: string) => boolean | Promise<boolean>) | undefined;
    let resolveRead: ((value: string) => void) | undefined;
    const responses: string[] = [];
    const feedback: string[] = [];
    const addon = new Osc52Addon({
      policy: {
        ...DEFAULT_TERMINAL_BEHAVIOR,
        osc52Enabled: true,
        osc52ReadPolicy: 'allow',
      },
      getClipboard: () => ({
        readText: () => new Promise((resolve) => (resolveRead = resolve)),
        writeText: async () => {},
      }),
      sendData: (data) => {
        responses.push(data);
        return true;
      },
      feedback: (message) => void feedback.push(message),
    });
    addon.activate({
      parser: {
        registerOscHandler: (_identifier: number, callback: typeof handler) => {
          handler = callback;
          return { dispose() {} };
        },
      },
    } as unknown as Terminal);
    const pending = handler?.('c;?');
    addon.dispose();
    resolveRead?.('late');
    await pending;
    expect(responses).toEqual([]);
    expect(feedback).toEqual([]);
  });

  it('reports a bounded clipboard timeout instead of leaving the parser pending', async () => {
    let handler: ((data: string) => boolean | Promise<boolean>) | undefined;
    const feedback: string[] = [];
    const addon = new Osc52Addon({
      policy: {
        ...DEFAULT_TERMINAL_BEHAVIOR,
        osc52Enabled: true,
        osc52ReadPolicy: 'allow',
      },
      getClipboard: () => ({
        readText: () => new Promise(() => {}),
        writeText: async () => {},
      }),
      sendData: () => true,
      feedback: (message) => void feedback.push(message),
      timeoutMs: 1,
    });
    addon.activate({
      parser: {
        registerOscHandler: (_identifier: number, callback: typeof handler) => {
          handler = callback;
          return { dispose() {} };
        },
      },
    } as unknown as Terminal);
    expect(await handler?.('c;?')).toBe(true);
    expect(feedback).toEqual(['CLIPBOARD_TIMEOUT']);
    addon.dispose();
  });

  it('reports Browser Clipboard rejection and a failed read-response send', async () => {
    let handler: ((data: string) => boolean | Promise<boolean>) | undefined;
    const feedback: string[] = [];
    const addon = new Osc52Addon({
      policy: {
        ...DEFAULT_TERMINAL_BEHAVIOR,
        osc52Enabled: true,
        osc52ReadPolicy: 'allow',
        osc52WritePolicy: 'allow',
      },
      getClipboard: () => ({
        readText: async () => 'reply',
        writeText: async () => {
          throw new DOMException('denied', 'NotAllowedError');
        },
      }),
      sendData: () => false,
      feedback: (message) => void feedback.push(message),
    });
    addon.activate({
      parser: {
        registerOscHandler: (_identifier: number, callback: typeof handler) => {
          handler = callback;
          return { dispose() {} };
        },
      },
    } as unknown as Terminal);
    await handler?.(`c;${base64('write')}`);
    await handler?.('c;?');
    expect(feedback).toEqual(['CLIPBOARD_FAILED', 'INPUT_UNAVAILABLE']);
    addon.dispose();
  });
});
