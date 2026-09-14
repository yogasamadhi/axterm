import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import iconv from 'iconv-lite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  formatLogTimestamp,
  normalizeBareCarriageReturns,
  TerminalRecordingWriter,
} from './terminal-recording';

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function logPath(initial = '') {
  const directory = await mkdtemp(join(tmpdir(), 'axterm-terminal-log-'));
  directories.push(directory);
  const path = join(directory, 'session.log');
  await writeFile(path, initial);
  return path;
}

describe('TerminalRecordingWriter', () => {
  it('appends decoded visual lines with ANSI removed and optional timestamps', async () => {
    const path = await logPath('existing\n');
    const now = new Date(2026, 8, 12, 21, 4, 5, 6);
    const writer = await TerminalRecordingWriter.open({
      path,
      encoding: 'gbk',
      timestamps: true,
      onDrain: vi.fn(),
      onError: vi.fn(),
      now: () => now,
    });

    writer.write(iconv.encode('\u001b[31m红色\u001b[0m\r\n', 'gbk'));
    const chinese = iconv.encode('中文\r\n', 'gbk');
    writer.write(chinese.subarray(0, 1));
    writer.write(chinese.subarray(1));
    writer.write(iconv.encode('旧进度\r新进度\r\n', 'gbk'));
    await writer.close();

    const prefix = `[${formatLogTimestamp(now)}] `;
    expect(await readFile(path, 'utf8')).toBe(
      `existing\n${prefix}红色\n${prefix}中文\n${prefix}旧进度\n${prefix}新进度\n`,
    );
    expect(writer.bytesWritten).toBe(
      Buffer.byteLength(`${prefix}红色\n${prefix}中文\n${prefix}旧进度\n${prefix}新进度\n`),
    );
  });

  it('uses the headless VT buffer result and flushes accepted lines before close resolves', async () => {
    const path = await logPath();
    const writer = await TerminalRecordingWriter.open({
      path,
      encoding: 'utf-8',
      timestamps: false,
      onDrain: vi.fn(),
      onError: vi.fn(),
    });

    writer.write(Buffer.from('abcdef\u001b[3DXYZ\r\npartial'));
    await writer.close();

    expect(await readFile(path, 'utf8')).toBe('abcXYZ\n');
  });

  it('fails explicitly instead of growing an unbounded parser queue', async () => {
    const path = await logPath();
    const onError = vi.fn();
    const writer = await TerminalRecordingWriter.open({
      path,
      encoding: 'utf-8',
      timestamps: false,
      onDrain: vi.fn(),
      onError,
    });

    expect(writer.write(Buffer.alloc(1_024 * 1_024 + 1, 97))).toBe(true);
    expect(onError).toHaveBeenCalledTimes(1);
    await expect(writer.close()).rejects.toThrow('bounded capacity');
  });

  it('matches the upstream bare carriage-return normalization', () => {
    expect(normalizeBareCarriageReturns('a\rb\r\nc')).toBe('a\r\nb\r\nc');
  });
});
