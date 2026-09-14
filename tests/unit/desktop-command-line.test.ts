import { describe, expect, it } from 'vitest';
import { parseQuickConnect } from '../../packages/shared/src/quick-connect';
import {
  DESKTOP_COMMAND_LINE_HELP,
  materializeDesktopCommandLine,
  parseDesktopCommandLine,
} from '../../apps/desktop/src/main/command-line';

describe('desktop command line', () => {
  it('maps Electerm SSH flags and quoted values into one bounded transient target', () => {
    const parsed = parseDesktopCommandLine(
      [
        '/Applications/Axterm.app',
        '--user-data-dir=/tmp/profile',
        '-l',
        'operator',
        '-P',
        '2222',
        '-pw',
        'session-only',
        '-se',
        'LANGUAGE=zh_CN RELEASE="summer build"',
        '-so',
        '-t',
        'Release shell',
        'ssh.example.test',
      ],
      '/work',
    );
    expect(parsed).toMatchObject({ kind: 'session', newWindow: false });
    if (parsed.kind !== 'session') throw new Error('Expected a session command');
    expect(parseQuickConnect(parsed.source)).toMatchObject({
      protocol: 'ssh',
      hostname: 'ssh.example.test',
      port: 2222,
      username: 'operator',
      title: 'Release shell',
      temporarySecret: 'session-only',
      enableSsh: false,
      enableSftp: true,
      environment: { LANGUAGE: 'zh_CN', RELEASE: 'summer build' },
    });
  });

  it('accepts typed opts and applies explicit flags after JSON values', () => {
    const parsed = parseDesktopCommandLine([
      '-tp',
      'vnc',
      '-opts',
      '{"host":"screen.test","port":5902,"username":"viewer","viewOnly":true}',
      '--title=Operations',
      '--port=5903',
    ]);
    if (parsed.kind !== 'session') throw new Error('Expected a session command');
    expect(parseQuickConnect(parsed.source)).toMatchObject({
      protocol: 'vnc',
      hostname: 'screen.test',
      port: 5903,
      username: 'viewer',
      title: 'Operations',
      viewOnly: true,
    });
  });

  it('materializes opaque grants for local cwd and SSH private keys', () => {
    const local = parseDesktopCommandLine(
      ['-tp', 'local', '-d', './workspace with spaces', '-t', 'Local build'],
      '/tmp',
    );
    expect(local).toMatchObject({
      kind: 'session',
      initialDirectoryPath: '/tmp/workspace with spaces',
    });
    if (local.kind !== 'session') throw new Error('Expected local session');
    expect(
      parseQuickConnect(
        materializeDesktopCommandLine(local, { initialDirectoryGrantId: 'grant_directory' }),
      ),
    ).toEqual({
      protocol: 'local',
      title: 'Local build',
      initialDirectoryGrantId: 'grant_directory',
    });

    const ssh = parseDesktopCommandLine(
      ['-i', './id_ed25519', '-ps', 'key-only', 'alice@host'],
      '/keys',
    );
    expect(ssh).toMatchObject({ kind: 'session', privateKeyPath: '/keys/id_ed25519' });
    if (ssh.kind !== 'session') throw new Error('Expected SSH session');
    expect(
      parseQuickConnect(
        materializeDesktopCommandLine(ssh, {
          privateKeyGrantId: 'grant_private_key',
          initialDirectoryGrantId: 'grant_ssh_local_directory',
        }),
      ),
    ).toMatchObject({
      protocol: 'ssh',
      username: 'alice',
      hostname: 'host',
      authType: 'privateKey',
      credentialGrantId: 'grant_private_key',
      temporaryPassphrase: 'key-only',
      initialDirectoryGrantId: 'grant_ssh_local_directory',
    });

    const sshDirectory = parseDesktopCommandLine(
      ['--init-folder', './downloads', 'operator@host'],
      '/work',
    );
    expect(sshDirectory).toMatchObject({
      kind: 'session',
      initialDirectoryPath: '/work/downloads',
    });
  });

  it('honors direct protocol URLs and single/new-window control flags', () => {
    expect(
      parseDesktopCommandLine([
        '--new-window',
        '--title',
        'ignored like Electerm',
        'telnet://user:once@host.test:2323?title=Direct',
      ]),
    ).toEqual({
      kind: 'session',
      newWindow: true,
      source: 'telnet://user:once@host.test:2323?title=Direct',
    });
    expect(parseDesktopCommandLine([])).toEqual({ kind: 'none', newWindow: false });
    expect(parseDesktopCommandLine(['--help'])).toEqual({ kind: 'help', newWindow: false });
    expect(parseDesktopCommandLine(['-V'])).toEqual({ kind: 'version', newWindow: false });
    expect(DESKTOP_COMMAND_LINE_HELP).toContain('transient session password');
  });

  it('materializes a grant-scoped batch-operation file without exposing its path', () => {
    const parsed = parseDesktopCommandLine(['--batch-op', './release workflow.json'], '/work');
    expect(parsed).toMatchObject({
      kind: 'session',
      batchOperationPath: '/work/release workflow.json',
    });
    if (parsed.kind !== 'session') throw new Error('Expected a batch-operation intent');
    const source = materializeDesktopCommandLine(parsed, {
      batchOperationGrantId: 'grant_batch_operation',
    });
    expect(source).not.toContain('/work/release');
    expect(parseQuickConnect(source)).toEqual({
      protocol: 'local',
      batchOperationGrantId: 'grant_batch_operation',
    });
  });

  it.each([
    [['--wat'], 'CLI_UNKNOWN_OPTION'],
    [['--port'], 'CLI_OPTION_VALUE_REQUIRED'],
    [['--port', '70000', 'host'], 'CLI_INVALID_PORT'],
    [['--opts', '{bad}', 'host'], 'CLI_INVALID_OPTIONS_JSON'],
    [['--tp', 'invalid', 'host'], 'CLI_INVALID_PROTOCOL'],
    [['--server-port', '30976'], 'CLI_FIXED_RUNTIME_PORT_UNSUPPORTED'],
    [['--tp', 'telnet', '--init-folder', '/tmp', 'host'], 'CLI_INIT_FOLDER_REQUIRES_LOCAL'],
  ])('rejects %j with a stable path-free code', (argv, errorCode) => {
    expect(parseDesktopCommandLine(argv)).toEqual({
      kind: 'error',
      newWindow: false,
      errorCode,
    });
  });
});
