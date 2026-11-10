import { RemoteError } from '@axterm/plugin-api';
import {
  createFileComparisonSchema,
  fileComparisonSchema,
  MAX_FILE_COMPARISON_BYTES,
  MAX_FILE_COMPARISON_LINES,
  type CreateFileComparison,
  type FileComparison,
  type FileComparisonSource,
} from '@axterm/plugin-api/files';
import type { HostFiles } from '@axterm/plugin-api/host';
import type { RemoteFileApplication } from './remote-files.ts';
const MAX_COMPARISON_BYTES = MAX_FILE_COMPARISON_BYTES;
const MAX_COMPARISON_LINES = MAX_FILE_COMPARISON_LINES;
const BINARY_EXTENSIONS = new Set([
  '7z',
  'a',
  'aac',
  'avi',
  'bin',
  'bmp',
  'bz2',
  'class',
  'db',
  'dll',
  'dmg',
  'doc',
  'docx',
  'exe',
  'gif',
  'gz',
  'ico',
  'iso',
  'jar',
  'jpeg',
  'jpg',
  'm4a',
  'mkv',
  'mov',
  'mp3',
  'mp4',
  'o',
  'odt',
  'ogg',
  'otf',
  'pdf',
  'png',
  'ppt',
  'pptx',
  'psd',
  'pyc',
  'rar',
  'so',
  'sqlite',
  'sqlite3',
  'tar',
  'tif',
  'tiff',
  'ttf',
  'wav',
  'webm',
  'webp',
  'woff',
  'woff2',
  'xls',
  'xlsx',
  'xz',
  'zip',
]);

interface Candidate {
  entry: FileComparison['left'];
  bytes?: Buffer;
}
const failure = (reason: 'closed' | 'capacity' | 'cancelled' | 'unavailable') =>
  new RemoteError('files/failure', 'File comparison could not complete', { reason });
/** Readonly bounded work. Both reads/leases finish before a result, rejection or unload completes. */
export class FileComparisonApplication {
  private readonly lifetime = new AbortController();
  private readonly pending = new Set<Promise<FileComparison>>();
  private closing: Promise<void> | undefined;
  constructor(
    private readonly local: HostFiles,
    private readonly remote: Pick<RemoteFileApplication, 'readForComparison'>,
  ) {}
  compare(input: CreateFileComparison, signal: AbortSignal): Promise<FileComparison> {
    if (this.closing) return Promise.reject(failure('closed'));
    if (this.pending.size >= 4) return Promise.reject(failure('capacity'));
    const parsed = createFileComparisonSchema.parse(input);
    const owned = AbortSignal.any([signal, this.lifetime.signal]);
    const task = this.execute(parsed, owned);
    this.pending.add(task);
    void task.finally(() => this.pending.delete(task)).catch(() => {});
    return task;
  }
  close(): Promise<void> {
    return (this.closing ??= (async () => {
      this.lifetime.abort();
      await Promise.allSettled([...this.pending]);
    })());
  }
  private async execute(input: CreateFileComparison, signal: AbortSignal): Promise<FileComparison> {
    if (signal.aborted) throw failure('cancelled');
    const group = new AbortController(),
      lifetime = AbortSignal.any([signal, group.signal]);
    let failed = false,
      firstFailure: unknown;
    const read = (source: FileComparisonSource) =>
      this.readCandidate(source, lifetime).catch((error) => {
        if (!failed) {
          failed = true;
          firstFailure = error;
          group.abort();
        }
        throw error;
      });
    const result = await Promise.allSettled([read(input.left), read(input.right)]);
    if (signal.aborted) throw failure('cancelled');
    if (failed) throw firstFailure;
    const [left, right] = result.map((value) => {
      if (value.status === 'rejected') throw failure('unavailable');
      return value.value;
    }) as [Candidate, Candidate];
    return fileComparisonSchema.parse(classify(left, right));
  }
  private async readCandidate(
    source: FileComparisonSource,
    signal: AbortSignal,
  ): Promise<Candidate> {
    signal.throwIfAborted();
    if (source.scope === 'remote') {
      const result = await this.remote.readForComparison(
        source.target,
        source.path,
        MAX_COMPARISON_BYTES,
        signal,
      );
      const { type: _type, revision: _revision, ...metadata } = result.entry;
      return {
        entry: { scope: 'remote', ...metadata },
        ...(result.bytes ? { bytes: result.bytes } : {}),
      };
    }
    const lease = await this.local.open(source.grantId, 'read', signal);
    try {
      signal.throwIfAborted();
      const path = source.path || lease.path;
      const { type, ...metadata } = await lease.stat(path);
      const entry: FileComparison['left'] = {
        scope: 'local',
        ...metadata,
        path: source.path || metadata.name,
      };
      if (type !== 'file' || entry.size > MAX_COMPARISON_BYTES) return { entry };
      const stream = await lease.read(path, { end: MAX_COMPARISON_BYTES });
      const chunks: Buffer[] = [];
      let bytesRead = 0;
      for await (const chunk of stream) {
        signal.throwIfAborted();
        const bytes = Buffer.from(chunk);
        bytesRead += bytes.length;
        if (bytesRead > MAX_COMPARISON_BYTES)
          return { entry: { ...entry, size: Math.max(entry.size, bytesRead) } };
        chunks.push(bytes);
      }
      signal.throwIfAborted();
      return { entry, bytes: Buffer.concat(chunks, bytesRead) };
    } finally {
      await lease.close();
    }
  }
}
function classify(left: Candidate, right: Candidate): FileComparison {
  const base = { left: left.entry, right: right.entry };
  if (left.entry.size > MAX_COMPARISON_BYTES || right.entry.size > MAX_COMPARISON_BYTES)
    return { status: 'too-large', reason: 'too-many-bytes', ...base };
  if (!left.bytes || !right.bytes) return { status: 'unsupported', reason: 'directory', ...base };
  if (
    isBinaryName(left.entry.name) ||
    isBinaryName(right.entry.name) ||
    looksBinary(left.bytes) ||
    looksBinary(right.bytes)
  )
    return { status: 'unsupported', reason: 'binary', ...base };
  const leftText = decodeUtf8(left.bytes),
    rightText = decodeUtf8(right.bytes);
  if (leftText === undefined || rightText === undefined)
    return { status: 'unsupported', reason: 'binary', ...base };
  const leftLineCount = lineCount(leftText),
    rightLineCount = lineCount(rightText);
  if (leftLineCount > MAX_COMPARISON_LINES || rightLineCount > MAX_COMPARISON_LINES)
    return { status: 'too-large', reason: 'too-many-lines', ...base };
  if (leftText === rightText)
    return {
      status: 'equal',
      left: { ...left.entry, lineCount: leftLineCount },
      right: { ...right.entry, lineCount: rightLineCount },
    };
  return {
    status: 'different',
    left: { ...left.entry, content: leftText, lineCount: leftLineCount },
    right: { ...right.entry, content: rightText, lineCount: rightLineCount },
  };
}
function isBinaryName(name: string): boolean {
  const extension = name.includes('.') ? name.split('.').at(-1)?.toLowerCase() : undefined;
  return !!extension && BINARY_EXTENSIONS.has(extension);
}

function looksBinary(bytes: Buffer): boolean {
  if (bytes.includes(0)) return true;
  const sample = bytes.subarray(0, Math.min(bytes.length, 8_192));
  let controls = 0;
  for (const byte of sample) {
    if (byte < 0x20 && byte !== 0x09 && byte !== 0x0a && byte !== 0x0d) controls += 1;
  }
  return sample.length > 0 && controls / sample.length > 0.1;
}

function decodeUtf8(bytes: Buffer): string | undefined {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }
}

function lineCount(content: string): number {
  if (!content) return 0;
  return content.split(/\r\n|\r|\n/u).length;
}
