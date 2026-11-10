import {
  aiProviderHeaderSchema,
  aiGenerationSchema,
  aiModelSchema,
  aiConversationSchema,
  aiRunHeaderSchema,
  aiApprovalSchema,
  aiEngineHeaderSchema,
  AI_INDEX_MAX_ENTRIES,
  AI_CHUNK_CHARACTERS,
  AI_MAX_SNAPSHOT_BYTES,
  type AiBaseline,
  type AiCollection,
  type AiUpdate,
} from '@axterm/plugin-api/ai';
const names: readonly AiCollection[] = [
  'providers',
  'models',
  'conversations',
  'runs',
  'approvals',
  'engines',
];
const invalid = (): never => {
  throw new Error('AI_PROJECTION_INVALID');
};
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
/** Stage bounded fragments privately; observers see only schema-validated atomic commits. */
export class AiProjection {
  private baseline: AiBaseline | undefined;
  private opening = true;
  private pending: Extract<AiUpdate, { type: 'begin' }> | undefined;
  private fragments = new Map<AiCollection, { text: string; final: boolean }>();
  private bytes = 0;
  reset(): void {
    this.opening = true;
    this.pending = undefined;
    this.fragments.clear();
    this.bytes = 0;
  }
  accept(frame: AiUpdate): AiBaseline | undefined {
    if (frame.type === 'begin') {
      if (
        this.pending ||
        !Number.isSafeInteger(frame.cursor) ||
        frame.cursor < 0 ||
        !aiGenerationSchema.safeParse(frame.generation).success ||
        !Number.isSafeInteger(frame.revision) ||
        frame.revision < 0 ||
        (frame.mode === 'baseline' && !frame.collections.length) ||
        frame.collections.length > names.length ||
        new Set(frame.collections).size !== frame.collections.length ||
        frame.collections.some((name) => !names.includes(name))
      )
        invalid();
      if (
        this.opening
          ? frame.mode !== 'baseline' || frame.collections.length !== names.length
          : frame.mode !== 'delta' ||
            frame.generation !== this.baseline?.generation ||
            frame.cursor < this.baseline.cursor ||
            frame.revision <= this.baseline.revision
      )
        invalid();
      this.pending = frame;
      this.fragments.clear();
      this.bytes = 0;
      return;
    }
    const pending = this.pending;
    if (!pending) return invalid();
    if (frame.type === 'chunk') {
      const previous = this.fragments.get(frame.collection);
      if (
        !pending.collections.includes(frame.collection) ||
        previous?.final ||
        frame.offset !== (previous?.text.length ?? 0) ||
        !frame.text.length ||
        frame.text.length > AI_CHUNK_CHARACTERS
      )
        invalid();
      this.bytes += new TextEncoder().encode(frame.text).byteLength;
      if (this.bytes > AI_MAX_SNAPSHOT_BYTES) invalid();
      this.fragments.set(frame.collection, {
        text: (previous?.text ?? '') + frame.text,
        final: frame.final,
      });
      return;
    }
    if (
      frame.cursor !== pending.cursor ||
      frame.revision !== pending.revision ||
      pending.collections.some((name) => !this.fragments.get(name)?.final)
    )
      invalid();
    const selected = <T>(name: AiCollection, parse: (value: unknown) => T): T => {
      const entry = this.fragments.get(name);
      return entry ? parse(JSON.parse(entry.text)) : (this.baseline![name] as T);
    };
    const baseline: AiBaseline = freeze({
      generation: pending.generation,
      cursor: pending.cursor,
      revision: pending.revision,
      providers: selected('providers', (value) =>
        aiProviderHeaderSchema.array().max(AI_INDEX_MAX_ENTRIES).parse(value),
      ),
      models: selected('models', (value) =>
        aiModelSchema.array().max(AI_INDEX_MAX_ENTRIES).parse(value),
      ),
      conversations: selected('conversations', (value) =>
        aiConversationSchema.array().max(AI_INDEX_MAX_ENTRIES).parse(value),
      ),
      runs: selected('runs', (value) =>
        aiRunHeaderSchema.array().max(AI_INDEX_MAX_ENTRIES).parse(value),
      ),
      approvals: selected('approvals', (value) => aiApprovalSchema.array().max(3200).parse(value)),
      engines: selected('engines', (value) => aiEngineHeaderSchema.array().max(256).parse(value)),
    });
    this.baseline = baseline;
    this.opening = false;
    this.pending = undefined;
    this.fragments.clear();
    this.bytes = 0;
    return baseline;
  }
}
