import { tmpdir } from 'node:os';
import type { Context } from '@deepseek-ai/cordis';
import type { PtyPort } from '../../packages/plugins/terminals/src/ports/terminal-channel.ts';
import { TerminalService } from '../../packages/plugins/terminals/src/application/terminal-service.ts';
import { AiToolResources } from '../../packages/plugins/ai/src/adapters/tool-resources.ts';
import { AiToolService } from '../../packages/plugins/ai/src/application/ai-tool-service.ts';
import { ownedAiPolicy } from './level3-ai-policy.ts';
/** Actual tool/resource/terminal owners; the test supplies only the PTY port. */
export async function ownedAiToolPolicy(pty: PtyPort) {
  const owned = await ownedAiPolicy();
  const terminals = new TerminalService(pty, {
    open: async () => {
      throw Error('No recording requested');
    },
  });
  owned.ctx.provide('terminals', {
    recentOutput: (id: string) => terminals.recentOutput(id),
    executeCommand: (id: string, command: string, signal?: AbortSignal) =>
      terminals.executeCommand(id, command, signal),
  } as Context['terminals']);
  const resources = new AiToolResources(owned.ctx, tmpdir());
  const tools = new AiToolService(resources);
  const drain = async () => {
    await resources.close();
    await terminals.dispose();
  };
  owned.ctx.effect(() => async () => {
    await owned.drain();
    await drain();
  });
  return {
    ...owned,
    terminals,
    resources,
    tools,
    close: async () => {
      // Stop application admissions/effects before the Tool's dependencies.
      await owned.close();
      await drain();
    },
  };
}
