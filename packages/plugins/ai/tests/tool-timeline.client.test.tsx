// @vitest-environment jsdom
import { randomUUID } from 'node:crypto';
import type { ReactNode } from 'react';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { aiToolCallSchema, aiApprovalSchema } from '@axterm/plugin-api/ai';
import { AgentToolCards, AiPanel } from '../src/client/ui/ai-panel.tsx';
import type { AiPanelActions } from '../src/client/ui/panel-actions.ts';
import { AiI18nProvider } from '../src/client/ui/i18n.tsx';
import { dictionaries } from '../src/client/ui/locales.ts';
afterEach(cleanup);
it('keeps the latest run selected when older replies lie outside the bounded message window', async () => {
  const conversationId = randomUUID();
  const runs = Array.from({ length: 26 }, () => ({
    id: randomUUID(),
    conversationId,
    state: 'succeeded',
    useCase: 'chat',
  }));
  const snapshot = {
    status: 'ready',
    baseline: {
      generation: 'history-fixture',
      runs,
      providers: [],
      models: [],
      engines: [],
      approvals: [],
      conversations: [{ id: conversationId }],
    },
  };
  const window = {
    messages: runs
      .slice(0, 25)
      .map((run) => ({ runId: run.id, role: 'assistant', content: 'done' })),
    hasLater: false,
  };
  const openRun = vi.fn(async (_id: string) => {
    throw Error('fixture read unavailable');
  });
  const states = new Map<string, object>();
  const client = {
    model: { getSnapshot: () => snapshot, subscribe: () => () => {}, openRun },
    queries: {
      open: (kind: string) => {
        if (!states.has(kind))
          states.set(kind, {
            data: kind === 'conversation' ? window : undefined,
            isSuccess: true,
            isError: false,
            isPending: false,
          });
        return {
          resource: { getSnapshot: () => states.get(kind), subscribe: () => () => {} },
          dispose: async () => {},
        };
      },
    },
  };
  render(
    <AiPanel
      client={client as unknown as AiPanelActions}
      settingsOnly
      activeTerminalId={undefined}
    />,
    { wrapper },
  );
  await waitFor(() => expect(openRun).toHaveBeenLastCalledWith(runs[0]!.id));
  expect(openRun.mock.calls.some((args) => args[0] === runs[25]!.id)).toBe(false);
});
function call() {
  const now = new Date().toISOString();
  return aiToolCallSchema.parse({
    id: randomUUID(),
    runId: randomUUID(),
    toolName: 'workspace.exec',
    args: { command: 'printf fixture' },
    target: randomUUID(),
    risk: 'mutating',
    state: 'succeeded',
    argsHash: 'f'.repeat(64),
    version: 1,
    createdAt: now,
    updatedAt: now,
    resultMetadata: {
      stdout: Array.from({ length: 20 }, (_, i) => `output line ${i + 1}`).join('\n'),
      stderr: '',
      exitCode: 0,
    },
  });
}
function wrapper({ children }: { children: ReactNode }) {
  return (
    <AiI18nProvider value={{ language: 'en', x: (key) => dictionaries.en[key] }}>
      {children}
    </AiI18nProvider>
  );
}
it('previews plain output, expands long output and keeps technical metadata out of the default transcript', () => {
  const tool = call();
  const f = render(
    <AgentToolCards visible toolCalls={[tool]} approvals={[]} decide={vi.fn()} cancel={vi.fn()} />,
    { wrapper },
  );
  expect(f.container.textContent).toContain('$ printf fixture');
  expect(f.container.textContent).toContain('output line 10');
  expect(f.container.textContent).not.toContain('output line 11');
  expect(f.container.textContent).not.toContain(tool.target);
  expect(f.container.textContent).not.toContain(tool.argsHash);
  expect(f.container.textContent).not.toContain('Agent tool activity');
  fireEvent.click(f.getByRole('button', { name: /printf fixture/ }));
  expect(f.container.textContent).toContain('output line 20');
  expect(f.container.querySelector('details')?.open).toBe(false);
});
it('retains independent privileged approval without rendering a detached tool panel', async () => {
  const tool = {
    ...call(),
    toolName: 'plugins.manage',
    state: 'waiting_approval' as const,
    risk: 'privileged' as const,
  };
  const approval = aiApprovalSchema.parse({
    id: randomUUID(),
    runId: tool.runId,
    toolCallId: tool.id,
    argsHash: tool.argsHash,
    target: tool.target,
    state: 'pending',
    expiresAt: new Date(Date.now() + 60000).toISOString(),
    version: 1,
    createdAt: tool.createdAt,
    updatedAt: tool.updatedAt,
  });
  const decide = vi.fn(async () => {});
  const f = render(
    <AgentToolCards
      visible
      portalOnly
      toolCalls={[tool]}
      approvals={[approval]}
      decide={decide}
      cancel={vi.fn()}
    />,
    { wrapper },
  );
  expect(f.container.querySelector('.ai-tool-timeline')).toBeNull();
  expect(f.getByRole('dialog', { name: 'Plugin management requiring approval' })).toBeTruthy();
  fireEvent.click(f.getByRole('button', { name: 'Reject' }));
  expect(decide).toHaveBeenCalledWith(approval, 'reject');
});
