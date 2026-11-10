import { randomUUID } from 'node:crypto';
import { posix } from 'node:path';
import { RemoteError, remoteErrorOf } from '@axterm/plugin-api';
import {
  previewFileRenameSchema,
  type PreviewFileRenameInput,
  type FileRenamePreview,
  type FileRenameResult,
  type RenameBaseline,
  type RenameUpdate,
  type AutomationFailureReason,
} from '@axterm/plugin-api/automation';
import type { FileRenamePort, RenameScope, RenameFile } from '../ports/file-renamer.ts';
const fail = (reason: AutomationFailureReason) =>
  new RemoteError('automation/failure', 'The reviewed file rename could not complete', { reason });
interface Preview {
  metadata: FileRenamePreview;
  scope: RenameScope;
  versions: Map<string, string>;
  moved: { source: string; current: string; version: string }[];
  timer?: ReturnType<typeof setTimeout>;
  revoked: () => void;
  uncertain: boolean;
}
interface Receipt {
  previewId: string;
  pending?: Promise<FileRenameResult>;
  result?: FileRenameResult;
  failure?: AutomationFailureReason;
  expired?: boolean;
}
/** A review is transient authority, never a durable instruction to replay filesystem mutations. */
export class FileRenamer {
  private readonly previews = new Map<string, Preview>();
  private readonly recoveries = new Map<string, Preview>();
  private readonly receipts = new Map<string, Receipt>();
  private readonly pending = new Set<Promise<unknown>>();
  private readonly listeners = new Set<() => void>();
  private accepting = true;
  private activeRun = false;
  private activePreview: Preview | undefined;
  private openings = 0;
  private revision = 0;
  private closing?: Promise<void>;
  constructor(
    private readonly generation: string,
    private readonly files: FileRenamePort,
  ) {}
  resourceCount(): number {
    return this.pending.size + this.previews.size + this.recoveries.size;
  }
  baseline(): RenameBaseline {
    return {
      generation: this.generation,
      revision: this.revision,
      previews: [...this.previews.values()].map((item) => structuredClone(item.metadata)),
      running: this.activePreview ? [structuredClone(this.activePreview.metadata)] : [],
      recoveries: [...this.recoveries].map(([previewId, item]) => ({
        previewId,
        items: item.moved.map(({ source, current }) => ({ source, current })),
      })),
    };
  }
  preview(input: PreviewFileRenameInput): Promise<FileRenamePreview> {
    if (!this.accepting) return Promise.reject(fail('closed'));
    if (this.previews.size + this.openings >= 16 || this.recoveries.size)
      return Promise.reject(fail('capacity'));
    this.openings++;
    return this.track(
      (async () => {
        let scope: RenameScope | undefined;
        try {
          const config = previewFileRenameSchema.parse(input);
          scope = await this.files.open(config.grantId);
          const root = await scope.inspect('');
          if (root.type !== 'directory') throw fail('invalid-input');
          const paths: string[] = [];
          let visited = 0;
          const visit = async (path: string, depth: number): Promise<void> => {
            if (depth > 32 || ++visited > 1000) throw fail('capacity');
            scope!.signal.throwIfAborted();
            const entries = await scope!.list(path);
            for (const item of entries) {
              if (item.type === 'directory' && config.includeSubfolders)
                await visit(item.path, depth + 1);
              else if (item.type === 'file') paths.push(item.path);
              if (paths.length > 1000) throw fail('capacity');
            }
          };
          await visit('', 0);
          const types =
            config.fileTypes.trim() === '*'
              ? undefined
              : new Set(
                  config.fileTypes
                    .split(',')
                    .map((value) => value.trim().replace(/^\./, '').toLowerCase())
                    .filter(Boolean),
                );
          if (types?.size === 0) throw fail('invalid-input');
          const selected = paths
            .filter((path) => !types || types.has(posix.extname(path).slice(1).toLowerCase()))
            .sort((a, b) => a.localeCompare(b));
          const versions = new Map<string, string>();
          const items: FileRenamePreview['items'] = [];
          for (const [index, path] of selected.entries()) {
            const current = await scope.inspect(path);
            if (current.type !== 'file') throw fail('precondition-failed');
            versions.set(path, current.version);
            const target = render(
              config.template,
              current,
              index + config.startNumber,
              config.preserveCase,
              scope.rootName,
            );
            let state: FileRenamePreview['items'][number]['state'] =
              path === target ? 'unchanged' : 'ready';
            if (state === 'ready' && (await exists(scope, target))) state = 'conflict';
            items.push({ source: path, target, state });
          }
          const targets = new Map<string, number>();
          for (const item of items) targets.set(item.target, (targets.get(item.target) ?? 0) + 1);
          for (const item of items) if (targets.get(item.target)! > 1) item.state = 'conflict';
          const ready = items.filter((item) => item.state === 'ready').length;
          const conflicts = items.filter((item) => item.state === 'conflict').length;
          const id = randomUUID();
          const now = Date.now();
          const metadata: FileRenamePreview = {
            id,
            rootName: scope.rootName,
            createdAt: new Date(now).toISOString(),
            expiresAt: new Date(now + 120000).toISOString(),
            total: items.length,
            ready,
            conflicts,
            canRun: ready > 0 && conflicts === 0,
            items,
          };
          if (!this.accepting) throw fail('closed');
          scope.signal.throwIfAborted();
          const owned = scope;
          const revoke = () => {
            void this.discard(id).catch(() => {});
          };
          const preview: Preview = {
            metadata,
            scope: owned,
            versions,
            moved: [],
            revoked: revoke,
            uncertain: false,
          };
          preview.timer = setTimeout(revoke, 120000);
          preview.timer.unref();
          if (
            Buffer.byteLength(
              JSON.stringify({
                ...this.baseline(),
                previews: [...this.baseline().previews, metadata],
              }),
            ) >
            8 * 1024 * 1024
          ) {
            clearTimeout(preview.timer);
            throw fail('capacity');
          }
          this.previews.set(id, preview);
          owned.signal.addEventListener('abort', revoke, { once: true });
          scope = undefined;
          this.changed();
          return structuredClone(metadata);
        } finally {
          this.openings--;
          await scope?.close();
        }
      })(),
    );
  }
  discard(id: string): Promise<void> {
    const preview = this.previews.get(id);
    if (!preview) return Promise.resolve();
    this.previews.delete(id);
    this.detach(preview);
    this.changed();
    return this.track(
      preview.scope.close().catch((error: unknown) => {
        preview.uncertain = true;
        this.recoveries.set(id, preview);
        this.changed();
        throw error;
      }),
    );
  }
  run(key: string, id: string, signal?: AbortSignal): Promise<FileRenameResult> {
    if (!this.accepting) return Promise.reject(fail('closed'));
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(key))
      return Promise.reject(fail('invalid-input'));
    key = key.toLowerCase();
    const previous = this.receipts.get(key);
    if (previous) {
      if (previous.previewId !== id) return Promise.reject(fail('conflict'));
      if (previous.pending) return previous.pending.then((value) => structuredClone(value));
      if (previous.failure) return Promise.reject(fail(previous.failure));
      if (previous.expired || !previous.result) return Promise.reject(fail('receipt-expired'));
      return Promise.resolve(structuredClone(previous.result));
    }
    if (this.receipts.size >= 10000) return Promise.reject(fail('capacity'));
    if (this.activeRun || this.recoveries.size) return Promise.reject(fail('conflict'));
    const preview = this.previews.get(id);
    if (
      !preview ||
      Date.parse(preview.metadata.expiresAt) <= Date.now() ||
      !preview.metadata.canRun
    )
      return Promise.reject(fail('precondition-failed'));
    const receipt: Receipt = { previewId: id };
    this.receipts.set(key, receipt);
    this.activeRun = true;
    this.activePreview = preview;
    this.previews.delete(id);
    this.detach(preview);
    this.changed();
    const task = this.track(
      (async () => {
        try {
          const ready = preview.metadata.items.filter((item) => item.state === 'ready');
          for (const item of ready) {
            signal?.throwIfAborted();
            if (
              (await preview.scope.inspect(item.source)).version !==
                preview.versions.get(item.source) ||
              (await exists(preview.scope, item.target))
            )
              throw fail('precondition-failed');
          }
          for (const item of ready) {
            signal?.throwIfAborted();
            preview.moved.push({
              source: item.source,
              current: item.target,
              version: preview.versions.get(item.source)!,
            });
            await preview.scope.move(item.source, item.target, preview.versions.get(item.source)!);
          }
          const result: FileRenameResult = {
            previewId: id,
            renamed: ready.length,
            items: structuredClone(preview.metadata.items),
            finishedAt: new Date().toISOString(),
          };
          await preview.scope.close();
          receipt.result = result;
          return structuredClone(result);
        } catch (error) {
          for (let index = preview.moved.length - 1; index >= 0; index--) {
            const item = preview.moved[index]!;
            try {
              if (
                !(await exists(preview.scope, item.source)) ||
                (await preview.scope.inspect(item.source)).version !== item.version
              )
                await preview.scope.move(item.current, item.source, item.version);
              preview.moved.splice(index, 1);
            } catch {
              preview.uncertain = true;
            }
          }
          if (preview.moved.length || preview.uncertain) {
            this.recoveries.set(id, preview);
            receipt.failure = 'uncertain';
          } else {
            try {
              await preview.scope.close();
            } catch {
              preview.uncertain = true;
              this.recoveries.set(id, preview);
            }
            receipt.failure = preview.uncertain
              ? 'uncertain'
              : signal?.aborted
                ? 'cancelled'
                : remoteErrorOf(error)?.code === 'automation/failure'
                  ? (remoteErrorOf(error)!.details as { reason: AutomationFailureReason }).reason
                  : 'unavailable';
          }
          throw fail(receipt.failure!);
        } finally {
          delete receipt.pending;
          this.activeRun = false;
          this.activePreview = undefined;
          const completed = [...this.receipts.values()].filter((item) => item.result);
          let bytes = completed.reduce(
            (total, item) => total + Buffer.byteLength(JSON.stringify(item.result)),
            0,
          );
          while (completed.length > 32 || bytes > 16 * 1024 * 1024) {
            const old = completed.shift()!;
            bytes -= Buffer.byteLength(JSON.stringify(old.result));
            delete old.result;
            old.expired = true;
          }
          this.changed();
        }
      })(),
    );
    receipt.pending = task;
    return task;
  }
  recover(id: string, grantId: string): Promise<void> {
    if (!this.accepting) return Promise.reject(fail('closed'));
    if (this.activeRun) return Promise.reject(fail('conflict'));
    const preview = this.recoveries.get(id);
    if (!preview) return Promise.resolve();
    this.activeRun = true;
    return this.track(
      (async () => {
        let replacement: RenameScope | undefined;
        try {
          replacement = await this.files.open(grantId);
          if (replacement.identity !== preview.scope.identity) throw fail('precondition-failed');
          await preview.scope.close();
          preview.scope = replacement;
          replacement = undefined;
          for (let index = preview.moved.length - 1; index >= 0; index--) {
            const item = preview.moved[index]!;
            if (
              !(await exists(preview.scope, item.source)) ||
              (await preview.scope.inspect(item.source)).version !== item.version
            )
              await preview.scope.move(item.current, item.source, item.version);
            preview.moved.splice(index, 1);
          }
          await preview.scope.close();
          this.recoveries.delete(id);
        } finally {
          await replacement?.close();
          this.activeRun = false;
          this.changed();
        }
      })(),
    );
  }
  async *watch(signal: AbortSignal): AsyncIterable<RenameUpdate> {
    if (!this.accepting) throw fail('closed');
    if (this.listeners.size >= 8) throw fail('capacity');
    let wake: (() => void) | undefined;
    let dirty = true;
    const notify = () => {
      dirty = true;
      wake?.();
    };
    this.listeners.add(notify);
    signal.addEventListener('abort', notify);
    try {
      while (this.accepting && !signal.aborted) {
        if (!dirty)
          await new Promise<void>((resolve) => {
            wake = resolve;
          });
        wake = undefined;
        if (!this.accepting || signal.aborted) break;
        dirty = false;
        const baseline = this.baseline();
        const text = JSON.stringify(baseline);
        if (Buffer.byteLength(text) > 16 * 1024 * 1024) throw fail('capacity');
        yield { type: 'begin', generation: this.generation, revision: baseline.revision };
        for (let offset = 0; offset < text.length; offset += 16384)
          yield {
            type: 'chunk',
            offset,
            text: text.slice(offset, offset + 16384),
            final: offset + 16384 >= text.length,
          };
        yield { type: 'commit', revision: baseline.revision };
      }
    } finally {
      this.listeners.delete(notify);
      signal.removeEventListener('abort', notify);
    }
  }
  close(): Promise<void> {
    return (this.closing ??= (async () => {
      this.accepting = false;
      this.changed();
      await Promise.allSettled([...this.pending]);
      const results = await Promise.allSettled(
        [...this.previews.keys()].map((id) => this.discard(id)),
      );
      if (results.some((result) => result.status === 'rejected') || this.recoveries.size)
        throw fail('uncertain');
      this.receipts.clear();
    })());
  }
  private detach(preview: Preview): void {
    clearTimeout(preview.timer);
    preview.scope.signal.removeEventListener('abort', preview.revoked);
  }
  private changed(): void {
    this.revision++;
    for (const notify of this.listeners) notify();
  }
  private track<T>(promise: Promise<T>): Promise<T> {
    this.pending.add(promise);
    void promise.then(
      () => this.pending.delete(promise),
      () => this.pending.delete(promise),
    );
    return promise;
  }
}
async function exists(scope: RenameScope, path: string): Promise<boolean> {
  try {
    await scope.inspect(path);
    return true;
  } catch (error) {
    if (
      error &&
      typeof error === 'object' &&
      'code' in error &&
      ['ENOENT', 'not-found'].includes(String(error.code))
    )
      return false;
    throw error;
  }
}
function render(
  template: string,
  file: RenameFile,
  number: number,
  preserveCase: boolean,
  rootName: string,
): string {
  const path = posix.parse(file.path);
  const date = new Date(file.timestamp);
  const tags: Record<string, (value?: string) => string> = {
    n: (padding) =>
      padding ? String(number).padStart(Math.min(Number(padding) || 0, 20), '0') : String(number),
    name: () => (preserveCase ? path.name : path.name.toLowerCase()),
    ext: () => path.ext.slice(1),
    date: () => date.toISOString().slice(0, 10),
    time: () => date.toTimeString().slice(0, 8).replaceAll(':', '-'),
    random: () => randomUUID().replaceAll('-', '').slice(0, 6),
    parent: () => (path.dir ? posix.basename(path.dir) : posix.basename(rootName)),
  };
  let name = template;
  for (const [tag, value] of Object.entries(tags))
    name = name.replace(new RegExp(`\\{${tag}(?::([^}]+))?\\}`, 'g'), (_, padding) =>
      value(typeof padding === 'string' ? padding : undefined),
    );
  if (!name || name === '.' || name === '..' || name.length > 255 || /[\\/\0]/u.test(name))
    throw fail('invalid-input');
  return path.dir ? path.dir + '/' + name : name;
}
