import { Context } from '@deepseek-ai/cordis';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { buildCommandLine } from '../../packages/infra/win32-process/src/process.ts';
import { parseWindowsStartRequest } from '../../packages/infra/subprocess-local/src/runner-protocol.ts';
import { spawnSubprocess } from '../../packages/infra/subprocess-local/src/spawn.ts';
import LocalSubprocess from '../../packages/infra/subprocess-local/src/index.ts';

it('preserves the reviewed CMD/PowerShell payload verbatim while keeping normal argv escaping as the default', () => {
  const program = 'C:\\Program Files\\owned\\cmd.exe';
  const command =
    "powershell -NoProfile -Command \"Set-Content -LiteralPath 'quoted.txt' -Value 'alpha beta' -Encoding UTF8\"";
  const args = ['/d', '/s', '/c', `"${command}"`];
  expect(buildCommandLine(program, args, true)).toBe(`"${program}" /d /s /c "${command}"`);
  expect(buildCommandLine(program, args)).toBe(buildCommandLine(program, args, false));
  expect(buildCommandLine(program, args)).not.toBe(buildCommandLine(program, args, true));
  expect(buildCommandLine('program', ['plain', 'two words'])).toBe('program plain "two words"');
});
it('accepts only an explicit boolean in the private Windows start message and still rejects unknown authority fields', () => {
  const start = { type: 'start', cwd: 'C:\\controlled', env: { PATH: 'controlled' } };
  expect(parseWindowsStartRequest(start)).toEqual(start);
  for (const windowsVerbatimArguments of [true, false])
    expect(parseWindowsStartRequest({ ...start, windowsVerbatimArguments })).toEqual({
      ...start,
      windowsVerbatimArguments,
    });
  for (const windowsVerbatimArguments of [1, 'true', null, {}, []])
    expect(() => parseWindowsStartRequest({ ...start, windowsVerbatimArguments })).toThrow(
      'invalid Windows start',
    );
  expect(() =>
    parseWindowsStartRequest({ ...start, windowsVerbatimArguments: true, approved: true }),
  ).toThrow('invalid Windows start');
});
it('rejects a non-boolean Host quoting option before any process allocation', () => {
  const spawn = vi.fn();
  expect(() =>
    spawnSubprocess(
      {
        argv: [process.execPath],
        cwd: process.cwd(),
        graceMs: 100,
        windowsVerbatimArguments: 'yes',
        stdio: { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' },
      } as never,
      { spawn },
    ),
  ).toThrow('SUBPROCESS_SPEC_INVALID');
  expect(spawn).not.toHaveBeenCalled();
});
it.skipIf(process.platform !== 'win32')(
  'preserves a real Windows PowerShell literal through the owned Job process path',
  async () => {
    const directory = await mkdtemp(join(tmpdir(), 'axterm-owned-cmd-'));
    const ctx = new Context();
    try {
      await ctx.plugin(LocalSubprocess);
      const executable = await ctx.subprocess.resolveExecutable(process.env.ComSpec || 'cmd.exe');
      const command =
        "powershell -NoProfile -NonInteractive -Command \"Set-Content -LiteralPath 'quoted.txt' -Value 'alpha beta ''single''' -Encoding UTF8\"";
      const child = ctx.subprocess.spawn({
        argv: [executable, '/d', '/s', '/c', `"${command}"`],
        windowsVerbatimArguments: true,
        cwd: directory,
        graceMs: 1000,
        signal: AbortSignal.timeout(10000),
        stdio: { stdin: 'ignore', stdout: { maxBytes: 8192 }, stderr: { maxBytes: 8192 } },
      });
      try {
        expect((await child.done).exitCode).toBe(0);
      } finally {
        await child.dispose();
      }
      expect(
        (await readFile(join(directory, 'quoted.txt'), 'utf8')).replace(/^\uFEFF/, '').trim(),
      ).toBe("alpha beta 'single'");
    } finally {
      await ctx.fiber.dispose();
      await rm(directory, { recursive: true, force: true });
    }
  },
  15000,
);
