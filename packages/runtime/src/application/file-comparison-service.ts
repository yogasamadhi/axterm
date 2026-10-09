import { open, stat } from 'node:fs/promises';
import { basename } from 'node:path';
import type {
  CreateFileComparison,
  FileComparison,
  FileComparisonSource,
} from '@workspace/contracts';
import type { HostCapabilityClient } from '../adapters/host-capability/client';
import { ApplicationError } from './errors';
import type { SftpService } from './sftp-service';

const MAX_COMPARISON_BYTES = 2 * 1024 * 1024;
const MAX_COMPARISON_LINES = 10_000;
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

export class FileComparisonService {
  constructor(
    private readonly sftp: SftpService,
    private readonly hostCapabilities?: HostCapabilityClient,
  ) {}

  async compare(input: CreateFileComparison): Promise<FileComparison> {
    const [left, right] = await Promise.all([
      this.readCandidate(input.left),
      this.readCandidate(input.right),
    ]);
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
    const leftText = decodeUtf8(left.bytes);
    const rightText = decodeUtf8(right.bytes);
    if (leftText === undefined || rightText === undefined)
      return { status: 'unsupported', reason: 'binary', ...base };
    const leftLineCount = lineCount(leftText);
    const rightLineCount = lineCount(rightText);
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

  private async readCandidate(source: FileComparisonSource): Promise<Candidate> {
    if (source.scope === 'remote') {
      const result = await this.sftp.readForComparison(
        source.connectionId,
        source.path,
        MAX_COMPARISON_BYTES,
      );
      return {
        entry: {
          scope: 'remote',
          name: result.entry.name,
          path: result.entry.path,
          size: result.entry.size,
          ...(result.entry.mode === undefined ? {} : { mode: result.entry.mode }),
          ...(result.entry.modifiedAt ? { modifiedAt: result.entry.modifiedAt } : {}),
          ...(result.entry.accessedAt ? { accessedAt: result.entry.accessedAt } : {}),
          ...(result.entry.owner ? { owner: result.entry.owner } : {}),
          ...(result.entry.group ? { group: result.entry.group } : {}),
        },
        ...(result.bytes ? { bytes: result.bytes } : {}),
      };
    }
    if (!this.hostCapabilities)
      throw new ApplicationError('CAPABILITY_UNAVAILABLE', 'File grants are unavailable', 503);
    const grant = await this.hostCapabilities.resolveGrantTransferPath(
      source.grantId,
      source.path,
      'read',
    );
    const metadata = await stat(grant.path);
    const entry: FileComparison['left'] = {
      scope: 'local',
      name: basename(source.path),
      path: source.path,
      size: metadata.size,
      mode: metadata.mode,
      modifiedAt: metadata.mtime.toISOString(),
      accessedAt: metadata.atime.toISOString(),
      owner: String(metadata.uid),
      group: String(metadata.gid),
    };
    if (!metadata.isFile() || metadata.size > MAX_COMPARISON_BYTES) return { entry };
    const handle = await open(grant.path, 'r');
    try {
      const buffer = Buffer.alloc(MAX_COMPARISON_BYTES + 1);
      const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, 0);
      if (bytesRead > MAX_COMPARISON_BYTES) {
        entry.size = bytesRead;
        return { entry };
      }
      return { entry, bytes: buffer.subarray(0, bytesRead) };
    } finally {
      await handle.close();
    }
  }
}

function isBinaryName(name: string): boolean {
  const extension = name.includes('.') ? name.split('.').at(-1)?.toLowerCase() : undefined;
  return !!extension && BINARY_EXTENSIONS.has(extension);
}

function looksBinary(bytes: Buffer): boolean {
  const sample = bytes.subarray(0, Math.min(bytes.length, 8_192));
  let controls = 0;
  for (const byte of sample) {
    if (byte === 0) return true;
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
