import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { stat } from 'node:fs/promises';
import { expect, it } from 'vitest';
import {
  createLinuxLaunchFiles,
  cleanupLinuxLaunchFiles,
} from '../../packages/infra/subprocess-local/src/runner-protocol.ts';
import {
  spawnRunnerInvocation,
  runnerEnvironment,
} from '../../packages/infra/subprocess-local/src/runner-launch.ts';
const execute = promisify(execFile);
it.skipIf(process.platform === 'win32')(
  'executes the emitted Unix bootstrap with the packaged FFI closure and consumes its private launch file once',
  async () => {
    const files = createLinuxLaunchFiles({
      cwd: process.cwd(),
      env: { PATH: '/usr/bin:/bin', AXTERM_EXPLICIT_FIXTURE: 'owned-fact' },
    });
    try {
      expect((await stat(files.directory)).mode & 0o777).toBe(0o700);
      expect((await stat(files.requestPath)).mode & 0o777).toBe(0o600);
      const [program, ...args] = spawnRunnerInvocation();
      expect(args.at(-1)).toMatch(/\/lib\/runner\.js$/);
      const { stdout, stderr } = await execute(
        program,
        [
          ...args,
          '--',
          '/bin/sh',
          '-c',
          'printf "%s:%s" "$AXTERM_EXPLICIT_FIXTURE" "${AXTERM_SUBPROCESS_RUNNER-unset}"',
        ],
        { env: runnerEnvironment(files.requestPath), timeout: 4000 },
      );
      expect(stdout).toBe('owned-fact:unset');
      expect(stderr).toBe('');
      await expect(stat(files.requestPath)).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(
        execute(program, [...args, '--', '/bin/echo', 'must-not-replay'], {
          env: runnerEnvironment(files.requestPath),
          timeout: 4000,
        }),
      ).rejects.toMatchObject({ code: 127, stdout: '' });
    } finally {
      cleanupLinuxLaunchFiles(files);
    }
  },
);
