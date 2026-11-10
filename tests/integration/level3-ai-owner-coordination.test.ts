import { Context } from '@deepseek-ai/cordis';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile, readdir, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { afterEach, expect, it, vi } from 'vitest';
import Storage from '@axterm/infra-storage';
import * as Schema from '@axterm/data-schema';
import * as Relational from '@axterm/infra-storage-relational';
import * as Domains from '@axterm/infra-storage-domain';
import {
  AiOwnerLease,
  aiProcessExited,
} from '../../packages/plugins/ai/src/adapters/owner-coordination.ts';
import { AiRepository } from '../../packages/plugins/ai/src/adapters/repository.ts';
import { AiStorage } from '../../packages/plugins/ai/src/adapters/storage.ts';
import { AiRunJournal } from '../../packages/plugins/ai/src/adapters/run-journal.ts';
const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'axterm-ai-owner-'));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const ctx = new Context();
  cleanups.push(() => ctx.fiber.dispose());
  await ctx.plugin(Storage);
  await ctx.plugin(Schema);
  await ctx.plugin(Relational, { path: ':memory:', schema: 'productSchema' });
  await ctx.plugin(Domains, { backend: 'relational' });
  const domain = await ctx.storage.domain.open(Schema.productDomains.ai);
  cleanups.push(() => domain.close());
  const repository = new AiRepository(new AiStorage(domain));
  const owner = { profile: 'desktop', generation: randomUUID(), pid: process.pid };
  const journal = new AiRunJournal(domain, repository, owner, (text) => text);
  return { root, domain, repository, owner, journal };
}
it('holds one actual owner lease per Profile until explicit close, while other Profiles remain independent', async () => {
  const f = await fixture();
  const directory = join(f.root, 'coordination');
  const desktop = await AiOwnerLease.open(directory, 'desktop');
  cleanups.push(() => desktop.close());
  expect(desktop.active()).toBe(true);
  await expect(AiOwnerLease.open(directory, 'desktop')).rejects.toThrow('unavailable');
  const web = await AiOwnerLease.open(directory, 'web');
  cleanups.push(() => web.close());
  await desktop.close();
  expect(desktop.active()).toBe(false);
  const next = await AiOwnerLease.open(directory, 'desktop');
  await next.close();
  await web.close();
  expect(await readdir(directory)).toEqual([]);
  if (process.platform !== 'win32') {
    const alias = join(f.root, 'alias');
    await symlink(directory, alias, 'dir');
    await expect(AiOwnerLease.open(alias, 'web')).rejects.toThrow('unavailable');
  }
  expect(aiProcessExited(process.pid)).toBe(false);
  expect(aiProcessExited(0)).toBe(false);
  expect(aiProcessExited(-1)).toBe(false);
});
it('does not touch a live owner, then takes over its real crashed-process lock and logs interruption without replaying effects', async () => {
  const f = await fixture();
  const directory = join(f.root, 'coordination');
  const script = join(f.root, 'owner.mjs');
  const entryUrl = pathToFileURL(join(process.cwd(), 'packages/plugins/ai/lib/index.js')).href;
  await writeFile(
    script,
    `import {AiOwnerLease} from ${JSON.stringify(entryUrl)};const lease=await AiOwnerLease.open(${JSON.stringify(directory)},'web');process.stdout.write('READY\\n');setInterval(()=>{},1000);`,
  );
  const child = spawn(process.execPath, [script], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr!.on('data', (chunk) => (stderr += String(chunk)));
  let ready = '';
  child.stdout!.on('data', (chunk) => (ready += String(chunk)));
  cleanups.push(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const done = once(child, 'exit');
      child.kill('SIGKILL');
      await done;
    }
  });
  await vi.waitFor(
    () => {
      if (child.exitCode !== null) throw new Error('Owner fixture failed: ' + stderr);
      expect(ready).toContain('READY');
    },
    { timeout: 5000 },
  );
  const oldOwner = { profile: 'web', generation: randomUUID(), pid: child.pid! };
  const old = new AiRunJournal(f.domain, f.repository, oldOwner, (text) => text);
  const { run } = old.admit(randomUUID(), oldOwner.generation, {
    engineId: 'application',
    useCase: 'diagnose',
    prompt: 'controlled',
  });
  old.transition(run.id, 'running');
  const tool = old.createTool({
    runId: run.id,
    toolName: 'terminal.exec',
    risk: 'mutating',
    argsHash: 'a'.repeat(64),
    args: { command: 'echo controlled' },
    target: randomUUID(),
  });
  old.updateTool(tool.id, 'running');
  const lease = await AiOwnerLease.open(directory, 'desktop');
  cleanups.push(() => lease.close());
  expect(await lease.recover(f.journal)).toEqual({ interrupted: 0, blockedProfiles: [] });
  expect(f.repository.getAiRun(run.id).state).toBe('running');
  const exit = once(child, 'exit');
  child.kill('SIGKILL');
  await exit;
  expect(aiProcessExited(child.pid!)).toBe(true);
  const guard = await AiOwnerLease.open(directory, 'web');
  expect(await lease.recover(f.journal)).toEqual({ interrupted: 0, blockedProfiles: ['web'] });
  expect(f.repository.getAiRun(run.id).state).toBe('running');
  await guard.close();
  expect(await lease.recover(f.journal)).toEqual({ interrupted: 1, blockedProfiles: [] });
  expect(f.repository.getAiRun(run.id)).toMatchObject({
    state: 'failed',
    errorCode: 'RUN_INTERRUPTED',
  });
  expect(f.repository.getToolCall(tool.id)).toMatchObject({
    state: 'canceled',
    resultMetadata: { effect: 'uncertain', code: 'RUN_INTERRUPTED' },
  });
  expect(
    f.journal
      .read(run.id, 0, 200)
      .entries.some(
        (entry) =>
          entry.payload.kind === 'tool' &&
          entry.payload.tool.resultMetadata?.effect === 'uncertain',
      ),
  ).toBe(true);
  expect(await lease.recover(f.journal)).toEqual({ interrupted: 0, blockedProfiles: [] });
});
