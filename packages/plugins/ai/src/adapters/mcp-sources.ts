import { createHash } from 'node:crypto';
import type { AiMcpTools, AiMcpToolSource } from '@axterm/plugin-api/host';
import type { AiToolService } from '../application/ai-tool-service.ts';
import type { AiService } from '../application/ai-service.ts';
/** A selected source capability delegates the existing application Tool/Approval/Audit owner. */
export class AiMcpSources implements AiMcpTools {
  private readonly sources = new Map<string, AiMcpToolSource>();
  private closed = false;
  constructor(
    private readonly tools: AiToolService,
    private readonly application: AiService,
  ) {}
  listTools() {
    if (this.closed) return [];
    return this.tools.mcpTools();
  }
  registerSource(id: string): AiMcpToolSource {
    if (
      this.closed ||
      !/^widget_[0-9a-f-]{36}$/u.test(id) ||
      this.sources.has(id) ||
      this.sources.size >= 64
    )
      throw Error('AI_MCP_SOURCE_UNAVAILABLE');
    let closing: Promise<void> | undefined;
    const source: AiMcpToolSource = {
      listTools: () => (closing || this.closed ? [] : this.listTools()),
      callTool: (name, args, key) => {
        if (closing || this.closed || key.length > 256)
          return Promise.reject(Error('AI_MCP_SOURCE_CLOSED'));
        const hash = createHash('sha256').update(id).update('\0').update(key).digest('hex');
        const commandId = `${hash.slice(0, 8)}-${hash.slice(8, 12)}-5${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
        return this.application.invokeRegisteredTool(
          this.tools.mcpProposal(name, args),
          commandId,
          id,
        );
      },
      close: () =>
        (closing ??= (async () => {
          await this.application.stopMcpSource(id);
          if (this.sources.get(id) === source) this.sources.delete(id);
        })()),
    };
    this.sources.set(id, source);
    return source;
  }
  async close(): Promise<void> {
    this.closed = true;
    const results = await Promise.allSettled(
      [...this.sources.values()].map((source) => source.close()),
    );
    if (results.some((result) => result.status === 'rejected'))
      throw Error('AI_MCP_SOURCE_DRAIN_FAILED');
  }
}
