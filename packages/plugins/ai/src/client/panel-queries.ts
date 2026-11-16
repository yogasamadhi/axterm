import type * as Contract from '@axterm/plugin-api/ai';
import type { AiModel } from './index.ts';
import { AiReadRegistry, type AiReadLease } from './read-registry.ts';
interface AiQueryMap {
  provider: Contract.AiProvider;
  workspace: Contract.AiWorkspace;
  catalog: Contract.PiCatalogProvider[];
  skills: Contract.AiSkill[];
  conversation: Contract.AiMessageWindow & { conversation: Contract.AiConversation };
  tools: Contract.AiToolCall[];
  toolsByRuns: Contract.AiToolCall[];
}
export type AiQueryKind = keyof AiQueryMap;
export type AiQueryValue<K extends AiQueryKind> = AiQueryMap[K];
/** Selected detail reads belong to this Client owner. Metadata carries no output or provider secrets. */
export class AiPanelQueries {
  private readonly reads = new AiReadRegistry();
  private readonly off: () => void;
  private closing: Promise<void> | undefined;
  constructor(private readonly model: AiModel) {
    this.off = model.subscribe(() => this.reads.invalidate());
  }
  open<K extends AiQueryKind>(kind: K, id?: string): AiReadLease<AiQueryValue<K>> | undefined {
    if (this.closing) throw new Error('AI_PANEL_READS_CLOSED');
    if (['provider', 'workspace', 'conversation', 'toolsByRuns'].includes(kind) && !id)
      return undefined;
    return this.reads.open(
      kind + ':' + (id ?? ''),
      (signal) => this.read(kind, id, signal),
      () => this.version(kind, id),
      kind === 'workspace' ? 2000 : undefined,
    );
  }
  dispose(): Promise<void> {
    if (this.closing) return this.closing;
    this.off();
    return (this.closing = this.reads.dispose());
  }
  private baseline(): Contract.AiBaseline {
    const state = this.model.getSnapshot();
    if (state.status !== 'ready') throw new Error('AI_PANEL_METADATA_UNAVAILABLE');
    return state.baseline;
  }
  private version(kind: AiQueryKind, id?: string): string {
    const state = this.model.getSnapshot();
    if (state.status !== 'ready') return 'pending';
    const baseline = state.baseline;
    const version =
      kind === 'provider'
        ? baseline.providers.find((row) => row.id === id)?.version
        : kind === 'conversation'
          ? baseline.conversations.find((row) => row.id === id?.split(':')[0])
          : kind === 'tools'
            ? baseline.approvals.map((row) => [row.id, row.version])
            : kind;
    return JSON.stringify([baseline.generation, version]);
  }
  private async read<K extends AiQueryKind>(
    kind: K,
    id?: string,
    signal?: AbortSignal,
  ): Promise<AiQueryValue<K>> {
    signal?.throwIfAborted();
    const generation = this.baseline().generation;
    let value: AiQueryMap[AiQueryKind];
    switch (kind) {
      case 'provider':
        value = await this.model.readProvider(id!);
        break;
      case 'workspace':
        value = await this.model.workspace(id!);
        break;
      case 'catalog':
        value = await this.model.catalog();
        break;
      case 'skills':
        value = await this.model.skills();
        break;
      case 'conversation': {
        const [conversationId, direction = 'latest', cursor = '0'] = id!.split(':');
        if (!['latest', 'earlier', 'later'].includes(direction))
          throw new Error('AI_MESSAGE_WINDOW_INVALID');
        const anchor = Number(cursor);
        if (!Number.isSafeInteger(anchor) || anchor < 0)
          throw new Error('AI_MESSAGE_WINDOW_INVALID');
        const conversation = await this.model.getConversation(conversationId!);
        const page = await this.model.getMessageWindow(
          conversationId!,
          direction === 'latest'
            ? { direction: 'latest', limit: 50 }
            : { direction: direction as 'earlier' | 'later', cursor: anchor, limit: 50 },
        );
        value = { conversation, ...page };
        break;
      }
      case 'tools': {
        const offset = Number(id ?? 0);
        if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('AI_TOOL_PAGE_INVALID');
        const pending = this.baseline().approvals.slice(offset, offset + 8);
        const tools: Contract.AiToolCall[] = [];
        for (const toolId of new Set(pending.map((row) => row.toolCallId)))
          tools.push(await this.model.getToolCall(toolId));
        value = tools;
        break;
      }
      case 'toolsByRuns': {
        const ids: unknown = JSON.parse(id!);
        if (
          !Array.isArray(ids) ||
          ids.length > 50 ||
          ids.some((value) => typeof value !== 'string')
        )
          throw new Error('AI_TOOL_PAGE_INVALID');
        const tools: Contract.AiToolCall[] = [];
        let bytes = 0;
        let pages = 0;
        for (const runId of new Set<string>(ids)) {
          let cursor = 0;
          for (;;) {
            signal?.throwIfAborted();
            if (++pages > 256) throw new Error('AI_READ_CAPACITY');
            const page = await this.model.getTools(runId, { after: cursor, limit: 50 });
            signal?.throwIfAborted();
            if (this.baseline().generation !== generation)
              throw new Error('AI_MODEL_GENERATION_CHANGED');
            bytes += new TextEncoder().encode(JSON.stringify(page.tools)).byteLength;
            if (bytes > 4 * 1024 * 1024 || tools.length + page.tools.length > 256)
              throw new Error('AI_READ_CAPACITY');
            tools.push(...page.tools);
            if (!page.hasMore) break;
            if (page.nextCursor <= cursor) throw new Error('AI_TOOL_PAGE_INVALID');
            cursor = page.nextCursor;
          }
        }
        value = tools;
        break;
      }
    }
    if (this.baseline().generation !== generation) throw new Error('AI_MODEL_GENERATION_CHANGED');
    return value as AiQueryValue<K>;
  }
}
