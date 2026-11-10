import { createReadStream, createWriteStream } from 'node:fs';
import { chmod, lstat, mkdir, mkdtemp, readdir, rm, stat, utimes } from 'node:fs/promises';
import { join, posix } from 'node:path';
import { tmpdir } from 'node:os';
import { Readable } from 'node:stream';
import { pipeline, finished } from 'node:stream/promises';
import { c as createTar, x as extractTar, t as listTar } from 'tar';
import { root } from '@openclaw/fs-safe/root';
import type { LocalFileLease } from '@axterm/plugin-api/host';
import type { ArchiveStaging, PrivateArchive, ExtractedArchive } from '../ports/archive.ts';
import { ApplicationError } from '../application/errors.ts';
const MAX_ENTRIES = 20_000,
  MAX_DEPTH = 64,
  MAX_BYTES = 16 * 1024 ** 4;
const invalid = () =>
  new ApplicationError('VALIDATION_ERROR', 'Archive contains an unsafe member', 400);
function member(path: string): void {
  if (
    !path ||
    path.startsWith('/') ||
    path.includes('\\') ||
    path.includes('\0') ||
    path
      .split('/')
      .some((part) => !part || part === '.' || part === '..' || /^[A-Za-z]:/.test(part))
  )
    throw invalid();
}
interface Stage {
  directory: string;
  streams: Set<Readable>;
  closing?: Promise<void>;
}
/** Native tar sees only bounded app-owned staging, never an unrestricted granted source/destination. */
export class NativeArchiveStaging implements ArchiveStaging {
  private readonly stages = new Set<Stage>();
  private readonly operations = new Set<Promise<unknown>>();
  private readonly lifetime = new AbortController();
  private accepting = true;
  private closing: Promise<void> | undefined;
  pack(files: LocalFileLease, path: string, signal: AbortSignal): Promise<PrivateArchive> {
    return this.track(signal, (lifetime) => this.packOwned(files, path, lifetime));
  }
  private async packOwned(
    files: LocalFileLease,
    path: string,
    signal: AbortSignal,
  ): Promise<PrivateArchive> {
    const stage = await this.open(signal);
    try {
      const metadata = await files.stat(path);
      if (metadata.type !== 'directory') throw invalid();
      const name = metadata.name;
      member(name);
      const tree = join(stage.directory, 'tree');
      await mkdir(tree, { mode: 0o700 });
      const output = await root(tree, { hardlinks: 'reject', symlinks: 'reject', mode: 0o600 });
      const budget = { entries: 0, bytes: 0 };
      const clone = async (source: string, target: string, depth: number): Promise<void> => {
        signal.throwIfAborted();
        if (depth > MAX_DEPTH || ++budget.entries > MAX_ENTRIES)
          throw new ApplicationError('CAPACITY_EXCEEDED', 'Archive tree limit exceeded', 503);
        const entry = await files.stat(source);
        if (entry.type === 'symlink') return;
        if (entry.type === 'file') {
          budget.bytes += entry.size;
          if (budget.bytes > MAX_BYTES)
            throw new ApplicationError('CAPACITY_EXCEEDED', 'Archive byte limit exceeded', 503);
          const input = await files.read(source);
          const canceled = () => input.destroy(new Error('Archive packing canceled'));
          input.on('error', observed);
          signal.addEventListener('abort', canceled, { once: true });
          try {
            await output.create(target, input, {
              maxBytes: Math.max(0, MAX_BYTES),
              mode: (entry.mode ?? 0o600) & 0o777,
              signal,
            });
          } finally {
            signal.removeEventListener('abort', canceled);
            input.destroy();
            await finished(input).catch(() => {});
            input.off('error', observed);
          }
          if (entry.modifiedAt) {
            const modified = new Date(entry.modifiedAt);
            await utimes(
              join(tree, ...target.split('/')),
              entry.accessedAt ? new Date(entry.accessedAt) : modified,
              modified,
            );
          }
          return;
        }
        if (entry.type !== 'directory') throw invalid();
        await output.mkdir(target);
        for (const child of await files.list(source)) {
          member(child.name);
          if (child.type === 'symlink') continue;
          await clone(child.path, posix.join(target, child.name), depth + 1);
        }
        signal.throwIfAborted();
        if (entry.modifiedAt) {
          const modified = new Date(entry.modifiedAt);
          await utimes(
            join(tree, ...target.split('/')),
            entry.accessedAt ? new Date(entry.accessedAt) : modified,
            modified,
          );
        }
        if (process.platform !== 'win32')
          await chmod(join(tree, ...target.split('/')), (entry.mode ?? 0o700) & 0o777);
      };
      await clone(path, name, 0);
      signal.throwIfAborted();
      const archive = join(stage.directory, 'payload.tar');
      // The fixed tar implementation drains its private file IO before resolving.
      // Cancellation prevents publication; cleanup waits for this bounded pack.
      await createTar({ cwd: tree, file: archive, portable: true }, [name]);
      signal.throwIfAborted();
      const size = (await stat(archive)).size;
      if (size > MAX_BYTES)
        throw new ApplicationError('CAPACITY_EXCEEDED', 'Archive byte limit exceeded', 503);
      return {
        size,
        read: () => {
          if (stage.closing) throw new ApplicationError('INVALID_STATE', 'Archive is closed');
          signal.throwIfAborted();
          const stream = createReadStream(archive, { highWaterMark: 64 * 1024, signal });
          stage.streams.add(stream);
          stream.once('close', () => stage.streams.delete(stream));
          stream.on('error', () => {});
          return stream;
        },
        close: () => this.release(stage),
      };
    } catch (error) {
      await this.release(stage);
      throw error;
    }
  }
  unpack(source: Readable, name: string, signal: AbortSignal): Promise<ExtractedArchive> {
    return this.track(signal, (lifetime) => this.unpackOwned(source, name, lifetime)).catch(
      async (error) => {
        source.on('error', observed);
        source.destroy();
        await finished(source).catch(() => {});
        source.off('error', observed);
        throw error;
      },
    );
  }
  private async unpackOwned(
    source: Readable,
    name: string,
    signal: AbortSignal,
  ): Promise<ExtractedArchive> {
    member(name);
    const stage = await this.open(signal);
    try {
      const archive = join(stage.directory, 'payload.tar');
      let bytes = 0;
      const canceled = () => source.destroy(new Error('Archive download canceled'));
      source.on('error', observed);
      signal.addEventListener('abort', canceled, { once: true });
      const bounded = Readable.from(
        (async function* () {
          for await (const chunk of source) {
            const data = Buffer.from(chunk);
            bytes += data.length;
            if (bytes > MAX_BYTES)
              throw new ApplicationError('CAPACITY_EXCEEDED', 'Archive byte limit exceeded', 503);
            yield data;
          }
        })(),
        { objectMode: false, highWaterMark: 64 * 1024 },
      );
      try {
        await pipeline(bounded, createWriteStream(archive, { flags: 'wx', mode: 0o600 }), {
          signal,
        });
      } finally {
        signal.removeEventListener('abort', canceled);
        source.destroy();
        await finished(source).catch(() => {});
        source.off('error', observed);
      }
      const tree = join(stage.directory, 'tree');
      await mkdir(tree, { mode: 0o700 });
      signal.throwIfAborted();
      const metadata = await this.validate(archive, name, signal);
      await extractTar({
        cwd: tree,
        file: archive,
        preservePaths: false,
        strict: true,
        filter: (path, entry) => {
          const portable = canonical(path);
          const value = metadata.get(portable);
          if (
            !value ||
            !('type' in entry) ||
            !['File', 'OldFile', 'Directory'].includes(entry.type)
          )
            return false;
          // Materialize readable private files, then apply archived modes only when
          // the selected Files owner has finished populating the destination.
          entry.mode = entry.type === 'Directory' ? 0o700 : 0o600;
          return true;
        },
      });
      signal.throwIfAborted();
      const selected = join(tree, name);
      const selectedStat = await lstat(selected);
      if (!selectedStat.isDirectory() || selectedStat.isSymbolicLink()) throw invalid();
      return {
        publish: async (files, signal) => {
          if (stage.closing) throw new ApplicationError('INVALID_STATE', 'Archive is closed');
          const target = '';
          const clone = async (
            source: string,
            destination: string,
            depth: number,
            archivePath: string,
          ): Promise<void> => {
            signal.throwIfAborted();
            if (depth > MAX_DEPTH) throw invalid();
            const entry = await lstat(source);
            if (entry.isSymbolicLink() || (entry.isFile() && entry.nlink > 1)) throw invalid();
            if (entry.isDirectory()) {
              if (destination !== target) await files.mkdir(destination);
              for (const child of await readdir(source)) {
                member(child);
                await clone(
                  join(source, child),
                  posix.join(destination, child),
                  depth + 1,
                  posix.join(archivePath, child),
                );
              }
              const original = metadata.get(archivePath);
              if (original?.mtime !== undefined)
                await files.setTimes(destination, {
                  modifiedAt: original.mtime,
                  ...(original.atime === undefined ? {} : { accessedAt: original.atime }),
                });
              await files.chmod(destination, (original?.mode ?? entry.mode) & 0o777);
              return;
            }
            if (!entry.isFile()) throw invalid();
            const input = createReadStream(source, { highWaterMark: 64 * 1024, signal });
            stage.streams.add(input);
            input.on('error', () => {});
            try {
              await files.write(destination, input, { mode: 0o600 });
              const original = metadata.get(archivePath);
              if (original?.mtime !== undefined)
                await files.setTimes(destination, {
                  modifiedAt: original.mtime,
                  ...(original.atime === undefined ? {} : { accessedAt: original.atime }),
                });
              await files.chmod(destination, (original?.mode ?? entry.mode) & 0o777);
            } finally {
              input.destroy();
              await finished(input).catch(() => {});
              stage.streams.delete(input);
            }
          };
          await clone(selected, target, 0, name);
        },
        close: () => this.release(stage),
      };
    } catch (error) {
      await this.release(stage);
      throw error;
    }
  }
  private async validate(
    archive: string,
    name: string,
    signal: AbortSignal,
  ): Promise<Map<string, { mode: number; mtime?: number; atime?: number }>> {
    const metadata = new Map<string, { mode: number; mtime?: number; atime?: number }>();
    let entries = 0;
    let expanded = 0;
    let failure: Error | undefined;
    const source = createReadStream(archive, { highWaterMark: 64 * 1024, signal });
    const parser = listTar({
      strict: true,
      onReadEntry: (entry) => {
        try {
          signal.throwIfAborted();
          const path = canonical(entry.path);
          member(path);
          if (path !== name && !path.startsWith(name + '/')) throw invalid();
          if (++entries > MAX_ENTRIES || path.split('/').length > MAX_DEPTH || metadata.has(path))
            throw new ApplicationError('CAPACITY_EXCEEDED', 'Archive tree limit exceeded', 503);
          if (['SymbolicLink', 'Link'].includes(entry.type)) return;
          if (!['File', 'OldFile', 'Directory'].includes(entry.type)) throw invalid();
          expanded += entry.size;
          if (expanded > MAX_BYTES)
            throw new ApplicationError('CAPACITY_EXCEEDED', 'Expanded archive limit exceeded', 503);
          const mtime = entry.mtime?.getTime();
          const atime = entry.atime?.getTime();
          metadata.set(path, {
            mode: entry.mode ?? 0o600,
            ...(mtime === undefined ? {} : { mtime }),
            ...(atime === undefined ? {} : { atime }),
          });
        } catch (error) {
          failure = error instanceof Error ? error : invalid();
          source.destroy(failure);
          queueMicrotask(() => parser.abort(failure!));
        }
      },
    });
    try {
      await pipeline(source, parser, { signal });
      if (failure) throw failure;
      return metadata;
    } finally {
      source.destroy();
      await finished(source).catch(() => {});
    }
  }
  resourceCount(): number {
    return this.stages.size + this.operations.size;
  }
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.accepting = false;
    this.lifetime.abort();
    return (this.closing = (async () => {
      await Promise.allSettled([...this.operations]);
      const results = await Promise.allSettled(
        [...this.stages].map((stage) => this.release(stage)),
      );
      if (results.some((result) => result.status === 'rejected') || this.stages.size)
        throw new ApplicationError('TRANSFER_FAILED', 'Archive staging did not drain');
    })());
  }
  private track<T>(signal: AbortSignal, perform: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (!this.accepting)
      return Promise.reject(new ApplicationError('INVALID_STATE', 'Archive staging is closing'));
    if (this.operations.size >= 32)
      return Promise.reject(
        new ApplicationError('CAPACITY_EXCEEDED', 'Archive staging capacity exceeded', 503),
      );
    const lifetime = AbortSignal.any([signal, this.lifetime.signal]);
    const task = Promise.resolve().then(() => perform(lifetime));
    this.operations.add(task);
    void task.then(
      () => this.operations.delete(task),
      () => this.operations.delete(task),
    );
    return task;
  }
  private async open(signal: AbortSignal): Promise<Stage> {
    signal.throwIfAborted();
    if (!this.accepting) throw new ApplicationError('INVALID_STATE', 'Archive staging is closing');
    if (this.stages.size >= 32)
      throw new ApplicationError('CAPACITY_EXCEEDED', 'Archive staging capacity exceeded', 503);
    const directory = await mkdtemp(join(tmpdir(), 'axterm-owned-archive-'));
    const stage: Stage = { directory, streams: new Set() };
    this.stages.add(stage);
    if (signal.aborted || !this.accepting) {
      await this.release(stage);
      signal.throwIfAborted();
      throw new ApplicationError('INVALID_STATE', 'Archive staging is closing');
    }
    return stage;
  }
  private release(stage: Stage): Promise<void> {
    return (stage.closing ??= (async () => {
      const streams = [...stage.streams];
      for (const stream of streams) stream.destroy();
      await Promise.allSettled(streams.map((stream) => finished(stream)));
      await rm(stage.directory, { recursive: true, force: true });
      this.stages.delete(stage);
    })());
  }
}

function canonical(path: string): string {
  return path.replace(/^(?:\.\/)+/, '').replace(/\/$/, '');
}

function observed(): void {}
