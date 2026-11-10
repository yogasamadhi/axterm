import { randomUUID } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { AiMcpSources } from '../../packages/plugins/ai/src/adapters/mcp-sources.ts';
import type { AiToolService } from '../../packages/plugins/ai/src/application/ai-tool-service.ts';
import type { AiService } from '../../packages/plugins/ai/src/application/ai-service.ts';
it('delegates proposals and stable source-scoped identities to existing application approval and drains closed sources', async () => {
  const invokeRegisteredTool = vi.fn(async () => ({
      runId: randomUUID(),
      state: 'succeeded' as const,
    })),
    stopMcpSource = vi.fn(async () => {}),
    mcpProposal = vi.fn(() => ({ visible: true }));
  const owner = new AiMcpSources(
    { mcpTools: () => [], mcpProposal } as unknown as AiToolService,
    { invokeRegisteredTool, stopMcpSource } as unknown as AiService,
  );
  const id = 'widget_' + randomUUID(),
    source = owner.registerSource(id);
  await source.callTool('terminal.exec', { command: 'echo reviewed' }, 'mcp:session:1');
  await source.callTool('terminal.exec', { command: 'echo reviewed' }, 'mcp:session:1');
  expect(mcpProposal).toHaveBeenCalledTimes(2);
  const first = invokeRegisteredTool.mock.calls[0] as unknown as [unknown, string, string],
    second = invokeRegisteredTool.mock.calls[1] as unknown as [unknown, string, string];
  expect(first[1]).toMatch(/^[0-9a-f-]{36}$/u);
  expect(first[1]).toBe(second[1]);
  expect(first[2]).toBe(id);
  await source.close();
  expect(stopMcpSource).toHaveBeenCalledWith(id);
  await expect(source.callTool('terminal.exec', {}, 'mcp:session:2')).rejects.toThrow();
  for (let index = 0; index < 65; index++)
    await owner.registerSource('widget_' + randomUUID()).close();
  await owner.close();
});
