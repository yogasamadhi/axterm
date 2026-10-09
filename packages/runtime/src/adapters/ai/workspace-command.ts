import { execFile, spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import type { AiWorkspace } from '@workspace/contracts';

export function workspaceExecutionFacts(command: string, workspace: AiWorkspace) {
  if (workspace.execution === 'ssh') {
    const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
    return {
      shell: 'SSH login shell (server-selected)',
      command: workspace.commandDirectory
        ? `cd -- ${quote(workspace.commandDirectory)} && (\n${command}\n)`
        : command,
      connectionId: workspace.connectionId,
      cwd: workspace.commandDirectory,
    };
  }
  const executable = process.platform === 'win32' ? process.env.ComSpec || 'cmd.exe' : '/bin/sh';
  return {
    shell:
      process.platform === 'win32' && /(?:^|[\\/])cmd\.exe$/iu.test(executable)
        ? 'cmd.exe'
        : executable,
    executable: process.platform === 'win32' ? process.env.ComSpec || 'cmd.exe' : '/bin/sh',
    arguments: process.platform === 'win32' ? ['/d', '/s', '/c', `"${command}"`] : ['-c', command],
    command,
    cwd: workspace.commandDirectory,
  };
}

/** One owned process group, bounded output and deterministic cancellation. */
export async function executeWorkspaceCommand(command: string, cwd: string, signal: AbortSignal) {
  signal.throwIfAborted();
  const windows = process.platform === 'win32';
  const child = spawn(
    windows ? process.env.ComSpec || 'cmd.exe' : '/bin/sh',
    windows ? ['/d', '/s', '/c', `"${command}"`] : ['-c', command],
    {
      cwd,
      env: Object.fromEntries(
        Object.entries(process.env).filter(
          ([key, value]) =>
            value !== undefined && !/^(ELECTRON_|AXTERM_.*TOKEN|NODE_OPTIONS$)/iu.test(key),
        ),
      ),
      detached: !windows,
      windowsHide: true,
      // CMD /s removes this one outer quote pair. Node's normal argv escaping
      // uses backslashes, which are not CMD quote escapes and alter PS payloads.
      windowsVerbatimArguments: windows,
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  return new Promise<{ stdout: string; stderr: string; exitCode: number | null }>(
    (resolve, reject) => {
      let bytes = 0;
      let stdout = '';
      let stderr = '';
      let failure: Error | undefined;
      let stopping = false;
      const outDecoder = new StringDecoder('utf8');
      const errDecoder = new StringDecoder('utf8');
      const stop = () => {
        if (!child.pid || stopping) return;
        stopping = true;
        if (windows) {
          execFile(
            'taskkill',
            ['/pid', String(child.pid), '/t', '/f'],
            {
              timeout: 5000,
              windowsHide: true,
              maxBuffer: 8192,
            },
            () => child.kill('SIGKILL'),
          );
        } else {
          try {
            process.kill(-child.pid, 'SIGKILL');
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ESRCH') child.kill('SIGKILL');
          }
        }
      };
      const abort = () => {
        failure = new Error('Workspace command canceled');
        stop();
        child.stdout.destroy();
        child.stderr.destroy();
      };
      const receive = (data: Buffer, target: 'out' | 'err') => {
        bytes += data.length;
        if (bytes > 128 * 1024) {
          failure = new Error('Workspace command output limit exceeded');
          stop();
          child.stdout.destroy();
          child.stderr.destroy();
          return;
        }
        if (target === 'out') stdout += outDecoder.write(data);
        else stderr += errDecoder.write(data);
      };
      const receiveOut = (data: Buffer) => receive(data, 'out');
      const receiveErr = (data: Buffer) => receive(data, 'err');
      const error = (value: Error) => {
        failure = value;
        stop();
      };
      child.stdout.on('data', receiveOut);
      child.stderr.on('data', receiveErr);
      child.once('error', error);
      child.once('exit', stop);
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
      child.once('close', (exitCode) => {
        signal.removeEventListener('abort', abort);
        child.removeListener('error', error);
        child.removeListener('exit', stop);
        child.stdout.removeListener('data', receiveOut);
        child.stderr.removeListener('data', receiveErr);
        if (failure) reject(failure);
        else
          resolve({
            stdout: stdout + outDecoder.end(),
            stderr: stderr + errDecoder.end(),
            exitCode,
          });
      });
    },
  );
}
