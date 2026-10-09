import { existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { prepareIndependentSnapshot } from './prepare-independent-snapshot.mjs';

const repositoryRoot = resolve(import.meta.dirname, '../..');

function commandError(command, argumentsList, code, signal) {
  const outcome = signal ? `signal ${signal}` : `exit code ${code ?? 'unknown'}`;
  return new Error(`${command} ${argumentsList.join(' ')} failed with ${outcome}`);
}

function run(command, argumentsList, { cwd, capture = false, env } = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, argumentsList, {
      cwd,
      env,
      stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    if (capture) {
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (value) => {
        stdout += value;
      });
      child.stderr.on('data', (value) => {
        stderr += value;
      });
    }
    child.once('error', reject);
    child.once('close', (code, signal) => {
      if (code === 0) {
        resolvePromise({ stdout, stderr });
        return;
      }
      reject(commandError(command, argumentsList, code, signal));
    });
  });
}

function trackedFileCount(stdout) {
  return stdout.split('\0').filter(Boolean).length;
}

async function assertCleanCandidate(cloneDirectory) {
  const status = await run('git', ['status', '--porcelain'], {
    cwd: cloneDirectory,
    capture: true,
  });
  if (status.stdout) throw new Error('Ephemeral candidate clone has uncommitted changes');
  await run('git', ['diff', '--check'], { cwd: cloneDirectory });
  await run('git', ['diff', '--cached', '--check'], { cwd: cloneDirectory });

  for (const path of ['.gitmodules', 'vendor/legacy-prototype', 'docs/api/openapi.json']) {
    if (existsSync(resolve(cloneDirectory, path))) {
      throw new Error(`Ephemeral candidate unexpectedly contains ${path}`);
    }
  }
  const submodules = await run('git', ['submodule', 'status'], {
    cwd: cloneDirectory,
    capture: true,
  });
  if (submodules.stdout.trim()) throw new Error('Ephemeral candidate unexpectedly has a submodule');
}

/**
 * Creates a disposable root commit from the independently-audited source
 * snapshot, then verifies that a non-local clone has the same clean source.
 * The temporary repository is never given a remote and this function never
 * writes to the caller's checkout.
 */
export async function createEphemeralGitCandidate(sourceDirectory = repositoryRoot) {
  const prepared = await prepareIndependentSnapshot(sourceDirectory);
  if (!prepared.report.passed) {
    await rm(prepared.temporaryDirectory, { recursive: true, force: true });
    throw new Error('Independent source snapshot audit failed before candidate creation');
  }

  const sourceDirectoryPath = prepared.snapshotDirectory;
  const cloneDirectory = resolve(prepared.temporaryDirectory, 'clone');
  try {
    for (const path of ['.git', '.gitmodules', 'vendor/legacy-prototype']) {
      if (existsSync(resolve(sourceDirectoryPath, path))) {
        throw new Error(`Prepared source snapshot unexpectedly contains ${path}`);
      }
    }
    await run('git', ['init', '--quiet'], { cwd: sourceDirectoryPath });
    await run('git', ['config', 'user.name', 'Axterm temporary evidence'], {
      cwd: sourceDirectoryPath,
    });
    await run('git', ['config', 'user.email', 'evidence@invalid.local'], {
      cwd: sourceDirectoryPath,
    });
    await run('git', ['add', '--all'], { cwd: sourceDirectoryPath });
    await run('git', ['commit', '--quiet', '--message', 'Independent source candidate'], {
      cwd: sourceDirectoryPath,
    });
    const commit = await run('git', ['rev-parse', 'HEAD'], {
      cwd: sourceDirectoryPath,
      capture: true,
    });
    await run('git', ['clone', '--no-local', '--quiet', sourceDirectoryPath, cloneDirectory]);
    const cloneCommit = await run('git', ['rev-parse', 'HEAD'], {
      cwd: cloneDirectory,
      capture: true,
    });
    if (commit.stdout.trim() !== cloneCommit.stdout.trim()) {
      throw new Error('Ephemeral candidate clone commit does not match its source commit');
    }
    await assertCleanCandidate(cloneDirectory);
    const tracked = await run('git', ['ls-files', '-z'], {
      cwd: cloneDirectory,
      capture: true,
    });
    return {
      ...prepared,
      sourceDirectory: sourceDirectoryPath,
      cloneDirectory,
      commit: commit.stdout.trim(),
      trackedFiles: trackedFileCount(tracked.stdout),
    };
  } catch (error) {
    await rm(prepared.temporaryDirectory, { recursive: true, force: true });
    throw error;
  }
}

export function parseArguments(argumentsList) {
  const keep = argumentsList.includes('--keep');
  const ssh = argumentsList.includes('--ssh');
  const externalPeers = argumentsList.includes('--external-peers');
  if (
    !argumentsList.includes('--check') ||
    argumentsList.some(
      (value) => !['--check', '--keep', '--ssh', '--external-peers'].includes(value),
    )
  ) {
    throw new Error(
      'Usage: node scripts/commercialization/check-ephemeral-git-candidate.mjs --check [--ssh] [--external-peers] [--keep]',
    );
  }
  if (externalPeers && process.platform === 'win32') {
    throw new Error('External SSH/PTY peer fixtures are not available on Windows');
  }
  return { keep, ssh, externalPeers };
}

async function checkEphemeralGitCandidate({ keep, ssh, externalPeers }) {
  const candidate = await createEphemeralGitCandidate();
  try {
    await run('bun', ['install', '--frozen-lockfile'], { cwd: candidate.cloneDirectory });
    await run('bun', ['run', 'check'], { cwd: candidate.cloneDirectory });
    if (ssh) {
      await run('bun', ['run', 'test:ssh'], { cwd: candidate.cloneDirectory });
    }
    if (externalPeers) {
      if (!['arm64', 'x64'].includes(process.arch)) {
        throw new Error(`External SSH/PTY peer fixtures do not support ${process.arch}`);
      }
      const peerPlatform = process.arch === 'arm64' ? 'linux/arm64' : 'linux/amd64';
      const lrzszPackage =
        process.env.AXTERM_EXTERNAL_LRZSZ_DEB?.trim() ||
        resolve(
          candidate.temporaryDirectory,
          peerPlatform === 'linux/arm64'
            ? 'lrzsz_0.12.21-10_arm64.deb'
            : 'lrzsz_0.12.21-10+b1_amd64.deb',
        );
      if (!process.env.AXTERM_EXTERNAL_LRZSZ_DEB?.trim()) {
        await run('curl', [
          '--fail',
          '--location',
          '--silent',
          '--show-error',
          '--max-time',
          '30',
          '--output',
          lrzszPackage,
          `https://deb.debian.org/debian/pool/main/l/lrzsz/${basename(lrzszPackage)}`,
        ]);
      }
      for (const fixture of [
        {
          variable: 'AXTERM_EXTERNAL_LRZSZ_SSH',
          path: 'packages/runtime/src/adapters/terminal-transfer/external-lrzsz-ssh-pty.test.ts',
        },
        {
          variable: 'AXTERM_EXTERNAL_TRZSZ_SSH',
          path: 'packages/runtime/src/adapters/terminal-transfer/external-trzsz-ssh-pty.test.ts',
        },
      ]) {
        await run('bun', ['x', 'vitest', 'run', fixture.path], {
          cwd: candidate.cloneDirectory,
          env: {
            ...process.env,
            AXTERM_EXTERNAL_LRZSZ_SSH: '0',
            AXTERM_EXTERNAL_TRZSZ_SSH: '0',
            AXTERM_EXTERNAL_PEER_PLATFORM: peerPlatform,
            AXTERM_EXTERNAL_LRZSZ_DEB: lrzszPackage,
            [fixture.variable]: '1',
          },
        });
      }
    }
    await assertCleanCandidate(candidate.cloneDirectory);
    console.log(
      JSON.stringify(
        {
          report: candidate.report,
          commit: candidate.commit,
          trackedFiles: candidate.trackedFiles,
          sshFixture: ssh ? 'passed' : 'not requested',
          externalSshPeers: externalPeers ? 'passed' : 'not requested',
          ...(keep ? { temporaryDirectory: candidate.temporaryDirectory } : {}),
        },
        null,
        2,
      ),
    );
  } finally {
    if (!keep) await rm(candidate.temporaryDirectory, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await checkEphemeralGitCandidate(parseArguments(process.argv.slice(2)));
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
