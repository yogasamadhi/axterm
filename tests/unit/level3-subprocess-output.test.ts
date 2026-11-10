import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it } from 'vitest';
import {
  OutputCollector,
  prepareManagedProcessBinding,
} from '../../packages/infra/subprocess-local/src/output.ts';
const cleanup: string[] = [];
afterEach(async () => {
  for (const path of cleanup.splice(0)) await rm(path, { recursive: true, force: true });
});
it('keeps exact independent bounded byte tails and offsets when a single fragment exceeds the cap', () => {
  const output = new OutputCollector(7, 'stdout', undefined);
  const input = Buffer.from('0123456789');
  output.push(input);
  input.fill(0);
  expect(output.readFrom(0)).toEqual({ text: '3456789', nextOffset: 10, lossy: true });
  expect(output.readFrom(8)).toEqual({ text: '89', nextOffset: 10, lossy: false });
  const snapshot = output.snapshot();
  snapshot.bytes.fill(0);
  expect(output.readFrom(0).text).toBe('3456789');
  expect(() => output.readFrom(-1)).toThrow('OFFSET_INVALID');
  expect(() => output.readFrom(11)).toThrow('OFFSET_INVALID');
  output.dispose();
  expect(() => output.readFrom(0)).toThrow('CLOSED');
});
it('keeps a complete private spill until explicit disposal and removes only created files', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'axterm-subprocess-output-'));
  cleanup.push(directory);
  const output = new OutputCollector(3, 'stdout', {
    maxBytes: 100,
    dir: directory,
    onFailure: () => {
      throw new Error('Unexpected spill failure');
    },
  });
  output.push(Buffer.from('first'));
  output.push(Buffer.from('second'));
  const value = output.finalize();
  expect(value).toMatchObject({ text: 'ond', truncated: true });
  expect(await readFile(value.spillPath!, 'utf8')).toBe('firstsecond');
  output.dispose();
  output.dispose();
  expect(await readdir(directory)).toEqual([]);
  expect(() => output.finalize()).toThrow('CLOSED');
});
it('discards oversized incomplete spills, supports zero tails and closes an owned private directory', async () => {
  const binding = prepareManagedProcessBinding();
  cleanup.push(binding.spillDir);
  const output = new OutputCollector(0, 'stderr', {
    maxBytes: 4,
    dir: binding.spillDir,
    onFailure: () => {},
  });
  output.push(Buffer.from('abcd'));
  expect(output.readFrom(0)).toMatchObject({ text: '', nextOffset: 4, lossy: true });
  output.push(Buffer.from('e'));
  expect(output.finalize().spillPath).toBeUndefined();
  output.dispose();
  binding.dispose();
  await expect(readdir(binding.spillDir)).rejects.toMatchObject({ code: 'ENOENT' });
});
it('rejects unsafe capacity and spill labels before allocating files', () => {
  for (const cap of [-1, Number.NaN, Number.MAX_SAFE_INTEGER])
    expect(() => new OutputCollector(cap, 'stdout', undefined)).toThrow('CAPACITY');
  expect(() => new OutputCollector(10, '../outside', undefined)).toThrow('LABEL_INVALID');
  expect(
    () => new OutputCollector(10, 'stdout', { maxBytes: 9, dir: '/', onFailure: () => {} }),
  ).toThrow('SPILL_CAPACITY');
});
