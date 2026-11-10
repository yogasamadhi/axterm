import { Context } from '@deepseek-ai/cordis';
import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { terminalSessionSchema } from '@axterm/plugin-api/terminals';
import type { TerminalChannel } from '@axterm/plugin-api/host';
import DesktopTasks from '../../packages/plugins/desktop/src/tasks.ts';
import Terminals from '../../packages/plugins/terminals/src/index.ts';
import LocalSubprocess from '../../packages/infra/subprocess-local/src/index.ts';

it('projects only a confirmed directory and a bounded UTF-8 tail through the terminal owner, then revokes access on close', async () => {
  const ctx = new Context();
  ctx.provide('runtimeIdentity', {
    runtimeId: randomUUID(),
    generation: randomUUID(),
    startedAt: new Date().toISOString(),
    pid: process.pid,
    mode: 'headless',
    appVersion: '0.10.0',
  });
  await ctx.plugin(DesktopTasks);
  await ctx.plugin(LocalSubprocess);
  await ctx.plugin(Terminals, { shellArgs: [], env: {}, maxSessions: 2 });
  let receive: (data: Uint8Array) => void = () => {};
  let listeners = 0;
  const channel: TerminalChannel = {
    cwd: '/controlled-selected-directory',
    write: () => {},
    resize: () => {},
    signal: () => {},
    pause: () => {},
    resume: () => {},
    close: async () => {},
    onData: (listener) => {
      receive = listener;
      listeners++;
      return () => {
        receive = () => {};
        listeners--;
      };
    },
    onExit: () => () => {},
  };
  try {
    const { id: _id, ...metadata } = terminalSessionSchema.parse({
      id: randomUUID(),
      kind: 'local',
      title: 'controlled',
      state: 'ready',
      createdAt: new Date().toISOString(),
    });
    const session = ctx.terminals.registerExternal(metadata, channel);
    expect(ctx.terminals.workingDirectory(session.id)).toBe('/controlled-selected-directory');
    receive(Buffer.from('界'.repeat(30000)));
    const text = ctx.terminals.recentOutput(session.id);
    expect(typeof text).toBe('string');
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(64 * 1024);
    expect(text).not.toContain('\uFFFD');
    expect(text.length).toBeGreaterThan(0);
    await ctx.terminals.close(session.id);
    expect(listeners).toBe(0);
    expect(() => ctx.terminals.workingDirectory(session.id)).toThrow();
    expect(() => ctx.terminals.recentOutput(session.id)).toThrow();
  } finally {
    await ctx.fiber.dispose();
  }
});
