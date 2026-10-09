import { once } from 'node:events';
import { describe, expect, it } from 'vitest';
import {
  expandProxyCommand,
  ProxyCommandError,
  StdioProxyCommandRunner,
} from './stdio-proxy-command-runner';

const relayCommand = {
  executable: process.execPath,
  arguments: [
    '-e',
    'process.stdin.pipe(process.stdout);setInterval(()=>{},1000).unref()',
    '%h',
    '%p',
    '%r',
  ],
};

describe('StdioProxyCommandRunner', () => {
  it('expands validated placeholders into independent argv values', () => {
    expect(
      expandProxyCommand(
        {
          executable: '/usr/bin/proxy-helper',
          arguments: ['--target', '%h:%p', '--user=%r', 'literal=%%', 'x;%h'],
        },
        { host: 'ssh.example.test', port: 2202 },
        'operator',
      ),
    ).toEqual({
      executable: '/usr/bin/proxy-helper',
      arguments: [
        '--target',
        'ssh.example.test:2202',
        '--user=operator',
        'literal=%',
        'x;ssh.example.test',
      ],
    });
  });

  it('bridges stdin/stdout and closes the child when the owner destroys the channel', async () => {
    const channel = await new StdioProxyCommandRunner().connect({
      command: relayCommand,
      target: { host: 'ssh.example.test', port: 22 },
      username: 'operator',
      timeoutMs: 2_000,
    });
    const output = once(channel, 'data');
    channel.write(Buffer.from('proxy-command-bytes'));
    await expect(output).resolves.toEqual([Buffer.from('proxy-command-bytes')]);
    channel.destroy();
    await once(channel, 'close');
  });

  it('propagates bounded process failures and cancellation through the channel', async () => {
    const failed = await new StdioProxyCommandRunner().connect({
      command: {
        executable: process.execPath,
        arguments: ['-e', "process.stderr.write('fixture failed');process.exit(7)", '%h', '%p'],
      },
      target: { host: 'ssh.example.test', port: 22 },
      username: 'operator',
      timeoutMs: 2_000,
    });
    const failure = once(failed, 'error');
    await expect(failure).resolves.toMatchObject([
      {
        code: 'PROXY_COMMAND_FAILED',
        message: expect.stringMatching(/code 7.*fixture failed/u),
      },
    ]);

    const abort = new AbortController();
    const canceled = await new StdioProxyCommandRunner().connect({
      command: relayCommand,
      target: { host: 'ssh.example.test', port: 22 },
      username: 'operator',
      timeoutMs: 2_000,
      signal: abort.signal,
    });
    const canceledError = once(canceled, 'error');
    abort.abort();
    await expect(canceledError).resolves.toMatchObject([{ code: 'PROXY_COMMAND_ABORTED' }]);
  });

  it('rejects invalid templates and executable start failures', async () => {
    expect(() =>
      expandProxyCommand(
        { executable: 'proxy-helper', arguments: ['%h', '%x', '%p'] },
        { host: 'ssh.example.test', port: 22 },
        'operator',
      ),
    ).toThrowError(ProxyCommandError);

    await expect(
      new StdioProxyCommandRunner().connect({
        command: {
          executable: `/definitely-missing-axterm-proxy-command-${process.pid}`,
          arguments: ['%h', '%p'],
        },
        target: { host: 'ssh.example.test', port: 22 },
        username: 'operator',
        timeoutMs: 2_000,
      }),
    ).rejects.toMatchObject({ code: 'PROXY_COMMAND_START_FAILED' });
  });
});
