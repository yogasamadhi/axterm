import type { Context } from '@deepseek-ai/cordis';
import { randomUUID } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import type { WorkspaceSessionDescriptionSource } from '@axterm/ui/workspace';
import type { TerminalsModel } from '../../packages/plugins/terminals/src/client/index.ts';
import { installTerminalSessionDescriptions } from '../../packages/plugins/terminals/src/client/session-descriptions.ts';
it('refuses a named-workspace admission before IO when the terminal owner has already changed generation', async () => {
  let provider: WorkspaceSessionDescriptionSource | undefined;
  const open = vi.fn(async () => randomUUID()),
    current = randomUUID();
  const scope = {
    workspaceSessionDescriptions: {
      register: (_kind: string, value: WorkspaceSessionDescriptionSource) => {
        provider = value;
        return () => {};
      },
    },
    effect: (setup: () => unknown) => setup(),
  };
  const ctx = {
    inject: (_keys: readonly string[], apply: (scope: unknown) => unknown) => apply(scope),
    terminalWorkspaceUi: { open },
    connectionActions: {
      getSnapshot: () => ({ status: 'ready', baseline: { generation: current, connections: [] } }),
    },
  } as unknown as Context;
  installTerminalSessionDescriptions(ctx, {
    getSnapshot: () => ({ status: 'ready', baseline: { generation: current, sessions: [] } }),
  } as unknown as TerminalsModel);
  await expect(
    provider!.restore(
      { id: randomUUID(), kind: 'local', title: 'Old selection', pinned: false, paneIndex: 0 },
      randomUUID(),
      new AbortController().signal,
    ),
  ).rejects.toThrow('WORKSPACE_TERMINAL_GENERATION_RETIRED');
  expect(open).not.toHaveBeenCalled();
});
