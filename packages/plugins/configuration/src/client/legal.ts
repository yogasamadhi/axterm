import type { Context } from '@deepseek-ai/cordis';
import type { LegalDocumentsBaseline } from '@axterm/plugin-api/configuration';
import type { SettingsModel } from './index.ts';
type State =
  | { status: 'connecting' }
  | { status: 'ready'; baseline: LegalDocumentsBaseline }
  | { status: 'error' };
/** Canonical immutable artifact metadata; UI owns only bounded displayed text. */
export class LegalDocumentsModel {
  private state: State = { status: 'connecting' };
  private readonly listeners = new Set<() => void>();
  private readonly active = new Set<AbortController>();
  private readonly tasks = new Set<Promise<unknown>>();
  private listing: Promise<void> | undefined;
  private closed = false;
  private readonly off: () => void;
  constructor(
    private readonly ctx: Context,
    private readonly settings: Pick<SettingsModel, 'getSnapshot' | 'subscribe'>,
  ) {
    this.off = settings.subscribe(() => {
      const facts = settings.getSnapshot();
      if (
        this.state.status === 'ready' &&
        (facts.status !== 'ready' || facts.baseline.generation !== this.state.baseline.generation)
      ) {
        for (const controller of this.active) controller.abort();
        this.publish({ status: 'connecting' });
      }
    });
  }
  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private publish(state: State) {
    if (this.closed) return;
    this.state = state;
    for (const listener of [...this.listeners]) listener();
  }
  load(): Promise<void> {
    if (this.closed) throw Error('LEGAL_CLOSED');
    if (this.listing) return this.listing;
    const task = Promise.resolve()
      .then(async () => {
        const facts = this.settings.getSnapshot();
        if (facts.status !== 'ready') throw Error('LEGAL_NOT_READY');
        const result = await this.ctx.remote.configuration.listLegalDocuments();
        if (!result.ok) throw result.error;
        const current = this.settings.getSnapshot(),
          baseline = result.value;
        if (
          current.status !== 'ready' ||
          current.baseline.generation !== baseline.generation ||
          baseline.generation !== facts.baseline.generation ||
          baseline.documents.length > 128 ||
          new Set(baseline.documents.map((value) => value.id)).size !== baseline.documents.length ||
          baseline.documents.some(
            (value) =>
              !/^[a-f0-9]{24}$/.test(value.id) || value.bytes < 1 || value.bytes > 8 * 1024 * 1024,
          ) ||
          baseline.documents.reduce((sum, value) => sum + value.bytes, 0) > 32 * 1024 * 1024
        )
          throw Error('LEGAL_BASELINE_INVALID');
        this.publish({
          status: 'ready',
          baseline: Object.freeze({
            ...baseline,
            documents: Object.freeze(
              baseline.documents.map((value) => Object.freeze({ ...value })),
            ),
          }),
        });
      })
      .catch(() => {
        this.publish({ status: 'error' });
        throw Error('LEGAL_UNAVAILABLE');
      });
    this.listing = task;
    void task.then(
      () => {
        this.listing = undefined;
      },
      () => {
        this.listing = undefined;
      },
    );
    return task;
  }
  read(id: string, signal: AbortSignal): Promise<string> {
    if (this.closed || this.active.size >= 8 || this.state.status !== 'ready')
      throw Error('LEGAL_NOT_READY');
    const baseline = this.state.baseline,
      document = baseline.documents.find((value) => value.id === id),
      facts = this.settings.getSnapshot();
    if (!document || facts.status !== 'ready' || facts.baseline.generation !== baseline.generation)
      throw Error('LEGAL_RETIRED');
    const controller = new AbortController();
    this.active.add(controller);
    const task = (async () => {
      const combined = AbortSignal.any([signal, controller.signal]);
      combined.throwIfAborted();
      const stream = this.ctx.remote.configuration.readLegalDocument(id, combined),
        parts: string[] = [];
      let offset = 0,
        bytes = 0;
      try {
        for await (const chunk of stream) {
          combined.throwIfAborted();
          if (chunk.offset !== offset || chunk.text.length > 32768)
            throw Error('LEGAL_CHUNK_INVALID');
          offset += chunk.text.length;
          bytes += new TextEncoder().encode(chunk.text).byteLength;
          if (bytes > document.bytes) throw Error('LEGAL_CAPACITY');
          parts.push(chunk.text);
        }
        combined.throwIfAborted();
        if (bytes !== document.bytes) throw Error('LEGAL_INCOMPLETE');
        const text = parts.join(''),
          digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
        combined.throwIfAborted();
        if (
          Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join(
            '',
          ) !== document.sha256
        )
          throw Error('LEGAL_CHANGED');
        return text;
      } finally {
        stream.dispose();
      }
    })();
    this.tasks.add(task);
    void task.then(
      () => {
        this.tasks.delete(task);
        this.active.delete(controller);
      },
      () => {
        this.tasks.delete(task);
        this.active.delete(controller);
      },
    );
    return task;
  }
  async close(): Promise<void> {
    this.closed = true;
    this.off();
    for (const controller of this.active) controller.abort();
    await Promise.allSettled([...this.tasks, this.listing]);
    this.listeners.clear();
  }
}
