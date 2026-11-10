import { Context } from '@deepseek-ai/cordis';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import LocalSubprocess from '../../packages/infra/subprocess-local/src/index.ts';
import { OwnedWorkspaceCommands } from '../../packages/plugins/ai/src/adapters/workspace-command.ts';
const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
  vi.unstubAllEnvs();
});
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'axterm-ai-command-'));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const ctx = new Context();
  cleanups.push(() => ctx.fiber.dispose());
  await ctx.plugin(LocalSubprocess);
  const commands = new OwnedWorkspaceCommands(ctx.subprocess);
  cleanups.push(() => commands.close());
  return { directory, commands };
}
it.skipIf(process.platform === 'win32')(
  'runs the actual local shell through the subprocess owner with bounded stdout/stderr and exact exit facts',
  async () => {
    const { directory, commands } = await fixture();
    expect(
      await commands.execute(
        "printf 'stdout'; printf 'stderr' >&2; exit 7",
        directory,
        new AbortController().signal,
      ),
    ).toEqual({ stdout: 'stdout', stderr: 'stderr', exitCode: 7 });
    expect(commands.resourceCount()).toBe(0);
  },
);
it.skipIf(process.platform === 'win32')(
  'terminates and actually joins a command that exceeds the combined output limit',
  async () => {
    const { directory, commands } = await fixture();
    await expect(
      commands.execute('head -c 131073 /dev/zero', directory, new AbortController().signal),
    ).rejects.toMatchObject({ code: 'PAYLOAD_TOO_LARGE' });
    expect(commands.resourceCount()).toBe(0);
  },
);
it.skipIf(process.platform === 'win32')(
  'does not forward ambient AI credentials into workspace commands',
  async () => {
    vi.stubEnv('AI_API_KEY', 'CONTROLLED_PARENT_SECRET');
    const { directory, commands } = await fixture();
    expect(
      (
        await commands.execute(
          'printf "%s" "${AI_API_KEY-unset}"',
          directory,
          new AbortController().signal,
        )
      ).stdout,
    ).toBe('unset');
  },
);
it.skipIf(process.platform === 'win32')(
  'cancels a TERM-resistant real command and retains ownership until its process range is gone',
  async () => {
    const { directory, commands } = await fixture();
    const pending = commands.execute(
      "printf '%s' $$ > ready.pid; trap '' TERM; while :; do sleep 1; done",
      directory,
      new AbortController().signal,
    );
    void pending.catch(() => {});
    let pid = 0;
    await vi.waitFor(async () => {
      pid = Number(await readFile(join(directory, 'ready.pid'), 'utf8'));
      expect(pid).toBeGreaterThan(0);
    });
    await commands.close();
    await expect(pending).rejects.toThrow();
    expect(() => process.kill(pid, 0)).toThrow();
    expect(commands.resourceCount()).toBe(0);
    await expect(
      commands.execute('pwd', directory, new AbortController().signal),
    ).rejects.toMatchObject({ code: 'CAPABILITY_UNAVAILABLE' });
  },
);
