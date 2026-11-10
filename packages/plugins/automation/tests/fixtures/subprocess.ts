import { Context } from '@deepseek-ai/cordis';
import LocalSubprocessRuntime from '@axterm/infra-subprocess-local';
import { beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
let root: Context;
let home: string;
let previous: Record<string, string | undefined>;
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'axterm-owned-widget-home-'));
  previous = Object.fromEntries(
    ['HOME', 'ZDOTDIR', 'AXTERM_HOME'].map((key) => [key, process.env[key]]),
  );
  process.env.HOME = home;
  process.env.ZDOTDIR = home;
  process.env.AXTERM_HOME = join(home, 'axterm');
  root = new Context();
  await root.plugin(LocalSubprocessRuntime);
});
afterEach(async () => {
  try {
    await root?.fiber.dispose();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(home, { recursive: true, force: true });
  }
});
export function localSubprocess() {
  return root.subprocess;
}
