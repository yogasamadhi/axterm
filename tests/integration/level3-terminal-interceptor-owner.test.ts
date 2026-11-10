import { expect, it, vi } from 'vitest';
import { TerminalService } from '../../packages/plugins/terminals/src/application/terminal-service.ts';
import type { PtyPort } from '../../packages/plugins/terminals/src/ports/terminal-channel.ts';
import type { TerminalRecorderFactory } from '../../packages/plugins/terminals/src/ports/terminal-recording.ts';
it('enforces one protocol interceptor and withdraws only the registered owner', async () => {
  const terminals = new TerminalService({} as PtyPort, {} as TerminalRecorderFactory);
  const one = { receive: vi.fn(() => false), observeInput: vi.fn(), closed: vi.fn() },
    two = { ...one };
  const dispose = terminals.setDataInterceptor(one);
  expect(() => terminals.setDataInterceptor(two)).toThrow('already set');
  dispose();
  const second = terminals.setDataInterceptor(two);
  dispose();
  expect(() => terminals.setDataInterceptor(one)).toThrow('already set');
  second();
  terminals.setDataInterceptor(one)();
  await terminals.dispose();
  expect(() => terminals.setDataInterceptor(one)).toThrow('closing');
});
